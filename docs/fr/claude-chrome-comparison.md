# WebBrain vs Extension Claude Chrome

Cette note compare le checkout WebBrain local avec `../webbrain-claude`, un
arbre désobfusqué de l'extension Claude Chrome. Elle se concentre sur
l'architecture, les outils appelables par le modèle et le comportement des
adaptateurs spécifiques aux sites.

## Sources inspectées

WebBrain :

- `docs/architecture.md`
- `docs/adding-a-tool.md`
- `docs/site-adapters.md`
- `docs/accessibility-tree-and-refs.md`
- `docs/webbrain-tool-tiers.xlsx`
- `src/chrome/ARCHITECTURE.md`
- `src/chrome/src/agent/tools.js`
- `src/chrome/src/agent/skills.js`
- `src/chrome/src/agent/adapters.js`
- `src/chrome/skills/freeskillz-xyz.md`
- Fichiers Firefox correspondants lorsque la parité est importante

Claude Chrome :

- `../webbrain-claude/manifest.json`
- `../webbrain-claude/settings.html`
- `../webbrain-claude/settings.js`
- `../webbrain-claude/assets/service-worker.js`
- `../webbrain-claude/assets/mcpPermissions.js`
- `../webbrain-claude/assets/PermissionManager.js`
- `../webbrain-claude/assets/sidepanel.js`
- `../webbrain-claude/assets/accessibility-tree.js`

L'arbre Claude est regroupé/minifié par endroits. Les noms d'outils ci-dessous
ont été reconstitués à partir des définitions `toAnthropicSchema()`, de la
distribution des messages natifs et de l'invite de commande rapide du panneau
latéral.

## Architecture

| Domaine | WebBrain | Extension Claude Chrome |
|---|---|---|
| Support navigateur | Deux builds d'extension miroirs : Chrome/Edge MV3 et Firefox MV2. | Chrome MV3 uniquement dans cet arbre. |
| Emplacement de l'agent | L'extension possède la boucle d'agent complète dans `agent.js` ; les fournisseurs sont des modules d'extension locaux. | Deux chemins : une boucle normale d'appel d'outils Anthropic dans le panneau latéral, plus un pont hôte natif/MCP dans le service worker. |
| Modèle de fournisseur LLM | L'abstraction de fournisseur prend en charge les points de terminaison compatibles OpenAI, Anthropic, llama.cpp/LM Studio/Ollama locaux et les paramètres du fournisseur. | Principalement l'API Messages Anthropic ; le mode rapide du panneau latéral pointe vers `http://localhost:4000` lorsqu'il est configuré, et les noms d'hôte natifs ciblent l'intégration Claude desktop / Claude Code. |
| Distribution des outils | `getToolsForMode()` retourne des schémas de fonctions de style OpenAI depuis `tools.js`, éventuellement étendus par les outils de compétences activés. `agent.js` distribue les outils vers les scripts de contenu, les API Chrome, CDP, les helpers réseau ou les exécuteurs de compétences. | Les schémas de style MCP se trouvent dans `mcpPermissions.js`. Le panneau latéral exécute les appels d'outils par nom. Le mode rapide utilise un DSL de commande compact sans outils Anthropic, puis convertit les commandes en appels/résultats d'outils synthétiques. |
| Lecture de page | Outil arbre AX préféré avec `ref_id` stables plus lecteurs de prose/page source/PDF. | Un lecteur d'arbre AX existe aussi et utilise `window.__wbElementMap` / IDs `ref_`, mais l'outil d'action navigateur principal est davantage orienté coordonnées/ordinateur. |
| Événements navigateur de confiance | Chrome utilise CDP pour les événements souris/clavier de confiance, les captures d'écran, l'accès aux shadow DOM fermés et certains chemins de téléchargement de fichiers. Firefox utilise des événements synthétiques. | Chrome utilise `debugger`/CDP pour les actions informatiques, les captures d'écran, l'évaluation JavaScript, les téléchargements, le suivi console/réseau et les captures d'écran zoomées. |
| Contrôles de conversation | Modes Demander/Agir, planifier avant d'agir, bloc-notes, registre de progression, tâches/reprises planifiées, traces optionnelles. | Modes de permission, approbation du plan via `update_plan`, invites de transition de domaine, groupes d'onglets, compaction, statut hôte natif/MCP. |
| Modèle d'extension dynamique | Les compétences utilisateur/importées peuvent injecter du texte d'invite et déclarer des outils runtime `webbrain-tools`. | Les extensions natives/MCP et les raccourcis sont les points d'extension visibles dans l'arbre désobfusqué ; aucun manifeste d'outil Markdown modifiable par l'utilisateur n'a été trouvé. |

