# Ajouter un outil

Ce guide explique comment ajouter un nouvel outil à l'agent DIV — de la définition du schéma à la répartition de l'exécution en passant par la gestion des résultats.

---

## Aperçu

Il existe deux façons d'ajouter un outil appelable par le modèle :

- **Outil central** : navigateur, DOM, réseau, téléchargement, planificateur ou comportement privilégié appartenant au produit et implémenté dans le code source de DIV. Utilisez la liste de contrôle complète ci-dessous.
- **Outil de compétence** : intégration HTTP ou de tâche de téléchargement importable et supprimable par l'utilisateur, déclarée dans le manifeste `webbrain-tools` d'une compétence. Utilisez ceci lorsque l'outil est mieux traité comme une extension tierce de confiance plutôt qu'une primitive centrale de DIV.

Un outil central nécessite des modifications dans trois couches :

1. **Schéma de l'outil** — définir le nom, la description et les paramètres dans `tools.js`
2. **Exécution de l'outil** — ajouter un gestionnaire dans `executeTool()` de `agent.js` ou dans un script de contenu
3. **Étiquettes d'interface** (optionnel) — ajouter des noms d'affichage localisés dans `locales/*.js`

La plupart des outils doivent également être dupliqués vers les builds Chrome et Firefox.

---

## Option 0 : Exposer un outil depuis une compétence

Si l'intégration est un service HTTP tiers de confiance, préférez un outil de compétence avant de coder en dur un outil central. Les outils de compétence sont supprimables depuis Paramètres -> Compétences et peuvent être renommés ou remplacés en modifiant le manifeste. Utilisez `kind: "http"` pour les recherches en lecture seule et `kind: "httpDownloadJob"` pour les services qui créent une tâche temporaire, exposent une URL de fichier et ont besoin des téléchargements du navigateur.

Ajoutez un bloc JSON `webbrain-tools` délimité dans le markdown de la compétence :

````markdown
# Compétence exemple

Utilisez cette compétence lorsque...

```webbrain-tools
{
  "tools": [
    {
      "id": "example_lookup",
      "name": "example_lookup",
      "description": "Lire les métadonnées publiques depuis Example. Utilisez ceci avant de télécharger un média.",
      "kind": "http",
      "readOnly": true,
      "method": "POST",
      "endpoint": "https://api.example.com/v1/lookup",
      "defaultArgs": {},
      "activeTabUrlArg": "url",
      "inputUrlArg": "url",
      "inputUrlAllowlist": [
        { "host": "example.com", "paths": ["/"] }
      ],
      "resultPolicy": "untrusted",
      "parameters": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "URL optionnelle. Omettre pour utiliser l'onglet actif."
          }
        },
        "required": []
      }
    }
  ]
}
```
````

Une compétence de type tâche de téléchargement utilise la même clôture de manifeste, mais déclare les points d'accès de la tâche. L'origine du point d'accès doit rester la même entre les URL de création, statut, fichier et nettoyage :

````markdown
```webbrain-tools
{
  "tools": [
    {
      "id": "example_download_media",
      "name": "example_download_media",
      "description": "Télécharger un fichier média public depuis Example dans le dossier Téléchargements du navigateur.",
      "kind": "httpDownloadJob",
      "readOnly": false,
      "requiresDownloadPermission": true,
      "method": "POST",
      "endpoint": "https://api.example.com/v1/media/jobs",
      "job": {
        "idField": "job_id",
        "statusEndpoint": "https://api.example.com/v1/media/jobs/{job_id}",
        "fileEndpoint": "https://api.example.com/v1/media/jobs/{job_id}/file",
        "cleanupEndpoint": "https://api.example.com/v1/media/jobs/{job_id}",
        "pollIntervalMs": 1000,
        "timeoutMs": 90000
      },
      "activeTabUrlArg": "url",
      "inputUrlArg": "url",
      "resultPolicy": "untrusted",
      "modes": ["act"],
      "parameters": {
        "type": "object",
        "properties": {
          "url": { "type": "string" },
          "filename": { "type": "string" }
        },
        "required": []
      }
    }
  ]
}
```
````

Comment c'est câblé :

