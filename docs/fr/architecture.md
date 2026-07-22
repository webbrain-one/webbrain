# Architecture de WebBrain

> Version 18.0.0

## Aperçu

WebBrain est une extension de navigateur qui donne à un LLM le contrôle de l'onglet actif du navigateur de l'utilisateur. L'utilisateur tape une instruction en langage naturel dans un panneau latéral, et une boucle d'agent autonome appelle le LLM, exécute des appels d'outils (clic, saisie, navigation, lecture d'état de page, etc.), renvoie les résultats au LLM, et répète jusqu'à ce que la tâche soit terminée.

Il existe deux builds qui partagent presque tout le code :
- **Chrome** — Manifest V3, service worker, événements de confiance basés sur CDP
- **Firefox** — Manifest V2, page d'arrière-plan, événements synthétiques uniquement

Ce document couvre l'architecture partagée et signale où les builds divergent.

---

## Architecture en couches

```
┌─────────────────────────────────────────────────────┐
│                 Panneau latéral (UI)                  │
│  sidepanel.js  ·  settings.js  ·  traces.js          │
│  locale: i18n.js / locales/*.js                      │
└──────────────┬──────────────────────────────────────┘
               │ chrome.runtime.sendMessage({action, ...})
               ▼
┌─────────────────────────────────────────────────────┐
│        Script d'arrière-plan / Service Worker        │
│                                                      │
│  background.js        — routeur de messages          │
│    └─ agent.js        — boucle d'agent + executeTool()│
│         ├─ tools.js   — schémas d'outils + prompts   │
│         ├─ planner.js — Planificateur JSON Plan-before-Act│
│         ├─ adapters.js— conseils par site            │
│         ├─ permission-gate.js — octrois de capacités │
│         ├─ credential-fields.js — détection de secrets│
│         ├─ captcha-solver.js — intégration CapSolver │
│         ├─ loop-bucket.js — regroupement de boucles  │
│         └─ pdf-tools.js — extraction de texte PDF    │
│    ├─ providers/       — abstraction des fournisseurs│
│    ├─ network/         — fetch_url, téléchargements  │
│    ├─ trace/           — enregistreur IndexedDB opt. │
│    └─ recorder/        — orchestration d'enregistrement│
│                                                      │
│  Chrome uniquement :                                  │
│    ├─ cdp/             — Protocole DevTools Chrome   │
│    └─ offscreen/       — proxy fetch + enregistreur  │
└──────┬──────────────────────────────────────────────┘
       │ chrome.scripting.executeScript / CDP
       ▼
┌─────────────────────────────────────────────────────┐
│             Scripts de contenu (injectés)             │
│                                                      │
│  accessibility-tree.js  — constructeur arbre AX      │
│  content.js             — lecteur DOM, cliqueur,     │
│  agent-visual-indicator.js — bordure clignotante     │
└─────────────────────────────────────────────────────┘
```

### Panneau latéral (`src/ui/sidepanel.js`)

L'interface de chat. Communique avec le script d'arrière-plan via `chrome.runtime.sendMessage` (`browser.runtime.sendMessage` sur Firefox). Supporte trois modes de conversation :

- **Mode Ask** — outils sémantiques/lecture seule uniquement (`ASK_ONLY_TOOLS` dans `tools.js`). L'agent peut lire, analyser et résumer mais jamais cliquer, saisir ou naviguer. Ask exclut intentionnellement les outils de lecture développeur/débogage comme `read_page_source`, `inspect_element_styles`, et l'outil `clarify` ; la clarification ordinaire est juste une conversation normale.
- **Mode Act** — les outils d'agent navigateur normaux du niveau de fournisseur sélectionné. L'agent peut entreprendre des actions réelles dans le navigateur.
- **Mode Dev** — un mode d'action pour le débogage de page et l'inspection HTML/CSS. Dev nécessite un niveau de fournisseur Mid ou Full, utilise le niveau de prompt Act sélectionné, puis ajoute l'annexe de prompt Dev et expose les modules complémentaires Dev tels que les outils source/style. Les fournisseurs de niveau Compact ne peuvent pas entrer en mode Dev.

