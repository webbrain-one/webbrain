# Confidentialité et flux de données

---

## Ce qui quitte le navigateur

### Requêtes au fournisseur LLM

Le message de l'utilisateur, le contenu de la page courante (arbre AX, capture
d'écran ou texte extrait) et l'historique des appels d'outils sont envoyés au
**fournisseur LLM configuré** à chaque tour.

| Donnée | Envoyée au fournisseur ? | Notes |
|---|---|---|
| Message de chat de l'utilisateur | Oui | C'est la fonctionnalité principale — l'utilisateur l'a tapé |
| URL + titre de la page | Oui | Injecté dans le premier message utilisateur pour le contexte |
| Contenu de la page (arbre AX / texte extrait) | Oui | L'agent lit la page pour agir dessus |
| Capture d'écran du viewport | Oui | Si le fournisseur supporte la vision (ou un modèle de vision dédié est configuré) |
| Historique des appels d'outils | Oui | Les résultats d'outils précédents sont le contexte pour le prochain appel LLM |
| Identifiants utilisateur (mots de passe, clés API) | Oui | Si l'utilisateur les tape dans le chat ou si l'agent les remplit et qu'ils apparaissent dans les résultats d'outils |
| Clé API du fournisseur | Oui | Envoyée comme en-tête HTTP (jeton Bearer) au point de terminaison de l'API du fournisseur |

Lorsque **Planifier avant d'agir** est activé, les tours en mode action (Agir ou
Dev) effectuent un appel supplémentaire au planificateur vers le même fournisseur
configuré avant que les outils navigateur ne s'exécutent. Cet appel contient la
tâche de l'utilisateur, l'URL/titre de page nettoyés, un court résumé de la
conversation récente et l'invite système du planificateur. Les blocs d'images
sont supprimés avant l'appel au planificateur ; toute description textuelle de
capture d'écran est traitée comme un contexte non fiable.

**Aucune autre donnée n'est envoyée au fournisseur.** L'extension n'injecte pas
de suivi, de télémétrie ou d'analytique.

### Quel fournisseur reçoit les données ?

L'utilisateur choisit son fournisseur dans les Paramètres. Les options incluent :

- **WebBrain Cloud** : les requêtes passent par `api.webbrain.one` ; Aider à
  améliorer WebBrain est activé par défaut et, tant qu'il reste activé,
  certaines interactions peuvent être conservées et utilisées pour
  l'évaluation, l'amélioration, l'affinage et l'entraînement
- **Fournisseurs cloud configurés par l'utilisateur** : OpenAI, Anthropic,
  Google Gemini, Mistral, DeepSeek, xAI, Groq, OpenRouter, etc. — les requêtes
  sont envoyées directement au fournisseur avec les identifiants de l'utilisateur
  et ne sont jamais collectées par WebBrain
- **Fournisseurs locaux** : llama.cpp, Ollama, LM Studio, Jan, vLLM, SGLang,
  LocalAI —
  les données restent sur la machine de l'utilisateur

