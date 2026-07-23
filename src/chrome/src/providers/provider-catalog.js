/**
 * Additional built-in providers.
 *
 * The catalog is a curated, checked-in snapshot of OpenCode's provider data at
 * commit 62e4641235d7847dadc60da37cca8a023dd54fc1. Keeping it local makes the
 * extension deterministic and avoids loading provider metadata at runtime.
 */

const DEFAULT_API_KEY_PLACEHOLDER = 'API key';

function provider(id, label, baseUrl, model, contextWindow, options = {}) {
  const {
    category = 'router',
    type = 'openai',
    apiKeyUrl = '',
    supportsVision = false,
    supportsTools = true,
    supportsAskStreaming = true,
    suggestions = model ? [model] : [],
    inputCostPerMillionUsd,
    cacheReadCostPerMillionUsd,
    cacheWriteCostPerMillionUsd,
    outputCostPerMillionUsd,
    apiKeyPlaceholder = DEFAULT_API_KEY_PLACEHOLDER,
    ...config
  } = options;

  return {
    id,
    config: {
      type,
      category,
      label,
      providerName: id,
      baseUrl,
      model,
      contextWindow,
      supportsVision,
      supportsTools,
      supportsAskStreaming,
      // Chat Completions streaming is broadly supported, but the optional
      // stream_options.include_usage extension is not. Individual providers
      // can opt in later when their wire contract guarantees it.
      supportsStreamUsageOptions: false,
      apiKey: '',
      apiKeyUrl,
      enabled: false,
      ...(inputCostPerMillionUsd == null ? {} : { inputCostPerMillionUsd }),
      ...(cacheReadCostPerMillionUsd == null ? {} : { cacheReadCostPerMillionUsd }),
      ...(cacheWriteCostPerMillionUsd == null ? {} : { cacheWriteCostPerMillionUsd }),
      ...(outputCostPerMillionUsd == null ? {} : { outputCostPerMillionUsd }),
      ...config,
    },
    ui: {
      suggestions,
      apiKeyPlaceholder,
    },
  };
}