Le niveau de modèle est séparé du mode : `compact | mid | full` contrôle combien d'outils normaux le modèle voit, tandis que `ask | act | dev` contrôle le type de tâche que l'utilisateur autorise.

L'utilisateur tape un message, le panneau envoie `{action: 'chat', text, mode, tabId}` à l'arrière-plan, puis écoute les événements `agent_update` renvoyés en flux pendant l'exécution. Le panneau rend les appels d'outils, les résultats, les cartes de révision du plan, les invites de clarification et la réponse finale de manière incrémentale.

### Script d'arrière-plan (`src/chrome/src/background.js`)

Le routeur de messages central. Sur Chrome c'est un service worker (MV3) ; sur Firefox c'est une page d'arrière-plan persistante (MV2). Responsabilités :

1. **Router les messages** entre le panneau latéral, les scripts de contenu et l'agent
2. **Gérer le cycle de vie de l'agent** : `chat` / `chat_stream` / `continue` / `abort` / `clear_conversation`
3. **Gérer la configuration du fournisseur** : charger, sauvegarder, tester, changer de fournisseur actif
4. **Gérer la visibilité du panneau latéral** : le groupe d'onglets « WebBrain » par fenêtre contrôle où le panneau est activé
5. **Observer les requêtes XHR/fetch du même onglet** avec `webRequest` pour que la détection de boucle puisse suggérer un raccourci `fetch_url` exact lorsque des clics d'interface répétés déclenchent la même requête d'arrière-plan
6. **Exposer OAuth Claude**, l'enregistrement d'onglet, CAPTCHA et autres sous-fonctionnalités comme gestionnaires de messages

### Scripts de contenu (`src/chrome/src/content/`)

Injectés dans chaque page (`<all_urls>`). Deux fichiers chargés séquentiellement :

