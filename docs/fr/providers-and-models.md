# Fournisseurs et Modèles

---

## Interface Fournisseur (`providers/base.js`)

Chaque fournisseur LLM implémente l'interface `BaseLLMProvider` :

```js
class BaseLLMProvider {
  async chat(messages, options)         // → { content, toolCalls, usage }
  async *chatStream(messages, options)  // → générateur async produisant { type, content }
  get supportsTools()                   // → booléen
  get supportsVision()                  // → booléen
  get promptTier()                      // → 'compact' | 'mid' | 'full'
  async testConnection()                // → { ok, error?, model? }
}
```

### Options

```js
{
  tools: [...],            // schémas d'outils
  temperature: 0.3,
  maxTokens: 4096,
  stream: false,           // utiliser chatStream au lieu de chat
  extraBody: {},           // champs supplémentaires transmis à l'API
}
```

---

## Fournisseurs Intégrés

| ID Fournisseur | Type | Catégorie | Modèle par défaut | Vision |
|---|---|---|---|---|
| `llamacpp` | `llamacpp` | local | (modèle chargé) | Oui (activé par défaut) |
| `ollama` | `openai` | local | (modèle chargé) | Oui (activé par défaut) |
| `lmstudio` | `openai` | local | (modèle chargé) | Oui (activé par défaut) |
| `jan` | `openai` | local | (modèle chargé) | Oui (activé par défaut) |
| `vllm` | `openai` | local | (modèle chargé) | Oui (activé par défaut) |
| `sglang` | `openai` | local | (modèle chargé) | Oui (activé par défaut) |
| `localai` | `openai` | local | (modèle chargé) | Oui (activé par défaut) |
| `openai` | `openai` | cloud | `gpt-5.6-terra` | Regex nom de modèle |
| `anthropic` | `anthropic` | cloud | `claude-sonnet-4-6` | Regex nom de modèle |
| `claude_subscription` | `anthropic_oauth` | cloud | `claude-sonnet-4-6` | Oui |
| `gemini` | `openai` | cloud | `gemini-3.1-flash` | Regex nom de modèle |
| `mistral` | `openai` | cloud | `mistral-large-latest` | Regex nom de modèle |
| `deepseek` | `openai` | cloud | `deepseek-v4-flash` | Regex nom de modèle |
| `xai` (Grok) | `openai` | cloud | `grok-4.3` | Regex nom de modèle |
| `nvidia` (NIM) | `openai` | cloud | `meta/llama-3.1-8b-instruct` | Regex nom de modèle |
| `groq` | `openai` | cloud | `llama-3.3-70b-versatile` | Regex nom de modèle |
| `minimax` | `openai` | cloud | `minimax-m2.7` | Regex nom de modèle |
| `alibaba` (Qwen) | `openai` | cloud | `qwen-max` | Regex nom de modèle |
| `openrouter` | `openai` | routeur | `openrouter/free` | Regex nom de modèle |

### Fournisseurs Locaux

Sept fournisseurs locaux sont activés par défaut sans clé API requise sauf si le
serveur local a été démarré avec authentification :

- **llama.cpp** : `http://localhost:8080` — exécutez `llama-server -m model.gguf`
- **Ollama** : `http://localhost:11434/v1` — `ollama serve`, ou `ollama launch webbrain --model <model>`
- **LM Studio** : `http://localhost:1234/v1` — le serveur d'inférence local de LM Studio
- **Jan** : `http://localhost:1337/v1` — le serveur API local compatible OpenAI de Jan
- **vLLM** : `http://localhost:8000/v1` — le serveur compatible OpenAI de vLLM
- **SGLang** : `http://localhost:30000/v1` — le serveur compatible OpenAI de SGLang
- **LocalAI** : `http://localhost:8080/v1` — le serveur compatible OpenAI de LocalAI

Les sept ont `supportsVision: true` par défaut car la plupart des modèles chargés localement en 2026 sont multimodaux.

**Fenêtre de contexte.** Chargez les modèles locaux avec **au moins une fenêtre de contexte de 16k tokens** pour des exécutions d'agent fiables — c'est le minimum utilisable. 8k peut fonctionner avec le niveau Compact sélectionné ; 4k est trop petit pour contenir le prompt système + les schémas d'outils. L'agent lit la fenêtre depuis `provider.contextWindow` (`providers/base.js`) pour piloter l'auto-compaction ; quand une configuration de fournisseur ne définit pas `contextWindow`, les fournisseurs locaux utilisent par défaut une valeur prudente de **16k** (cloud/routeur par défaut à 128k). **Tester la connexion** / **Charger les modèles** détectent pour **llama.cpp**, **Ollama** et **LM Studio** quand c'est rapporté (llama.cpp `GET /props` `n_ctx`, Ollama `GET /api/ps` puis `/api/show` `num_ctx`, LM Studio `/api/v0/models` `loaded_context_length`). La détection rafraîchit le 16k par défaut ; elle réduit une surcharge manuelle plus grande seulement depuis le contexte live/runtime (pas depuis Ollama `/api/show` seul). Jan / vLLM / SGLang / LocalAI ne détectent pas encore. Vous pouvez toujours définir `config.contextWindow` explicitement, et le serveur de modèle doit effectivement être démarré avec cette taille de contexte (par exemple `llama-server -c 16384`).

