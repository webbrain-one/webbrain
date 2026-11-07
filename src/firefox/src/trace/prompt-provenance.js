const RUNTIME_MODE_RE = /\bAuthoritative execution state:\s*runtime_mode=(ask|act|dev);\s*mutation_tools_enabled=(true|false)\b/i;

// These revisions describe controlled WebBrain policy, never request content.
// Bump them when the corresponding prompt or tool-exposure policy changes.
export const PROMPT_POLICY_REVISION = 1;
export const TOOL_POLICY_REVISION = 1;

function messageContentChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return content == null ? 0 : String(content).length;
  return content.reduce((total, block) => {
    if (!block || typeof block !== 'object') return total;
    if (typeof block.text === 'string') return total + block.text.length;
    if (typeof block.content === 'string') return total + block.content.length;
    const imageUrl = block.image_url?.url || block.source?.data || '';
    return total + (typeof imageUrl === 'string' ? imageUrl.length : 0);
  }, 0);
}

function systemPromptVariant(prompt) {
  const text = String(prompt || '');
  if (text.startsWith("You are WebBrain's private on-device chat assistant")) return 'standalone_webgpu';
  if (text.startsWith("You are WebBrain's on-device page assistant")) return 'tiny_ask';
  if (text.startsWith("You are WebBrain's standalone chat assistant")) return 'standalone_chat';
  if (text.startsWith("You are WebBrain's chat assistant, opened from the browser's new tab page")) return 'standalone_web_chat';
  if (text.startsWith('You are WebBrain, a helpful AI browser assistant running in Ask mode.')) return 'ask';

  let actTier = '';
  if (text.startsWith('You are WebBrain, an AI browser agent running in Act mode. You can read web pages')) actTier = 'full';
  else if (text.startsWith('You are WebBrain, an AI browser agent running in Act mode. You read web pages')) actTier = 'mid';
  else if (text.startsWith('You are WebBrain, an AI browser agent. You control web pages through tools.')) actTier = 'compact';
  if (actTier) return text.includes('\nDEV MODE APPENDIX:\n') ? `dev_${actTier}` : `act_${actTier}`;

  if (text.startsWith('You are the planning subsystem for WebBrain')) return 'planner';
  if (text.startsWith('You are the intent and compact planning subsystem for WebBrain')) return 'planner_intent';
  if (text.startsWith('You classify how much of the active communication thread WebBrain must read')) return 'read_scope';
  if (text.startsWith('You are WebBrain producing a tool-free chat response')) return 'context_only';
  if (text.startsWith('You are WebBrain on a forced terminal delivery turn')) return 'delivery_recovery';
  return text ? 'unknown' : 'missing';
}

function variantMode(variant) {
  if (variant === 'ask' || variant === 'standalone_chat' || variant === 'standalone_web_chat' || variant === 'standalone_webgpu' || variant === 'tiny_ask') return 'ask';
  if (variant.startsWith('act_')) return 'act';
  if (variant.startsWith('dev_')) return 'dev';
  return null;
}

function runtimeEnvelope(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const content = typeof message.content === 'string'
      ? message.content
      : (Array.isArray(message.content)
        ? message.content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n')
        : '');
    const match = content.match(RUNTIME_MODE_RE);
    if (match) {
      return {
        mode: match[1].toLowerCase(),
        mutationToolsEnabled: match[2].toLowerCase() === 'true',
      };
    }
  }
  return { mode: null, mutationToolsEnabled: null };
}

/**
 * Build a content-free diagnostic summary of the request sent to a provider.
 * Raw prompt text, message text, tool schemas, and tool names never leave this
 * function; traces retain only counts, controlled variants, and policy revisions.
 */
export function buildPromptTraceProvenance(rawMessages, rawTools, runtimeMode = '') {
  const messages = Array.isArray(rawMessages) ? rawMessages : [];
  const tools = Array.isArray(rawTools) ? rawTools : [];
  const systemMessage = messages.find(message => message?.role === 'system');
  const systemPrompt = typeof systemMessage?.content === 'string' ? systemMessage.content : '';
  const variant = systemPromptVariant(systemPrompt);
  const promptMode = variantMode(variant);
  const expectedMode = ['ask', 'act', 'dev'].includes(String(runtimeMode || '').toLowerCase())
    ? String(runtimeMode).toLowerCase()
    : null;
  const envelope = runtimeEnvelope(messages);
  // Tiny Ask carries a one-line trusted clock instead of the full envelope.
  const runtimeEnvelopeRequired = variant !== 'standalone_chat' && variant !== 'standalone_web_chat' && variant !== 'standalone_webgpu' && variant !== 'tiny_ask';
  const roleCounts = { system: 0, user: 0, assistant: 0, tool: 0, other: 0 };
  let messageChars = 0;
  for (const message of messages) {
    const role = Object.prototype.hasOwnProperty.call(roleCounts, message?.role) ? message.role : 'other';
    roleCounts[role] += 1;
    messageChars += messageContentChars(message?.content);
  }
  return {
    schemaVersion: 1,
    promptPolicyRevision: PROMPT_POLICY_REVISION,
    toolPolicyRevision: TOOL_POLICY_REVISION,
    systemPromptVariant: variant,
    systemPromptMode: promptMode,
    systemPromptChars: systemPrompt.length,
    messageCount: messages.length,
    messageChars,
    messageRoleCounts: roleCounts,
    toolCount: tools.length,
    runtimeMode: expectedMode,
    runtimeEnvelopeRequired,
    runtimeEnvelopeMode: envelope.mode,
    runtimeEnvelopeMutationToolsEnabled: envelope.mutationToolsEnabled,
    runtimeEnvelopeMatches: expectedMode && runtimeEnvelopeRequired ? envelope.mode === expectedMode : null,
    systemPromptMatchesRuntime: expectedMode && promptMode ? expectedMode === promptMode : null,
  };
}
