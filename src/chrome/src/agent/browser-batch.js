/** Browser-free execution/transcript helpers. Keep byte-identical in both builds. */
import { validateToolArguments } from './tool-arguments.js';

export const MAX_BATCH_ACTIONS = Object.freeze({ mid: 6, full: 10 });
export const BATCH_INTERMEDIATE_RESULT_CHARS = 2000;
export const BATCHABLE_ACTION_TOOLS = new Set([
  'click_ax', 'type_ax', 'set_field', 'set_checked', 'click', 'type_text', 'press_keys',
  'scroll', 'hover', 'drag_drop', 'navigate', 'go_back', 'go_forward',
  'wait_for_element', 'wait_for_stable', 'iframe_click', 'iframe_type',
]);
export const BATCH_TRAILING_OBSERVATION_TOOLS = new Set([
  'get_accessibility_tree', 'read_page', 'inspect_viewport', 'get_window_info',
]);
const passive = new Set(['wait_for_element', 'wait_for_stable', ...BATCH_TRAILING_OBSERVATION_TOOLS]);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const argsFor = call => {
  try { return typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments; }
  catch { return null; }
};

export function validateBrowserBatch(call, { enabled = true, tier = 'full', allowedToolNames = new Set(), toolSchemas = new Map(), turnCalls = [call] } = {}) {
  const fail = detail => ({ ok: false, result: { success: false, noDispatch: true, dispatched: false,
    invalidToolArguments: true, errorCode: 'invalid_browser_batch', error: `browser_batch: ${detail}` } });
  if (!enabled || tier === 'compact' || !allowedToolNames.has('browser_batch')) return fail('Batching is unavailable for this request.');
  if (typeof call.id !== 'string' || !call.id.trim() || call.id.includes('::')
      || turnCalls.filter(item => item.id === call.id).length !== 1) return fail('The parent call id must be non-empty and unique.');
  const args = argsFor(call);
  if (!object(args) || Object.keys(args).some(key => key !== 'actions')) return fail('Expected an actions object.');
  const actions = args.actions;
  if (!Array.isArray(actions) || !actions.length || actions.length > (MAX_BATCH_ACTIONS[tier] || MAX_BATCH_ACTIONS.full)) return fail('Invalid action count.');
  if (actions.some((_, index) => turnCalls.some(item => item.id === `${call.id}::${index}`))) return fail('Expanded action ids collide with another call.');
  let observed = false, mutated = false;
  for (const [index, action] of actions.entries()) {
    if (!object(action) || Object.keys(action).some(key => key !== 'name' && key !== 'input')
        || typeof action.name !== 'string' || !object(action.input)) return fail(`actions[${index}] must contain a name and input object.`);
    const { name, input } = action;
    if (!allowedToolNames.has(name) || (!BATCHABLE_ACTION_TOOLS.has(name) && !BATCH_TRAILING_OBSERVATION_TOOLS.has(name))) return fail(`actions[${index}] is not an advertised batchable tool.`);
    if (BATCH_TRAILING_OBSERVATION_TOOLS.has(name)) observed = true;
    else if (observed) return fail('Observations must follow all actions.');
    if (name === 'click' && (input.x != null || input.y != null) && mutated) return fail('Coordinate clicks must precede page changes.');
    const schema = toolSchemas.get(name);
    if (!schema) return fail(`actions[${index}] has no advertised schema.`);
    const validation = validateToolArguments(name, input, schema);
    if (!validation.ok) return fail(`actions[${index}]: ${validation.result.detail || validation.result.error}`);
    if (!passive.has(name)) mutated = true;
  }
  return { ok: true, args, actions };
}

export function expandBrowserBatchCalls(calls, options) {
  return calls.flatMap(call => {
    if (call.function?.name !== 'browser_batch') return [call];
    const validation = validateBrowserBatch(call, { ...options, turnCalls: calls });
    if (!validation.ok) return [{ ...call, _browserBatchError: validation.result }];
    return validation.actions.map((action, index) => ({
      id: `${call.id}::${index}`, type: 'function',
      function: { name: action.name, arguments: JSON.stringify(action.input) },
      _browserBatch: { parentId: call.id, index, total: validation.actions.length },
    }));
  });
}

export function browserBatchResultStatus(message) {
  if (!message) return { ran: false, reason: 'interrupted' };
  let text = String(message.content || '');
  const wrapped = text.match(/^<untrusted_page_content\b[^>]*>([\s\S]*?)<\/untrusted_page_content\b[^>]*>/);
  if (wrapped) text = wrapped[1].trim();
  let result;
  try { result = JSON.parse(text); } catch {
    try { result = JSON.parse(text.split('\n')[0]); } catch { return { ran: true, reason: '', failed: false }; }
  }
  if (!object(result)) return { ran: true, reason: '', failed: false };
  const ran = !(result.skipped || result.denied || result.invalidToolArguments || result.invalidArguments
    || ((result.noDispatch === true || result.dispatched === false) && result.success !== true));
  const unverified = result.inconclusive || result.verified === false || result.remoteStateVerified === false;
  const failed = !!(result.success === false || result.error || result.noProgress || result.ambiguous
    || result.outcomeUnknown || result.stale || unverified);
  const reason = result.cancelled ? 'cancelled'
    : failed || !ran ? result.reason || (unverified ? 'action_unverified' : failed ? 'action_failed' : 'interrupted') : '';
  return { ran, failed, reason };
}
const safeReasons = new Set(['interrupted', 'cancelled', 'action_failed', 'action_unverified', 'navigation_changed', 'submit_boundary', 'small_model_action_boundary']);

