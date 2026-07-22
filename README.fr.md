<p align="center">
  <img src="assets/logo-mark.png" alt="Logo WebBrain" width="92">
</p>

<h1 align="center">WebBrain</h1>

<p align="center">
  Agent de navigation IA open source pour discuter avec les pages, automatiser les tâches et exécuter des workflows multi-étapes avec le LLM de votre choix.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb"><img src="https://img.shields.io/badge/Chrome-Installer-4285F4?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="Installer WebBrain depuis le Chrome Web Store"></a>
  <a href="https://addons.mozilla.org/en-US/firefox/addon/webbrain/"><img src="https://img.shields.io/badge/Firefox-Installer-FF7139?style=for-the-badge&amp;logo=firefoxbrowser&amp;logoColor=white" alt="Installer WebBrain depuis Firefox Browser Add-ons"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo"><img src="https://img.shields.io/badge/Edge-Installer-0A84FF?style=for-the-badge&amp;logo=microsoftedge&amp;logoColor=white" alt="Installer WebBrain depuis Microsoft Edge Add-ons"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="https://webbrain.one">Site web</a> ·
  <a href="LICENSE">Licence MIT</a>
</p>

![Claude Chrome vs WebBrain](assets/webbrain-vs-claude-chrome.gif)

## Fonctionnalités

- **Lecture de page** — Extrait le texte, les liens, les formulaires, les tableaux et les éléments interactifs de n'importe quelle page
- **Actions du navigateur** — Cliquer, saisir, faire défiler, naviguer et interagir avec les éléments de la page
- **Modes Ask / Act / Dev** — Lecture seule par défaut, actions normales sur demande et outils Dev dédiés à l'inspection, à l'édition réversible et au diagnostic des pages
- **Plan avant Act** — Les modes Act et Dev peuvent générer un plan structuré, l'afficher pour approbation, puis épingler le plan approuvé dans le scratchpad avant l'exécution des outils
- **Agent multi-étapes** — Exécution autonome de tâches via des boucles d'utilisation d'outils (configurable, 130 étapes par défaut)
- **Continuer depuis la limite** — Lorsque l'agent atteint la limite d'étapes, cliquez sur Continuer pour poursuivre
- **LLM multi-fournisseurs** — Prend en charge les modèles locaux et cloud :
  - **WebBrain Cloud 1.0** (cloud, par défaut) — Option cloud gérée intégrée, aucune configuration locale requise
  - **llama.cpp** (local) — Aucune clé API requise. Également **Ollama**, **LM Studio**, **Jan**, **vLLM** et **SGLang**
  - **OpenAI** (GPT-5.5, etc.)
  - **Anthropic Claude** (API native)
  - **Google Gemini**, **Mistral AI**, **DeepSeek**, **xAI Grok**, **Groq**
  - **MiniMax**, **Alibaba Cloud (Qwen)**
  - **Cloudflare Workers AI**, **Nvidia NIM**
  - **OpenRouter** (modèle par défaut : `openrouter/free` ; accès à plus de 100 modèles)
- **Assistant d'intégration** — Visite guidée au premier lancement couvrant la sécurité du mode Act et la configuration des fournisseurs
- **Interface en panneau latéral** — Interface de chat épurée qui accompagne votre navigation
- **Conversations par onglet** — Chaque onglet possède son propre historique de chat
- **Streaming** — Diffusion de jetons en temps réel depuis tous les fournisseurs
- **Contexte intelligent** — Auto-compactage tenant compte des jetons (résume les tours plus anciens lorsque la conversation approche de la fenêtre de contexte du modèle, avec un avis visible « Contexte automatiquement compacté »), limites de résultats d'outils et récupération d'urgence en cas de débordement
- **Contrôle de l'historique du navigateur** — Le mode Act peut utiliser les outils natifs d'historique `go_back` / `go_forward` au lieu du JavaScript de page sensible à la CSP
- **Indices de raccourcis API** — Les clics répétés qui déclenchent la même requête XHR/fetch peuvent afficher une suggestion `fetch_url` correspondante tout en préservant la règle UI-d'abord et la politique de mutation `/allow-api`
- **Prise en charge de la copie** — Boutons de copie sur les blocs de code et les messages complets
- **Bannière d'inspection de page** — Indicateur visuel lorsque l'agent interagit avec la page
- **Bouton d'arrêt** — Interrompez l'agent en cours d'exécution à tout moment
- **Mode Act déterministe** — Le mode Act utilise une température de `0.15` pour les décisions de contrôle du navigateur ; le mode Ask utilise `0.3`, et les descriptions de captures d'écran par vision dédiée utilisent `0`