### Niveaux de prompt/outils et modes

Le niveau du fournisseur et le mode de conversation sont des paramètres indépendants :

- **Niveau** (`compact | mid | full`) est un paramètre du fournisseur. Il contrôle quel prompt système Act et quel sous-ensemble d'outils d'agent navigateur normaux le modèle reçoit.
- **Mode** (`ask | act | dev`) est sélectionné par l'utilisateur par conversation/message. Il contrôle si la requête est en lecture seule, action navigateur normale, ou travail de développement/inspection de page.

`provider.promptTier` résout le niveau actif. Les fournisseurs cloud sont forcés au niveau Full. Les fournisseurs locaux utilisent Mid par défaut. Les fournisseurs OpenRouter/routeur utilisent Full par défaut sauf modification explicite. Les configurations existantes qui définissent encore l'ancien booléen `useCompactPrompt` sont mappées vers Compact.

| Niveau | Classe de modèle visée | Surface d'outils normale |
|---|---|---|
| `compact` | très petits modèles / locaux | Prompt le plus court et un petit ensemble d'outils Act normaux. Pas d'outils de planification, d'iframe, de téléchargement de ressource, ou d'interface DOM/UI avancée. |
| `mid` | modèles locaux capables | Prompt équilibré et outils de tâches courantes : téléchargements, planification, outils iframe, vérification de formulaire, et `download_resource_from_page`, tout en excluant les solutions de repli UI/DOM avancées réservées à Full. |
| `full` | modèles frontière/cloud ou grands modèles locaux | Prompt Act normal complet et solutions de repli avancées telles que survol, glisser-déposer, trames, et shadow DOM. |

Le mode Ask ignore le niveau du fournisseur et reste en lecture seule. Le mode Act utilise les outils normaux du niveau sélectionné. Le mode Dev nécessite Mid ou Full, utilise le prompt Act sélectionné, ajoute `SYSTEM_PROMPT_DEV_APPENDIX`, et ajoute des outils source/style propres à Dev plus l'inspection étendue shadow/trame pour le débogage niveau Mid. Dev en Compact est bloqué avant l'envoi d'une requête LLM.

### Détection de la Vision

| Fournisseur | Mécanisme |
|---|---|
| Compatible OpenAI | Regex sur le nom du modèle (`gpt-4o`, `gpt-5`, `claude-3`, `claude-sonnet-4`, `gemini-2.0-flash`, etc.) |
| Anthropic | Patterns `claude-(3\|sonnet-4\|opus-4)` |
| llama.cpp | Interrupteur explicite `supportsVision` dans la configuration |
| Ollama / LM Studio / Jan / vLLM / SGLang / LocalAI | Interrupteur explicite `supportsVision` dans la configuration (via le fournisseur OpenAI) |

### Conversion Anthropic

Lorsque le fournisseur actif est Anthropic, l'agent convertit les messages au format OpenAI :

| Format OpenAI | Format Anthropic |
|---|---|
| Message `system` | Champ `system` (niveau supérieur) |
| `assistant` + `tool_calls` | Blocs de contenu `assistant` + `tool_use` |
| Rôle `tool` | Blocs de contenu `user` + `tool_result` |
| `image_url` (URL de données) | Bloc source `image` |

---

## ProviderManager (`providers/manager.js`)

Gère le cycle de vie des fournisseurs :

```js
const pm = new ProviderManager();

await pm.load();                    // Chargement depuis chrome.storage.local
await pm.save();                    // Persistance vers chrome.storage.local
pm.getActive();                     // Obtient l'instance du fournisseur actif
await pm.setActive('openai');       // Change de fournisseur actif
await pm.updateProvider('openai', { model: 'gpt-5' }); // Met à jour la configuration
pm.getAll();                        // Toutes les configurations de fournisseurs (pour l'interface Paramètres)
await pm.testProvider('openai');    // Teste la connexion
```

### Persistance de la Configuration

Les configurations sont stockées dans `chrome.storage.local` sous la clé `providers`, fusionnées avec les valeurs par défaut. Les valeurs par défaut fournissent la STRUCTURE (quelles clés de fournisseur existent) ; les configurations stockées remplacent les valeurs par clé. Cela permet aux mises à jour qui introduisent de nouvelles entrées de fournisseur de fonctionner sans que les utilisateurs aient à vider le stockage.