1. **`accessibility-tree.js`** — expose `window.__generateAccessibilityTree()` (parcours DOM qui produit l'arbre textuel indenté plat), `window.__wb_ax_lookup()` (résolveur ref_id → Element), et `window.__wbElementMap` (registre basé sur WeakRef). Livré avant `content.js` pour que les gestionnaires AX soient prêts.
2. **`content.js`** — lecteur DOM, découverte d'éléments interactifs, implémentations de clic/saisie/touches/défilement, et support iframe/frame. Gestionnaires pour tous les outils distribués par script de contenu.

---

## Flux complet d'un tour

```
L'utilisateur tape « créer un produit 'namaz' à 500 CNY, récurrent tous les 2 mois »
```

### Étape 1 : Panneau latéral → Arrière-plan
```
sidepanel.js → chrome.runtime.sendMessage({
  action: 'chat',
  text: 'create a product ...',
  mode: 'act',
  tabId: 42
})
```

### Étape 2 : Arrière-plan → Agent
```
background.js handleMessage('chat')
  → agent.processMessage(tabId, text, onUpdate, mode)
```

### Étape 3 : Enrichir le premier message utilisateur
```
_enrichUserMessageWithCurrentPage(tabId, messages, userMessage)

  1. Collecter l'URL + le titre via chrome.tabs.get(tabId)
  2. Si /allow-api défini pour cet onglet → injecter le préambule [USER OVERRIDE]
  3. Si les adaptateurs de site sont activés → getActiveAdapter(url) → injecter les notes d'adaptateur
  4. Si le fournisseur supporte la vision (ou un modèle de vision dédié configuré) :
     a. Capturer une capture d'écran de la fenêtre via CDP
     b. (Optionnel) Sous-appeler le modèle de vision dédié pour une description textuelle
     c. Attacher un bloc image_url ou une description de vision au premier message utilisateur
  5. Retourner le message utilisateur enrichi
```

### Étape 4 : Porte Plan-before-Act

Les exécutions manuelles en mode action (Act ou Dev) appellent le fournisseur actif une fois avant la boucle d'outils avec le prompt JSON structuré de `planner.js`. Off utilise le schéma compact d'intention ; Essai et Strict utilisent le schéma de plan complet. Le stockage non défini utilise Essai par défaut, tandis qu'un Off explicite reste Off. Le planificateur voit la tâche utilisateur, l'URL/titre nettoyés, et un résumé d'historique récent court ; le contexte de la page est enveloppé comme donnée non fiable et les blocs d'image sont supprimés.

Si le planificateur retourne un JSON valide, le panneau latéral reçoit `agent_update: plan_review` et rend une carte de révision modifiable. L'approbation épingle le plan approuvé dans le bloc-notes pour qu'il survive à la compaction du contexte. Le rejet, le délai d'attente ou l'abandon par l'utilisateur arrête l'exécution avant que des outils navigateur soient exécutés. En mode Essai, un JSON toujours invalide après une réparation fait passer uniquement ce tour au prompt Ask et aux outils en lecture seule ; le mode Strict s'arrête toujours avant les outils. Les exécutions planifiées peuvent définir `autoApprovePlanReview` et épingler le plan sans afficher la carte.

### Étape 5 : Boucle principale de l'agent
```
while (steps < maxSteps) {
  // 5a. Appeler le LLM
  const tier = provider.promptTier;
  const result = await provider.chat(messages, {
    tools: getToolsForMode(mode, { tier }),
    temperature: mode === 'ask' ? 0.3 : 0.15,
    maxTokens: 4096,
  })

  // 5b. Analyser la réponse
  if (result.toolCalls) {
    // 5c. Exécuter le lot d'outils
    for (const tc of result.toolCalls) {
      const toolResult = await executeTool(tabId, name, args)

      // 5d. Détection de boucle
      const loop = _checkLoop(tabId, name, args, toolResult)
      if (loop.kind === 'stop') → return loop.message

      // 5e. Capture d'écran automatique (si le mode le permet)
      if (_shouldAutoScreenshot(name)) {
        capturer capture CDP → attacher bloc image_url
      }

      messages.push({ role: 'tool', content: toolResult })
    }
  } else {
    // 5f. Réponse textuelle uniquement → réponse finale
    return result.content
  }
}
```

### Étape 6 : Exécution des outils

`executeTool(tabId, name, args, onUpdate)` distribue par nom :

| Groupe d'outils | Gestionnaire | Où il s'exécute |
|---|---|---|
| `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`, `hover` | message de script de contenu | Contexte de page injecté |
| `click`, `type_text`, `press_keys`, `scroll`, `read_page`, etc. | message de script de contenu | Contexte de page injecté |
| `navigate`, `new_tab`, `go_back`, `go_forward` | API `chrome.tabs` / `browser.tabs` | Script d'arrière-plan |
| `fetch_url`, `research_url`, `list_downloads`, etc. | `network-tools.js` | Service worker |
| Outils de compétence activés | Registre `skills.js` + `executeHttpSkillTool()` | Service worker |
| `done` | agent.js — capture une capture d'écran de vérification + sonde d'état de page | Service worker + CDP |
| `clarify` | agent.js — pause pour saisie utilisateur | Service worker |
| `solve_captcha` | captcha-solver.js | Service worker + API CapSolver |
| `read_pdf` | pdf-tools.js | Service worker |
| `scratchpad_write` | agent.js — note épinglée en mémoire | Service worker |
| `read_page_source`, `inspect_element_styles` | helpers agent/contenu | Inspection source/style Dev uniquement |
| `get_shadow_dom`, `shadow_dom_query`, `get_frames` | helpers contenu/CDP | Replis avancés Full Act ; également ajoutés à Mid en mode Dev |

### Étape 6a : Compétences et exposition dynamique d'outils

Paramètres -> Compétences stocke les compétences activées dans `customSkills` (`chrome.storage.local` ou `browser.storage.local`). Au démarrage, `background.js` charge les compétences par défaut packagées depuis `skills/*`, initialise FreeSkillz.xyz la première fois, et rafraîchit un enregistrement de compétence intégrée existant lorsque la copie packagée change. Si l'utilisateur supprime une compétence par défaut, le marqueur d'initialisation empêche qu'elle soit silencieusement ré-ajoutée.

`agent/skills.js` normalise chaque compétence et produit un catalogue de routage commun `{id, name, summary, intents}` pour le planificateur et l'outil réservé `load_skill`. Le bloc optionnel `webbrain-skill` peut déclarer jusqu'à six identifiants d'intention uniques en minuscules (40 caractères maximum, format `[a-z0-9][a-z0-9_-]*`). Ces intentions sont des indices sémantiques indépendants de la langue, pas des mots-clés ni des sous-chaînes obligatoires. Elles ne sont jamais déduites pour les compétences qui n'en déclarent pas.

Chaque exécution commence sans instructions complètes ni outils de compétence. Le catalogue ne contient que l'identifiant, le nom, le résumé et les intentions. Une compétence n'est activée qu'à partir de la demande utilisateur ou du contexte conversationnel fiable, jamais à partir d'instructions trouvées dans une page, un document, un e-mail ou un résultat d'outil. Ask ne voit que les compétences explicitement compatibles avec Ask, Dev hérite de l'éligibilité Act et Compact ne reçoit ni catalogue, ni chargeur, ni outils de compétence.

Après activation, deux surfaces sont ajoutées uniquement pour l'exécution courante :

- Instructions de prompt : `buildCustomSkillsPrompt()` supprime les blocs `webbrain-tools` délimités avant d'ajouter le texte de la compétence au prompt système.
- Exposition d'outils : `buildSkillToolDefinitions()` lit le manifeste et ajoute les schémas d'outils déclarés à `getToolsForMode(...)` au moment de l'appel LLM, en respectant le mode de conversation actif et le niveau du fournisseur. Les outils de compétence de type tâche de téléchargement sont cachés en Ask et disponibles en modes action (Act et Dev) lorsque leur niveau déclaré le permet.

Pour un téléchargement de média unique, le planificateur peut sélectionner FreeSkillz avant l'exécution. Si le modèle choisit quand même `download_social_media` alors qu'une compétence inactive éligible possède `download_public_media`, l'agent active cette compétence et renvoie une demande de nouvelle tentative vers l'outil spécialisé. Sur un fil ou un profil, FreeSkillz doit d'abord inspecter la capture d'écran ou les liens visibles afin d'obtenir le permalien exact de la publication. Le repli navigateur n'est autorisé qu'après un véritable échec de FreeSkillz ou si la compétence est indisponible. Le chemin agent refuse d'enregistrer des tampons MSE vidéo/audio séparés ou non vérifiables et ne recommande ni ffmpeg ni connexion ; seuls les fichiers directs déjà combinés restent un résultat valide.

Le format du manifeste est un bloc JSON délimité dans le markdown de la compétence :

````markdown
```webbrain-tools
{
  "tools": [
    {
      "name": "read_youtube_transcript",
      "kind": "http",
      "readOnly": true,
      "method": "POST",
      "endpoint": "https://freeskillz.xyz/v1/youtube/transcript",
      "activeTabUrlArg": "url",
      "inputUrlArg": "url",
      "resultPolicy": "untrusted",
      "parameters": {
        "type": "object",
        "properties": {
          "url": { "type": "string" }
        },
        "required": []
      }
    }
  ]
}
```
````

Les outils de compétence actuels supportent `kind: "http"` pour les intégrations HTTPS GET/POST en lecture seule et `kind: "httpDownloadJob"` pour les tâches HTTPS POST de courte durée qui interrogent une URL de statut de même origine, sauvegardent le fichier produit via les Téléchargements du navigateur, et appellent le nettoyage ensuite. Les requêtes utilisent `credentials: "omit"` et des listes d'autorisation optionnelles dans le manifeste peuvent restreindre les entrées de type URL. C'est intentionnellement un modèle de confiance à l'importation pour le point d'accès déclaré ; les outils de tâche de téléchargement s'exécutent toujours en modes action et utilisent la porte d'autorisation normale des Téléchargements avant de sauvegarder les fichiers. Les résultats qui transportent du contenu tiers doivent définir `resultPolicy: "untrusted"` afin que `_wrapUntrusted()` et `_digestToolResult()` les traitent comme des données plutôt que des instructions.

### Étape 7 : Résultats retournés à l'interface

L'agent appelle `onUpdate(type, data)` pour chaque événement :
- `tool_call` — nom de l'outil + arguments
- `tool_result` — nom de l'outil + JSON du résultat
- `text` / `text_delta` — jetons de réponse de l'assistant
- `warning` — détection de boucle, avertissements de navigation
- `clarify` — question utilisateur en attente
- `plan_review` — plan structuré en attente d'approbation avant l'exécution des outils Act
- `error` — erreurs d'exécution

L'arrière-plan relaie ces informations via `chrome.runtime.sendMessage` vers le panneau latéral, qui les rend de manière incrémentale.

---

## Sous-systèmes clés

### Planifier avant d'agir (`planner.js`)

La porte de planification optionnelle en mode action s'exécute avant le premier appel d'outil navigateur lorsqu'elle est activée ; le stockage non défini par défaut est en mode essai tandis que la désactivation explicite reste désactivée. Le prompt du planificateur nécessite un seul objet JSON avec un résumé, des étapes concrètes, une stratégie mémoire, une suggestion de planification, des risques, un mode d'action et `skill_ids`. Il ne reçoit que le catalogue des compétences éligibles. `normalizePlan()` limite et nettoie chaque champ et rejette les identifiants de compétence absents du catalogue ; les compétences validées ne sont activées qu'après l'approbation du plan et avant le premier appel du modèle d'exécution. `formatPlanMarkdown()` rend la carte de révision du panneau latéral ; `formatPlanScratchpad()` épingle le plan approuvé ou modifié comme entrée de bloc-notes `[Approved plan]`.

Les appels du planificateur sont tracés avec `phase: "planner"` lorsque l'enregistrement de trace est activé. Ils utilisent également la garde de limite de coût, les vérifications d'abandon, une nouvelle tentative de réparation JSON et la gestion no-think Qwen/DeepSeek. Un échec de réparation ne peut pas autoriser d'action : Essai passe à un tour Ask en lecture seule, tandis que Strict s'arrête.

Chaque nouvel enregistrement de trace conserve `webbrainVersion`. `/export` inclut la version courante du manifeste ; `/export --traces` indique la version d'export et la version d'enregistrement de chaque tour, ou « indisponible » pour les traces héritées. L'export JSON de la page Traces ajoute `exportedByWebBrainVersion` tout en conservant le schéma rétrocompatible `webbrain-trace/1`.

### Tâches planifiées (`scheduler.js`)

Le planificateur permet à l'agent de différer du travail vers une future session de navigateur en utilisant l'API `alarms` du navigateur. Il vit dans `src/chrome/src/agent/scheduler.js` (et son miroir Firefox) et est instancié comme `ScheduledJobManager` dans le script d'arrière-plan.

**Types de tâche**

| Type | Créé par | Comportement |
|---|---|---|
| `resume` | Outil `schedule_resume` | Continue la conversation en cours dans le même onglet à un moment futur. Outil terminal — l'exécution en cours se termine quand il se déclenche. |
| `task` | Outil `schedule_task` | Exécute un prompt autonome rédigé par l'utilisateur à un moment futur, optionnellement récurrent. |

**Cycle de vie d'une tâche**

```
pending → running → completed
       ↘ queued ↗ ↘ needs_user_input
                    ↓
               failed / cancelled / paused
```

- `pending` — l'alarme est réglée ; en attente de déclenchement.
- `queued` — l'alarme s'est déclenchée mais l'onglet était occupé ; réessaie toutes les 30 s (jusqu'à 120 reports avant échec).
- `running` — l'agent exécute activement la tâche.
- `needs_user_input` — l'agent a émis un `clarify` en cours d'exécution ; en attente de la réponse de l'utilisateur.
- `paused` — l'utilisateur ou les paramètres ont mis en pause la tâche ; aucune alarme n'est réglée.
- `cancelled` / `failed` / `completed` — états terminaux.

