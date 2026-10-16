// OpenRouter carries Gemini's opaque signatures in reasoning_details. Use the
// Agent's existing provider-owned envelope to preserve them across tool turns.
export function openRouterReplayIdentity(config) {
  let url;
  try { url = new URL(config.baseUrl); } catch { return null; }
  const model = String(config.model || '').trim().toLowerCase();
  return url.hostname === 'openrouter.ai'
    && url.pathname.replace(/\/+$/, '') === '/api/v1'
    && /^(?:google\/gemini-4-argon|meta\/muse-(?:wonder|spark-open))(?=$|:)/.test(model)
    ? `openrouter:${model}` : null;
}

export function openRouterReplayItems(config, details, calls = []) {
  const identity = openRouterReplayIdentity(config);
  if (!identity || !Array.isArray(details) || !details.length) return null;
  return [{
    type: 'webbrain_provider_replay', version: 1,
    provider: config.providerName || 'openai', model: config.model,
    providerIdentity: identity,
    content: [{ type: 'openrouter_reasoning_details', details },
      ...(calls || []).map(call => ({ type: 'tool_use', id: call.id }))],
  }];
}

export function projectOpenRouterReplay(messages, originals, config) {
  const identity = openRouterReplayIdentity(config);
  if (!identity) return messages;
  return messages.map((message, index) => {
    const { reasoning_details: _unownedDetails, ...clean } = message;
    const state = originals[index]?._reasoning_replay?.providerState;
    if (state?.providerIdentity !== identity || state.version !== 1
      || state.provider !== (config.providerName || 'openai') || state.model !== config.model
      || !Array.isArray(state.content)) return clean;
    const ids = state.content.filter(block => block.type === 'tool_use').map(block => block.id);
    const calls = clean.tool_calls || [];
    if (ids.length !== calls.length || ids.some((id, i) => !id || id !== calls[i]?.id)) return clean;
    const details = state.content.find(block => block.type === 'openrouter_reasoning_details')?.details;
    return Array.isArray(details) ? { ...clean, reasoning_details: details } : clean;
  });
}

export function accumulateReasoningDetails(accumulator, details) {
  for (const detail of Array.isArray(details) ? details : []) {
    if (!detail || typeof detail !== 'object') continue;
    const existing = Number.isInteger(detail.index)
      ? accumulator.find(block => block.index === detail.index) : null;
    if (!existing) { accumulator.push({ ...detail }); continue; }
    for (const [key, value] of Object.entries(detail)) {
      if (['text', 'data', 'summary'].includes(key) && typeof value === 'string') {
        existing[key] = String(existing[key] || '') + value;
      } else existing[key] = value;
    }
  }
}
