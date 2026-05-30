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
   * Whether this provider is running a small/local model that benefits from
   * a compact system prompt. When true, the agent uses SYSTEM_PROMPT_ACT_COMPACT
   * instead of the full SYSTEM_PROMPT_ACT to save context budget.
   */
  get useCompactPrompt() {
    return !!this.config.useCompactPrompt;
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