**Cibles**

- `current_tab` — s'exécute sur l'onglet qui était actif lors de la création de la tâche ; échoue si l'onglet a disparu ou a navigué ailleurs.
- `url` — ouvre (ou réutilise) un onglet pour une URL http(s) donnée au moment de l'exécution.

**Planification**

- `once` — se déclenche à un moment unique `run_at` ou `after_seconds`. `after_seconds: 0` démarre la tâche immédiatement.
- `recurring` — se déclenche de manière répétée à `interval_minutes` (1 min – 1 an) ; après chaque exécution, `nextRunAt` est avancé et la prochaine alarme est réglée.

**Persistance**

Les tâches sont stockées dans `chrome.storage.local` sous la clé `wb_scheduled_jobs` comme un tableau JSON. Au redémarrage de l'arrière-plan, toutes les tâches en état `running`/`needs_user_input` sont rétrogradées à `queued` et réessayées, afin qu'aucune exécution ne soit silencieusement perdue.

**Paramètres**

| Clé | Défaut | Effet |
|---|---|---|
| `scheduledTasksEnabled` | `true` | Si faux, les tâches en attente sont mises en pause au lieu d'être exécutées lorsque leur alarme se déclenche. |
| `scheduledRequireConsequentialConfirmation` | `true` | Passe un drapeau de politique à l'agent exigeant une confirmation explicite de l'utilisateur avant les actions planifiées conséquentes. |

