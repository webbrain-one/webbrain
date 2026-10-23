<p align="center">
  <img src="assets/logo-mark.png" alt="Logo DIV" width="92">
</p>

<h1 align="center">DIV</h1>

<p align="center">
  Agent de navigation IA open source pour discuter avec les pages, automatiser les tâches et exécuter des workflows multi-étapes avec le LLM de votre choix.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb"><img src="https://img.shields.io/badge/Chrome-Installer-4285F4?style=for-the-badge&amp;logo=googlechrome&amp;logoColor=white" alt="Installer DIV depuis le Chrome Web Store"></a>
  <a href="https://addons.mozilla.org/en-US/firefox/addon/webbrain/"><img src="https://img.shields.io/badge/Firefox-Installer-FF7139?style=for-the-badge&amp;logo=firefoxbrowser&amp;logoColor=white" alt="Installer DIV depuis Firefox Browser Add-ons"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo"><img src="https://img.shields.io/badge/Edge-Installer-0A84FF?style=for-the-badge&amp;logo=microsoftedge&amp;logoColor=white" alt="Installer DIV depuis Microsoft Edge Add-ons"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="docs/fr/">Documentation</a> ·
  <a href="https://webbrain.one">Site web</a> ·
  <a href="LICENSE">GPL-3.0-or-later</a>
</p>

![DIV lit une page, remplit un formulaire et télécharge un fichier](assets/webbrain-demo.gif)

DIV est une extension de navigateur qui place un agent IA dans un panneau
latéral, à côté de vos onglets. Posez-lui des questions sur la page où vous
êtes, ou confiez-lui une tâche et laissez-le cliquer, saisir et naviguer pour
l'accomplir. Il tourne sur le modèle de votre choix — un serveur local
llama.cpp ou Ollama, une API cloud de pointe, ou l'option gérée par défaut qui
ne demande aucune configuration.

## Installation

