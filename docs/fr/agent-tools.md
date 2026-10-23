# Outils de l'agent

DIV sépare le **niveau du modèle** du **mode de conversation**.

- **Niveau** (`compact`, `mid`, `full`) est un réglage par fournisseur. Il
  contrôle le nombre d'outils navigateur normaux que le modèle voit.
- **Mode** (`ask`, `act`, `dev`) est choisi par conversation. Il contrôle le type
  de tâche que l'utilisateur autorise.

| Mode | Ce qu'il autorise |
|---|---|
| **Ask** | Lecture seule. Pas de clic, de saisie, de navigation ni de téléchargement. |
| **Act** | Les outils navigateur normaux du niveau sélectionné. |
| **Dev** | Exige un fournisseur Mid ou Full. Ajoute une annexe source/style/debug, y compris une inspection DOM/frame plus profonde pour les exécutions Dev en Mid. Le mode Dev en Compact est bloqué avant l'envoi d'une requête au LLM. |

| Niveau | Classe de modèle visée | Surface d'outils normaux |
|---|---|---|
| `compact` | très petits modèles locaux | Prompt le plus court et petit ensemble d'outils Act normaux. Pas de planification, d'iframe, de téléchargement de ressource ni de repli DOM/UI avancé. |
| `mid` | modèles locaux capables | Outils de tâche courants : téléchargements, planification, outils iframe, vérification de formulaires. Sans les replis avancés réservés à Full. |
| `full` | modèles frontière/cloud ou grands modèles locaux | Tout, y compris hover, drag-drop, frames et shadow DOM. |

