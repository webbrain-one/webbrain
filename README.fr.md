# WebBrain

[![Lang](https://img.shields.io/badge/Lang-English-blue)](README.md)
[![Lang](https://img.shields.io/badge/Lang-中文-red)](README.zh-CN.md)
[![Lang](https://img.shields.io/badge/Lang-Français-blueviolet)](README.fr.md)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

![Claude Chrome vs WebBrain](assets/webbrain-vs-claude-chrome.gif)

Agent de navigation IA open source pour Chrome et Firefox. Discutez avec n'importe quelle page web, automatisez les tâches du navigateur et exécutez des workflows d'agent multi-étapes — propulsé par le LLM de votre choix.

## Fonctionnalités

- **Lecture de page** — Extrait le texte, les liens, les formulaires, les tableaux et les éléments interactifs de n'importe quelle page
- **Actions du navigateur** — Cliquer, saisir, faire défiler, naviguer et interagir avec les éléments de la page
- **Modes Ask / Act** — Mode lecture seule par défaut, mode agent complet avec confirmation
- **Agent multi-étapes** — Exécution autonome de tâches via des boucles d'utilisation d'outils (configurable, 130 étapes par défaut)
- **Continuer depuis la limite** — Lorsque l'agent atteint la limite d'étapes, cliquez sur Continuer pour poursuivre
- **LLM multi-fournisseurs** — Prend en charge les modèles locaux et cloud :
  - **WebBrain Cloud 1.0** (cloud, par défaut) — Option cloud gérée intégrée, aucune configuration locale requise
  - **llama.cpp** (local) — Aucune clé API requise. Également **Ollama** et **LM Studio**
  - **OpenAI** (GPT-5.5, etc.)
  - **Anthropic Claude** (API native)
  - **Google Gemini**, **Mistral AI**, **DeepSeek**, **xAI Grok**, **Groq**
  - **MiniMax**, **Alibaba Cloud (Qwen)**
  - **Nvidia NIM**
  - **OpenRouter** (modèle par défaut : `stepfun/step-3.7-flash` ; accès à plus de 100 modèles)
- **Assistant d'intégration** — Visite guidée au premier lancement couvrant la sécurité du mode Act et la configuration des fournisseurs
- **Interface en panneau latéral** — Interface de chat épurée qui accompagne votre navigation
- **Conversations par onglet** — Chaque onglet possède son propre historique de chat
- **Streaming** — Diffusion de jetons en temps réel depuis tous les fournisseurs
- **Contexte intelligent** — Auto-compactage tenant compte des jetons (résume les tours plus anciens lorsque la conversation approche de la fenêtre de contexte du modèle, avec un avis visible « Contexte automatiquement compacté »), limites de résultats d'outils et récupération d'urgence en cas de débordement
- **Prise en charge de la copie** — Boutons de copie sur les blocs de code et les messages complets
- **Bannière d'inspection de page** — Indicateur visuel lorsque l'agent interagit avec la page
- **Bouton d'arrêt** — Interrompez l'agent en cours d'exécution à tout moment
- **Mode Act déterministe** — Le mode Act utilise une température de `0.15` pour les décisions de contrôle du navigateur ; le mode Ask utilise `0.3`, et les descriptions de captures d'écran par vision dédiée utilisent `0`

## Démarrage rapide

### Chrome

```bash
git clone https://github.com/esokullu/webbrain.git
```

1. Ouvrez Chrome → `chrome://extensions/`
2. Activez le **mode développeur** (en haut à droite)
3. Cliquez sur **Charger l'extension non empaquetée** → sélectionnez le dossier `webbrain`

### Firefox

```bash
git clone https://github.com/esokullu/webbrain.git
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
```

> **Fenêtre de contexte :** Pour des exécutions d'agent fiables, chargez un modèle local avec **au moins une fenêtre de contexte de 16k jetons** (le minimum utilisable). 8k peut fonctionner avec le **mode Compact** activé (Paramètres → case à cocher par fournisseur) ; 4k est trop petit pour contenir le prompt système + les schémas d'outils. WebBrain compacte automatiquement la conversation à l'approche de la fenêtre — il suppose 16k pour les modèles locaux sauf si vous définissez une taille de contexte explicite, alors donnez au serveur du modèle (par ex. `llama-server -c 16384`) suffisamment d'espace.

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

**Fournisseurs :**

| Fournisseur | URL de base | Clé API | Modèle par défaut |
|----------|----------|---------|---------------|
| llama.cpp | `http://localhost:8080` | Non requise | (votre modèle chargé) |
| Ollama | `http://localhost:11434/v1` | Non requise | (votre modèle chargé) |
| LM Studio | `http://localhost:1234/v1` | Non requise | (votre modèle chargé) |
| OpenAI | `https://api.openai.com/v1` | Requise | gpt-5.5 |
| Anthropic Claude | `https://api.anthropic.com` | Requise | claude-sonnet-4-6 |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Requise | gemini-3.1-flash |
| Mistral AI | `https://api.mistral.ai/v1` | Requise | mistral-large-latest |
| DeepSeek | `https://api.deepseek.com/v1` | Requise | deepseek-v4-flash |
| xAI Grok | `https://api.x.ai/v1` | Requise | grok-4.3 |
| Nvidia NIM | `https://integrate.api.nvidia.com/v1` | Requise | meta/llama-3.1-8b-instruct |
| Groq | `https://api.groq.com/openai/v1` | Requise | llama-3.3-70b-versatile |
| MiniMax | `https://api.minimax.chat/v1` | Requise | minimax-m2.7 |
| Alibaba Cloud (Qwen) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Requise | qwen-max |
| OpenRouter | `https://openrouter.ai/api/v1` | Requise | stepfun/step-3.7-flash |

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

| Outil | Ask | Act | Compact | Description |
|------|-----|-----|---------|-------------|
| `get_accessibility_tree` | Oui | Oui | Oui | Texte indenté à plat de l'arbre d'accessibilité de la page avec des ref_ids persistants |
| `read_page` | Oui | Oui | Oui | Extrait le texte, les liens, les formulaires de la page (repli texte hérité) |
| `read_pdf` | Oui | Oui | -- | Extrait le texte des documents PDF via pdfjs-dist intégré |
| `screenshot` | Oui | Oui | Oui | Capture l'onglet visible (avec `save:true` optionnel vers Téléchargements) |
| `full_page_screenshot` | Oui | Oui | -- | Capture la page entière défilable (Chrome uniquement) |
| `get_interactive_elements` | Oui | Oui | -- | Liste tous les éléments cliquables/interactifs (hérité, traverse le shadow DOM) |
| `get_frames` | Oui | Oui | -- | Liste toutes les iframes de la page |
| `get_shadow_dom` | Oui | Oui | -- | Lit les arbres shadow DOM |
| `scroll` | Oui | Oui | Oui | Fait défiler la page |
| `extract_data` | Oui | Oui | Oui | Extrait les tableaux, titres, images |
| `get_selection` | Oui | Oui | Oui | Récupère le texte surligné |
| `click_ax` | -- | Oui | Oui | Clique sur un élément par ref_id de l'arbre d'accessibilité (préféré) |
| `type_ax` | -- | Oui | Oui | Saisit dans un champ par ref_id. Prend en charge `lang: "tr-deasciify"` |
| `set_field` | -- | Oui | Oui | Focus + effacement + saisie + vérification en une fois par ref_id. Prend en charge `lang: "tr-deasciify"` |
| `click` | -- | Oui | Oui | Clique sur des éléments par sélecteur, index ou coordonnées (repli hérité) |
| `type_text` | -- | Oui | Oui | Saisit dans les champs de saisie. Prend en charge `lang: "tr-deasciify"` |
| `press_keys` | -- | Oui | Oui | Appuie sur Échap, Tab ou Entrée |
| `hover` | -- | Oui | -- | Survol approuvé par CDP pour les menus révélés au survol (Chrome uniquement) |
| `drag_drop` | -- | Oui | -- | Glisser-déposer via les événements de pointeur CDP (Chrome uniquement) |
| `navigate` | -- | Oui | Oui | Aller à une URL |
| `new_tab` | -- | Oui | Oui | Ouvrir un nouvel onglet |
| `wait_for_element` | -- | Oui | Oui | Attendre qu'un sélecteur apparaisse |
| `wait_for_stable` | -- | Oui | -- | Attendre que la page soit inactive (aucune mutation du DOM + aucun réseau) |
| `upload_file` | -- | Oui | -- | Télécharger un fichier vers un champ de fichier (Chrome uniquement) |
| `execute_js` | -- | Oui | -- | Exécuter du JavaScript personnalisé (**Firefox uniquement** — bloqué par la CSP MV3 sur Chrome) |
| `fetch_url` | Oui | Oui | Oui | Récupérer une URL depuis l'arrière-plan avec les cookies de l'utilisateur |
| `research_url` | Oui | Oui | -- | Ouvrir une URL dans un onglet caché, attendre le rendu JS, retourner le contenu |
| `download_files` | -- | Oui | -- | Télécharger un ou plusieurs fichiers (url unique ou tableau, max 3 simultanés) |
| `download_resource_from_page` | -- | Oui | -- | Télécharger une URL `<img>`/`<video>`/blob de la page actuelle |
| `download_social_media` | -- | Oui | Oui | Téléchargement de médias sociaux en une fois ; DOM/CDN d'abord, repli optionnel par recadrage vision du média visible |
| `list_downloads` | Oui | Oui | -- | Lister les téléchargements récents avec statut et URL sources |
| `read_downloaded_file` | -- | Oui | -- | Récupérer à nouveau le contenu d'un fichier téléchargé (texte ou base64) |
| `iframe_read` / `iframe_click` / `iframe_type` | -- | Oui | -- | Lire/cliquer/saisir à l'intérieur d'iframes inter-origines |
| `record_tab` / `stop_recording` | -- | Oui | -- | Enregistrer la vidéo+audio de l'onglet en .webm avec transcription Whisper optionnelle (Chrome uniquement) |
| `scratchpad_write` | Oui | Oui | Oui | Épingler une note dans le contexte qui survit à la synthèse |
| `clarify` | Oui | Oui | Oui | Mettre en pause et poser une question à l'utilisateur |
| `verify_form` | -- | Oui | -- | Vérifier les champs du formulaire avant de soumettre |
| `solve_captcha` | -- | Oui | Oui | Résoudre les CAPTCHAs via l'API CapSolver (optionnel, nécessite une clé API) |
| `done` | Oui | Oui | Oui | Signaler l'achèvement de la tâche |

**Le mode Compact** est un ensemble d'outils réduit + un prompt système plus court conçu pour les petits modèles locaux (2B-8B). Dans les builds Chrome et Firefox, il réduit le schéma du mode Act de plus de 40 outils à environ 20, diminuant la surface de décision et les hallucinations. Activez-le par fournisseur dans les Paramètres (case à cocher sur llama.cpp, Ollama, LM Studio ; désactivé par défaut).

> **Note sur le Shadow DOM :** L'arbre d'accessibilité ne traverse que le light DOM. Sur les pages riches en Web Components (Stripe, Salesforce, Shopify), utilisez `get_interactive_elements` (traverse les shadow roots ouverts) ou `get_shadow_dom` / `shadow_dom_query` pour des lectures ciblées.

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

WebBrain accepte les commandes slash en tant que premier élément d'une ligne dans le champ de saisie. Tapez `/help` pour voir la liste dans le panneau.

| Commande | Ce qu'elle fait |
|---------|--------------|
| `/help` | Affiche la liste des commandes disponibles |
| `/schedule` | Créer une tâche planifiée |
| `/list-schedules` | Afficher les tâches planifiées |
| `/show-scratchpad` | Afficher le bloc-notes actuel |
| `/edit-scratchpad <texte>` | Ajouter du texte au bloc-notes actuel |
| `/allow-api` | **Dérogation de mutation API par conversation.** Lève la restriction UI-d'abord afin que l'agent puisse utiliser POST/PUT/PATCH/DELETE via `fetch_url` lorsque l'UI échoue. Un badge apparaît pendant l'activation ; il s'efface au `/reset`. |
| `/compact` | Force le compactage du contexte pour la conversation actuelle |
| `/verbose` | Bascule l'affichage des outils verbeux/compact (identique au bouton de la barre d'outils) |
| `/reset` | Efface la conversation et tous les indicateurs par conversation |
| `/screenshot` | Capture l'onglet visible et affiche l'image en ligne dans le chat |
| `/record` | Démarrer l'enregistrement de l'onglet actuel |
| `/export` | Télécharge la conversation actuelle sous forme de fichier Markdown |
| `/profile` | Bascule le remplissage automatique du profil sans ouvrir les Paramètres |
| `/vision` | Bascule le mode vision (compréhension de captures d'écran) sur le fournisseur actif |
| `/ask` | Passer en mode Demander avant d'envoyer |
| `/plan` | Passer en mode Demander avec une intention de planification |

La règle UI-d'abord par défaut existe parce que les actions API sont invisibles (vous ne voyez pas ce qui est envoyé), nécessitent souvent des jetons d'authentification distincts que vous n'avez peut-être pas configurés, et peuvent avoir un rayon d'impact bien plus grand qu'un mauvais clic visible. N'utilisez `/allow-api` que lorsque vous avez décidé d'accepter ce compromis pour une tâche spécifique.

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

Consultez [CHANGELOG.md](./CHANGELOG.md) pour l'historique complet des versions. Points forts récents : lecture PDF native avec passthrough Claude (8.x), plus de 65 corrections de bugs dans 8.5.0, le mode compact devenu entièrement opt-in (8.3.0), désasciification du turc (8.2.x), indicateur d'agent sur la page et panneau latéral limité au groupe d'onglets (6.0.x).

## Feuille de route

- [ ] **Export/import de conversation** — Sauvegarder et charger les historiques de chat
- [ ] **Définitions d'outils personnalisés** — Outils définis par l'utilisateur via les paramètres
- [ ] **Raccourcis clavier** — Touches de raccourci pour ouvrir le panneau, envoyer des messages, changer de mode
- [ ] **Intégration au menu contextuel** — Clic droit → « Demander à WebBrain à propos de ceci »
- [X] **Outil de capture d'écran/vision** — Envoyer des captures d'écran à des modèles multimodaux pour la compréhension visuelle
- [X] **Chrome Web Store / Firefox AMO** — Référencements officiels dans les boutiques

## Ajouter un nouveau fournisseur

1. Créez une nouvelle classe étendant `BaseLLMProvider` dans `src/providers/`
2. Implémentez `chat()` et optionnellement `chatStream()`
3. Enregistrez-la dans `src/providers/manager.js`

Tous les fournisseurs se normalisent vers un format de réponse commun :
```js
{ content: string, toolCalls: Array|null, usage: Object|null }
```


## Licence

MIT — créé par [Emre Sokullu](https://emresokullu.com)