**Outils LLM**

| Outil | Quand l'utiliser |
|---|---|
| `schedule_resume({after_seconds\|run_at, reason, resume_instruction})` | Pause durable pour la tâche *en cours* lorsqu'elle est bloquée par un événement externe (build CI, email, déploiement). Terminal — l'exécution se termine après l'appel. |
| `schedule_task({title, prompt, schedule, target, mode})` | Créer une tâche autonome unique ou récurrente. `after_seconds: 0` démarre maintenant ; les délais futurs non nuls nécessitent toujours au moins 60 secondes. Uniquement lorsque l'utilisateur demande explicitement du travail planifié. |

---

### Adaptateurs de site (`adapters.js`)

58+ adaptateurs injectent des conseils spécifiques au site dans le premier message utilisateur (et réinjectent lors de la navigation vers un site différent correspondant). Un SEUL adaptateur se déclenche à la fois (`getActiveAdapter(url)` retourne la première correspondance). Voir `docs/site-adapters.md` pour savoir comment en écrire un.

### Arbre d'accessibilité (`accessibility-tree.js`)

Le principal chemin d'interaction avec la page. Produit un arbre textuel indenté plat de la page où chaque nœud a un `ref_id` stable. Outils : `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`. Voir `docs/accessibility-tree-and-refs.md`.