## Surface d'outils WebBrain

Outils statiques de base actuels de la source locale :

- Chrome : 57 outils de base.
- Firefox : 48 outils de base.
- Outils de base Chrome uniquement : `shadow_dom_query` ainsi que les outils Dev réversibles/de diagnostic `inject_css`, `remove_injected_css`, `patch_element`, `revert_patch`, `read_console`, `inspect_network_requests`, `inspect_event_listeners` et `highlight_element`.
- `execute_js` est partagé : Chrome Dev utilise l'évaluation CDP et Firefox Dev son évaluateur de script de contenu MV2.
- Les outils de compétences dynamiques peuvent ajouter d'autres schémas à l'exécution et ne sont pas inclus dans ces décomptes.

Outils de base du mode Demander :

```text
get_accessibility_tree, read_page, read_pdf,
get_window_info, get_interactive_elements, scroll, extract_data,
get_selection, done, wait_for_stable,
fetch_url, research_url, list_downloads
```

Liste statique des outils de base Chrome (union de tous les modes et niveaux) :

```text
get_accessibility_tree, click_ax, type_ax, set_field, hover, drag_drop,
read_page, read_pdf, read_page_source, get_window_info, resize_window,
get_interactive_elements, click, type_text, press_keys, scroll, navigate,
go_back, go_forward, extract_data, inspect_element_styles, wait_for_element,
inject_css, remove_injected_css, patch_element, revert_patch, execute_js,
read_console, inspect_network_requests, inspect_event_listeners,
highlight_element, wait_for_stable, schedule_resume, schedule_task, get_selection, new_tab,
done, clarify, get_shadow_dom, shadow_dom_query, get_frames, iframe_read,
iframe_click, iframe_type, fetch_url, research_url, list_downloads,
read_downloaded_file, download_resource_from_page, download_files,
upload_file, scratchpad_write, progress_update, progress_read,
verify_form, download_social_media, solve_captcha
```

Firefox omet les outils Dev exclusifs à Chrome et `shadow_dom_query` ; le reste
de la surface de base, y compris `execute_js` réservé au mode Dev, est partagé.

### Familles d'outils WebBrain

| Famille | Outils |
|---|---|
| Contrôle DOM AX prioritaire | `get_accessibility_tree`, `click_ax`, `type_ax`, `set_field`, `hover`, `drag_drop` |
| Repli DOM hérité | `get_interactive_elements`, `click`, `type_text`, `press_keys`, `scroll`, `wait_for_element`, `wait_for_stable` |
| Navigation et onglets | `navigate`, `go_back`, `go_forward`, `new_tab` |
| Lecture/extraction | `read_page`, `read_pdf`, `read_page_source`, `extract_data`, `inspect_element_styles`, `get_selection` |
| Édition et diagnostic Dev | `inject_css`, `remove_injected_css`, `patch_element`, `revert_patch`, `execute_js`, `read_console`, `inspect_network_requests`, `inspect_event_listeners`, `highlight_element` |
| Shadow DOM et cadres | `get_shadow_dom`, `shadow_dom_query` sur Chrome, `get_frames`, `iframe_read`, `iframe_click`, `iframe_type` |
| Réseau et fichiers | `fetch_url`, `research_url`, `list_downloads`, `read_downloaded_file`, `download_resource_from_page`, `download_files`, `upload_file` sur Chrome |
| Travail longue durée | `schedule_resume`, `schedule_task`, `scratchpad_write`, `progress_update`, `progress_read` |
| Sécurité/flux de travail | `verify_form`, `clarify`, `done`, `solve_captcha` |
| Média | `download_social_media`, plus les outils de compétences dynamiques lorsqu'ils sont activés |

### Outils de compétences dynamiques WebBrain

WebBrain dispose de deux classes d'outils déclarées dans les blocs Markdown de
compétences :

- `kind: "http"` : outils GET/POST HTTPS en lecture seule, disponibles en modes
  Demander et Agir selon leurs `modes` de manifeste.
