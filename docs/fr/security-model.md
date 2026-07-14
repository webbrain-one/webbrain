# Modèle de Sécurité

Ce document décrit l'architecture de sécurité de WebBrain — ce que l'extension peut faire, ce qu'elle considère comme fiable, comment elle gère les identifiants, et comment elle se défend contre l'injection de prompt.

Pour la divulgation de vulnérabilités, voir [SECURITY.md](../SECURITY.md).

---

## Privilèges de l'Extension

### Permissions

```json
{
  "permissions": [
    "sidePanel", "activeTab", "contextMenus", "tabs", "tabGroups",
    "scripting", "storage", "webNavigation", "webRequest", "debugger",
    "downloads", "alarms", "unlimitedStorage", "offscreen",
    "privateNetworkAccess", "tabCapture",
    "clipboardWrite", "clipboardRead"
  ],
  "host_permissions": ["<all_urls>", "http://localhost/*", "http://127.0.0.1/*", "http://*/*"]
}
```

(Ceci est le manifeste Chrome MV3. Firefox MV2 accorde un ensemble plus restreint —
`activeTab`, `menus`, `webNavigation`, `webRequest`, `storage`,
`unlimitedStorage`, `tabs`, `tabGroups`, `downloads`, `alarms`, `clipboard*`,
`<all_urls>` — et n'a pas `debugger`/`offscreen`/`tabCapture`, voir Différences
Firefox ci-dessous.)

| Permission | Risque | Atténuation |
|---|---|---|
| `<all_urls>` | Injection de script de contenu n'importe où — l'agent peut lire et interagir avec toute page visitée par l'utilisateur | L'utilisateur doit explicitement passer en mode action (Act ou Dev) avant les clics/saisies/navigations. Le mode Ask est en lecture seule. L'agent ne s'active jamais automatiquement sur les nouveaux onglets. |
| `debugger` | L'accès CDP fournit des événements fiables et un contrôle complet du DOM/réseau sur n'importe quel onglet | Le débogueur est uniquement attaché pendant les exécutions actives de l'agent et détaché à la fin/l'abandon. |
| `webRequest` | Peut observer les métadonnées XHR/fetch pour les requêtes faites par la page active | L'observateur de mutation d'API est désactivé par défaut ; lorsqu'il est activé, il conserve seulement un tampon mémoire limité par onglet pour les indices de raccourcis de clics répétés et la relecture opaque de même origine. |
| `downloads` | Peut enregistrer des fichiers dans le dossier Téléchargements de l'utilisateur sans demander | Seuls les appels d'outils explicites de téléchargement de l'agent (`download_files`, `download_file`, `download_resource_from_page`, `download_social_media`, outils de compétence de téléchargement) l'utilisent, et chacun est soumis à la passerelle de permission capacité × origine. |
| `alarms` | Peut réveiller des tâches planifiées dans de futures sessions navigateur | Seuls `schedule_resume` / `schedule_task` créent des alarmes, et ces outils sont soumis à la passerelle. |
| `offscreen` | Un document hors écran peut faire des requêtes HTTP immunisées contre la CSP de l'utilisateur | Utilisé uniquement pour le proxy du fournisseur LLM local et l'enregistrement d'onglet. Ne transmet jamais d'URLs arbitraires. |

### Authentification

L'extension s'exécute **à l'intérieur de la session navigateur authentifiée de l'utilisateur**. Il n'y a pas de "compte IA" séparé — chaque site sur lequel l'utilisateur est connecté (GitHub, Gmail, banque, outils internes) est accessible à l'agent avec toutes les permissions de l'utilisateur, exactement comme s'il cliquait lui-même.

Le prompt système indique explicitement au modèle :
> "Vous n'avez PAS besoin de jetons API, de flux OAuth, ou de 'permission d'agir au nom de l'utilisateur'. La session navigateur a déjà tout cela."

C'est une fonctionnalité (elle rend l'agent utile sans aucune configuration) mais aussi le risque le plus important : **l'agent peut faire tout ce que l'utilisateur peut faire dans un navigateur**.