Installez depuis le [Chrome Web Store](https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb),
les [modules Firefox](https://addons.mozilla.org/en-US/firefox/addon/webbrain/)
ou les [modules Edge](https://microsoftedge.microsoft.com/addons/detail/dfbioajafcijomhljabppcelecgdgfeo).

<details>
<summary><b>Ou chargez-le depuis les sources</b></summary>

```bash
git clone https://github.com/webbrain-one/webbrain.git
```

**Chrome** — ouvrez `chrome://extensions/`, activez le **mode développeur** (en
haut à droite), cliquez sur **Charger l'extension non empaquetée** et
sélectionnez le dossier `webbrain/src/chrome`.

**Firefox** — ouvrez `about:debugging#/runtime/this-firefox`, cliquez sur
**Charger un module complémentaire temporaire** et sélectionnez
`src/firefox/manifest.json`. Les modules temporaires sont supprimés au
redémarrage de Firefox ; une installation permanente nécessite une signature via
[addons.mozilla.org](https://addons.mozilla.org).

</details>

## Utilisation

Cliquez sur l'icône DIV pour ouvrir le panneau latéral, puis tapez par
exemple :

- « Résume cette page »
- « Trouve tous les liens à propos des tarifs »
- « Remplis le champ de recherche avec 'AI agents' et clique sur Rechercher »
- « Navigue vers github.com et trouve les dépôts tendance »

Trois modes contrôlent ce que l'agent a le droit de faire :

| Mode | Ce qu'il peut faire |
|---|---|
| **Ask** | Lecture seule. Lit la page, répond aux questions, récupère des URL. |
| **Act** | Clique, saisit, navigue, téléverse, télécharge, remplit des formulaires. |
| **Dev** | Ajoute source de page, styles, console, réseau et éditions réversibles. |

## Choisir un modèle

**DIV Compass 1.0** est l'option par défaut : ni clé API, ni configuration
locale.

**Les modèles locaux** ne demandent pas non plus de clé API. Pointez DIV
vers n'importe quel serveur compatible OpenAI :

```bash
llama-server -m your-model.gguf --port 8080          # llama.cpp
ollama serve                                          # Ollama  → :11434/v1
vllm serve your-model --port 8000                     # vLLM    → :8000/v1
python -m sglang.launch_server --model-path your-model --port 30000
```

LM Studio (`:1234/v1`), Jan (`:1337/v1`), LocalAI (`:8080/v1`) et GPT4All
(`:4891/v1`) fonctionnent de la même manière. Une carte générique **Proxy local
compatible OpenAI** accepte aussi les passerelles de boucle locale authentifiées
comme CLIProxyAPI ; consultez la [configuration sécurisée du proxy](docs/fr/providers-and-models.md#exemple-de-proxy-dabonnement-cliproxyapi).
Dimensionnez la fenêtre chargée pour le prompt et les schémas d'outils du niveau
choisi, la page, l'historique et la sortie demandée. **16k est une valeur de
configuration par défaut, pas un minimum garanti ; Compact ne tient pas
nécessairement dans 8k.** Mid et Full peuvent dépasser 16k avant même que
l'historique s'accumule ; la compression ne réduit pas le prompt ni les schémas
fixes. L'estimation ne remplace pas le tokenizer du modèle ; consultez le
[guide de contexte](docs/providers-and-models.md#local-providers). DIV détecte
automatiquement la fenêtre réelle pour llama.cpp, Ollama et LM Studio, et
compacte la conversation à mesure qu'elle se remplit. Il existe aussi un relais
`ollama launch webbrain --model <model>` en préversion. Détails :
[fournisseurs et modèles](docs/fr/providers-and-models.md#fournisseurs-locaux).

**API cloud** — OpenAI, Anthropic Claude, Google Gemini, Azure OpenAI, AWS
Bedrock, Mistral, DeepSeek, xAI Grok, MiniMax, Kimi, Qwen, z.ai GLM, Groq,
Together, Cloudflare, Nvidia NIM, Hugging Face, Fireworks, OpenRouter et
d'autres. Les Paramètres embarquent **106 cartes de fournisseurs sur Chromium**
(105 sur Firefox), dont l'option WebGPU locale sans endpoint — voir le
[catalogue complet](docs/fr/providers-and-models.md#catalogue-étendu-de-fournisseurs).

## Fonctionnalités

- **Lit n'importe quelle page** — texte, liens, formulaires, tableaux, PDF et
  éléments interactifs, via l'arbre d'accessibilité plutôt que des sélecteurs
  fragiles
- **Agit dessus** — cliquer, saisir, faire défiler, naviguer, téléverser,
  télécharger et vérifier des formulaires, avec des demandes d'autorisation par
  site avant toute action conséquente
- **Plan avant Act** — Act et Dev peuvent générer un plan structuré, l'afficher
  pour approbation, et l'épingler dans le scratchpad avant l'exécution du
  moindre outil
- **Agent multi-étapes** — boucle d'utilisation d'outils autonome, configurable
  jusqu'à 195 étapes (130 par défaut), avec un bouton Continuer en cas de limite
- **Workflows enregistrés** — transformez une exécution réussie en workflow
  réutilisable et sans valeurs, que vous pouvez relancer, exporter et partager
- **Tâches planifiées et surveillance** — `/schedule` pour plus tard, `/watch`
  pour interroger une page et agir quand une condition est remplie
- **Compétences** — instructions et outils de confiance chargés uniquement quand
  c'est pertinent
- **Contexte intelligent** — auto-compactage tenant compte des jetons, limites de
  résultats d'outils et récupération d'urgence en cas de débordement
- **Conversations par onglet** — chaque onglet garde son historique ; mémoire
  utilisateur locale optionnelle pour vos préférences déclarées
- **Panneau latéral pensé pour la lecture** — réponses Ask en streaming,
  commandes flottantes qui gardent votre question visible pendant que la réponse
  s'allonge, boutons de copie, bannière d'inspection de page et un bouton d'arrêt
  utilisable en cours d'exécution
- **Déterministe par défaut** — température `0.15` pour les décisions de contrôle
  du navigateur, `0.3` pour Ask, `0` pour les descriptions de captures d'écran

## Outils de l'agent

DIV sépare le **niveau** du **mode**. Le niveau (`compact`, `mid`, `full`)
est un réglage par fournisseur contrôlant le nombre d'outils que le modèle voit
— Compact convient aux petits modèles locaux, Full débloque hover, drag-drop,
frames et shadow DOM. Le mode (`ask`, `act`, `dev`) contrôle ce que
l'utilisateur autorise.

La matrice complète outil × niveau, les notes WebMCP et les diagnostics du mode
Dev se trouvent dans [outils de l'agent](docs/fr/agent-tools.md).

## Commandes slash

Tapez `/help` dans le panneau pour les syntaxes et options complètes. Les plus
utiles :

| Commande | Ce qu'elle fait |
|---------|--------------|
| `/ask` · `/act` · `/dev` · `/plan` | Changer de mode avant d'envoyer |
| `/schedule [invite]` | Créer une tâche planifiée |
| `/watch [--keep] [--secs <30-120>] [--long \| --short] <condition et action> [/beep]` | Interroger la page courante et agir quand une condition est remplie |
| `/workflow --save <nom>` | Compiler la dernière exécution réussie en workflow réutilisable |
| `/memory --add <texte>` | Enregistrer une préférence utilisateur |
| `/screenshot [--full-page]` | Capturer l'onglet, ou la page entière défilable |
| `/record [--transcribe]` | Enregistrer l'onglet actuel, avec transcription optionnelle |
| `/export [--traces \| --config]` | Télécharger la conversation, la chaîne d'outils ou un instantané des Paramètres |
| `/compact` · `/reset` · `/verbose` | Compacter le contexte, effacer la conversation, basculer le détail des outils |
| `/allow-api` | Dérogation par conversation autorisant `fetch_url` à muter quand l'UI échoue |

`/watch` effectue sa première vérification immédiatement, puis interroge toutes
les 60 secondes (`--secs` accepte 30 à 120). Les conditions relatives comme
« quand un nouveau commit apparaît » établissent une référence à la première
vérification ; `--keep` maintient la surveillance active et supprime les alertes
répétées pour la même clé d'événement stable.

Référence complète, y compris `/dangerously-skip-permissions` et les suffixes de
capture d'exécution : [commandes slash](docs/fr/slash-commands.md).

## Raccourcis clavier

Les raccourcis du panneau latéral Chrome fonctionnent lorsque le panneau latéral
DIV a le focus.

| Raccourci | Ce qu'il fait |
|----------|--------------|
| `Ctrl+/` ou `Cmd+/` | Mettre le focus dans le champ de saisie |
| `Ctrl+Shift+A` ou `Cmd+Shift+A` | Passer en mode Ask |
| `Ctrl+Shift+X` ou `Cmd+Shift+X` | Passer en mode Act |
| `Ctrl+Shift+D` ou `Cmd+Shift+D` | Passer en mode Dev |
| `Escape` | Arrêter l'exécution active, sauf s'il ne fait que fermer l'autocomplétion des commandes slash |
| `Escape` deux fois | Arrêter un enregistrement actif depuis DIV ou une page du navigateur |

## Documentation

| | |
|---|---|
| [Architecture](docs/fr/architecture.md) | Vue d'ensemble, flux d'un tour, sous-systèmes |
| [Outils de l'agent](docs/fr/agent-tools.md) | Niveaux, modes et matrice complète |
| [Commandes slash](docs/fr/slash-commands.md) | Toutes les commandes et options |
| [Fournisseurs et modèles](docs/fr/providers-and-models.md) | 106 cartes sur Chromium, 105 sur Firefox, configuration locale, niveaux |
| [Compétences](docs/fr/skills.md) | Compétences intégrées, import, outils de compétence |
| [Modèle de sécurité](docs/fr/security-model.md) | Permissions, identifiants, frontières de confiance |
| [Défense contre l'injection de prompt](docs/fr/prompt-injection-defense.md) | Couches de défense et limites connues |
| [Confidentialité et flux de données](docs/fr/privacy-and-data-flow.md) | Ce qui quitte le navigateur, et ce qui reste |
| [Arbre d'accessibilité et refs](docs/fr/accessibility-tree-and-refs.md) | Comment les pages sont lues et ciblées |
| [Adaptateurs de sites](docs/fr/site-adapters.md) | Consignes par site |
| [Export and workflow formats](docs/export-and-workflow-formats.md) | `webbrain-config/1`, `webbrain-workflow/1` (en anglais) |
| [Ajouter un outil](docs/fr/adding-a-tool.md) · [Localisation](docs/fr/localization.md) · [Scénarios de test](docs/fr/test-scenarios.md) | Guides pour contributeurs |

Également disponible en [English](docs/) et [中文](docs/zh-CN/).

## Structure du dépôt

```
src/chrome/     Build Manifest V3 — service worker, chrome.scripting, sidePanel
src/firefox/    Build Manifest V2 — page d'arrière-plan, executeScript, sidebar_action
docs/           Documentation de conception et de référence (en, zh-CN, fr)
lmstudio-plugin/  fetch_url + research_url en plugin LM Studio autonome
web/            Site vitrine et site de documentation
test/           Suite de tests Node, benchmarks de scénarios LLM, corpus de sécurité
```

La quasi-totalité du code de l'agent est partagée entre les deux builds. Voir
[architecture](docs/fr/architecture.md) pour les points de divergence.

## Problèmes connus

**Firefox est nettement plus faible que Chrome.** Firefox n'a pas d'équivalent au
Chrome DevTools Protocol via `chrome.debugger` : le build Firefox n'a donc pas de
traversée du shadow DOM, pas de véritables événements de souris approuvés
(certains gestionnaires React/Vue ne se déclenchent pas), pas de traversée de
shadow root fermé, pas de budget de réessai `resolveSelector`, pas de réessai
conscient de la navigation SPA, et pas de captures d'écran CDP (repli sur
`tabs.captureVisibleTab`, onglets actifs uniquement). Les adaptateurs de sites,
la détection par vision, la détection de boucle, la boucle de capture
automatique et l'ensemble prompt/outils Compact *sont* reflétés sur Firefox.
Certaines applications monopages peuvent aussi ne pas déclencher la réinjection
du content-script après une navigation côté client.

## Contribuer

Voir [CONTRIBUTING.md](CONTRIBUTING.md). Pour ajouter un outil, suivez la
checklist d'[ajout d'un outil](docs/fr/adding-a-tool.md). Pour ajouter un
fournisseur, étendez `BaseLLMProvider`, implémentez `chat()` (et éventuellement
`chatStream()`), et enregistrez-le dans `providers/manager.js` — en répercutant
les deux changements dans `src/chrome/` et `src/firefox/`. Tous les fournisseurs
se normalisent vers `{ content, toolCalls, usage }` ; détails dans
[fournisseurs et modèles](docs/fr/providers-and-models.md#ajouter-un-fournisseur).

Les changements récents sont dans [CHANGELOG.md](CHANGELOG.md).

## Plugin LM Studio

`fetch_url` et `research_url` sont également fournis comme plugin
[LM Studio](https://lmstudio.ai) autonome sur
[`webbrain/web-tools`](https://lmstudio.ai/webbrain/web-tools), pour utiliser des
outils de récupération web dans les chats LM Studio sans l'extension de
navigateur. Pur Node, sans navigateur sans interface.

```bash
lms clone webbrain/web-tools
```

Source : [`lmstudio-plugin/`](lmstudio-plugin/).


## Contributeurs

<a href="https://github.com/webbrain-one/webbrain/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=webbrain-one/webbrain" />
</a>

## Citation

```bibtex
@software{webbrain2026,
  author = {Sokullu, Emre},
  title = {DIV : Agent de navigation IA open source pour discuter avec les pages},
  year = {2026},
  publisher = {GitHub},
  url = {https://github.com/webbrain-one/webbrain}
}
```

## Licence

DIV est distribué sous
[GPL-3.0-or-later](LICENSE), car l’extension de navigateur distribuée intègre
le runtime WebAssembly Xapian/libzim sous GPL.

Créé avec ❤️ par [Emre Sokullu](https://emresokullu.com) et les [contributeurs open source](https://github.com/webbrain-one/webbrain/graphs/contributors).