- `kind: "httpDownloadJob"` : outils de tâche POST HTTPS (mode Agir uniquement)
  qui créent une tâche, interrogent le statut, récupèrent le fichier, sauvegardent
  via les téléchargements du navigateur et nettoient.

La compétence `FreeSkillz.xyz` intégrée expose :

```text
read_youtube_transcript
resolve_public_media
download_public_media
```

Ce ne sont pas des mutations `/allow-api`. Elles sont approuvées au moment de
l'importation/activation de la compétence, utilisent `credentials: "omit"`, et
doivent marquer les résultats tiers comme non fiables.

## Surface d'outils Claude Chrome

Schémas MCP/outils reconstitués :

```text
computer, javascript_tool, file_upload, find, form_input, get_page_text,
gif_creator, navigate, read_console_messages, read_network_requests,
read_page, resize_window, tabs_context, tabs_create, turn_answer_start,
update_plan, upload_image, tabs_context_mcp, tabs_create_mcp, tabs_close_mcp,
shortcuts_list, shortcuts_execute
```

La plus grande différence de conception est que Claude regroupe de nombreuses
actions navigateur dans `computer`, avec une énumération `action` :

```text
left_click, right_click, type, screenshot, wait, scroll, key,
left_click_drag, double_click, triple_click, zoom, scroll_to, hover
```

Le mode rapide du panneau latéral possède un DSL de commande séparé :

```text
ST tabId        sélectionner un onglet
NT url          ouvrir un nouvel onglet
LT              lister les onglets
C x y           cliquer
RC x y          clic droit
DC x y          double-clic
TC x y          triple-clic
H x y           survoler
T text          taper
K keys          appuyer sur des touches
S dir amt x y   défiler
D x1 y1 x2 y2  glisser
Z x1 y1 x2 y2  capture d'écran zoomée d'une région
N url           naviguer, retour ou avant
J code          exécuter JavaScript
W               attendre la stabilisation de la page
```

Le mode rapide envoie `tools: []` à Anthropic, analyse ces commandes textuelles,
les exécute localement, puis ajoute des messages `tool_use` / `tool_result`
synthétiques avec une nouvelle capture d'écran.

### Familles d'outils Claude

| Famille | Outils |
|---|---|
| Actions navigateur/informatique | `computer`, `navigate`, `resize_window` |
| Lecture/recherche de page | `read_page`, `get_page_text`, `find` |
| Travail DOM/formulaire/fichier | `form_input`, `file_upload`, `upload_image`, `javascript_tool` |
| Débogage | `read_console_messages`, `read_network_requests` |
| Onglets et groupes d'onglets MCP | `tabs_context`, `tabs_create`, `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp` |
| Flux de travail et permissions | `update_plan`, `turn_answer_start` |
| Réutilisation/export | `gif_creator`, `shortcuts_list`, `shortcuts_execute` |

## Différences d'outils

