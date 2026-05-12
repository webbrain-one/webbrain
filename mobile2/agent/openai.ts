/**
 * Minimal OpenAI-compatible chat completions client.
 *
 * Ported from src/chrome/src/providers/openai.js with a few simplifications
 * for v0:
 *   - No streaming (we'll add chatStream later for live deltas in chat).
 *   - No vision branch yet (the WebView doesn't capture screenshots in v0).
 *   - No fetch-with-fallback (no localhost/PNA workaround needed on mobile).
 *
 * Works against any OpenAI-shape endpoint: api.openai.com, OpenRouter,
 * LM Studio, Ollama (`ollama serve` exposes /v1/chat/completions), etc.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  // assistant-only:
  tool_calls?: ToolCall[];
  // tool-only:
  tool_call_id?: string;
  name?: string;
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ToolSchema = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatResult = {
  content: string;
  toolCalls: ToolCall[] | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
};

export type OpenAIConfig = {
  apiKey: string;
  baseUrl?: string; // defaults to https://api.openai.com/v1
  model?: string;   // defaults to gpt-5.4-mini
};

const DEFAULT_BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.4-mini';

// gpt-5 / gpt-4.1 / o-series use a different field for max tokens and reject
// non-default temperature. Detect by model-name regex (mirrors the Chrome
// extension's logic).
function isNewContract(model: string): boolean {
  return /^(gpt-5|gpt-4\.1|o1|o3|o4)/i.test(model);
}

export class OpenAIProvider {
  constructor(private config: OpenAIConfig) {}

  get model(): string {
    return this.config.model || DEFAULT_MODEL;
  }

  get baseUrl(): string {
    return (this.config.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  }

  async chat(
    messages: ChatMessage[],
    options: {
      tools?: ToolSchema[];
      temperature?: number;
      maxTokens?: number;
      toolChoice?: 'auto' | 'none' | 'required';
    } = {},
  ): Promise<ChatResult> {
    const newContract = isNewContract(this.model);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    };
    if (!newContract) {
      body.temperature = options.temperature ?? 0.3;
      body.max_tokens = options.maxTokens ?? 4096;
    } else {
      body.max_completion_tokens = options.maxTokens ?? 4096;
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

    const url = `${this.baseUrl}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Network error contacting ${url}: ${msg}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI error ${res.status}: ${text || res.statusText}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: ToolCall[];
        };
      }>;
      usage?: ChatResult['usage'];
    };
    const message = data.choices?.[0]?.message;
    return {
      content: message?.content || '',
      toolCalls: message?.tool_calls && message.tool_calls.length > 0 ? message.tool_calls : null,
      usage: data.usage || null,
    };
  }
}