/** Fold only results: signed assistant/replay objects retain their exact identity. */
export function foldBrowserBatchMessages(messages, { repairPending = false } = {}) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const output = [];
  for (let start = 0; start < messages.length;) {
    const assistant = messages[start];
    if (assistant.role !== 'assistant' || !assistant.tool_calls?.some(call => call.function?.name === 'browser_batch')) {
      output.push(assistant); start++; continue;
    }
    let end = start + 1;
    while (end < messages.length && messages[end].role !== 'assistant') end++;
    const tail = messages.slice(start + 1, end);
    const ids = new Set(assistant.tool_calls.map(call => call.id));
    const replacements = new Map(), childIds = new Set();
    for (const parent of assistant.tool_calls) {
      if (parent.function?.name !== 'browser_batch' || typeof parent.id !== 'string' || !parent.id.trim()
          || parent.id.includes('::') || assistant.tool_calls.filter(call => call.id === parent.id).length !== 1) continue;
      // A parent rejection or already folded answer is authoritative. Native
      // sibling IDs may resemble generated IDs, but never belong to this batch.
      if (tail.some(message => message.role === 'tool' && message.tool_call_id === parent.id)) continue;
      const actions = argsFor(parent)?.actions;
      if (!Array.isArray(actions) || !actions.length) continue;
      const generatedIds = actions.map((_, i) => `${parent.id}::${i}`);
      const children = generatedIds.map(id => !ids.has(id)
        ? tail.find(message => message.role === 'tool' && message.tool_call_id === id) : undefined);
      if (!children.some(Boolean) && !repairPending) continue;
      for (const id of generatedIds) if (!ids.has(id)) childIds.add(id);
      const states = children.map(browserBatchResultStatus);
      const ran = states.filter(state => state.ran).length;
      const reason = states.find(state => state.reason)?.reason || '';
      const stopReason = safeReasons.has(reason) ? reason : reason ? 'interrupted' : '';
      const metadata = { actions: actions.map((action, index) => ({ name: BATCHABLE_ACTION_TOOLS.has(action?.name) || BATCH_TRAILING_OBSERVATION_TOOLS.has(action?.name) ? action.name : 'unknown', ran: states[index].ran })), stopReason };
      const content = `[browser_batch] ran ${ran} of ${actions.length} actions${stopReason ? `; stop: ${stopReason}` : ''}\n[browser_batch metadata] ${JSON.stringify(metadata)}\n`
        + metadata.actions.map((action, i) => `actions[${i}] ${action.name} → ${action.ran ? 'ran' : 'not run'}\n${children[i]?.content ?? 'not run (interrupted)'}`).join('\n');
      replacements.set(parent.id, { role: 'tool', tool_call_id: parent.id, content });
    }
    if (!replacements.size) { output.push(...messages.slice(start, end)); start = end; continue; }
    changed = true;
    const folded = [], inserted = new Set();
    for (const message of tail) {
      if (message.role === 'tool' && childIds.has(message.tool_call_id)) {
        const parentId = message.tool_call_id.slice(0, message.tool_call_id.lastIndexOf('::'));
        if (!inserted.has(parentId)) { folded.push(replacements.get(parentId)); inserted.add(parentId); }
      } else if (!(message.role === 'tool' && replacements.has(message.tool_call_id))) folded.push(message);
    }
    for (const [id, message] of replacements) if (!inserted.has(id)) folded.push(message);
    if (repairPending) {
      // A restart also discards queued native siblings from this same turn.
      for (const call of assistant.tool_calls) {
        if (!folded.some(message => message.role === 'tool' && message.tool_call_id === call.id)) folded.push({
          role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, skipped: true,
            noDispatch: true, dispatched: false, reason: 'interrupted', error: 'not run (interrupted)' }),
        });
      }
    }
    const answer = message => message.role === 'tool' && ids.has(message.tool_call_id);
    output.push(assistant, ...folded.filter(answer), ...folded.filter(message => !answer(message)));
    start = end;
  }
  return changed ? output : messages;
}

export function digestBrowserBatch(content) {
  // Only our fixed-position header is trusted; page bytes can imitate later lines.
  try {
    const line = String(content).split('\n', 3)[1];
    if (!line?.startsWith('[browser_batch metadata] ')) return 'browser_batch: result unavailable';
    const metadata = JSON.parse(line.slice('[browser_batch metadata] '.length));
    const actions = metadata.actions.slice(0, MAX_BATCH_ACTIONS.full).map(action =>
      `${BATCHABLE_ACTION_TOOLS.has(action.name) || BATCH_TRAILING_OBSERVATION_TOOLS.has(action.name) ? action.name : 'unknown'}: ${action.ran === true ? 'ran' : 'not run'}`);
    return `browser_batch: ${actions.join(', ')}${safeReasons.has(metadata.stopReason) ? `; stop: ${metadata.stopReason}` : ''}`;
  } catch { return 'browser_batch: result unavailable'; }
}