| Capacité | WebBrain | Claude Chrome |
|---|---|---|
| Granularité des outils | Beaucoup d'outils étroits : clic AX, saisie, définition de champ, réseau, téléchargements, planificateur, iframe, PDF, source, progression. | Moins d'outils de haut niveau ; la saisie navigateur est principalement un outil `computer` avec une énumération d'actions. |
| Chemin de lecture principal | `get_accessibility_tree` est la première lecture préférée et retourne des références stables avec pagination/dégradation automatique. | `read_page` retourne également un arbre d'accessibilité, mais le contrôle par coordonnées basé sur les captures d'écran est plus central, surtout en mode rapide. |
| Recherche d'élément en langage naturel | Pas de `find` autonome basé sur un modèle ; le modèle lit généralement l'arbre AX et choisit des références. | Dispose de `find`, qui exécute un petit appel de modèle sur l'arbre d'accessibilité et retourne les références correspondantes. |
| Texte de page | `read_page` est orienté prose/article ; `get_accessibility_tree` est orienté UI. | Sépare `read_page` (arbre AX) et `get_page_text` (texte brut/article). |
| Lecture PDF | `read_pdf` extrait le texte PDF directement. | Aucun équivalent trouvé. |
| Lecture de source brute | `read_page_source` expose le HTML fourni par le serveur et les URLs des ressources. | Aucun équivalent trouvé. |
| Requête réseau | `fetch_url` / `research_url`, avec des règles de mutation d'API spécifiques à WebBrain et `/allow-api` pour les méthodes mutantes. | Aucun outil de requête générique trouvé. Des logs réseau de débogage existent via `read_network_requests`. |
| Inspection console/réseau | Pas de lecteur de logs console dédié dans la liste des outils de base WebBrain. Des raccourcis réseau existent pour l'observation d'API, mais pas un lecteur de logs de requêtes orienté modèle. | `read_console_messages` et `read_network_requests` dédiés. |
| Téléchargements | Plusieurs outils de téléchargement/fichier navigateur plus des outils de compétences de tâche de téléchargement dynamiques. | La permission `downloads` existe et `gif_creator` peut télécharger des exports, mais aucun gestionnaire de téléchargement général équivalent n'a été trouvé. |
| Téléchargement média | Compétence `download_public_media` d'abord ; `download_social_media` en repli navigateur. | Aucun équivalent de téléchargement de média public trouvé. |
| Téléchargement de fichier | Chrome dispose de `upload_file` par flux orienté downloadId/chemin ; Firefox ne l'a pas. | `file_upload` définit directement des chemins absolus locaux sur une entrée fichier ; `upload_image` télécharge des images capturées/utilisateur par référence ou coordonnée. |
| Planificateur | `schedule_resume` et `schedule_task`. | L'interface utilisateur/les chaînes d'invite de tâches planifiées existent, mais aucun schéma de planificateur appelable par le modèle équivalent n'a été trouvé dans la liste d'outils visible. |
| CAPTCHA | `solve_captcha` lorsque CapSolver est configuré. | L'invite de sécurité explicite demande de respecter les CAPTCHA et de ne jamais les contourner ; aucun outil de résolution trouvé. |
| Mémoire persistante de l'agent | `scratchpad_write`, `progress_update`, `progress_read`. | La compaction de conversation existe ; aucun outil équivalent de bloc-notes/progression trouvé. |
| Sécurité des formulaires | `verify_form` pour les formulaires importants. | `form_input` peut définir des valeurs ; aucun outil de vérification de formulaire dédié trouvé. |
| Iframes | `get_frames`, `iframe_read`, `iframe_click`, `iframe_type` dédiés. | Aucun outil iframe dédié trouvé ; les actions se font probablement par coordonnées/JS lorsque c'est permis. |
| Raccourcis/flux de travail | Les compétences personnalisées sont du Markdown avec des manifestes d'outils optionnels. | `shortcuts_list` / `shortcuts_execute` exposent les raccourcis/flux de travail sauvegardés. |
| Flux de travail GIF/vidéo | L'enregistrement via slash existe dans WebBrain Chrome, mais pas en tant qu'outils appelables par le modèle. | `gif_creator` est appelable par le modèle et peut enregistrer/exporter des sessions d'automatisation navigateur en GIF. |

## Adaptateurs spécifiques aux sites

### WebBrain

WebBrain dispose d'un véritable système d'adaptateurs de sites :

- Les fichiers d'adaptateurs se trouvent dans `src/chrome/src/agent/adapters.js`
  et `src/firefox/src/agent/adapters.js`.
- `getActiveAdapter(url)` retourne le premier adaptateur correspondant.
- Un seul adaptateur s'exécute à la fois.
- Les notes des adaptateurs sont injectées dans le premier message utilisateur.
- Si la navigation passe à un adaptateur correspondant différent en cours de
  conversation, WebBrain injecte un nouveau message utilisateur
  `[Contexte du site modifié ...]`.
- `UNIVERSAL_PREAMBLE` est ajouté à l'invite système lorsque les adaptateurs
  sont activés. Il couvre les bannières de cookies/consentement, les paywalls
  et le comportement des onglets PDF.
- Les adaptateurs financiers contiennent un langage à enjeux élevés et doivent
  précéder `finance-generic`.
- Les modifications des adaptateurs Chrome et Firefox doivent rester en miroir.

Inventaire actuel des adaptateurs depuis `listAdapters()` :

