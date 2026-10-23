# Localisation

---

## Fonctionnement

L'interface utilisateur (panneau latéral, paramètres, page des traces) est traduite via un système simple basé sur des clés dans `src/chrome/src/ui/i18n.js`. Elle fonctionne à l'identique dans Chrome et Firefox.

### Architecture

```
src/chrome/src/ui/
├── i18n.js                # Cœur : t(), setLocale(), applyDOMTranslations()
└── locales/
    ├── en.js              # Anglais — canonique, toujours complète
    ├── ar.js              # Arabe
    ├── bn.js              # Bengali
    ├── de.js              # Allemand
    ├── es.js              # Espagnol
    ├── fa.js              # Persan
    ├── fr.js              # Français
    ├── he.js              # Hébreu
    ├── hi.js              # Hindi
    ├── id.js              # Indonésien
    ├── ja.js              # Japonais
    ├── ko.js              # Coréen
    ├── ms.js              # Malais
    ├── nl.js              # Néerlandais
    ├── pl.js              # Polonais
    ├── pt.js              # Portugais
    ├── ru.js              # Russe
    ├── th.js              # Thaï
    ├── tl.js              # Philippin
    ├── tr.js              # Turc
    ├── uk.js              # Ukrainien
    ├── vi.js              # Vietnamien
    └── zh.js              # Chinois
```

Paramètres → Langue liste les **23** locales de `LANGUAGES` dans `i18n.js`
(anglais et chinois épinglés en premier ; le reste trié par nom anglais).
### Fonctions clés

```js
import { t, setLocale, getLocale, applyDOMTranslations, LANGUAGES } from './i18n.js';

// Traduire une clé
t('sp.btn.send')              // → "Envoyer"
t('sp.status.connected', { model: 'gpt-5' })  // → "Connecté (gpt-5)"

// Changer la locale
setLocale('tr');
applyDOMTranslations(document);  // Retraduire la page courante

// Langues disponibles
LANGUAGES  // → [{ code: 'en', label: 'English' }, { code: 'tr', label: 'Türkçe' }, ...]
```

### Repli vers l'anglais

Si une clé est manquante dans la locale active, la fonction `t()` se replie sur `en.js` :

```js
export function t(key, params) {
  const dict = DICTS[currentLocale] || DICTS.en;
  let s = dict[key];
  if (s == null) s = DICTS.en[key];  // Repli vers l'anglais
  if (s == null) return key;         // Dernier recours : retourner la clé brute
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
  }
  return s;
}
```

Cela signifie qu'une traduction partielle peut être déployée sans risque — les
clés manquantes affichent simplement l'anglais.

### Traduction du DOM

Les éléments HTML utilisent des attributs `data-i18n` :

```html
<button data-i18n="sp.btn.send">Envoyer</button>
<span data-i18n-title="sp.tooltip.help">?</span>
<input data-i18n-placeholder="sp.input.ask_placeholder">
```

`applyDOMTranslations(root)` traite `data-i18n`, `data-i18n-html`,
`data-i18n-title`, `data-i18n-placeholder` et `data-i18n-aria-label`.

---

## Ajouter une nouvelle locale

### Étape 1 : Créer le fichier de traduction

Copiez `src/chrome/src/ui/locales/en.js` vers
`src/chrome/src/ui/locales/<code>.js` et traduisez les valeurs.

Le fichier exporte une map plate clé → chaîne :

```js
export default {
  'brand': 'DIV',
  'sp.btn.send': 'Envoyer',
  // ... toutes les clés de en.js
};
```

### Étape 2 : Enregistrer dans i18n.js

Ajoutez à l'import, au dictionnaire et au tableau `LANGUAGES` :

```js
import de from './locales/de.js';

const DICTS = { en, es, fr, tr, zh, ru, uk, ar, ja, ko, id, th, ms, tl, de };

export const LANGUAGES = [
  // ... entrées existantes ...
  { code: 'de', label: 'Deutsch' },
];
```

### Étape 3 : Miroir vers Firefox

Copiez le fichier de locale vers `src/firefox/src/ui/locales/<code>.js` et
mettez à jour `src/firefox/src/ui/i18n.js` à l'identique.

### Étape 4 : Tester

1. Ouvrez les paramètres de l'extension
2. Basculez vers la nouvelle langue dans le menu déroulant Langue
3. Vérifiez que le panneau latéral, les paramètres et la page des traces
   s'affichent correctement
4. Vérifiez que les clés manquantes se replient gracieusement vers l'anglais
5. Testez les dispositions RTL si vous ajoutez l'arabe ou l'hébreu

---

## Conseils de traduction

- **Conservez les espaces réservés intacts** : `{model}`, `{error}`, `{count}`
  doivent apparaître exactement comme dans le fichier anglais. Le code les
  remplace par des valeurs d'exécution.
- **Ne traduisez pas les noms de marque** : « DIV » est conservé en anglais
  dans toutes les locales.
- **Attention au HTML dans les valeurs** : Certaines clés contiennent du HTML
  (`data-i18n-html`). Préservez la structure HTML mais traduisez le contenu
  textuel.
- **Pluriels** : Le système n'a pas de formes plurielles. Utilisez le style
  `{n} élément(s)` ou une gestion des pluriels au niveau du code si nécessaire.
- **Étiquettes d'outils** : Les clés commençant par `tool.` sont utilisées comme
  étiquettes d'étape compactes dans le panneau latéral. Gardez-les courtes
  (2 à 4 mots).

### Conventions de nommage des clés

| Préfixe | Section |
|---|---|
| `sp.` | Interface du panneau latéral |
| `st.` | Page des paramètres |
| `tr.` | Page des traces |
| `tool.` | Étiquettes d'outils |
| `ob.` | Flux d'intégration |

---

## Maintenance

- `en.js` est la source de vérité canonique. Lors de l'ajout d'une nouvelle clé,
  ajoutez-la toujours d'abord à `en.js`.
- Après avoir ajouté une clé à `en.js`, ajoutez-la à chaque autre fichier de
  locale. Les valeurs anglaises comme espaces réservés sont acceptables pour les
  commits initiaux.
- Les chaînes mises à jour dans `en.js` doivent être signalées aux traducteurs
  — il n'y a pas de synchronisation automatisée.