Les requêtes vers un modèle local ou une API configurée par l'utilisateur ne
sont jamais collectées par WebBrain. Les requêtes WebBrain Cloud sont traitées
et peuvent être conservées conformément à la section détaillée de la
[documentation anglaise](../privacy-and-data-flow.md#webbrain-cloud-improvement-data).

---

## Ce qui reste dans le navigateur

### Historique des conversations

Stocké dans le stockage de session du navigateur :
`chrome.storage.session` sur Chrome et `browser.storage.session` sur Firefox.
L'historique fournisseur par onglet (`agentConv:<tabId>`), le chat rendu
(`tabChat:<tabId>`) et le journal d'interface de l'exécution détachée
(`runUi:<tabId>`) permettent de restaurer une conversation et une exécution en
cours après la fermeture/recharge du panneau ou un redémarrage de l'arrière-plan.
Le journal conserve une fenêtre bornée d'événements et un texte streamé
accumulé, limité séparément, afin de reconstruire le Markdown en cours après
reconnexion. Le contenu pertinent de la conversation est envoyé au fournisseur
configuré comme contexte de requête ; les copies stockées ne sont pas
synchronisées séparément avec WebBrain.

### Enregistreur de traces

Lorsqu'il est activé (Paramètres → Affichage → « Enregistrer les traces »),
chaque exécution de l'agent est écrite dans une base de données IndexedDB
(`webbrain_traces`) :

- **Stockage `runs`** : modèle, fournisseur, totaux de jetons, horodatages,
  message utilisateur, contenu final
- **Stockage `events`** : requêtes/réponses LLM par étape, appels d'outils avec
  arguments et résultats
- **Stockage `shots`** : blobs de captures d'écran

La page Traces (`ui/traces.html`) lit uniquement l'IndexedDB locale. L'export
produit un blob JSON sauvegardé dans le dossier Téléchargements de l'utilisateur.
**Aucune donnée de trace ne quitte jamais le navigateur.**

### Paramètres

Les configurations des fournisseurs (clés API, URLs de base, sélections de
modèles) sont stockées dans `chrome.storage.local`. Les clés API sont en
texte clair — c'est un outil pour ordinateur personnel et le stockage est
isolé par le navigateur. L'extension n'a aucun mécanisme pour exfiltrer ces
clés.

### Profil utilisateur

Si l'utilisateur active le remplissage automatique de profil, le texte du profil
(nom, email, mot de passe jetable) est stocké dans `chrome.storage.local` en
texte clair et envoyé au fournisseur LLM dans le cadre de l'invite système à
chaque tour.

### Observateur de raccourcis API

Le script d'arrière-plan maintient un petit tampon mémoire des métadonnées
XHR/fetch du même onglet : URL, méthode HTTP et horodatage pour les 40
dernières requêtes observées par onglet. Il est utilisé uniquement lorsque la
détection de boucle voit des clics répétés, afin que l'agent puisse suggérer
l'appel `fetch_url` exact correspondant au lieu de cliquer à nouveau. Les corps
de requête et de réponse ne sont pas capturés. Le tampon est supprimé lorsque
l'onglet se ferme, et aucune donnée d'observateur ne quitte le navigateur sauf
si un avertissement de boucle expose l'URL + la méthode à la conversation LLM
active.

---

## Télémétrie / Analytique

**Aucune.** L'extension n'inclut aucun SDK d'analytique, télémétrie,
signalement de plantage ou suivi d'utilisation. Il n'y a pas de point de
terminaison « téléphone à la maison ».

Les seules requêtes HTTP sortantes sont :

1. **Appels API au fournisseur LLM** (vers les URLs configurées par l'utilisateur)
2. **Appels API CapSolver** (si l'utilisateur active la résolution de CAPTCHA)
3. **Requêtes de contenu** via les outils `fetch_url` / `research_url` (vers les
   URLs que l'agent est invité à récupérer)
4. **Appels d'outils de compétences** (vers le(s) point(s) de terminaison HTTPS
   déclaré(s) par les compétences activées — voir « Compétences intégrées »
   ci-dessous pour celle activée par défaut)
5. **L'enregistrement d'onglet/écran via slash** ne crée pas de trafic sortant
   (le fichier .webm est sauvegardé dans le dossier Téléchargements via
   `chrome.downloads.download`)

L'observateur de raccourcis API `webRequest` (optionnel) est désactivé par
défaut et ne crée pas de requêtes sortantes ; lorsqu'il est activé, il observe
les métadonnées de rejeu pour les requêtes que la page a déjà faites afin de
diagnostiquer les mutations répétées de l'interface.

### Compétences intégrées

Une compétence intégrée « FreeSkillz.xyz »
(`skills/freeskillz-xyz.md`) est préinstallée dans Paramètres → Compétences
lors du premier démarrage, activée par défaut, et peut être supprimée à cet
endroit. Elle déclare les outils `read_youtube_transcript`,
`resolve_public_media` et `download_public_media`. Lorsque le modèle appelle
l'un de ces outils, WebBrain envoie uniquement l'URL actuelle ou fournie par le
modèle, ainsi que les options déclarées telles que la langue de transcription,
le type de média, la hauteur maximale ou une indication de nom de fichier, au
point de terminaison HTTPS déclaré `https://freeskillz.xyz` — un service
first-party exploité par le développeur de l'extension, distinct du fournisseur
LLM configuré par l'utilisateur. L'outil de transcription est limité aux URLs
YouTube/youtu.be, tandis que les outils média sont limités aux hôtes de médias
publics déclarés dans le manifeste de la compétence. Les outils de transcription
et de résolution en lecture seule ne nécessitent pas `/allow-api` ;
`download_public_media` est disponible uniquement en modes action et nécessite
une permission de téléchargement car il crée une tâche fournisseur de courte
durée, sauvegarde le fichier terminé via l'API Downloads du navigateur, puis
demande au fournisseur de supprimer la tâche. Ces appels n'envoient pas le
contenu de la page, l'historique de chat ou l'historique de navigation au-delà
de l'URL et des arguments d'outil déclarés. Les utilisateurs peuvent supprimer
cette compétence, ou tout outil de compétence importé par l'utilisateur, depuis
Paramètres → Compétences pour arrêter complètement ce flux de données.

---

## Diagrammes de flux de données

### Tour de chat de base

```
L'utilisateur tape un message
  │
  ▼
Panneau latéral → Arrière-plan (chrome.runtime.sendMessage)
  │
  ▼
L'agent enrichit : URL + titre + notes d'adaptateur + (optionnel) capture d'écran
  │
  ▼
Appel optionnel Planifier avant d'agir : provider.chat(messages planificateur, sans outils)
  │
  ▼
L'agent appelle provider.chat(messages, outils)
  ├─ Clé API fournisseur → en-tête HTTP vers le point de terminaison du fournisseur
  ├─ Messages + contenu de la page → corps HTTP vers le point de terminaison du fournisseur
  │
  ▼
Le fournisseur répond → l'agent exécute les appels d'outils → résultats ajoutés
  │
  ▼
Boucle jusqu'à la fin → l'arrière-plan envoie la réponse finale → le panneau latéral l'affiche
```

### Flux d'enregistrement de traces (lorsqu'il est activé)

```
Tour de l'agent
  │
  ├─ startRun()     → IndexedDB.runs   { runId, model, userMessage, ... }
  ├─ recordLLMRequest()  → IndexedDB.events  { runId, seq, kind:'llm_request', ... }
  ├─ recordLLMResponse() → IndexedDB.events  { runId, seq, kind:'llm_response', ... }
  ├─ recordToolCall()    → IndexedDB.events  { runId, seq, kind:'tool', ... }
  ├─ recordScreenshot()  → IndexedDB.shots   { runId, seq, blob } + marqueur events
  └─ endRun()       → IndexedDB.runs   (met à jour la durée, les jetons, le statut)
```

Toutes les lectures IndexedDB se produisent uniquement lorsque l'utilisateur
ouvre la page Traces.

### Flux de capture d'écran

```
Capture CDP → URL de données JPEG/PNG
  │
  ├─ Si un modèle de vision dédié est configuré → sous-appel pour décrire → description textuelle
  │   → seule la description textuelle est envoyée au fournisseur principal
  │
  ├─ Si le fournisseur principal supporte la vision → bloc image_url attaché au message utilisateur
  │   → l'image est visible par le LLM
  │
  └─ Si pas de vision → la capture d'écran est tout de même prise pour l'état interne, mais les données image ne sont pas envoyées au modèle
```

---

## Limites de sécurité

| Limite | Données la traversant | Protégée par |
|---|---|---|
| Navigateur ↔ Fournisseur LLM | Messages de chat, contenu de page, capture d'écran | HTTPS ; l'utilisateur a choisi le fournisseur |
| Navigateur ↔ CapSolver | Requêtes de jeton CAPTCHA | HTTPS ; l'utilisateur a donné son consentement |
| Extension ↔ Document hors écran | Requêtes proxy de récupération | Même extension, même origine |
| Service worker ↔ IndexedDB | Données de trace | Bac à sable du navigateur ; jamais transmises |
| Service worker ↔ `chrome.storage.local` | Clés API, paramètres | Bac à sable du navigateur (texte clair) |

---

## Contrôles utilisateur

| Paramètre | Effet |
|---|---|
| Sélection du fournisseur | Choisir quel LLM reçoit les données, ou exécuter localement |
| Niveau d'invite/outils du fournisseur | Choisir l'exposition d'outils Compacte, Moyenne ou Complète pour les fournisseurs non cloud |
| Mode Demander / Agir / Dev | Choisir le mode lecture seule, action normale ou développement/inspection de page |
| Bouton d'enregistrement des traces | Empêche tout stockage de données de trace |
| Repli de capture d'écran | Contrôle si les images de page sont envoyées au LLM |
| Mode de capture d'écran automatique | Contrôle la fréquence d'envoi des captures du viewport |
| Gestion stricte des secrets | Empêche l'apparition des identifiants dans les résumés |
| Remplissage automatique du profil | Contrôle si le texte du profil utilisateur est envoyé au LLM |
| Bouton des adaptateurs de sites | Contrôle si des conseils spécifiques au site sont ajoutés |
| `/allow-api` | Contrôle si l'agent peut utiliser des mutations d'API |
| Bouton CapSolver | Contrôle si les données CAPTCHA sont envoyées à un solveur tiers |

---

## Différences Firefox

Firefox n'a pas de document hors écran. L'enregistreur de traces et
`unlimitedStorage` sont présents et identiques à Chrome
(`src/firefox/src/trace/recorder.js`). Tous les modèles de flux de données sont
par ailleurs les mêmes, sauf :

- Pas de sous-appel de vision dédié (les captures d'écran vont directement au
  fournisseur principal si la vision est supportée)
- Pas d'enregistrement d'onglet/écran via slash
- La conversation, le chat rendu et le journal d'interface des exécutions
  détachées utilisent `browser.storage.session`, comme la persistance de
  session de Chrome.