```text
github, gitlab, stackoverflow, hackernews, gmail, google-docs,
google-calendar, slack, notion, jira, twitter, linkedin, reddit, youtube,
medium, substack, wordpress, amazon, aws, gcp, cloudflare, vercel, nytimes,
wsj, ft, bloomberg, economist, washingtonpost, stripe, coinbase, robinhood,
tradingview, finance-generic, airbnb, booking, expedia, google-maps,
google-flights, kayak, opentable, ebay, walmart, target, etsy, sahibinden,
trendyol, apple, outlook, google-sheets, trello, instagram, tiktok, facebook,
leetcode, hackerrank, greenhouse, workday, discord, whatsapp-web, telegram,
mastodon
```

Comportement notable des adaptateurs :

- Les adaptateurs codent des indications sur la structure de la page, pas des
  sélecteurs fragiles.
- WordPress est indépendant de l'hôte via `/wp-admin` et `/wp-login.php`.
- Mastodon utilise un vaste ensemble d'hôtes connus plus une correspondance
  d'URL conservative pour éviter de revendiquer tout chemin générique `/@user`
  sur le web.
- La préséance financière est importante : une correspondance financière large
  peut masquer des adaptateurs spécifiques à moins que les exclusions/l'ordre
  soient maintenus.

### Claude Chrome

L'arbre Claude désobfusqué possède une interface de paramètres qui mentionne
« Adaptateurs de sites » :

- `settings.html` expose un bouton « Adaptateurs de sites ».
- `settings.js` lit et écrit `useSiteAdapters`.

Cependant, aucun registre d'adaptateurs sous-jacent, d'équivalent
`getActiveAdapter`, d'injection de préambule universel ou de chemin d'injection
de conseils spécifiques au site n'a été trouvé dans l'arbre Claude inspecté.
Les recherches de marqueurs d'adaptateurs de style WebBrain n'ont trouvé que
l'étiquette/le chemin de stockage des paramètres.

Les équivalents Claude les plus proches ne sont pas des adaptateurs de sites :

- Modes de permission de domaine et invites de transition de domaine.
- Gestion des politiques / blocage de domaine.
- Métadonnées de compétences de domaine dans les rappels de contexte d'onglet.
- Étiquettes d'intégration MCP/Gmail/Google ailleurs dans le bundle UI.

La différence pratique d'adaptateur est donc :

- WebBrain dispose d'une augmentation d'invite spécifique au site en tant que
  fonctionnalité d'agent navigateur de première classe.
- Claude Chrome, dans cet arbre désobfusqué, semble s'appuyer sur des captures
  d'écran, `find`, les permissions de domaine et le contexte d'onglet/domaine
  plutôt que sur des notes d'adaptateur par site.

## Idées à emprunter

Idées potentiellement utiles de Claude pour WebBrain :

- Un outil `find` qui utilise un modèle petit/rapide sur l'arbre AX pour
  retourner des références candidates pour des descriptions vagues d'éléments.
- Des lecteurs de requêtes console et réseau orientés modèle pour déboguer les
  applications web.
- Un outil d'export GIF/flux de travail si l'enregistrement/export appelable
  par le modèle est souhaité.
- Des primitives de liste et d'exécution de raccourcis/flux de travail, si
  WebBrain souhaite une couche de flux de travail réutilisable distincte des
  compétences Markdown.
- Téléchargement direct d'image par ID de capture d'écran/d'image, si les flux
  de travail de pièce jointe d'image du panneau latéral se développent.

Idées à éviter de copier directement :

- Une surface d'« adaptateurs de sites » uniquement dans les paramètres sans
  registre sous-jacent ni chemin d'injection.
- Regrouper trop d'opérations navigateur déterministes dans un seul schéma
  `computer` si WebBrain souhaite préserver sa sémantique d'outils étroite,
  vérifiable et actuelle.
- Traiter le contrôle par capture d'écran/coordonnées comme le chemin principal
  lorsque des références AX stables sont disponibles.

## Suivi documentaire

Si cette comparaison devient une documentation destinée aux utilisateurs :

- Mettez à jour les décomptes à partir de `src/chrome/src/agent/tools.js` et
  `src/firefox/src/agent/tools.js` avant publication.
- Réexécutez `listAdapters()` pour éviter un inventaire d'adaptateurs obsolète.
- Traitez les détails Claude comme du rétro-ingénierie locale, pas un contrat
  de produit en amont.
- Si l'arbre Claude est actualisé, revérifiez si `useSiteAdapters` a acquis un
  registre d'adaptateurs sous-jacent.
