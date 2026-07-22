import { BaseLLMProvider } from './base.js';
import { fetchWithTimeout } from './fetch-timeout.js';

/**
 * AWS Bedrock provider (Converse API) with SigV4 signing.
 */
export class AwsBedrockProvider extends BaseLLMProvider {
  get name() {
    return this.config.providerName || 'aws-bedrock';
  }

  get supportsTools() {
    return true;
  }

  get supportsVision() {
    return false;
  }

  get region() {
    return String(this.config.region || '').trim() || 'us-east-1';
  }

  get modelId() {
    return String(this.config.model || '').trim();
  }

  get model() {
    return this.modelId;
  }

  get accessKeyId() {
    return String(this.config.accessKeyId || '').trim();
  }

  get secretAccessKey() {
    return String(this.config.secretAccessKey || '').trim();
  }

  get sessionToken() {
    return String(this.config.sessionToken || '').trim();
  }

  _assertConfigured() {
    if (!this.modelId) throw new Error('Bedrock model id is required (Model field).');
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error('AWS Access Key ID and Secret Access Key are required.');
    }
    if (!this.region) throw new Error('AWS region is required.');
  }

  _endpoint() {
    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const path = `/model/${encodeURIComponent(this.modelId)}/converse`;
    return { host, url: `https://${host}${path}`, path };
  }

  _messagesContainImage(messages) {
    return messages.some((msg) => Array.isArray(msg?.content) && msg.content.some((block) => {
      return block && (block.type === 'image_url' || block.type === 'image');
    }));
  }

  _toBedrockPayload(openAiMessages, options = {}) {
    if (this._messagesContainImage(openAiMessages)) {
      throw new Error('Bedrock Converse provider does not support image inputs yet. Disable screenshots or use a vision-capable provider.');
    }

    const systemTexts = [];
    const messages = [];

    const pushMessage = (role, contentBlocks) => {
      if (!contentBlocks.length) return;
      messages.push({ role, content: contentBlocks });
    };

    const toTextBlocks = (content) => {
      if (content == null) return [];
      if (Array.isArray(content)) {
        return content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => ({ text: b.text }));
      }
      const s = String(content);
      return s ? [{ text: s }] : [];
    };

    for (const msg of openAiMessages || []) {
      const role = msg?.role;
      if (role === 'system') {
        const text = Array.isArray(msg?.content)
          ? msg.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
          : String(msg?.content || '');
        if (text.trim()) systemTexts.push(text.trim());
        continue;
      }

      if (role === 'user') {
        pushMessage('user', toTextBlocks(msg.content));
        continue;
      }

      if (role === 'assistant') {
        const blocks = [];
        blocks.push(...toTextBlocks(msg.content));
        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : null;
        if (toolCalls) {
          for (const call of toolCalls) {
            const fn = call?.function;
            const name = fn?.name;
            if (!name) continue;
            let input = {};
            try { input = fn?.arguments ? JSON.parse(fn.arguments) : {}; } catch { input = {}; }
            blocks.push({
              toolUse: {
                toolUseId: call.id || crypto.randomUUID(),
                name,
                input,
              },
            });
          }
        }
        pushMessage('assistant', blocks);
        continue;
      }

      if (role === 'tool') {
        const toolUseId = msg.tool_call_id || msg.toolCallId || '';
        const name = msg.name || '';
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
        pushMessage('user', [{
          toolResult: {
            toolUseId: toolUseId || name || crypto.randomUUID(),
            content: [{ text }],
          },
        }]);
      }
    }

    const toolConfig = (options.tools && options.tools.length)
      ? {
          tools: options.tools
            .map((t) => t?.function)
            .filter(Boolean)
            .map((fn) => ({
              toolSpec: {
                name: fn.name,
                description: fn.description || '',
                inputSchema: { json: fn.parameters || { type: 'object', properties: {} } },
              },
            })),
          toolChoice: { auto: {} },
        }
      : undefined;

    const payload = {
      messages,
      ...(systemTexts.length ? { system: systemTexts.map((t) => ({ text: t })) } : {}),
      inferenceConfig: {
        maxTokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0.7,
      },
      ...(toolConfig ? { toolConfig } : {}),
    };
    return payload;
  }

  async _signAndFetch({ url, host, path }, body) {
    const method = 'POST';
    const service = 'bedrock';

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const payload = JSON.stringify(body);
    const payloadHash = await sha256Hex(payload);

    const headers = {
      host,
      'content-type': 'application/json',
      accept: 'application/json',
      'x-amz-date': amzDate,
    };
    if (this.sessionToken) headers['x-amz-security-token'] = this.sessionToken;

    const signedHeaders = Object.keys(headers).map((h) => h.toLowerCase()).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort()
      .map((h) => `${h}:${String(headers[h]).trim()}\n`)
      .join('');

    const canonicalRequest = [
      method,
      path,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const algorithm = 'AWS4-HMAC-SHA256';
    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const stringToSign = [
      algorithm,
      amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = await getSignatureKey(this.secretAccessKey, dateStamp, this.region, service);
    const signature = await hmacHex(signingKey, stringToSign);

    const authorization = `${algorithm} Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const finalHeaders = { ...headers, authorization };

    return await fetchWithTimeout(url, { method, headers: finalHeaders, body: payload });
  }

  _normalizeUsage(usage) {
    if (!usage) return null;
    const input = usage.inputTokens ?? usage.prompt_tokens ?? 0;
    const output = usage.outputTokens ?? usage.completion_tokens ?? 0;
    const normalized = {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: usage.totalTokens ?? (input + output),
    };
    if (usage.cacheReadInputTokens != null) normalized.cacheReadInputTokens = usage.cacheReadInputTokens;
    if (usage.cacheWriteInputTokens != null) normalized.cacheWriteInputTokens = usage.cacheWriteInputTokens;
    if (Array.isArray(usage.cacheDetails)) normalized.cacheDetails = usage.cacheDetails.map(detail => ({ ...detail }));
    return normalized;
  }

  _fromBedrockResponse(data) {
    const message = data?.output?.message;
    const contentBlocks = Array.isArray(message?.content) ? message.content : [];
    const text = contentBlocks.map((b) => b?.text).filter(Boolean).join('');

    const toolUses = contentBlocks.map((b) => b?.toolUse).filter(Boolean);
    const toolCalls = toolUses.length
      ? toolUses.map((u, index) => ({
          id: u.toolUseId || crypto.randomUUID(),
          type: 'function',
          index,
          function: {
            name: u.name,
            arguments: JSON.stringify(u.input ?? {}),
          },
        }))
      : null;

    return {
      content: text || '',
      toolCalls,
      usage: this._normalizeUsage(data?.usage),
      raw: data,
    };
  }

  async chat(messages, options = {}) {
    this._assertConfigured();
    const endpoint = this._endpoint();
    const payload = this._toBedrockPayload(messages, options);

    let res;
    try {
      res = await this._signAndFetch(endpoint, payload);
    } catch (e) {
      throw new Error(`${this.name} network error — could not reach ${endpoint.url} (${e.message}).`);
    }

    if (!res.ok) {
      let err = '';
      try { err = (await res.text()).slice(0, 1200); } catch {}
      throw new Error(`${this.name} error ${res.status}: ${err || res.statusText}`);
    }

    let data;
    try { data = await res.json(); } catch {
      throw new Error(`${this.name} returned invalid JSON.`);
    }

    return this._fromBedrockResponse(data);
  }

  async *chatStream(messages, options = {}) {
    const res = await this.chat(messages, options);
    if (res.content) yield { type: 'text', content: res.content };
    if (res.toolCalls) yield { type: 'tool_call', content: res.toolCalls };
    if (res.usage) yield { type: 'usage', usage: res.usage };
    yield { type: 'done', content: '' };
  }
}

async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacRaw(keyBytes, data) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function hmacHex(keyBytes, data) {
  const sig = await hmacRaw(keyBytes, data);
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(secretAccessKey, dateStamp, regionName, serviceName) {
  const kDate = await hmacRaw(new TextEncoder().encode('AWS4' + secretAccessKey), dateStamp);
  const kRegion = await hmacRaw(kDate, regionName);
  const kService = await hmacRaw(kRegion, serviceName);
  const kSigning = await hmacRaw(kService, 'aws4_request');
  return kSigning;
}