const PROVIDERS = [
  provider('302ai', '302.AI', 'https://api.302.ai/v1', 'gpt-5.4-mini-2026-03-17', 400000, { apiKeyUrl: 'https://doc.302.ai', supportsVision: true, inputCostPerMillionUsd: 0.75, outputCostPerMillionUsd: 4.5 }),
  provider('abacus', 'Abacus', 'https://routellm.abacus.ai/v1', 'o3', 200000, { apiKeyUrl: 'https://abacus.ai/help/api', supportsVision: true, inputCostPerMillionUsd: 2, cacheReadCostPerMillionUsd: 0.5, outputCostPerMillionUsd: 8 }),
  provider('aihubmix', 'AIHubMix', 'https://aihubmix.com/v1', 'coding-minimax-m2.7', 204800, { apiKeyUrl: 'https://docs.aihubmix.com', inputCostPerMillionUsd: 0.2, outputCostPerMillionUsd: 0.2 }),
  provider('alibaba-coding-plan', 'Alibaba Coding Plan', 'https://coding-intl.dashscope.aliyuncs.com/v1', 'qwen3-coder-plus', 1000000, { category: 'cloud', apiKeyUrl: 'https://www.alibabacloud.com/help/en/model-studio/coding-plan', supportsAskStreaming: false }),
  provider('alibaba-coding-plan-cn', 'Alibaba Coding Plan (China)', 'https://coding.dashscope.aliyuncs.com/v1', 'qwen3-coder-plus', 1000000, { category: 'cloud', apiKeyUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan', supportsAskStreaming: false }),
  provider('azure-cognitive-services', 'Azure AI Foundry', 'https://{resource}.openai.azure.com/openai/v1', '', 200000, { category: 'cloud', apiKeyUrl: 'https://ai.azure.com/', apiKeyHeader: 'api-key', resource: '', requiresModel: true, supportsVision: true, apiKeyPlaceholder: 'Azure API key' }),
  provider('bailing', 'Bailing', 'https://api.tbox.cn/api/llm/v1', 'Ling-1T', 128000, { category: 'cloud', apiKeyUrl: 'https://alipaytbox.yuque.com/sxs0ba/ling/intro', inputCostPerMillionUsd: 0.57, outputCostPerMillionUsd: 2.29 }),
  provider('baseten', 'Baseten', 'https://inference.baseten.co/v1', 'moonshotai/Kimi-K2.6', 262000, { apiKeyUrl: 'https://docs.baseten.co/inference/model-apis/overview', supportsVision: true, inputCostPerMillionUsd: 0.95, cacheReadCostPerMillionUsd: 0.16, outputCostPerMillionUsd: 4 }),
  provider('berget', 'Berget.AI', 'https://api.berget.ai/v1', 'meta-llama/Llama-3.3-70B-Instruct', 128000, { apiKeyUrl: 'https://api.berget.ai', inputCostPerMillionUsd: 0.99, outputCostPerMillionUsd: 0.99 }),
  provider('cerebras', 'Cerebras', 'https://api.cerebras.ai/v1', 'gemma-4-31b', 131072, { category: 'cloud', apiKeyUrl: 'https://cloud.cerebras.ai/', supportsVision: true, inputCostPerMillionUsd: 0.99, outputCostPerMillionUsd: 1.49 }),
  provider('chutes', 'Chutes', 'https://llm.chutes.ai/v1', 'moonshotai/Kimi-K2.6-TEE', 262144, { apiKeyUrl: 'https://chutes.ai/', supportsVision: true, inputCostPerMillionUsd: 0.66, cacheReadCostPerMillionUsd: 0.33, outputCostPerMillionUsd: 3.5 }),
  provider('clarifai', 'Clarifai', 'https://api.clarifai.com/v2/ext/openai/v1', 'moonshotai/chat-completion/models/Kimi-K2_6', 262144, { apiKeyUrl: 'https://clarifai.com/settings/security', supportsVision: true, inputCostPerMillionUsd: 0.95, outputCostPerMillionUsd: 4, apiKeyPlaceholder: 'Personal access token' }),
  provider('cloudferro-sherlock', 'CloudFerro Sherlock', 'https://api-sherlock.cloudferro.com/openai/v1', 'meta-llama/Llama-3.3-70B-Instruct', 70000, { apiKeyUrl: 'https://docs.sherlock.cloudferro.com/', inputCostPerMillionUsd: 2.92, outputCostPerMillionUsd: 2.92 }),
  provider('cohere', 'Cohere', 'https://api.cohere.ai/compatibility/v1', 'command-a-03-2025', 256000, { category: 'cloud', apiKeyUrl: 'https://dashboard.cohere.com/api-keys', inputCostPerMillionUsd: 2.5, outputCostPerMillionUsd: 10 }),
  provider('cortecs', 'Cortecs', 'https://api.cortecs.ai/v1', 'deepseek-r1-0528', 164000, { apiKeyUrl: 'https://api.cortecs.ai/v1/models', inputCostPerMillionUsd: 0.585, outputCostPerMillionUsd: 2.307 }),
  provider('deepinfra', 'DeepInfra', 'https://api.deepinfra.com/v1/openai', 'meta-llama/Llama-4-Scout-17B-16E-Instruct', 327680, { apiKeyUrl: 'https://deepinfra.com/dash/api_keys', supportsVision: true, inputCostPerMillionUsd: 0.1, outputCostPerMillionUsd: 0.3 }),
  provider('digitalocean', 'DigitalOcean Gradient AI', 'https://inference.do-ai.run/v1', 'anthropic-claude-haiku-4.5', 200000, { apiKeyUrl: 'https://cloud.digitalocean.com/account/api/tokens', supportsVision: true, inputCostPerMillionUsd: 1, cacheReadCostPerMillionUsd: 1, cacheWriteCostPerMillionUsd: 1.25, outputCostPerMillionUsd: 5, apiKeyPlaceholder: 'Access token' }),
  provider('dinference', 'DInference', 'https://api.dinference.com/v1', 'minimax-m2.5', 200000, { apiKeyUrl: 'https://dinference.com', inputCostPerMillionUsd: 0.22, outputCostPerMillionUsd: 0.88 }),
  provider('drun', 'D.Run (China)', 'https://chat.d.run/v1', 'public/deepseek-v3', 131072, { apiKeyUrl: 'https://www.d.run', inputCostPerMillionUsd: 0.28, outputCostPerMillionUsd: 1.1 }),
  provider('evroc', 'evroc', 'https://models.think.evroc.com/v1', 'moonshotai/Kimi-K2.6', 262144, { apiKeyUrl: 'https://docs.evroc.com/products/think/overview.html', supportsVision: true, inputCostPerMillionUsd: 1.4375, outputCostPerMillionUsd: 5.75 }),
  provider('fastrouter', 'FastRouter', 'https://go.fastrouter.ai/api/v1', 'moonshotai/kimi-k2', 131072, { apiKeyUrl: 'https://fastrouter.ai/models', inputCostPerMillionUsd: 0.55, outputCostPerMillionUsd: 2.2 }),
  provider('friendli', 'Friendli', 'https://api.friendli.ai/serverless/v1', 'google/gemma-4-31B-it', 262144, { apiKeyUrl: 'https://friendli.ai/docs/guides/serverless_endpoints/introduction', supportsVision: true, inputCostPerMillionUsd: 0.14, outputCostPerMillionUsd: 0.4 }),
  provider('google-vertex', 'Google Vertex AI', 'https://{vertex_endpoint}/v1/projects/{project}/locations/{location}/endpoints/openapi', 'gemini-2.5-flash', 1048576, { category: 'cloud', apiKeyUrl: 'https://console.cloud.google.com/apis/credentials', apiKeyHeader: 'x-goog-api-key', project: '', location: 'us-central1', supportsVision: true, apiKeyPlaceholder: 'Google authorization key' }),
  provider('google-vertex-anthropic', 'Google Vertex AI (Anthropic)', 'https://{vertex_endpoint}', 'claude-haiku-4-5@20251001', 200000, { category: 'cloud', type: 'vertex_anthropic', apiKeyUrl: 'https://console.cloud.google.com/apis/credentials', project: '', location: 'us-east5', supportsVision: true, inputCostPerMillionUsd: 1, cacheReadCostPerMillionUsd: 0.1, cacheWriteCostPerMillionUsd: 1.25, outputCostPerMillionUsd: 5, apiKeyPlaceholder: 'Google authorization key' }),
  provider('helicone', 'Helicone', 'https://ai-gateway.helicone.ai/v1', 'chatgpt-4o-latest', 128000, { apiKeyUrl: 'https://helicone.ai/', inputCostPerMillionUsd: 5, cacheReadCostPerMillionUsd: 2.5, outputCostPerMillionUsd: 20 }),
  provider('iflowcn', 'iFlow', 'https://apis.iflow.cn/v1', 'qwen3-coder-plus', 256000, { apiKeyUrl: 'https://platform.iflow.cn/en/docs' }),
  provider('inception', 'Inception', 'https://api.inceptionlabs.ai/v1', 'mercury-2', 128000, { category: 'cloud', apiKeyUrl: 'https://platform.inceptionlabs.ai/docs', inputCostPerMillionUsd: 0.25, cacheReadCostPerMillionUsd: 0.025, outputCostPerMillionUsd: 0.75 }),
  provider('inference', 'Inference.net', 'https://inference.net/v1', 'mistral/mistral-nemo-12b-instruct', 16000, { apiKeyUrl: 'https://inference.net/models', inputCostPerMillionUsd: 0.038, outputCostPerMillionUsd: 0.1 }),
  provider('io-net', 'IO.NET', 'https://api.intelligence.io.solutions/api/v1', 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', 430000, { apiKeyUrl: 'https://io.net/docs/guides/intelligence/io-intelligence', inputCostPerMillionUsd: 0.15, cacheReadCostPerMillionUsd: 0.075, cacheWriteCostPerMillionUsd: 0.3, outputCostPerMillionUsd: 0.6 }),
  provider('jiekou', 'Jiekou.AI', 'https://api.jiekou.ai/openai', 'o3', 131072, { apiKeyUrl: 'https://docs.jiekou.ai/docs/support/quickstart', supportsVision: true, inputCostPerMillionUsd: 10, outputCostPerMillionUsd: 40 }),
  provider('kilo', 'Kilo Gateway', 'https://api.kilo.ai/api/gateway', 'inclusionai/ling-2.6-1t', 262144, { apiKeyUrl: 'https://kilo.ai', inputCostPerMillionUsd: 0.3, cacheReadCostPerMillionUsd: 0.06, outputCostPerMillionUsd: 2.5 }),
  provider('kimi-for-coding', 'Kimi For Coding', 'https://api.kimi.com/coding/v1', 'kimi-for-coding', 262144, { category: 'cloud', apiKeyUrl: 'https://www.kimi.com/code/docs/en/', supportsVision: true, suggestions: ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3'] }),
  provider('kuae-cloud-coding-plan', 'KUAE Cloud Coding Plan', 'https://coding-plan-endpoint.kuaecloud.net/v1', 'GLM-4.7', 204800, { category: 'cloud', apiKeyUrl: 'https://docs.mthreads.com/kuaecloud/kuaecloud-doc-online/coding_plan/' }),
  provider('llama', 'Meta Llama API', 'https://api.llama.com/compat/v1', 'llama-4-scout-17b-16e-instruct-fp8', 128000, { category: 'cloud', apiKeyUrl: 'https://llama.developer.meta.com/', supportsVision: true }),
  provider('lucidquery', 'LucidQuery', 'https://api.lucidquery.com/v1', 'lucidnova-rf1-100b', 120000, { apiKeyUrl: 'https://lucidquery.com/docs', supportsVision: true, inputCostPerMillionUsd: 2, outputCostPerMillionUsd: 5 }),
  provider('meganova', 'Meganova', 'https://api.meganova.ai/v1', 'meta-llama/Llama-3.3-70B-Instruct', 131072, { apiKeyUrl: 'https://docs.meganova.ai', inputCostPerMillionUsd: 0.1, outputCostPerMillionUsd: 0.3 }),
  provider('minimax-cn-coding-plan', 'MiniMax Token Plan (China)', 'https://api.minimaxi.com/v1', 'MiniMax-M2.1', 204800, { category: 'cloud', apiKeyUrl: 'https://platform.minimaxi.com/docs/token-plan/intro' }),
  provider('minimax-coding-plan', 'MiniMax Token Plan', 'https://api.minimax.io/v1', 'MiniMax-M2.1', 204800, { category: 'cloud', apiKeyUrl: 'https://platform.minimax.io/docs/token-plan/intro' }),
  provider('moark', 'Moark', 'https://moark.com/v1', 'MiniMax-M2.1', 204800, { apiKeyUrl: 'https://moark.com/docs/openapi/v1', inputCostPerMillionUsd: 2.1, outputCostPerMillionUsd: 8.4 }),
  provider('modelscope', 'ModelScope', 'https://api-inference.modelscope.cn/v1', 'Qwen/Qwen3-30B-A3B-Thinking-2507', 262144, { apiKeyUrl: 'https://modelscope.cn/docs/model-service/API-Inference/intro' }),
  provider('morph', 'Morph', 'https://api.morphllm.com/v1', 'morph-v3-fast', 16000, { category: 'cloud', apiKeyUrl: 'https://docs.morphllm.com/api-reference/introduction', supportsTools: false, inputCostPerMillionUsd: 0.8, outputCostPerMillionUsd: 1.2 }),
  provider('nano-gpt', 'NanoGPT', 'https://nano-gpt.com/api/v1', 'claude-opus-4-thinking:8192', 200000, { apiKeyUrl: 'https://docs.nano-gpt.com', supportsVision: true, inputCostPerMillionUsd: 14.994, outputCostPerMillionUsd: 75.004 }),
  provider('nebius', 'Nebius Token Factory', 'https://api.tokenfactory.nebius.com/v1', 'meta-llama/Llama-3.3-70B-Instruct', 128000, { apiKeyUrl: 'https://docs.tokenfactory.nebius.com/', inputCostPerMillionUsd: 0.13, cacheReadCostPerMillionUsd: 0.013, cacheWriteCostPerMillionUsd: 0.16, outputCostPerMillionUsd: 0.4 }),
  provider('nova', 'Amazon Nova', 'https://api.nova.amazon.com/v1', 'nova-2-pro-v1', 1000000, { category: 'cloud', apiKeyUrl: 'https://nova.amazon.com/dev/documentation', supportsVision: true }),
  provider('novita-ai', 'NovitaAI', 'https://api.novita.ai/openai', 'inclusionai/ling-2.6-1t', 262144, { apiKeyUrl: 'https://novita.ai/docs/guides/introduction', inputCostPerMillionUsd: 0.3, cacheReadCostPerMillionUsd: 0.06, outputCostPerMillionUsd: 2.5 }),
  provider('ollama-cloud', 'Ollama Cloud', 'https://ollama.com/v1', 'deepseek-v4-flash', 1048576, { category: 'cloud', apiKeyUrl: 'https://docs.ollama.com/cloud' }),
  provider('opencode', 'OpenCode Zen', 'https://opencode.ai/zen/v1', 'ring-2.6-1t-free', 262000, { apiKeyUrl: 'https://opencode.ai/docs/zen' }),
  provider('opencode-go', 'OpenCode Go', 'https://opencode.ai/zen/go/v1', 'deepseek-v4-flash', 1000000, { apiKeyUrl: 'https://opencode.ai/docs/zen', inputCostPerMillionUsd: 0.14, cacheReadCostPerMillionUsd: 0.0028, outputCostPerMillionUsd: 0.28 }),
  provider('ovhcloud', 'OVHcloud AI Endpoints', 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', 'qwen3-coder-30b-a3b-instruct', 262144, { apiKeyUrl: 'https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/', inputCostPerMillionUsd: 0.07, outputCostPerMillionUsd: 0.26 }),
  provider('perplexity', 'Perplexity Sonar', 'https://api.perplexity.ai', 'sonar-reasoning-pro', 128000, { category: 'cloud', apiKeyUrl: 'https://www.perplexity.ai/settings/api', supportsVision: true, supportsTools: false, inputCostPerMillionUsd: 2, outputCostPerMillionUsd: 8 }),
  provider('perplexity-agent', 'Perplexity Agent', 'https://api.perplexity.ai/v1', 'xai/grok-4-1-fast-non-reasoning', 2000000, { category: 'cloud', apiKeyUrl: 'https://www.perplexity.ai/settings/api', supportsVision: true, apiFormat: 'responses', inputCostPerMillionUsd: 0.2, cacheReadCostPerMillionUsd: 0.05, outputCostPerMillionUsd: 0.5 }),
  provider('poe', 'Poe', 'https://api.poe.com/v1', 'trytako/tako', 2048, { apiKeyUrl: 'https://poe.com/api_key', supportsVision: true }),
  provider('privatemode-ai', 'Privatemode AI', 'http://localhost:8080/v1', 'gemma-3-27b', 128000, { category: 'local', apiKeyUrl: 'https://docs.privatemode.ai/api/overview', supportsVision: true }),
  provider('qihang-ai', 'QiHang', 'https://api.qhaigc.net/v1', 'claude-haiku-4-5-20251001', 200000, { apiKeyUrl: 'https://www.qhaigc.net/docs', supportsVision: true, inputCostPerMillionUsd: 0.14, outputCostPerMillionUsd: 0.71 }),
  provider('qiniu-ai', 'Qiniu', 'https://api.qnaigc.com/v1', 'deepseek-r1-0528', 128000, { apiKeyUrl: 'https://developer.qiniu.com/aitokenapi' }),
  provider('requesty', 'Requesty', 'https://router.requesty.ai/v1', 'xai/grok-4', 256000, { apiKeyUrl: 'https://requesty.ai/solution/llm-routing/models', supportsVision: true, inputCostPerMillionUsd: 3, cacheReadCostPerMillionUsd: 0.75, cacheWriteCostPerMillionUsd: 3, outputCostPerMillionUsd: 15 }),
  provider('scaleway', 'Scaleway', 'https://api.scaleway.ai/v1', 'qwen3-235b-a22b-instruct-2507', 260000, { apiKeyUrl: 'https://www.scaleway.com/en/docs/generative-apis/', inputCostPerMillionUsd: 0.75, outputCostPerMillionUsd: 2.25 }),
  provider('siliconflow', 'SiliconFlow', 'https://api.siliconflow.com/v1', 'moonshotai/Kimi-K2.6', 262000, { apiKeyUrl: 'https://cloud.siliconflow.com/account/ak', inputCostPerMillionUsd: 0.77, cacheReadCostPerMillionUsd: 0.2, outputCostPerMillionUsd: 4 }),
  provider('siliconflow-cn', 'SiliconFlow (China)', 'https://api.siliconflow.cn/v1', 'baidu/ERNIE-4.5-300B-A47B', 131000, { apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak', inputCostPerMillionUsd: 0.28, outputCostPerMillionUsd: 1.1 }),
  provider('stackit', 'STACKIT', 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1', 'cortecs/Llama-3.3-70B-Instruct-FP8-Dynamic', 128000, { apiKeyUrl: 'https://docs.stackit.cloud/products/data-and-ai/ai-model-serving/', inputCostPerMillionUsd: 0.53, outputCostPerMillionUsd: 0.76 }),
  provider('stepfun', 'StepFun', 'https://api.stepfun.com/v1', 'step-1-32k', 32768, { category: 'cloud', apiKeyUrl: 'https://platform.stepfun.com/docs/zh/overview/concept', inputCostPerMillionUsd: 2.05, cacheReadCostPerMillionUsd: 0.41, outputCostPerMillionUsd: 9.59 }),
  provider('submodel', 'submodel', 'https://llm.submodel.ai/v1', 'Qwen/Qwen3-235B-A22B-Thinking-2507', 262144, { apiKeyUrl: 'https://submodel.gitbook.io', inputCostPerMillionUsd: 0.2, outputCostPerMillionUsd: 0.6 }),
  provider('synthetic', 'Synthetic', 'https://api.synthetic.new/openai/v1', 'hf:moonshotai/Kimi-K2.7-Code', 262144, { apiKeyUrl: 'https://synthetic.new/', supportsVision: true, inputCostPerMillionUsd: 0.95, cacheReadCostPerMillionUsd: 0.95, outputCostPerMillionUsd: 4 }),
  provider('tencent-coding-plan', 'Tencent Coding Plan (China)', 'https://api.lkeap.cloud.tencent.com/coding/v3', 'minimax-m2.5', 204800, { category: 'cloud', apiKeyUrl: 'https://cloud.tencent.com/document/product/1772/128947' }),
  provider('upstage', 'Upstage', 'https://api.upstage.ai/v1/solar', 'solar-pro2', 65536, { category: 'cloud', apiKeyUrl: 'https://console.upstage.ai/api-keys', inputCostPerMillionUsd: 0.25, outputCostPerMillionUsd: 0.25 }),
  provider('v0', 'v0', 'https://api.v0.dev/v1', 'v0-1.0-md', 128000, { category: 'cloud', apiKeyUrl: 'https://v0.dev/chat/settings/keys', supportsVision: true, inputCostPerMillionUsd: 3, outputCostPerMillionUsd: 15 }),
  provider('venice', 'Venice AI', 'https://api.venice.ai/api/v1', 'z-ai-glm-5-turbo', 200000, { apiKeyUrl: 'https://venice.ai/settings/api', inputCostPerMillionUsd: 1.2, cacheReadCostPerMillionUsd: 0.24, outputCostPerMillionUsd: 4 }),
  provider('vercel', 'Vercel AI Gateway', 'https://ai-gateway.vercel.sh/v1', 'xai/grok-4.1-fast-reasoning', 1000000, { apiKeyUrl: 'https://vercel.com/ai-gateway', inputCostPerMillionUsd: 0.2, cacheReadCostPerMillionUsd: 0.05, outputCostPerMillionUsd: 0.5 }),
  provider('vivgrid', 'Vivgrid', 'https://api.vivgrid.com/v1', 'deepseek-v4-pro', 1000000, { apiKeyUrl: 'https://docs.vivgrid.com/models', inputCostPerMillionUsd: 0.435, cacheReadCostPerMillionUsd: 0.003625, outputCostPerMillionUsd: 0.87 }),
  provider('vultr', 'Vultr', 'https://api.vultrinference.com/v1', 'moonshotai/Kimi-K2.6', 262144, { apiKeyUrl: 'https://my.vultr.com/', supportsVision: true, inputCostPerMillionUsd: 0.3, outputCostPerMillionUsd: 1.2 }),
  provider('wandb', 'Weights & Biases', 'https://api.inference.wandb.ai/v1', 'ibm-granite/granite-4.1-8b', 131072, { apiKeyUrl: 'https://wandb.ai/authorize', inputCostPerMillionUsd: 0.05, cacheReadCostPerMillionUsd: 0.05, outputCostPerMillionUsd: 0.1 }),
  provider('xiaomi', 'Xiaomi MiMo', 'https://api.xiaomimimo.com/v1', 'mimo-v2.5-pro-ultraspeed', 1048576, { category: 'cloud', apiKeyUrl: 'https://platform.xiaomimimo.com/', inputCostPerMillionUsd: 1.305, cacheReadCostPerMillionUsd: 0.0108, outputCostPerMillionUsd: 2.61 }),
  provider('zai-coding-plan', 'Z.AI Coding Plan', 'https://api.z.ai/api/coding/paas/v4', 'glm-4.7', 204800, { category: 'cloud', apiKeyUrl: 'https://docs.z.ai/devpack/overview' }),
  provider('zenmux', 'ZenMux', 'https://zenmux.ai/api/v1', 'inclusionai/ling-1t', 128000, { apiKeyUrl: 'https://docs.zenmux.ai', inputCostPerMillionUsd: 0.56, cacheReadCostPerMillionUsd: 0.11, outputCostPerMillionUsd: 2.24 }),
  provider('zhipuai', 'Zhipu AI', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.1', 200000, { category: 'cloud', apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', inputCostPerMillionUsd: 1.4, cacheReadCostPerMillionUsd: 0.26, outputCostPerMillionUsd: 4.4 }),
  provider('zhipuai-coding-plan', 'Zhipu AI Coding Plan', 'https://open.bigmodel.cn/api/coding/paas/v4', 'glm-5.1', 200000, { category: 'cloud', apiKeyUrl: 'https://docs.bigmodel.cn/cn/coding-plan/overview' }),
];

export const ADDITIONAL_PROVIDER_IDS = Object.freeze(PROVIDERS.map(({ id }) => id));

export const ADDITIONAL_PROVIDER_DEFAULTS = Object.freeze(Object.fromEntries(
  PROVIDERS.map(({ id, config }) => [id, Object.freeze(config)]),
));

export const ADDITIONAL_PROVIDER_UI = Object.freeze(Object.fromEntries(
  PROVIDERS.map(({ id, ui }) => [id, Object.freeze(ui)]),
));