---

## Gestion des Identifiants

### Détection

Après chaque appel `set_field` / `type_ax`, `credential-fields.js` vérifie si le champ rempli est une entrée d'identifiant. Déclencheurs :

1. `<input type="password">`
2. `autocomplete="current-password" | "new-password" | "one-time-code"`
3. Le nom / id / aria-label / placeholder / texte d'étiquette du champ correspond à `SENSITIVE_NAME_RE`

La regex : `pwd|password|passwd|secret|token|api[-_\s]?key|otp|2fa|mfa|credential|recovery[-_\s]?code|backup[-_\s]?code|access[-_\s]?token|refresh[-_\s]?token|client[-_\s]?secret|private[-_\s]?key|seed[-_\s]?phrase|passphrase|pin[-_\s]?code`

### Mode Secret Strict

Lorsqu'il est activé (Paramètres → "Gestion stricte des secrets"), l'agent :

- **Ne cite jamais les identifiants** dans les résumés, le texte de l'assistant, ou les arguments d'appel d'outil — même lorsque l'utilisateur le demande explicitement
- La description de l'outil `done` est remplacée par `DONE_TOOL_STRICT`, qui ajoute une interdiction ferme
- Après avoir rempli un champ sensible, `CREDENTIAL_NOTE_STRICT` est injecté dans le résultat de l'outil

Lorsqu'il est désactivé (par défaut — c'est un outil pour ordinateur personnel, pas un déploiement tiers) :

- Le modèle reçoit des conseils d'hygiène souples ("préférez une formulation générique sauf si l'utilisateur demande la valeur")
- L'utilisateur peut demander à voir les identifiants et le modèle les affichera
- La description de l'outil `done` encourage toujours les résumés soignés

### Auto-Remplissage de Profil

Les utilisateurs peuvent stocker un court profil (nom, email, mot de passe jetable) dans Paramètres → Profil. Ce texte est ajouté au prompt système lorsqu'il est activé. Avertissements dans l'interface :

- Stocké en texte clair dans `chrome.storage.local`
- Envoyé au fournisseur LLM à chaque tour dans le cadre du prompt système
- N'y mettez pas de mots de passe pour des comptes importants

---

## Défenses contre l'Injection de Prompt

La menace principale : une page malveillante conçoit un contenu qui, lorsqu'il est lu par l'agent et transmis au LLM, amène le modèle à exécuter des actions non intentionnelles.

### Couches de Défense

