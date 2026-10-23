# Défense contre l'injection de prompt — comment ça fonctionne et comment ne pas la casser

L'agent de DIV agit **à l'intérieur de la session navigateur authentifiée de l'utilisateur** : il
peut cliquer, taper, naviguer, exécuter du JS et soumettre des formulaires *en tant qu'utilisateur connecté*. Ainsi,
tout texte qu'il lit sur une page web est **contrôlable par un attaquant** — un
tweet malveillant, un document partagé, un courriel, un commentaire d'issue, un PDF. Le but
des défenses ci-dessous est : **le contenu de la page est une DONNÉE, jamais des instructions, et les actions
conséquentes nécessitent un humain dans la boucle.**

Si vous ajoutez un outil, une nouvelle façon de lire la page, ou un nouvel endroit qui alimente
le modèle avec des octets provenant de la page, lisez ceci d'abord. Les tests unitaires peuvent imposer
*l'appartenance* aux registres, mais **pas** si vous avez correctement classifié une chose
— cela dépend de vous et du relecteur.

Le code vit dans **les deux versions** (`src/firefox/...` et `src/chrome/...`). Gardez-les
synchronisées — la suite de tests affirme que les modules purs sont octet-identiques.

---

## Les quatre couches

1. **Encapsulation du contenu non fiable (Couche 1).** Les résultats d'outils qui transportent des octets
   provenant de la page sont encapsulés dans des marqueurs `<untrusted_page_content id="<nonce>">…</…>`,
   tout marqueur littéral dans le contenu étant supprimé (défense contre les évasions).
   - Code : `agent.js` → `_wrapUntrusted(name, content)` ; l'ensemble
     `UNTRUSTED_CONTENT_TOOLS` dans `permission-gate.js`.
2. **Contrat de prompt système (Couche 2).** Les prompts indiquent au modèle que
   tout ce qui se trouve dans ces marqueurs est une donnée, jamais des instructions, et que seuls
   le prompt système et les propres messages de chat/`clarify` de l'utilisateur sont autoritaires.
   - Code : `tools.js` -> `SYSTEM_PROMPT_ASK`, `SYSTEM_PROMPT_ACT`,
     `SYSTEM_PROMPT_ACT_MID`, `SYSTEM_PROMPT_ACT_COMPACT`, et
     `SYSTEM_PROMPT_DEV_APPENDIX`, plus `planner.js` -> `PLANNER_SYSTEM_PROMPT`
     pour l'appel Plan-avant-Act avant la boucle.
3. **Passerelle de permission capacité × origine (Couche 3).** Avant qu'un outil
   conséquent ne s'exécute, l'agent vérifie une autorisation `(capacité, hôte)` et invite l'utilisateur
   (Autoriser une fois / Toujours / Refuser) s'il n'y en a pas. Aucune inspection de texte, aucun LLM —
   l'humain est l'ancre de confiance.
   - Code : `permission-gate.js` (`capabilityFor`, `requiredHosts`,
     `PermissionManager`) ; la boucle de passerelle dans `agent.js _executeToolBatch`.
   - Contrôle utilisateur : Paramètres → Permissions (réviser/révoquer les autorisations + l'interrupteur
     principal "Demander avant les actions conséquentes").
4. **Assainisseur de sortie (Couche 4).** La sortie du modèle est échappée HTML et seul
   le markdown `[label](url)` devient un lien autorisé (http/https/mailto) — pas
   d'images à chargement automatique, pas de lienification d'URL nues.
   - Code : `ui/markdown-link.js`.

---

## Ce qui est considéré comme "provenant de la page" (c'est-à-dire NON FIABLE)

Considérez **tous** les éléments suivants comme contrôlables par un attaquant :

- Texte DOM et HTML — y compris le texte **caché / hors écran**, les étiquettes ARIA, les attributs `alt`,
  `title`, les commentaires HTML, et le texte stylisé invisible.
- **Transcriptions OCR / modèle de vision** d'une capture d'écran (`desc.text`).
- **Documents récupérés / téléchargés** — texte extrait de PDF, contenu de fichiers
  téléchargés, corps de `fetch_url`/`research_url`.
- **URLs et hôtes que la page contrôle** — `href`/`src`, l'URL d'une iframe, une
  cible de redirection. (Ces éléments guident les décisions de *permission*, voir Couche 3.)
