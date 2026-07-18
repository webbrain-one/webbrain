# Arbre d'accessibilité et système `ref_id`

Le sous-système d'arbre d'accessibilité (AX) est le principal chemin d'interaction avec la page pour l'agent. Il remplace l'ancien `get_interactive_elements` basé sur les index pour presque tous les flux.

---

## Architecture

Deux scripts de contenu chargés dans l'ordre :

1. **`accessibility-tree.js`** — le constructeur d'arbre et le registre `ref_id`
2. **`content.js`** — les gestionnaires d'outils qui utilisent l'arbre

Les deux sont injectés dans les pages `<all_urls>` à `document_idle`.

---

## L'arbre (`accessibility-tree.js`)

Construit l'arbre avec un `generateAccessibilityTree(...)` interne (invoqué par l'agent via `executeScript`) et installe une API de résolution de référence sur `window` (`__wbElementMap`, `__wb_ax_lookup`, `__wb_ax_release`) :

### `generateAccessibilityTree(filter, maxDepth, maxChars, ref_id, page)`

Parcourt le DOM et émet un arbre textuel indenté plat :

```
dialog "Add a product" [ref_166]
 heading "Add a product" [ref_167]
 button "Close" [ref_169]
 textbox "Name" [ref_170] type="text" placeholder="Product name" value="namaz"
 combobox "Billing period" [ref_180] type="button"
```

**Paramètres :**
| Paramètre | Défaut | Description |
|---|---|---|
| `filter` | `'all'` | `'all'` (tout le DOM), `'visible'` (neuds visibles dans la fenêtre), `'interactive'` (cliquables/saisissables uniquement) |
| `maxDepth` | `15` | Profondeur maximale de l'arbre à parcourir |
| `maxChars` | — | Limite stricte de longueur de sortie (découpe automatique avec `autoDegraded:true` si dépassée) |
| `ref_id` | — | Ancrer sur le sous-arbre d'un élément spécifique au lieu de `document.body` |
| `page` | — | Numéro de chunk basé sur 1 pour les résultats paginés lorsque l'arbre est tronqué |

**Format de sortie :**
```
role "accessible name" [ref_id] href="..." type="..." placeholder="..." value="..."
```