| Couche | Mécanisme |
|---|---|
| **Encapsulation du contenu non fiable** | Les résultats d'outils provenant de la page sont encapsulés dans des marqueurs `<untrusted_page_content>` (`_wrapUntrusted` + `UNTRUSTED_CONTENT_TOOLS`) afin que le modèle les traite comme des données, pas des instructions. Voir [prompt-injection-defense.md](prompt-injection-defense.md). |
| **Passerelle capacité × origine** | Avant qu'un outil conséquent ne s'exécute (clic/saisie/navigation/execute_js/réseau/téléchargement/…), l'agent nécessite une autorisation `(capacité, hôte)` — Autoriser une fois / Toujours / Refuser. Indépendant de la langue, déterministe, humain dans la boucle (`permission-gate.js`). |
| **Limite de résultat d'outil** | Les résultats d'outils individuels sont tronqués à 8 000 caractères (`_limitToolResult`). Le texte injecté au-delà est silencieusement ignoré. |
| **Mode Ask/Act/Dev** | Le mode Ask expose uniquement des outils sémantiques en lecture seule. L'utilisateur doit explicitement passer en mode action pour les clics/saisies/navigations. Act expose les outils normaux du niveau du fournisseur sélectionné. Dev nécessite le niveau Mid/Full et ajoute des outils source/style/inspection de page pour le débogage développeur. |
| **Exposition d'outils par niveau** | Les niveaux de fournisseur (`compact | mid | full`) limitent la surface d'agent navigateur normale pour les modèles plus petits. Compact obtient la surface d'action la plus petite ; Mid ajoute des outils de tâches courantes ; Full ajoute des solutions de repli UI/DOM avancées. Dev en Compact est bloqué. |
| **Plan avant Act** | Lorsqu'il est activé, les exécutions en mode action produisent d'abord un plan structuré et attendent l'approbation du panneau latéral avant que tout outil navigateur ne s'exécute. Les exécutions planifiées peuvent auto-approuver le plan uniquement via la politique du planificateur. |
| **Limite d'import de compétence** | Les compétences peuvent exposer des outils HTTP en lecture seule et des outils de téléchargement via un manifeste `webbrain-tools`. Importer ou garder la compétence activée est la décision de confiance pour le point de terminaison HTTPS déclaré ; les outils de compétence déclarés utilisent `credentials: "omit"` et doivent marquer les résultats tiers `resultPolicy: "untrusted"`. Les outils de compétence de téléchargement nécessitent toujours un mode action et la passerelle de permission Téléchargements normale avant d'enregistrer des fichiers. |
| **`/allow-api`** | Un indicateur `/allow-api` par conversation qui *supprime* la demande de permission pour les sorties réseau avec méthode d'écriture (`fetch_url`/`research_url` avec POST/PUT/PATCH/DELETE). Il ne supprime PAS la sortie GET ni aucune autre capacité. S'efface à la réinitialisation de la conversation. |
| **Blocage `done()`** | Avant d'accepter la complétion, l'agent vérifie la présence de dialogues/formulaires ouverts. Si le résumé prétend "créé"/"sauvegardé" mais qu'une modale est encore ouverte, l'agent est forcé de continuer. |
| **Garde anti-soumission en double** | Les clics sur du texte de type soumission (créer/sauvegarder/soumettre/ajouter/poster/publier/envoyer/confirmer/s'inscrire/se connecter/payer/commander/checkout, etc.) sont bloqués pendant une fenêtre de 45 secondes par onglet+URL (Chrome). |
| **Test d'occlusion CLICK** | Avant de cliquer, le résolveur appelle `elementFromPoint()`. Si un autre élément est visuellement au-dessus, le clic est refusé. |
| **Clic limité à la modale** | Lorsqu'un dialogue est ouvert, les clics textuels sont limités à ce sous-arbre afin que l'agent ne clique pas sur un élément d'arrière-plan assombri. |
| **Préambule universel** | Chaque prompt système inclut des conseils sur les bannières de cookies et les paywalls — deux vecteurs d'injection courants qui ressemblent à du contenu de page bénin. |
| **Détection de boucle** | Trois détecteurs indépendants arrêtent l'agent s'il répète la même action ou oscille. Les boucles de clics répétés peuvent inclure un indice URL+méthode XHR/fetch exact sur le même onglet afin que l'agent puisse utiliser `fetch_url` au lieu de cliquer indéfiniment. Limite les dommages d'un prompt injecté persistant. |
| **Adaptateurs financiers** | Les adaptateurs avec `category: 'finance'` injectent des conseils de confirmation supplémentaires et une bannière d'avertissement. |
| **Gestion stricte des secrets** | Empêche l'exfiltration d'identifiants même si le modèle est jailbreaké pour citer des secrets. |
| **Blocage réseau local** | Lorsqu'il est désactivé (par défaut), `fetch_url` ne peut pas atteindre les adresses privées/RFC1918. Les points de terminaison de métadonnées cloud (169.254.169.254) sont toujours bloqués. |

### Ce qui n'est PAS défendu

- **Le fournisseur LLM lui-même** : si le fournisseur est compromis ou malveillant, il voit tout le contenu de la conversation, y compris les identifiants que l'utilisateur tape.
- **L'empreinte unique de l'extension** : les sites web pourraient détecter le script de contenu (bordure pulsante, `window.__wbElementMap`, gestionnaires d'événements personnalisés).
- **Attaques par canal temporel** : la latence des appels d'outils de l'agent pourrait être observable depuis le JS de la page.

---

## Indicateur `/allow-api`

Défini par conversation via la commande `/allow-api` dans le panneau latéral. Lorsqu'il est actif, il supprime la demande de permission pour **les sorties réseau avec méthode d'écriture uniquement** :

- `fetch_url` / `research_url` avec `method: POST/PUT/PATCH/DELETE`

Il ne supprime PAS la sortie GET, `execute_js`, ni aucune autre capacité — celles-ci
passent toujours par la passerelle capacité × origine. (`isNetworkMutation` dans
`permission-gate.js` est ce sur quoi `/allow-api` se base ; `execute_js` est sa propre
`Capability.EXECUTE_JS` et est toujours soumis à la passerelle.)

Le prompt système ajoute un préambule indiquant au modèle de :
- Indiquer l'URL, la méthode et la charge utile en texte clair avant tout appel API destructeur
- Privilégier l'interface utilisateur en premier ; n'utiliser l'API que lorsque l'interface a réellement échoué

Les indices de raccourcis API de détection de boucle ne contournent pas cette politique. Ils peuvent exposer
la méthode et l'URL exactes que la page appelait déjà, y compris POST/PATCH/etc.,
mais les appels `fetch_url` / `research_url` avec méthode d'écriture nécessitent toujours
l'état `/allow-api` de la conversation. Les requêtes GET et les capacités non réseau
passent toujours par la passerelle normale capacité × origine.

Effacé à la réinitialisation de la conversation.

---

## Isolation des Données de Trace

L'enregistreur de trace (`trace/recorder.js`) écrit dans IndexedDB sur la machine de l'utilisateur lorsqu'il est explicitement activé (Paramètres → Affichage → "Enregistrer les traces"). Les données ne quittent jamais le navigateur :

- Stockage `runs` : modèle, fournisseur, totaux de tokens, horodatages
- Stockage `events` : requêtes/réponses LLM, appels d'outils, métadonnées de capture d'écran
- Stockage `shots` : blobs de capture d'écran

La page des traces (`ui/traces.html`) lit uniquement depuis l'IndexedDB locale. L'export produit un blob JSON identique à ce que l'utilisateur voit à l'écran — pas de télémétrie, pas d'appels réseau.

---

## Différences Firefox

Firefox n'a pas de CDP (permission `debugger`), donc :

- Pas d'événements fiables (seulement `el.click()` synthétique)
- Pas de captures d'écran pleine page
- Pas de traversée du shadow DOM pour les racines fermées
- `execute_js` est un module complémentaire Dev dans les deux versions : Firefox utilise son évaluateur de script de contenu MV2 et Chrome utilise CDP `Runtime.evaluate` ; aucune version ne l'expose dans Ask ou Act normal
- Les correctifs CSS/élément réversibles de Chrome sont réservés au mode Dev et soumis à une autorisation par hôte. Les diagnostics console et réseau sont des lectures Dev. L'inspection des écouteurs ajoute puis restaure brièvement un attribut de ciblage interne, tandis que la mise en surbrillance insère une superposition temporaire ; les deux utilisent donc l'autorisation de modification temporaire de la page. Tous les résultats de diagnostic dérivés de la page sont traités comme contenu non fiable. Les en-têtes et corps réseau sont exclus par défaut, et les en-têtes sensibles sont toujours masqués avant la mise en mémoire tampon
- Pas de document hors écran (les CORS doivent être gérées par les serveurs LLM)
- Pas d'enregistrement d'onglet/écran par commande (les API de capture de Chrome et `recorder/` sont absentes)
- Pas de garde anti-soumission en double (la Map d'horodatages est déclarée mais non câblée)

Tout le reste — la passerelle de permission, l'encapsulation du contenu non fiable, la détection
d'identifiants, la détection de boucle, le système d'adaptateurs, et **l'enregistreur de trace** (il est livré
à l'identique dans `src/firefox/src/trace/recorder.js`) — est identique.

---

## Signaler des Problèmes

Voir [SECURITY.md](../SECURITY.md) pour le contact de divulgation et la politique.
