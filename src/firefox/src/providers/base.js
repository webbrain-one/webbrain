/**
 * Base LLM Provider — all providers implement this interface.
 */
export class BaseLLMProvider {
  constructor(config = {}) {
    this.config = config;
  }

  get name() {
    return 'base';
  }

  /**
   * Send a chat completion request.
   * @param {Array<{role: string, content: string}>} messages
   * @param {Object} options - { tools, temperature, maxTokens, stream }
   * @returns {Promise<{content: string, toolCalls: Array|null, usage: Object|null}>}
   */
  async chat(messages, options = {}) {
    throw new Error('chat() not implemented');
  }

  /**
   * Stream a chat completion request.
   * @param {Array<{role: string, content: string}>} messages
   * @param {Object} options
   * @yields {{type: 'text'|'tool_call'|'done', content: string}}
   */
  async *chatStream(messages, options = {}) {
    throw new Error('chatStream() not implemented');
  }

  /**
   * Check if this provider supports tool/function calling.
   */
  get supportsTools() {
    return false;
  }

  /**
   * Check if this provider supports image inputs (vision).
   */
  get supportsVision() {
    return false;
  }

  /**
   * Approximate context window (in tokens) for the active model. The agent
   * uses this to decide when to auto-compact the conversation ("Context
   * automatically compacted"): once the running input-token count crosses a
   * fraction of this window, older turns are summarized away.
   *
   * Providers can pass an exact value via `config.contextWindow` (e.g. a
   * 16k local model, or a 200k cloud model). Otherwise the default is
   * category-aware: local backends (llama.cpp / Ollama / LM Studio) often run
   * small windows and the default settings UI doesn't populate
   * `contextWindow`, so we assume a conservative 16k for them — better to
   * compact a little early than to sail past the real limit into emergency
   * trimming. 16k matches the usable minimum for WebBrain's agent loop: a 4k
   * window can't even hold the system prompt + tool schemas, 8k is the bare
   * minimum, and 16k is the smallest window most local models stay coherent
   * in. Cloud/router models get a modern 128k default where the char/message
   * heuristics still govern. Set `config.contextWindow` explicitly for a
   * large-window local model to lift the conservative cap.
   */
  get contextWindow() {
    const n = Number(this.config.contextWindow);
    if (Number.isFinite(n) && n > 0) return n;
    return this.config.category === 'local' ? 16384 : 128000;
  }

  /**
   * Whether this provider is running a small/local model that benefits from
   * a compact system prompt. When true, the agent uses SYSTEM_PROMPT_ACT_COMPACT
   * instead of the full SYSTEM_PROMPT_ACT to save context budget.
   */
  get useCompactPrompt() {
    return !!this.config.useCompactPrompt;
  }

  /**
   * Prompt tier for this provider: 'compact' | 'mid' | 'full'. Drives both
   * which ACT system prompt and which tool set the agent uses.
   *
   * Cloud providers are always 'full' — the tier knob is a small-model
   * concern, exposed only for local and OpenRouter providers. Otherwise an
   * explicit config.promptTier wins; failing that the legacy boolean
   * useCompactPrompt maps to 'compact'; failing that local providers default
   * to 'mid' and everything else (e.g. OpenRouter) to 'full'.
   */
  get promptTier() {
    if (this.config.category === 'cloud') return 'full';
    const t = this.config.promptTier;
    if (t === 'compact' || t === 'mid' || t === 'full') return t;
    if (this.config.useCompactPrompt) return 'compact';
    return this.config.category === 'local' ? 'mid' : 'full';
  }

  /**
   * Test the connection to this provider.
   * @returns {Promise<{ok: boolean, error?: string, model?: string}>}
   */
  async testConnection() {
    try {
      const res = await this.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 5 });
      return { ok: true, model: this.config.model };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}