L'indentation est de 1 espace par niveau de profondeur d'arbre (les conteneurs génériques ignorés n'augmentent pas la profondeur).

### `__wb_ax_lookup(ref_id)`

Résout une chaîne `ref_N` vers l'élément DOM vivant. Retourne `null` si l'élément a été supprimé du DOM.

### `__wb_ax_suggest(ref_id, n)`

Lorsqu'une recherche échoue, retourne jusqu'à `n` `ref_id` toujours valides à proximité pour que le message d'erreur puisse guider le modèle vers la bonne direction.

---

## Registre ref_id (`window.__wbElementMap`)

### Fonctionnement

- Un objet simple (`Object.create(null)`) indexé par des chaînes `ref_N`
- Chaque valeur est un `WeakRef` vers l'élément DOM
- Un compteur monotone (`window.__wbRefCounter`) attribue le prochain `ref_N`
- La carte est **partiellement effacée** au début de chaque construction d'arbre : les entrées dont `deref()` retourne `null` sont balayées. Les entrées vivantes survivent entre les appels.

### Propriétés de stabilité

- **Au sein d'un tour** : un `ref_id` récupéré de `get_accessibility_tree` est garanti de résoudre dans le même tour.
- **Entre les tours** : un `ref_id` résolve tant que l'élément survit dans le DOM. Les éléments supprimés par navigation ou manipulation DOM deviennent irrésolubles (l'outil retourne une erreur claire « non trouvé » et suggère de relire l'arbre).
- **Après navigation SPA** : la carte survit, mais la plupart des éléments de l'ancienne route ont disparu → leurs refs échoueront. L'agent doit rappeler `get_accessibility_tree` après la navigation.

### Pourquoi des WeakRef

Sans `WeakRef`, la carte épinglerait chaque élément qu'elle a jamais indexé, empêchant le ramasse-miettes et fuyant la mémoire sur les pages à longue durée de vie (SPA, applications de chat). Avec `WeakRef`, le navigateur peut GC les éléments supprimés naturellement. Le coût est que `deref()` peut retourner `null` même pour des éléments qui existent si le GC s'est exécuté — mais en pratique c'est rare au sein d'un seul tour d'agent (sous-seconde) et l'agent relit l'arbre lors de la navigation de toute façon.

---

## Outils AX

### `get_accessibility_tree`

L'outil principal de lecture de page. Retourne la chaîne d'arbre rendue plus les métadonnées (`truncated`, `hasMore`, `autoDegraded`, `notice`).

L'agent l'utilise comme première action à presque chaque tour — c'est plus rapide et moins coûteux qu'une capture d'écran, et fonctionne sur les modèles textuels uniquement.

### `click_ax({ref_id})`

1. Résout `ref_id` via `__wb_ax_lookup()`
2. Défile dans la vue (`scrollIntoView({block: 'center'})`)
3. Focus l'élément
4. Déclenche `el.click()`

Retourne `{success, method, tag, rect, name, href?, navigates?, hint?}`.

Les deux versions conservent d'abord le chemin compatible `el.click()` synthétique. Sous Chrome uniquement, une cible générique sûre peut recevoir un unique repli protégé via CDP `Input.dispatchMouseEvent` après deux intervalles d'observation stables de la page et de la cible. Un changement d'URL, de focus provoqué par le gestionnaire, une mutation locale synchrone ou un état sémantique différé tel que `aria-current` prouve une progression. Les variations globales ainsi que les changements différés de nom, classe, style ou enfants de la cible ne sont conservés que comme indices de diagnostic, car les aperçus de conversations, badges non lus et horodatages peuvent être sans rapport. Une requête XHR mutante proche ou un beacon hors télémétrie, un nouvel onglet ou un téléchargement rend le résultat non concluant et interdit la relance ; les lectures en arrière-plan et le trafic manifeste de télémétrie ou de heartbeat sont ignorés. Les cibles masquées par CSS, sans événements de pointeur, natives, avec état/bascule, dans un formulaire, de téléchargement ou potentiellement mutantes ne sont jamais retentées automatiquement. Firefox reste entièrement synthétique.

Aucune fenêtre d'observation finie ne peut prouver un état interne de l'application qui ne produit aucun signal d'URL, de focus, d'état sémantique, de réseau, d'onglet, de téléchargement ou d'interface visible. Les garde-fous des cibles génériques, l'attente différée et la règle d'un seul essai réduisent, sans l'éliminer complètement, le risque qu'un gestionnaire synthétique silencieusement réussi reçoive une seconde activation fiable.

### `type_ax({ref_id, text, clear})`

1. Résout `ref_id`
2. Utilise `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)` pour contourner les wrappers de composants contrôlés React/Vue
3. Déclenche les événements `input` + `change`
4. Pour contenteditable : définit `textContent` + déclenche `beforeinput` + `input`

Refuse les types de saisie non saisissables (checkbox, radio, submit, file) avec une erreur claire.

### `set_field({ref_id, text, clear, submit})`

De manière atomique, focus + (efface optionnellement) + saisit + (soumet optionnellement). L'équivalent en un coup de `click_ax` + `type_ax`.

**Soumission adaptative aux combobox** : quand `submit:true`, l'outil détecte si le champ est une combobox/autocomplétion (role=combobox, aria-autocomplete, aria-controls pointant vers une listbox, ou une listbox visible sur la page). Si c'est le cas, déclenche `ArrowDown` → `Enter` avec de petits délais pour valider l'option en surbrillance. Sinon, revient à `form.requestSubmit()` ou une simple pression de touche `Enter`.

---

## Remontée des superpositions

Lors de la construction de l'arbre, les dialogues ouverts, les listboxes, les menus et les comboboxes avec `[aria-expanded=true]` sont émis sous une bannière `[open overlays]` en haut de l'arbre — avant le reste du contenu de la page. Cela garantit que les popups rendus par portail (React, Radix, Stripe) survivent à la limite douce de 3 000 caractères vue par le modèle.

---

## Priorité de résolution du nom accessible

`getAccessibleName(el)` suit cet ordre :

1. Texte de l'option sélectionnée d'un `<select>`
2. `aria-label`
3. `aria-labelledby` — concatène le texte de tous les identifiants référencés
4. `placeholder`
5. `title`
6. `alt`
7. Recherche `<label for>`
8. Valeur `value` de l'entrée (submit/button/reset uniquement — jamais pour les entrées texte)
9. Contenu textuel direct
10. Repli `innerText` pour les boutons, liens, summary
11. Texte du frère précédent (motif des champs de formulaire non étiquetés : « Every 1 month(s) » → le texte précédent est l'étiquette)
12. Repli textuel direct

---

## Percée du Shadow DOM

### Chrome

Le client CDP (`cdp-client.js`) peut percer les racines shadow **fermées** via `Runtime.evaluate` :

```js
await cdpClient.evaluate(tabId, `
  (() => {
    const host = document.querySelector('my-component');
    return host.shadowRoot ? 'open' : 'closed';
  })()
`);
```

Pour les requêtes plus profondes, `shadow_dom_query` utilise `DOM.getDocument` + `DOM.querySelector` du CDP pour atteindre les racines fermées.

L'exposition des outils est hiérarchisée : `get_shadow_dom`, `shadow_dom_query` et `get_frames` sont des replis Full Act, et le mode Dev les ajoute également pour les fournisseurs de niveau Mid afin que les sessions de débogage de page puissent inspecter la structure des Web Components et iframes sans donner à Mid en Act normal toute la surface de repli de l'interface Full.

### Firefox

Seules les racines shadow **ouvertes** (`element.shadowRoot`) sont accessibles. Les racines fermées ne peuvent pas être lues via le script de contenu. `execute_js` est exposé en mode Dev dans les deux versions, mais le JavaScript ordinaire de la page ne peut toujours pas obtenir une racine fermée et le constructeur d'arbre ne peut pas l'atteindre.

---

## Ciblage des iframes

`get_frames`, `iframe_read`, `iframe_click` et `iframe_type` fonctionnent avec des iframes inter-origines car l'extension injecte des scripts de contenu directement dans chaque frame, contournant la politique de même origine.

Le constructeur d'arbre ne **descend pas** dans les iframes par défaut. L'agent doit appeler explicitement `iframe_read` ou `get_frames` pour découvrir et lire le contenu des iframes.

---

## Modes d'échec courants

| Échec | Symptôme | Correctif |
|---|---|---|
| Élément supprimé du DOM | `click_ax` retourne « non trouvé » | Relire l'arbre ; la page a peut-être été régénérée |
| Ref obsolète après navigation SPA | Tous les refs échouent | L'agent doit relire l'arbre après `/navigate` ou `wait_for_stable` |
| Racine shadow fermée | L'arbre montre `<my-component>` mais pas ses enfants | Utiliser `get_shadow_dom` + `shadow_dom_query` sur Chrome ; Firefox ne peut pas traverser une racine fermée |
| iframe absente de l'arbre | L'agent ne trouve pas le contenu de l'iframe | Appeler `get_frames` puis `iframe_read` / `iframe_click` |
| Arbre tronqué | `truncated: true` + `hasMore: true` | Appeler `get_accessibility_tree` avec `page: nextPage` ou `ref_id` pour zoomer |
| Superposition par portail non visible | L'arbre montre la combobox mais pas le menu déroulant | La superposition est remontée dans la section `[open overlays]` — relire avec `filter: 'all'` |

---

## Débogage

- La sortie de l'arbre est visible en mode verbeux (bascule du panneau latéral)
- `window.__wbElementMap` dans la console de la page liste tous les refs vivants
- `window.__wb_ax_lookup('ref_42')` teste un ref spécifique
- Le journal de débogage profond (clic `Shift+clic` sur le bouton verbeux) vide les 200 dernières paires requête/réponse LLM, y compris les résultats des outils AX