## Démarrage rapide

### Chrome

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

1. Ouvrez Chrome → `chrome://extensions/`
2. Activez le **mode développeur** (en haut à droite)
3. Cliquez sur **Charger l'extension non empaquetée** → sélectionnez le dossier `webbrain/src/chrome`

### Firefox

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

1. Ouvrez Firefox → `about:debugging#/runtime/this-firefox`
2. Cliquez sur **Charger un module complémentaire temporaire**
3. Accédez à `src/firefox/` et sélectionnez `manifest.json`

> **Note :** Les modules complémentaires temporaires sont supprimés au redémarrage de Firefox. Pour une installation permanente, l'extension doit être signée via [addons.mozilla.org](https://addons.mozilla.org).

### Lancer un LLM local (par défaut)

```bash
# Avec llama.cpp
llama-server -m your-model.gguf --port 8080

# Ou avec Ollama (compatible OpenAI)
ollama serve
# Puis définissez l'URL de base sur http://localhost:11434/v1 dans les paramètres

# Ou avec Jan (compatible OpenAI)
# Lancez le serveur d'API local de Jan et utilisez http://localhost:1337/v1

# Ou avec vLLM / SGLang (compatible OpenAI)
vllm serve your-model --port 8000
python -m sglang.launch_server --model-path your-model --port 30000
```

> **Fenêtre de contexte :** Pour des exécutions d'agent fiables, chargez un modèle local avec **au moins une fenêtre de contexte de 16k jetons** (le minimum utilisable). 8k peut fonctionner avec le **mode Compact** activé (Paramètres → niveau Prompt par fournisseur) ; 4k est trop petit pour contenir le prompt système + les schémas d'outils. WebBrain compacte automatiquement la conversation à l'approche de la fenêtre. Les fournisseurs locaux utilisent 16k par défaut sauf taille explicite dans les Paramètres. **Tester la connexion** / **Charger les modèles** détectent la fenêtre réelle pour **llama.cpp**, **Ollama** et **LM Studio** quand le backend la rapporte (llama.cpp `/props`, Ollama `/api/ps` puis `/api/show` `num_ctx`, LM Studio `/api/v0/models`). La détection rafraîchit le 16k par défaut ; elle réduit une surcharge manuelle plus grande seulement depuis le contexte live/runtime (llama.cpp `/props`, Ollama `/api/ps`, contexte chargé LM Studio). Les autres backends locaux (Jan, vLLM, SGLang, LocalAI) conservent la valeur manuelle/par défaut.

### Utilisation

Cliquez sur l'icône WebBrain → le panneau latéral s'ouvre. Tapez un message comme :

- « Résume cette page »
- « Trouve tous les liens à propos des tarifs »
- « Remplis le champ de recherche avec 'AI agents' et clique sur Rechercher »
- « Navigue vers github.com et trouve les dépôts tendance »

## Configuration

Cliquez sur l'icône d'engrenage ou accédez à la page Options de l'extension pour configurer :

**Paramètres d'affichage :**
- Mode verbeux — Affiche le JSON complet des appels d'outils (désactivé par défaut)
- Repli sur capture d'écran — Utilise des captures d'écran lorsque la lecture du DOM échoue
- Étapes max de l'agent — Limite d'étapes configurable (5-200, 60 par défaut)
- Plan avant Act — Génère et permet de revoir facultativement un plan structuré en mode Act avant l'exécution des outils du navigateur (désactivé par défaut)

**Fournisseurs :**

Les URL de base sont préremplies dans les paramètres lorsque vous choisissez un fournisseur. Les serveurs locaux utilisent le port par défaut indiqué ci-dessous.