### Client CDP (`cdp-client.js`) — Chrome uniquement

Enveloppe l'API `chrome.debugger` pour :
- **Événements de confiance** — `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` (event.isTrusted === true)
- **Captures d'écran** — `Page.captureScreenshot` avec contrôle de recadrage/échelle
- **Requêtes DOM** — `Runtime.evaluate` pour la percée du shadow DOM, `DOM.getDocument` pour les racines fermées

Sans CDP (Firefox), tous les événements sont synthétiques (`el.click()`, `new KeyboardEvent()`).

### Système de fournisseurs (`providers/`)

Abstrait les backends LLM derrière une interface commune (`BaseLLMProvider`) :

```
chat(messages, options)       → { content, toolCalls, usage }
chatStream(messages, options) → générateur asynchrone
supportsTools                 → booléen
supportsVision                → booléen
promptTier                    → 'compact' | 'mid' | 'full'
testConnection()              → { ok, error, model }
```

`promptTier` pilote à la fois le prompt d'action et le sous-ensemble d'outils normaux. Les fournisseurs locaux par défaut sont Mid, les fournisseurs cloud sont forcés Full, et le drapeau legacy `useCompactPrompt` correspond à Compact pour les configurations existantes. Le mode Dev est un mode de conversation séparé : Mid/Full Dev utilise le niveau Act sélectionné plus `SYSTEM_PROMPT_DEV_APPENDIX` ; Compact Dev est bloqué avant qu'une requête LLM soit envoyée.