- **Résultats d'outils qui intègrent des champs de vérification/provenant de la page** — par exemple, le
  résultat `done` inclut `pageTitle` / `pageState` (titres de dialogue, texte de
  région active). Non évidents, faciles à manquer — `done` a été mal classifié une fois exactement pour
  cette raison.

Le texte écrit par le modèle (la chaîne de statut propre d'un outil, le `summary` de l'agent) et les
messages de **l'utilisateur** sont fiables. Les réponses `clarify` sont également fiables lorsque
l'outil est disponible dans les modes d'action ; le mode Ask gère la clarification comme une
conversation ordinaire et n'expose pas d'outil `clarify`.

---

## Règles pour les contributeurs

### Ajouter un outil qui LIT le contenu de la page
Ajoutez son nom à `UNTRUSTED_CONTENT_TOOLS` dans `permission-gate.js` (les deux versions).
Le test d'exhaustivité échouera jusqu'à ce que chaque outil du mode act soit classifié.

Pour un outil de compétence dynamique, n'ajoutez pas le nom à l'ensemble statique. Déclarez
`"resultPolicy": "untrusted"` dans le manifeste `webbrain-tools` de la compétence à la place ;
`agent.js` consulte le registre des compétences activées à l'exécution et applique le même
comportement d'encapsulation/digest.

### Ajouter un outil qui a un EFFET SECONDAIRE (clic/saisie/navigation/téléchargement/etc.)
Mappez-le dans `permission-gate.js` :
- ajoutez-le à `TOOL_CAPABILITY` (ou gérez-le dans `capabilityFor` si la capacité
  dépend des arguments — voir `set_field`/`press_keys`/`fetch_url`) ;
- assurez-vous que `hostForCapability` / `requiredHosts` résout le **véritable hôte cible**
  (URL de destination pour naviguer/réseau/téléchargement ; page courante pour
  clic/saisie ; l'hôte de la **trame** pour les outils d'iframe ; **chaque** hôte pour un
  outil multi-URL comme `download_files`) ;
- si l'hôte ne peut pas être déterminé, retournez `''` / `[]` pour que la passerelle **échoue
  en sécurité** (voir le cas iframe-sans-`urlFilter`).

### Ajouter un endroit qui RÉINJECTE des octets provenant de la page dans un message
Certains textes provenant de la page atteignent le modèle **en dehors** du chemin normal des résultats d'outils
— ils sont interpolés dans un message `role:'user'` ou `role:'tool'` que l'agent
construit lui-même. Ceux-ci doivent être encapsulés **explicitement** :

```js
const wrapped = this._wrapUntrusted('screenshot', desc.text); // nonce + strip
messages.push({ role: 'user', content: `[…]\n${wrapped}` });
```

> ⚠️ **Une mention "ceci n'est pas fiable" en prose n'est PAS la limite.** La limite est
> les marqueurs `<untrusted_page_content>` délimités par nonce que `_wrapUntrusted`
> produit (et la suppression d'évasion qu'il effectue). Acheminez toujours le texte provenant de la page
> via `_wrapUntrusted`, pas seulement un préfixe `[avertissement]`.

Points d'ingestion connus non-outils (maintenez cette liste à jour) :
- réinjection automatique de capture d'écran (description de vision + liste d'éléments interactifs) ;
- la "Description initiale du viewport" dans `_enrichUserMessageWithCurrentPage` ;
- messages du planificateur Plan avant Act : l'URL/titre de page assaini et le digest
  de l'historique récent sont envoyés sous le cadre de page non fiable du planificateur ; les blocs d'image
  non textuels sont supprimés avant l'appel au planificateur ;
- transmission PDF : le bloc `document` PDF brut ne peut pas être encapsulé textuellement, donc sa
  note d'accompagnement porte un cadre non fiable explicite **et** le
  `docTitle` contrôlé par l'attaquant est assaini avant interpolation ;
- l'insertion du résultat d'outil `done` (cas spécial avant l'encapsulation normale).

### N'affaiblissez pas la limite pour les "sites de confiance"
L'interrupteur principal (Paramètres → Permissions) désactive **uniquement la Couche 3** (les
prompts). Les couches 1, 2 et 4 restent toujours actives — elles ne coûtent rien et sont ce qui
protège l'utilisateur sur les sites de confiance où le contenu injecté vit réellement
(un domaine réputé est *anti-corrélé* avec un contenu sûr). Ne bloquez jamais les couches
1/2/4 derrière un paramètre.

---

## Tests