| Fournisseur | Clé API | Modèle par défaut |
|-------------|----------|-------------------|
| llama.cpp (`:8080`) | Non requise | (votre modèle chargé) |
| Ollama (`:11434/v1`) | Non requise | (votre modèle chargé) |
| LM Studio (`:1234/v1`) | Non requise | (votre modèle chargé) |
| Jan (`:1337/v1`) | Non requise | (votre modèle chargé) |
| vLLM (`:8000/v1`) | Optionnelle | (votre modèle servi) |
| SGLang (`:30000/v1`) | Optionnelle | (votre modèle servi) |
| LocalAI (`:8080/v1`) | Optionnelle | (votre modèle chargé) |
| OpenAI | Requise | gpt-5.5 |
| Anthropic Claude | Requise | claude-sonnet-4-6 |
| Google Gemini | Requise | gemini-3.1-flash |
| Cloudflare Workers AI | Requise (+ Account ID) | @cf/zai-org/glm-5.2 |
| Mistral AI | Requise | mistral-large-latest |
| DeepSeek | Requise | deepseek-v4-flash |
| xAI Grok | Requise | grok-4.3 |
| Nvidia NIM | Requise | meta/llama-3.1-8b-instruct |
| Groq | Requise | llama-3.3-70b-versatile |
| MiniMax | Requise | minimax-m2.7 |
| Alibaba Cloud (Qwen) | Requise | qwen-max |
| OpenRouter | Requise | openrouter/free |

## Architecture

```
src/chrome/                        src/firefox/
├── manifest.json (MV3)            ├── manifest.json (MV2)
├── src/                           ├── src/
│   ├── background.js              │   ├── background.js (+ background.html)
│   ├── agent/                     │   ├── agent/
│   ├── content/                   │   ├── content/
│   ├── providers/                 │   ├── providers/
│   ├── network/                   │   ├── network/
│   ├── trace/                     │   ├── trace/
│   ├── ui/                        │   └── ui/
│   └── offscreen/                 ├── styles/
├── styles/                        ├── icons/
└── icons/                         └── LICENSE

web/
├── index.html
├── privacy.html
└── vercel.json
```