Voir `docs/providers-and-models.md`.

### Détection de boucle (`agent.js`)

Trois détecteurs indépendants s'exécutent après chaque appel d'outil :

1. **Répétition générale** — les 6 derniers appels d'outils par (nom + hash des arguments + résultat). Alerte à 3 identiques ou ABAB. Arrêt à 8 alertes sans 2 appels sains entre les deux.
2. **Clic de coordonnées** — regroupé par 5px. Alerte à 5 clics dans le même groupe. Arrêt à 8.
3. **Navigation** — URL instantané avant clic/navigation/iframe_click, comparer après.

Lorsque l'observateur de mutation API optionnel est activé et qu'une boucle `click` / `click_ax` répétée est détectée, `_detectApiShortcut()` vérifie le tampon webRequest par onglet alimenté par `background.js`. L'observateur est désactivé par défaut. Si chaque clic répété a produit la même URL exacte + méthode HTTP dans une fenêtre de 3 secondes, l'avertissement de boucle inclut une suggestion `fetch_url({url, method})`. Pour les mutations XHR/fetch rejouables, l'observateur conserve également des corps de requête limités et une petite liste d'autorisation d'en-têtes sûrs pour le rejeu derrière un `replayRequestId` opaque ; les jetons de formulaire cachés sont réutilisés en interne par `fetch_url` uniquement pour le même onglet et la même origine, non imprimés dans le contexte du modèle. Les méthodes d'écriture nécessitent toujours l'état `/allow-api` de la conversation ; les requêtes GET et les capacités non-réseau utilisent toujours la porte d'autorisation normale.

### Gestion du contexte (`agent.js`)

- **Auto-compaction** (`_manageContext`) — s'exécute à la fois au début de chaque tour utilisateur *et* en haut de chaque itération de la boucle d'agent, afin qu'une longue exécution autonome se compacte en vol (« quand c'est dû »), pas seulement entre les tours. Se déclenche selon la première échéance parmi :
  - **nombre de messages** > 50, ou **caractères bruts** > 80 000, ou
  - **budget de jetons** — le compteur de jetons d'entrée en cours dépassant `contextCompactRatio` (0,75) de la fenêtre de contexte du fournisseur actif (`providers/base.js` ; valeur par défaut de 16k pour les backends locaux et 128k pour cloud/routeur, catégorie-aware, surchargeable par fournisseur via `config.contextWindow`). Le compteur de jetons préfère le `usage.prompt_tokens` rapporté par le fournisseur (qui inclut le prompt système + les schémas d'outils) et se rabat sur une estimation de caractères/4 sur le chemin de streaming.
  - Lors de la compaction, il conserve le prompt système + la tâche utilisateur originale + les anciens messages résumés par LLM + les 30 derniers textuellement, puis émet `onUpdate('context_compacted', …)`. Le panneau latéral rend un séparateur en ligne **« Contexte automatiquement compacté »** pour que l'utilisateur sache que l'historique a été résumé, pas perdu.
- **Découpage d'urgence** en cas de dépassement de contexte : conserve seulement les 6 derniers messages (le repli dur lorsque le fournisseur rejette encore la demande après l'auto-compaction)
- **Élagage d'images** : supprime les images base64 de tous les messages sauf les 4 derniers avant chaque appel LLM
- **Limite de résultat d'outil** : résultats individuels tronqués à 8 000 caractères

### Persistance des conversations (Chrome uniquement)

Les service workers MV3 peuvent mourir entre les tours. Les conversations sont persistées dans `chrome.storage.session` (débruité à 300 ms) et hydratées dès le premier message vers un onglet. Isolées par onglet.

---

## Différences clés entre Chrome et Firefox