- `node test/run.js` — tests unitaires de logique pure, incluant :
  - la **garde d'exhaustivité** : chaque outil d'action exposé au modèle depuis
    `getToolsForMode('act')` et `getToolsForMode('dev')` doit être soumis à une passerelle
    (`capabilityFor`), une lecture non fiable (`UNTRUSTED_CONTENT_TOOLS`), ou sur la
    liste blanche `KNOWN_SAFE_TOOLS` (définie dans `test/run.js`) — sinon la CI échoue.
  - le mappage de capacités, la résolution d'hôtes, `requiredHosts`, `frameHostMatches`,
    le stockage d'autorisations / `hydrateFrom`, la suppression d'évasion d'encapsulation de contenu.
  - la vérification de parité / de limites des prompts du planificateur dans `test/security/injection-corpus.mjs`.
- `test/manual-permissions.md` — la checklist dans le navigateur (la carte de permission
  à 3 options et l'onglet Paramètres → Permissions) que la suite unitaire ne peut pas
  couvrir.

**La garde vérifie que les outils sont *listés*, pas qu'ils sont listés
*correctement*.** Si le résultat d'un outil transporte des octets provenant de la page, il appartient à
`UNTRUSTED_CONTENT_TOOLS` même s'il s'agit d'un "simple outil de statut" (voir `done`). En cas de
doute, encapsulez-le — encapsuler un champ fiable est inoffensif ; laisser un champ
provenant de la page non encapsulé est une brèche.

---

## Limitations connues (acceptées)

Ce sont des compromis conscients, pas des oublis.

- **L'interaction générique est imputée à l'hôte de la page de premier niveau, pas à la trame
  dans laquelle elle atterrit.** `click({x,y})` (clics coordonnés CDP), `type_text`, et
  `press_keys` vont vers n'importe quel pixel/élément ciblé ou focalisé — ce qui
  *peut* être à l'intérieur d'une iframe cross-origine (par exemple, une trame Stripe/PayPal intégrée).
  La passerelle impute cela à l'hôte de la page, donc une autorisation pour `merchant.com` couvre
  également un clic coordonné qui atterrit dans une trame `stripe.com` intégrée.
  - Pourquoi accepté : (1) les clics par sélecteur/texte **ne peuvent pas** atteindre les trames cross-origine
    (la politique de même origine empêche `querySelector` de les traverser), donc cela se
    limite aux clics coordonnés (Chrome/CDP uniquement — Firefox clique sur l'élément `<iframe>`,
    pas à l'intérieur) et à la saisie basée sur le focus ; (2) pour les flux intégrés
    légitimes, l'utilisateur autorise la page marchande *en s'attendant* à ce que le paiement —
    y compris son iframe de paiement — fonctionne, donc demander l'hôte du fournisseur
    en milieu de flux est discutablement une moins bonne UX que le risque résiduel. Les outils
    **explicites** `iframe_click` / `iframe_type` SONT soumis à la passerelle sur l'hôte de la trame
    (`frameHostMatches`), car là le modèle nomme délibérément une trame.
  - Si vous voulez le fermer : résolvez la trame cible pour les clics coordonnés
    (hit-test CDP) et la trame focalisée pour les frappes, puis soumettez à la passerelle sur cet
    hôte de trame ou échouez en sécurité quand c'est cross-origine. Non trivial et
    spécifique à Chrome/CDP ; nécessite des tests dans un vrai navigateur.

- **`solve_captcha` n'est pas soumis à la passerelle** (sur la liste blanche `KNOWN_SAFE_TOOLS`). Il
  consomme du quota CapSolver et injecte un jeton (déclenchant le
  `data-callback` du widget, ce qui sur certains sites soumet automatiquement). Accepté car le coût
  est limité, la soumission conséquente est autrement soumise à la passerelle, et y ajouter une
  invite pour un précurseur que l'utilisateur veut lorsqu'il est bloqué par un CAPTCHA. À réviser si
  l'abus de quota devient une réelle préoccupation.

- **`hover` n'est pas soumis à la passerelle** — le survol révèle des menus/astuces et n'engage rien.
  Il est uniquement en mode Act complet ; le mode Dev intermédiaire ne l'ajoute pas.

- **Un LLM n'est *pas* utilisé dans la passerelle.** L'intention n'est jamais déduite du
  texte de la page ou du prompt (cette approche a été essayée et supprimée — elle était anglais seulement
  et fuyante). La passerelle est déterministe capacité×origine avec l'humain comme
  ancre de confiance.