- `agent/skills.js` analyse les manifestes des compétences activées et construit les schémas d'outils au moment de l'appel LLM.
- Le bloc de manifeste est retiré des instructions du prompt, donc le JSON des points d'accès n'est pas copié dans le prompt système principal.
- `agent.js` achemine les appels d'outils de compétence déclarés via `executeHttpSkillTool()` dans `network-tools.js`.
- Les outils de compétence nécessitent actuellement HTTPS et `credentials: "omit"`. Les outils `kind: "http"` doivent être GET ou POST et `readOnly: true`. Les outils `kind: "httpDownloadJob"` doivent être POST, `readOnly: false`, `requiresDownloadPermission: true`, et déclarer des modèles de point d'accès statut/fichier/nettoyage de même origine avec `{job_id}`.

Modèle de sécurité :

- Importer/activer la compétence est la limite de confiance pour le point d'accès HTTPS déclaré. Après importation, les outils de compétence déclarés peuvent envoyer leurs entrées déclarées à ce point d'accès sans confirmation par appel.
- Les outils de compétence de type tâche de téléchargement sont toujours en mode action uniquement (Act ou Dev) et passent par la porte d'autorisation normale des Téléchargements avant qu'un fichier soit sauvegardé.
- Marquez toute réponse tierce/page/document comme `resultPolicy: "untrusted"` afin que le résultat soit enveloppé dans `<untrusted_page_content>` et ne puisse pas devenir des instructions de confiance pendant la synthèse.
- Utilisez `inputUrlAllowlist` lorsque le service ne doit recevoir que des familles d'URL publiques spécifiques.

Utilisez plutôt un outil central lorsque l'outil nécessite des privilèges navigateur au-delà des Téléchargements, des cookies, de l'accès DOM par script de contenu, des permissions de mutation, une porte d'autorisation personnalisée ou une exécution non-HTTP.

---

## Étape 1 : Définir le schéma

Ouvrez `src/chrome/src/agent/tools.js` et ajoutez une entrée au tableau `AGENT_TOOLS` :

```js
{
  type: 'function',
  function: {
    name: 'my_new_tool',
    description: 'Ce que fait cet outil, quand l'utiliser, et ce à quoi le modèle doit s'attendre en retour. Soyez explicite sur les cas d'erreur.',
    parameters: {
      type: 'object',
      properties: {
        param1: {
          type: 'string',
          description: 'À quoi sert ce paramètre.',
        },
        param2: {
          type: 'number',
          description: 'Un autre paramètre.',
        },
      },
      required: ['param1'],
    },
  },
},
```

### Règles de schéma

- **La qualité de la description compte** : le LLM la lit pour décider quand appeler l'outil. Incluez : ce qu'il fait, quand le préférer aux alternatives, à quelles erreurs s'attendre et les éventuels effets secondaires.
- **Les paramètres doivent être bien nommés** : le modèle déduit la sémantique à partir des noms de paramètres + descriptions.
- **Utilisez des énumérations** pour les choix contraints :
  ```js
  param: { type: 'string', enum: ['option1', 'option2'] }
  ```
- **Champs obligatoires** : listez uniquement ce qui est vraiment obligatoire. Les champs optionnels donnent de la flexibilité au modèle.
- **Gardez les descriptions concises** : ~2–3 phrases max. La liste complète des outils est envoyée à chaque appel LLM.

### Classification des outils