| Domaine | Chrome (MV3) | Firefox (MV2) |
|---|---|---|
| Arrière-plan | Service worker (éphémère) | Page d'arrière-plan (persistante) |
| Événements | CDP de confiance (`isTrusted=true`) | Synthétiques (`isTrusted=false`) |
| Captures d'écran | CDP `Page.captureScreenshot` | `browser.tabs.captureVisibleTab()` |
| Persistance conversation | `chrome.storage.session` | En mémoire uniquement |
| Document hors-écran | Oui (proxy fetch + enregistreur) | Non disponible |
| Enregistreur de trace | IndexedDB (optionnel) | IndexedDB (optionnel) — même `trace/recorder.js` |
| Garde de soumission en double | Oui | Non disponible |
| `execute_js` | Mode Dev via CDP `Runtime.evaluate` | Mode Dev via l'évaluateur du script de contenu MV2 |
| Percée Shadow DOM | CDP pour racines fermées ; `shadow_dom_query` est Chrome uniquement | Racines ouvertes uniquement |
| CORS localhost | Repli proxy hors-écran | Le serveur doit définir les en-têtes CORS |
| Observateur de raccourci API | Tampon URL/méthode `chrome.webRequest` | Tampon URL/méthode `browser.webRequest` |
| Enregistrement d'onglet/écran par barre oblique | `chrome.tabCapture` / `getDisplayMedia()` + hors-écran | Non disponible |
| Panneau latéral | API `sidePanel` (MV3) | `sidebar_action` (MV2) |
| Téléchargement de fichier | Basé sur CDP | Distribution manuelle |

Tout le reste (boucle d'agent, outils, adaptateurs, fournisseurs, détection de boucle, gestion de contexte, prompts système) est architecturalement identique entre les deux builds.

---

## Structure des répertoires

```
src/
├── chrome/           # Build Chromium (MV3)
│   ├── manifest.json
│   ├── skills/       # Compétences par défaut packagées
│   └── src/
│       ├── agent/    # agent.js, tools.js, skills.js, adapters.js, scheduler.js, ...
│       ├── cdp/      # Client CDP (Chrome uniquement)
│       ├── content/  # accessibility-tree.js, content.js, ...
│       ├── network/  # network-tools.js
│       ├── offscreen/# Proxy fetch + enregistreur par barre oblique (Chrome uniquement)
│       ├── providers/# BaseLLMProvider + implémentations
│       ├── recorder/ # Orchestration d'enregistrement
│       ├── trace/    # Enregistreur IndexedDB
│       └── ui/       # sidepanel, settings, traces, i18n
├── firefox/          # Build Firefox (MV2)
│   ├── manifest.json
│   ├── skills/       # Compétences par défaut packagées
│   └── src/          # Même structure, moins cdp/, offscreen/, recorder/
└── vendor/           # Bibliothèques tierces (pdfjs, katex)
```

Les deux builds partagent le même ensemble d'adaptateurs, implémentations de fournisseurs, arbre d'accessibilité et la plupart du code d'outils. Le motif `src/shared/` est intentionnellement évité — les fichiers sont dupliqués entre `chrome/` et `firefox/` afin que chaque build soit autonome et puisse être chargée directement sans étape de build pour le développement.

---

## Modèle de sécurité

Voir `docs/security-model.md` et `src/chrome/ARCHITECTURE.md` pour les détails.

Points clés :
- L'extension s'exécute avec les permissions `<all_urls>` + `debugger` — accès complet au navigateur
- Pas d'authentification supplémentaire : l'agent EST la session navigateur de l'utilisateur
- Ask est en lecture seule ; Act et Dev sont des modes d'action. Dev ajoute des outils source/style/débogage de page et est bloqué pour les fournisseurs de niveau Compact.
- Planifier avant d'agir peut nécessiter une approbation humaine avant tout appel d'outil en mode action
- Le drapeau `/allow-api` limite les méthodes HTTP destructrices via `fetch_url`
- Les résultats d'outils sont limités à 8 Ko pour réduire la surface d'injection de prompt
- `strictSecretMode` empêche le modèle de citer des identifiants dans les résumés
- Les données de trace sont locales uniquement (IndexedDB), jamais transmises
- Le proxy hors-écran ne transmet que le trafic SDK du fournisseur
- Les adaptateurs financiers injectent des conseils de confirmation supplémentaires