Les valeurs par défaut et les règles de résolution des niveaux sont documentées
dans [fournisseurs et modèles](providers-and-models.md#niveaux-de-promptoutils-et-modes).

## Lecture complète d'un fil Gmail

Le premier résultat d'accessibilité d'un fil Gmail expose le
`conversationRootRefId` fiable de la conversation active. Une lecture complète
doit paginer uniquement ce sous-arbre ancré avec `filter:"all"`, `maxDepth:15`
et chaque `continuationArgs` exact jusqu'à `hasMore:false`. Les pages 2 et
suivantes de la racine du document contiennent des lignes de boîte de réception
sans rapport et ne comptent pas. **Collapse all** doit aussi confirmer séparément
que Gmail a développé la conversation.

## Matrice des outils

Légende : **Oui** = disponible · **-** = indisponible · **C** = Chrome
uniquement · **Dev** = module Dev (fournisseurs Mid/Full ; pas Compact).

| Outil | Ask | Compact | Mid | Full | Dev |
|-------|:---:|:-------:|:---:|:----:|:---:|
| `get_accessibility_tree` | Oui | Oui | Oui | Oui | - |
| `read_page` | Oui | Oui | Oui | Oui | - |
| `read_pdf` | Oui | Non | Oui | Oui | - |
| `list_webmcp_tools` | C | Non | C | C | - |
| `execute_webmcp_tool` | Non | Non | C | C | - |
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
| `promote_iframe` | Non | Non | Oui | Oui | - |
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
| `upload_file` | Non | Non | Oui | Oui | - |
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

`promote_iframe` est un outil Act normal des niveaux Mid/Full, et non un
module réservé au mode Dev. Les sessions Dev avec un fournisseur Mid ou Full
l'héritent du niveau Act sélectionné. Voir le
[ciblage des iframes](accessibility-tree-and-refs.md#ciblage-des-iframes) pour le
flux de travail en page autonome et les contrôles de sécurité.

> **Note Shadow DOM :** L'arbre d'accessibilité ne traverse que le light DOM.
> Sur les pages riches en Web Components (Stripe, Salesforce, Shopify), utilisez
> d'abord `get_interactive_elements` ; en Full Act ou Dev, utilisez
> `get_shadow_dom` / `shadow_dom_query` pour des lectures ciblées.

## Outils absents du tableau

**Outils de compétence.** Les compétences chargées peuvent ajouter des schémas
d'outils pour l'exécution en cours. La compétence FreeSkillz.xyz intégrée, par
exemple, peut exposer `read_youtube_transcript` ainsi que
`resolve_public_media` / `download_public_media`. Ces outils ne sont pas codés en
dur : avant le chargement de la compétence (ou si elle est retirée), ils sont
absents. Le mode Ask filtre toujours les outils de mutation et de téléchargement,
même lorsque la compétence propriétaire est chargée. Voir
[compétences](skills.md).

**WebMCP (expérimental, activé par défaut).** Les lignes `list_webmcp_tools` /
`execute_webmcp_tool` ne s'appliquent que lorsque **WebMCP expérimental** est
activé dans Paramètres → Général → Avancé. Le réglage est activé par défaut ;
lorsqu'il est désactivé, les outils et leurs consignes de prompt sont omis des
requêtes au modèle. Les annotations WebMCP telles que `readOnly` sont des indications
écrites par la page, pas une frontière de sécurité. Chaque invocation exige Act
ou Dev, une confirmation fraîche à chaque appel, et la permission normale
capacité × origine de la frame d'enregistrement. WebMCP nécessite actuellement
un build/une configuration de page Chrome compatible ; Firefox n'expose pas ces
outils.

## Édition et diagnostics en mode Dev

Les outils Dev ne sont exposés qu'en mode Dev, et le mode Dev est bloqué pour les
fournisseurs de niveau Compact. Les outils d'édition réversible de Chrome
renvoient des patch IDs : `inject_css` va avec `remove_injected_css`, et
`patch_element` avec `revert_patch`.

- **`inject_css` / `remove_injected_css`** appliquent et annulent du CSS
  temporaire par `patchId`. Chaque patch est unique et lié au document exact de
  la page, et ses métadonnées sont conservées en session storage pour qu'un
  redémarrage du service worker ne perde pas la poignée d'annulation. La
  navigation invalide l'ancienne poignée au lieu de la laisser affecter une page
  de remplacement.
- **`patch_element` / `revert_patch`** effectuent des modifications structurées
  de styles inline, de classes et d'attributs avec des valeurs avant/après
  exactes. Les noms de styles et d'attributs HTML équivalents sont canonicalisés
  avant la création de l'enregistrement d'annulation, les opérations
  set/remove contradictoires sont rejetées, et les attributs d'URL exécutables
  rejettent les valeurs `javascript:` (y compris `action` de formulaire).
  `highlight_element` fournit une surcouche de cible temporaire transparente aux
  pointeurs ; comme elle insère du DOM vivant, elle utilise la permission de
  patch Dev temporaire.
- **`execute_js`** exécute un corps de fonction JavaScript asynchrone dans le
  monde principal de la page. Chrome utilise CDP `Runtime.evaluate` avec une
  limite d'exécution de 15 secondes ; Firefox utilise son évaluateur de script de
  contenu MV2. L'outil est soumis à une permission d'hôte et reçoit une
  confirmation de soumission fraîche.
- **`read_console`, `inspect_network_requests`, `inspect_event_listeners`**
  fournissent des diagnostics bornés sur Chrome. La capture démarre avant les
  exécutions Dev streamées ou non, et s'arrête quand l'onglet quitte le mode Dev
  ou que sa conversation est effacée ; quitter Dev vide tous les onglets ayant
  une capture active même si le panneau a changé d'onglet, retire les
  gestionnaires et les tampons, et désactive les domaines CDP correspondants.
  L'inspection des écouteurs ajoute et restaure brièvement un attribut de cible
  interne, suit les hôtes shadow ouverts lors de la collecte des ancêtres, et
  utilise donc la même permission d'hôte que les patchs Dev temporaires. Les
  en-têtes et corps réseau sont omis par défaut, les noms d'en-têtes sensibles
  (y compris les variantes courantes de clés d'API/d'abonnement) sont caviardés
  avant la mise en tampon, et la sortie de diagnostic issue de la page est
  traitée comme du contenu non fiable.

## Voir aussi

- [Ajouter un outil](adding-a-tool.md) — la checklist pour les outils nouveaux ou
  modifiés
- [Arbre d'accessibilité et refs](accessibility-tree-and-refs.md)
- [Modèle de sécurité](security-model.md) et
  [défense contre l'injection de prompt](prompt-injection-defense.md)