- **Outils Ask** (lecture sémantique/uniquement et sans danger pour tous les modèles) : ajoutez à `ASK_ONLY_TOOLS` dans `tools.js`. N'y mettez pas de lectures développeur/débogage à moins qu'elles n'appartiennent vraiment à Ask ordinaire.
- **Outils d'action normaux** : ajoutez le schéma à `AGENT_TOOLS`, puis décidez quels niveaux de fournisseur doivent le voir via `COMPACT_TOOL_NAMES`, `MID_TOOL_NAMES`, ou la valeur par défaut Full Act.
- **Outils Dev uniquement** : ajoutez les outils source/style/débogage qui ne doivent pas apparaître dans Act normal à `DEV_ONLY_TOOL_NAMES`.
- **Outils Dev étendus** : ajoutez les outils qui doivent rester Full Act mais aussi devenir disponibles pour le niveau Mid en Dev à `DEV_EXTENDED_TOOL_NAMES`. Les outils d'ombre/cadre utilisent ce motif.
- **Outils de navigation** : ajoutez à `Agent.NAV_TOOLS` (capture d'écran automatique lors de la navigation)
- **Outils de changement d'état** : ajoutez à `Agent.STATE_CHANGE_TOOLS` (capture d'écran automatique lors du changement d'état)
- **Outils sujets à la navigation** : ajoutez à `Agent.NAV_PRONE_TOOLS` lorsqu'un appel réussi doit être vérifié pour des changements d'URL/historique (`navigate`, `go_back`, `go_forward`, outils de type clic)
- **Outils de famille d'URL** : si l'outil prend un argument URL qui doit être haché par identité de bucket pour la détection de boucle, mettez à jour `URL_FAMILY_TOOLS` dans `loop-bucket.js`

Gardez le mode et le niveau séparés : le mode est `ask | act | dev` ; le niveau est `compact | mid | full`. `getToolsForMode('dev', { tier: 'mid' })` retourne les outils Mid Act plus les modules complémentaires Dev. `getToolsForMode('dev', { tier: 'compact' })` est intentionnellement vide car Compact Dev est bloqué avant une requête LLM.

---

## Étape 2 : Implémenter le gestionnaire

### Option A : Outil de script de contenu (interaction DOM)

Ajoutez un gestionnaire dans `src/chrome/src/content/content.js` :

```js
if (msg.action === 'my_new_tool') {
  const result = await myNewToolHandler(msg.args);
  sendResponse(result);
}
```

Puis ajoutez la répartition dans `executeTool()` de `agent.js` :

```js
if (name === 'my_new_tool') {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      target: 'content',
      action: 'my_new_tool',
      args,
    });
    return response || { success: false, error: 'Pas de réponse de la page' };
  } catch (e) {
    // Le script de contenu n'est peut-être pas encore injecté — injecter et réessayer
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/content.js'],
    });
    const response = await chrome.tabs.sendMessage(tabId, {
      target: 'content',
      action: 'my_new_tool',
      args,
    });
    return response || { success: false, error: 'Pas de réponse après l'injection' };
  }
}
```

### Option B : Outil de script d'arrière-plan/service worker (réseau, API chrome.*)

Ajoutez le gestionnaire directement dans `executeTool()` :

```js
if (name === 'my_new_tool') {
  try {
    const result = await doSomething(args);
    return { success: true, ...result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
```

### Option C : Outil basé sur CDP (Chrome uniquement)

Utilisez `cdpClient` pour les événements de confiance / requêtes DOM :

```js
if (name === 'my_new_tool') {
  try {
    await cdpClient.attach(tabId);
    const result = await cdpClient.evaluate(tabId, `/* JS à exécuter dans la page */`);
    return { success: true, value: result?.result?.value };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
```

---

## Étape 3 : Forme du résultat

Les résultats des outils doivent être sérialisables en JSON. Suivez ces conventions :

```js
// Succès
{ success: true, data: ..., note: '...' }

// Erreur
{ success: false, error: 'Description lisible de ce qui a mal fonctionné' }
```

### Champs de résultat spéciaux

Ces champs sont retirés avant la sérialisation et traités spécialement par `_executeToolBatch` :

| Champ | Type | Objectif |
|---|---|---|
| `_attachImage` | `string` (URL de données) | Poussé comme un bloc `image_url` sur un message utilisateur de suivi pour les fournisseurs compatibles vision |
| `_attachDocument` | `object` | Poussé comme un bloc de contenu `document` Anthropic pour le passage natif PDF |
| `done` | `boolean` | Signale à `_executeToolBatch` d'arrêter la boucle et de retourner `summary` |
| `summary` | `string` | La réponse finale quand `done: true` |

### Taille du résultat de l'outil

`_limitToolResult()` limite les résultats sérialisés à **8 000 caractères**. Si votre outil retourne de grandes données (pages de texte, longues listes), le résultat sera silencieusement tronqué. Envisagez :
- Retourner un résumé avec un indicateur `truncated: true`
- Supporter la pagination (comme `get_accessibility_tree` avec le paramètre `page`)
- Laisser le modèle rappeler pour plus de détails

---

## Étape 4 : Ajouter des étiquettes d'interface (optionnel)

Si l'outil doit avoir une étiquette lisible dans le panneau latéral, ajoutez-la à `src/chrome/src/ui/locales/en.js` :

```js
'tool.my_new_tool': 'My New Tool',
'tool.my_new_tool.with_param': 'My New Tool with {param}',
```

Et dans chaque autre fichier de locale sous `locales/*.js`.

---

## Étape 5 : Dupliquer vers Firefox

Copiez les modifications vers `src/firefox/src/agent/tools.js`, `src/firefox/src/agent/agent.js`, et `src/firefox/src/content/content.js`.

Certains outils sont intentionnellement Chrome uniquement (ceux nécessitant CDP, documents hors-écran, capture d'onglet, ou d'autres API Chrome uniquement). Pour ceux-ci, ajoutez le schéma aux deux builds mais implémentez le gestionnaire Firefox avec une erreur claire ou une opération nulle :

```js
// Firefox : non supporté
if (name === 'chrome_only_tool') {
  return { success: false, error: 'Cet outil n'est pas disponible sur Firefox.' };
}
```

---

## Étape 6 : Classification de sécurité

Chaque nouvel outil doit être classifié pour la sécurité :

1. **Peut-il lire ou exfiltrer des données de la page ?** → Ajoutez des vérifications de sensibilité des champs d'identification s'il lit des valeurs d'entrée.
2. **Peut-il effectuer des mutations destructrices ?** → Envisagez s'il doit être verrouillé derrière `/allow-api`.
3. **Peut-il être victime d'injection de prompt ?** → Si l'outil accepte des chaînes fournies par l'utilisateur qui se retrouvent dans les arguments d'appel d'outil, documentez la surface d'injection dans la description de l'outil.
4. **Quel mode/niveau doit l'exposer ?** → La lecture sémantique Ask uniquement va dans `ASK_ONLY_TOOLS` ; les outils d'action courants doivent rejoindre le plus petit niveau normal qui peut les utiliser de manière fiable ; les outils développeur uniquement source/style/débogage vont dans Dev uniquement ; les replis Full que Mid ne devrait obtenir qu'en débogage vont dans Dev étendu.
5. **Peut-il court-circuiter des actions d'interface répétées en appels réseau ?** → Maintenez la politique d'abord par l'interface intacte. L'observateur d'API d'arrière-plan peut exposer des indices exacts URL+méthode XHR/fetch pendant les boucles de clic, plus un `replayRequestId` opaque lorsque le matériel de rejeu corps/en-tête de même origine est disponible. Les appels `fetch_url` mutants nécessitent toujours l'état `/allow-api` de la conversation, et les jetons de formulaire cachés doivent rester derrière l'identifiant de rejeu plutôt que d'être exposés au modèle. Les requêtes GET et les capacités non-réseau utilisent toujours la porte d'autorisation normale.

Voir `docs/security-model.md` pour le modèle de menace complet.

---

## Étape 7 : Tester

1. Vérifiez que l'outil apparaît dans les outils disponibles du LLM (vérifiez `getToolsForMode()` dans le journal de débogage verbeux)
2. Testez que le gestionnaire s'exécute et retourne la forme de résultat correcte
3. Testez la gestion des erreurs (arguments invalides, page manquante, échec réseau)
4. Testez en modes Ask, Act et Dev selon le cas, y compris les limites de niveau Compact/Mid/Full
5. Testez sur les builds Chrome et Firefox
6. Vérifiez que le résultat est correctement affiché dans le panneau latéral

---

## Liste de contrôle

- [ ] Schéma ajouté à `AGENT_TOOLS` dans `src/chrome/src/agent/tools.js`
- [ ] Schéma dupliqué vers `src/firefox/src/agent/tools.js`
- [ ] Gestionnaire ajouté à `executeTool()` dans les deux fichiers `agent.js`
- [ ] Gestionnaire de script de contenu ajouté (si applicable) dans les deux fichiers `content.js`
- [ ] Ajouté aux bonnes constantes d'exposition Ask/Act/Dev (`ASK_ONLY_TOOLS`, jeux de niveaux, `DEV_ONLY_TOOL_NAMES`, ou `DEV_EXTENDED_TOOL_NAMES`)
- [ ] Comportement Compact, Mid, Full et Dev Compact-bloqué couvert lorsque la surface de l'outil change
- [ ] Ajouté à `Agent.NAV_TOOLS` / `Agent.STATE_CHANGE_TOOLS` / `Agent.NAV_PRONE_TOOLS` (s'il navigue, change l'état de la page, ou doit être vérifié pour la navigation)
- [ ] Classification de sécurité documentée
- [ ] README / docs d'architecture mis à jour lorsque la surface de l'outil public ou le flux d'exécution change
- [ ] Étiquettes d'interface ajoutées à `locales/*.js` (si nécessaire)
- [ ] Description de l'outil mise à jour dans le prompt système correspondant (si le modèle doit en avoir connaissance de manière proactive)