Les entrées de fournisseur obsolètes (`webbrain`, `openai_subscription`) sont filtrées.

### Plafonds de Coût

Les paramètres exposent des plafonds de coût cloud pour la session et le total. L'agent préfère une valeur `usage.cost`/`usage.cost_usd` rapportée par le fournisseur lorsqu'elle est présente (OpenRouter la rapporte directement). Pour les fournisseurs cloud directs qui ne retournent que des compteurs de tokens, WebBrain estime les dépenses à partir des champs de configuration du fournisseur :

- `inputCostPerMillionUsd`
- `cacheReadCostPerMillionUsd`
- `cacheWriteCostPerMillionUsd` (écritures de cache de 5 minutes ou sans durée précisée)
- `cacheWrite1hCostPerMillionUsd`
- `outputCostPerMillionUsd`

OpenAI inclut les lectures et écritures de cache dans le total des tokens d'entrée (`prompt_tokens_details.cached_tokens` / `cache_write_tokens`, ou les équivalents `input_tokens_details` de l'API Responses) ; WebBrain soustrait donc les deux avant d'appliquer le tarif d'entrée normal, et facture les écritures avec `cacheWriteCostPerMillionUsd`. Anthropic et Bedrock rapportent séparément l'entrée normale, les lectures du cache et les écritures dans le cache ; ces compteurs sont donc additionnés comme catégories de facturation distinctes. Ils peuvent également distinguer les écritures de cache de 5 minutes et d'une heure.

Ces tarifs sont modifiables dans la carte du fournisseur afin que le prix des modèles personnalisés puisse être ajusté sans modification de code. Si un tarif propre au cache est absent, le tarif d'entrée normal est utilisé ; si le tarif d'écriture d'une heure est absent, le tarif général d'écriture dans le cache est utilisé. Si un fournisseur distant facturé retourne des compteurs sans tarifs d'entrée/sortie configurés, l'agent utilise des valeurs prudentes (`3$` en entrée / `15$` en sortie par million de tokens). Pour chaque requête en streaming, seul le dernier instantané cumulatif d'utilisation est comptabilisé. Les fournisseurs locaux ne sont pas comptabilisés.

### Fournisseur de Vision Dédié

L'utilisateur peut configurer un fournisseur de vision séparé pour la description de capture d'écran. L'agent appelle ce fournisseur en sous-requête pour obtenir une description textuelle du viewport, puis transmet uniquement la description (pas l'image brute) au fournisseur de planification principal. Cela réduit les coûts de tokens lorsque le fournisseur principal est textuel uniquement :

```js
const vision = await providerManager.getVisionProvider();
// Retourne une instance OpenAICompatibleProvider ou null
```

### Fournisseur de Transcription

Utilisé par Tab Recorder pour la transcription Whisper. Passe par les fournisseurs configurés dans l'ordre de priorité : OpenAI → Groq → LM Studio → llama.cpp. La liste d'exclusion ignore les fournisseurs connus pour ne pas héberger Whisper (Anthropic, Gemini, Mistral, DeepSeek, xAI, Nvidia).

---

## Ajouter un Fournisseur

1. **Créez la classe du fournisseur** dans `src/chrome/src/providers/<nom>.js` implémentant `BaseLLMProvider`
2. **Ajoutez la configuration par défaut** à `_defaultConfigs()` dans `manager.js`
3. **Ajoutez le cas dans la fabrique** dans `_createProvider()`
4. **Enregistrez l'import** dans `manager.js`
5. **Ajoutez la gestion spécifique au fournisseur** dans l'agent si nécessaire (par exemple, la conversion de format de message d'Anthropic)
6. **Miroir vers Firefox** (`src/firefox/src/providers/`)

### Pour les fournisseurs compatibles OpenAI

Si le fournisseur utilise le format d'API OpenAI `/v1/chat/completions`, vous avez seulement besoin d'ajouter une entrée de configuration par défaut — `OpenAICompatibleProvider` gère le reste :

```js
myprovider: {
  type: 'openai',
  category: 'cloud',
  label: 'Mon Fournisseur',
  providerName: 'myprovider',
  baseUrl: 'https://api.myprovider.com/v1',
  model: 'my-model',
  supportsStreamUsageOptions: false,
  apiKey: '',
  enabled: false,
},
```

La vision est auto-détectée via une regex sur le nom du modèle. Si le fournisseur a un ensemble connu de modèles de vision, ajoutez-les à la regex dans `openai.js`. Définissez `supportsStreamUsageOptions: true` uniquement pour les fournisseurs qui acceptent `stream_options.include_usage` de style OpenAI ; laissez-le à false lorsqu'un fournisseur retourne l'utilisation sans accepter ce champ de requête.