Différence clé : Chrome utilise Manifest V3 (service worker, `chrome.scripting`, API `sidePanel`), Firefox utilise Manifest V2 (page d'arrière-plan, `browser.tabs.executeScript`, `sidebar_action`).

Une documentation plus approfondie se trouve dans [`docs/`](docs/) : [architecture](docs/architecture.md), [adaptateurs de sites](docs/site-adapters.md), [fournisseurs et modèles](docs/providers-and-models.md), [modèle de sécurité](docs/security-model.md), [défense contre l'injection de prompt](docs/prompt-injection-defense.md), [confidentialité et flux de données](docs/privacy-and-data-flow.md), [arbre d'accessibilité et refs](docs/accessibility-tree-and-refs.md), [localisation](docs/localization.md), [ajout d'un outil](docs/adding-a-tool.md), et [scénarios de test](docs/test-scenarios.md).

## Outils de l'agent

WebBrain sépare le niveau de modèle du mode de conversation :

- **Niveau** (`compact`, `mid`, `full`) contrôle combien d'outils navigateur normaux le modèle voit.
- **Mode** (`ask`, `act`, `dev`) contrôle le type de tâche autorisé. Ask est en lecture seule. Act expose les outils normaux du niveau sélectionné. Dev exige un fournisseur Mid/Full et ajoute une annexe source/style/debug, y compris une inspection DOM/frame plus profonde pour les exécutions Dev Mid.

Légende : **Oui** = disponible · **-** = indisponible · **C** = Chrome uniquement · **Dev** = module Dev (fournisseurs Mid/Full ; pas Compact).

| Outil | Ask | Compact | Mid | Full | Dev |
|-------|:---:|:-------:|:---:|:----:|:---:|
| `get_accessibility_tree` | Oui | Oui | Oui | Oui | - |
| `read_page` | Oui | Oui | Oui | Oui | - |
| `read_pdf` | Oui | Non | Oui | Oui | - |
| `read_page_source` | Non | Non | Non | Non | Oui |
| `get_window_info` | Oui | Oui | Oui | Oui | - |
| `get_interactive_elements` | Oui | Non | Oui | Oui | - |
| `scroll` | Oui | Oui | Oui | Oui | - |
| `extract_data` | Oui | Oui | Oui | Oui | - |
| `inspect_element_styles` | Non | Non | Non | Non | Oui |
| `wait_for_stable` | Oui | Non | Oui | Oui | - |
| `get_selection` | Oui | Oui | Oui | Oui | - |
| `done` | Oui | Oui | Oui | Oui | - |
| `clarify` | Non | Oui | Oui | Oui | - |
| `fetch_url` | Oui | Oui | Oui | Oui | - |
| `research_url` | Oui | Non | Oui | Oui | - |
| `list_downloads` | Oui | Non | Oui | Oui | - |
| `click_ax` | Non | Oui | Oui | Oui | - |
| `type_ax` | Non | Oui | Oui | Oui | - |
| `set_field` | Non | Oui | Oui | Oui | - |
| `resize_window` | Non | Non | Non | Oui | - |
| `click` | Non | Oui | Oui | Oui | - |
| `type_text` | Non | Oui | Oui | Oui | - |
| `press_keys` | Non | Oui | Oui | Oui | - |
| `navigate` | Non | Oui | Oui | Oui | - |
| `wait_for_element` | Non | Oui | Oui | Oui | - |
| `new_tab` | Non | Oui | Oui | Oui | - |
| `scratchpad_write` | Non | Oui | Oui | Oui | - |
| `progress_update` | Non | Oui | Oui | Oui | - |
| `progress_read` | Non | Oui | Oui | Oui | - |
| `download_social_media` | Non | Non | Oui | Oui | - |
| `solve_captcha` | Non | Non | Oui | Oui | - |
| `go_back` | Non | Non | Oui | Oui | - |
| `go_forward` | Non | Non | Oui | Oui | - |
| `schedule_resume` | Non | Non | Oui | Oui | - |
| `schedule_task` | Non | Non | Oui | Oui | - |
| `iframe_read` | Non | Non | Oui | Oui | - |
| `iframe_click` | Non | Non | Oui | Oui | - |
| `iframe_type` | Non | Non | Oui | Oui | - |
| `read_downloaded_file` | Non | Non | Oui | Oui | - |
| `download_files` | Non | Non | Oui | Oui | - |
| `download_resource_from_page` | Non | Non | Oui | Oui | - |
| `upload_file` | Non | Non | C | C | - |
| `verify_form` | Non | Non | Oui | Oui | - |
| `hover` | Non | Non | Non | Oui | - |
| `drag_drop` | Non | Non | Non | Oui | - |
| `get_shadow_dom` | Non | Non | Non | Oui | Oui |
| `shadow_dom_query` | Non | Non | Non | C | C |
| `get_frames` | Non | Non | Non | Oui | Oui |
| `inject_css` | Non | Non | Non | Non | C |
| `remove_injected_css` | Non | Non | Non | Non | C |
| `patch_element` | Non | Non | Non | Non | C |
| `revert_patch` | Non | Non | Non | Non | C |
| `execute_js` | Non | Non | Non | Non | Oui |
| `read_console` | Non | Non | Non | Non | C |
| `inspect_network_requests` | Non | Non | Non | Non | C |
| `inspect_event_listeners` | Non | Non | Non | Non | C |
| `highlight_element` | Non | Non | Non | Non | C |

Les compétences chargées peuvent ajouter des schémas d'outils pour l'exécution en cours. Par exemple, la compétence FreeSkillz.xyz peut exposer `read_youtube_transcript` pour YouTube et `resolve_public_media` / `download_public_media` pour les médias publics. Ces outils de compétence ne sont pas codés en dur dans le tableau ci-dessus : avant le chargement de la compétence (ou si elle est retirée), ils sont absents. Ask filtre aussi les outils de mutation/téléchargement même lorsque la compétence propriétaire est chargée.

Les outils Dev ne sont exposés qu'en mode Dev, et le mode Dev est bloqué pour les fournisseurs Compact. Les outils d'édition réversible Chrome renvoient des patch IDs : `inject_css` avec `remove_injected_css`, `patch_element` avec `revert_patch`.

### Édition et diagnostics en mode Dev

- `inject_css` / `remove_injected_css` appliquent et annulent du CSS temporaire par `patchId`. Chaque patch est unique et lié au document exact ; la navigation invalide l'ancien identifiant.
- `patch_element` / `revert_patch` modifient styles inline, classes et attributs avec valeurs avant/après exactes. `highlight_element` affiche une surcouche temporaire.
- `execute_js` exécute un corps de fonction JavaScript asynchrone dans le monde principal de la page. Chrome utilise CDP `Runtime.evaluate` (limite 15 s) ; Firefox utilise l'évaluateur de script de contenu MV2. Autorisation hôte + confirmation de soumission fraîche.
- `read_console`, `inspect_network_requests` et `inspect_event_listeners` fournissent des diagnostics bornés sur Chrome. En-têtes et corps réseau omis par défaut ; en-têtes sensibles caviardés ; sortie issue de la page traitée comme contenu non fiable.

**Niveau Compact** : ensemble d'outils réduit + prompt plus court pour les petits modèles locaux. **Niveau Mid** : outils de tâche courants, iframes, téléchargements, planification et vérification de formulaires. **Niveau Full** : hover, drag-drop, frames et shadow DOM. Activez le niveau par fournisseur dans les Paramètres.

> **Note Shadow DOM :** L'arbre d'accessibilité ne traverse que le light DOM. Sur les pages riches en Web Components (Stripe, Salesforce, Shopify), utilisez d'abord `get_interactive_elements` ; en Full Act ou Dev, utilisez `get_shadow_dom` / `shadow_dom_query` pour des lectures ciblées.

## Plugin LM Studio

Les outils `fetch_url` et `research_url` sont également fournis sous forme de
plugin [LM Studio](https://lmstudio.ai) autonome sur
[`webbrain/web-tools`](https://lmstudio.ai/webbrain/web-tools), pour les
utilisateurs qui veulent l'utilisation d'outils de récupération web dans les chats LM Studio sans
exécuter l'extension de navigateur complète. Pur Node, sans navigateur sans interface.

```bash
lms clone webbrain/web-tools
```

Source : [`lmstudio-plugin/`](./lmstudio-plugin/).

## Commandes slash

WebBrain accepte les commandes slash en tant que premier élément d'une ligne dans le champ de saisie. Tapez `/help` pour afficher dans le panneau les syntaxes complètes et la description des options. Saisissez une commande canonique suivie d'une espace pour afficher l'autocomplétion de ses options disponibles.

| Commande | Ce qu'elle fait |
|---------|--------------|
| `/help` | Affiche la liste des commandes disponibles |
| `/schedule [invite]` | Créer une tâche planifiée et éventuellement préremplir son invite |
| `/schedule --list` | Afficher les tâches planifiées |
| `/progress` | Afficher le journal de progression actuel |
| `/scratchpad` | Afficher le bloc-notes actuel |
| `/scratchpad --append <texte>` | Ajouter du texte au bloc-notes actuel |
| `/scratchpad --clear` | Effacer le bloc-notes actuel |
| `/memory` | Afficher la mémoire utilisateur enregistrée |
| `/memory --add <texte>` | Enregistrer une préférence utilisateur |
| `/memory --forget <id>` | Oublier une entrée de mémoire par identifiant |
| `/allow-api` | **Dérogation de mutation API par conversation.** Lève la restriction UI-d'abord afin que l'agent puisse utiliser POST/PUT/PATCH/DELETE via `fetch_url` lorsque l'UI échoue. Un badge apparaît pendant l'activation ; il s'efface au `/reset`. |
| `/dangerously-skip-permissions` | **Contournement global des demandes d'autorisation.** Désactive `Ask before consequential actions` sans ouvrir les Paramètres. WebBrain agira sans demandes par site jusqu'à ce que vous réactiviez le réglage. |
| `/compact` | Force le compactage du contexte pour la conversation actuelle |
| `/verbose` | Bascule l'affichage des outils verbeux/compact (identique au bouton de la barre d'outils) |
| `/reset` | Efface la conversation et tous les indicateurs par conversation |
| `/screenshot [--full-page]` | Capture l'onglet visible, ou la page entière avec `--full-page` (Chrome uniquement) |
| `/record [--full-screen] [--transcribe]` | Enregistre l'onglet actuel, ou un écran/une fenêtre avec `--full-screen` (Chrome uniquement) ; `--transcribe` enregistre une transcription |
| `/export [--traces]` | Télécharge la conversation en Markdown, ou la chaîne d'outils avec `--traces` |
| `/profile` | Bascule le remplissage automatique du profil sans ouvrir les Paramètres |
| `/vision` | Bascule le mode vision (compréhension de captures d'écran) sur le fournisseur actif |
| `/ask` | Passer en mode Demander avant d'envoyer |
| `/dev` | Passer en mode Dev avant d'envoyer |
| `/plan` | Passer en mode Demander avec une intention de planification |

La règle UI-d'abord par défaut existe parce que les actions API sont invisibles (vous ne voyez pas ce qui est envoyé), nécessitent souvent des jetons d'authentification distincts que vous n'avez peut-être pas configurés, et peuvent avoir un rayon d'impact bien plus grand qu'un mauvais clic visible. N'utilisez `/allow-api` que lorsque vous avez décidé d'accepter ce compromis pour une tâche spécifique.

## Raccourcis clavier

Les raccourcis du panneau latéral Chrome fonctionnent lorsque le panneau latéral WebBrain a le focus.

| Raccourci | Ce qu'il fait |
|----------|--------------|
| `Ctrl+/` ou `Cmd+/` | Mettre le focus dans le champ de saisie |
| `Ctrl+Shift+A` ou `Cmd+Shift+A` | Passer en mode Ask |
| `Ctrl+Shift+X` ou `Cmd+Shift+X` | Passer en mode Act |
| `Ctrl+Shift+D` ou `Cmd+Shift+D` | Passer en mode Dev |
| `Escape` | Arrêter l'exécution active, sauf s'il ne fait que fermer l'autocomplétion des commandes slash |
| `Escape` deux fois | Arrêter un enregistrement actif depuis WebBrain ou une page du navigateur |

## Problèmes connus

- **Firefox est nettement plus faible que Chrome.** Firefox n'a pas d'équivalent au Chrome DevTools Protocol via `chrome.debugger`, donc plusieurs fonctionnalités propres à Chrome manquent dans le build Firefox :
  - Le clic/la saisie passe par le chemin du content-script (`document.querySelector` + `el.click()`) au lieu de CDP `Input.dispatchMouseEvent`. Cela signifie **aucune traversée du shadow-DOM**, **aucun véritable événement de souris approuvé** (certains gestionnaires React/Vue ne se déclenchent pas), **aucune traversée de shadow root fermé**, et **aucun budget de réessai `resolveSelector`**.
  - **Aucune extension de réessai consciente de la navigation SPA.**
  - **Aucune persistance de conversation** à travers les redémarrages de l'arrière-plan.
  - **Aucune capture d'écran CDP.** La capture automatique utilise `tabs.captureVisibleTab` à la place, ce qui ne fonctionne que pour les onglets actifs et à une qualité légèrement inférieure.
  - **Aucun support de shadow root fermé** pour les outils de lecture/extraction.
  - Les adaptateurs de sites, la détection par vision, la détection de boucle, la boucle de capture d'écran automatique et l'ensemble prompt/outils compact opt-in *sont* reflétés sur Firefox.
- **Détection de navigation SPA dans Firefox.** Certaines applications monopages peuvent ne pas déclencher la réinjection du content-script après une navigation côté client.
- **Module complémentaire temporaire Firefox** — Firefox exige que l'extension soit chargée en tant que module complémentaire temporaire pendant le développement, ce qui est supprimé au redémarrage.

## Nouveautés

Consultez [CHANGELOG.md](./CHANGELOG.md) pour l'historique complet des versions. Les points forts récents incluent Plan avant Act, les outils natifs d'historique du navigateur, les indices de raccourcis API pour les clics répétés, WebBrain Cloud 1.0, les tâches planifiées, les améliorations du mode Compact et la lecture PDF native.

## Ajouter un nouveau fournisseur

1. Créez une nouvelle classe étendant `BaseLLMProvider` dans `src/providers/`
2. Implémentez `chat()` et optionnellement `chatStream()`
3. Enregistrez-la dans `src/providers/manager.js`

Tous les fournisseurs se normalisent vers un format de réponse commun :
```js
{ content: string, toolCalls: Array|null, usage: Object|null }
```

## Historique des étoiles

<a href="https://www.star-history.com/?repos=webbrain-one%2Fwebbrain&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&legend=top-left" />
   <img alt="Graphique d'historique des étoiles" src="https://api.star-history.com/chart?repos=webbrain-one/webbrain&type=date&legend=top-left" />
 </picture>
</a>


## Citation

Si vous utilisez WebBrain dans votre recherche ou votre projet, veuillez citer :

```bibtex
@software{webbrain2026,
  author = {Sokullu, Emre},
  title = {WebBrain : Agent de navigation IA open source pour discuter avec les pages},
  year = {2026},
  publisher = {GitHub},
  url = {https://github.com/webbrain-one/webbrain}
}
```

## Licence

MIT — créé par [Emre Sokullu](https://emresokullu.com)
