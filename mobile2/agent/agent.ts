/**
 * Minimal agent loop — the smallest possible thing that ports the spirit of
 * src/chrome/src/agent/agent.js to mobile.
 *
 * Out of scope for v0 (intentionally — port these as needs arise):
 *   - streaming responses (text_delta updates in chat)
 *   - vision / auto-screenshot
 *   - loop detection (general / coordinate-bucket / navigation)
 *   - context auto-trim & emergency trim
 *   - blockedDone probe
 *   - duplicate-submit guard
 *   - trace recorder
 *
 * What this DOES do:
 *   1. Take a user message + current page meta (url/title).
 *   2. Build messages = [system, ...history, user].
 *   3. Loop up to MAX_STEPS:
 *        a. provider.chat(messages, {tools})
 *        b. If tool_calls: execute each, append assistant + tool messages, continue.
 *        c. If done() was called: emit summary, stop.
 *        d. If text only: emit text, stop.
 *   4. Stream UI updates via onUpdate — the chat tab shows tool labels in
 *      real time so the user has feedback while the agent works.
 */
import { dispatchTool, AGENT_TOOLS, type ToolDispatchDeps } from './tools';
import type { ChatMessage, OpenAIProvider } from './openai';

const MAX_STEPS = 30;

const SYSTEM_PROMPT = `You are WebBrain, an AI agent that controls a mobile WebView browser.

You have these tools:
  - get_accessibility_tree({filter?, maxDepth?, maxChars?, ref_id?}) — read the current page as a flat indented text tree. PREFERRED first action.
  - click_ax({ref_id}) — click an element by ref_id from get_accessibility_tree.
  - type_ax({ref_id, text, clear?}) — type into a focusable input. After click_ax on a text field, your NEXT call must be type_ax on the same ref_id.
  - navigate({url}) — load a URL. Use this if the page isn't already where the task needs to start.
  - done({summary}) — call ONLY when the task is fully complete. Provide a short summary.

Operating rules:
  - Always start by calling get_accessibility_tree({filter: "visible"}) to see the current page.
  - ref_ids look like "ref_42" — use them VERBATIM from the tree output.
  - If a ref_id is missing or stale, re-read the tree.
  - Don't guess URLs or invent ref_ids.
  - Be decisive. After each action, re-read the tree to verify state, then take the next step.
  - Prefer 5–10 tool calls per task. If you're past 15 calls without progress, summarize what you tried and call done.`;

export type AgentEvent =
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string }
  | { type: 'text'; content: string }
  | { type: 'done'; summary: string }
  | { type: 'error'; message: string };

export type AgentInput = {
  provider: OpenAIProvider;
  history: ChatMessage[];
  userText: string;
  pageMeta: { url: string; title: string } | null;
  deps: ToolDispatchDeps;
  onEvent: (e: AgentEvent) => void;
};

/** Truncate a value for log preview to keep onEvent payloads small. */
function preview(v: unknown, max = 200): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

export async function runAgent({
  provider,
  history,
  userText,
  pageMeta,
  deps,
  onEvent,
}: AgentInput): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
  ];

  // Enrich the user message with current page context (the Chrome agent
  // does this in _enrichFirstUserMessage). Lets the model skip a wasted
  // navigate call when the user's task starts on the page already shown.
  const ctx = pageMeta ? `\n\n[Current page: ${pageMeta.url}${pageMeta.title ? ` — "${pageMeta.title}"` : ''}]` : '';
  messages.push({ role: 'user', content: userText + ctx });

  for (let step = 0; step < MAX_STEPS; step++) {
    let result;
    try {
      result = await provider.chat(messages, { tools: AGENT_TOOLS });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      onEvent({ type: 'error', message: msg });
      messages.push({ role: 'assistant', content: `[error] ${msg}` });
      return messages;
    }

    // Append the assistant turn (with any tool_calls) so the next iteration
    // can attach matching tool replies.
    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls || undefined,
    });

    if (!result.toolCalls || result.toolCalls.length === 0) {
      // Plain text response — final answer.
      const text = (result.content || '').trim();
      if (text) onEvent({ type: 'text', content: text });
      return messages;
    }

    // Execute each tool call and append a `tool` message per call.
    for (const tc of result.toolCalls) {
      let args: Record<string, unknown>;
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }

      onEvent({ type: 'tool_call', name: tc.function.name, args });

      const r = await dispatchTool(tc.function.name, args, deps);

      if (r.kind === 'done') {
        onEvent({ type: 'done', summary: r.summary });
        // Still record the tool reply so the conversation is coherent if
        // the user follows up.
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify({ success: true, summary: r.summary }),
        });
        return messages;
      }

      const replyValue = r.kind === 'value' ? r.value : { success: false, error: r.error };
      onEvent({
        type: 'tool_result',
        name: tc.function.name,
        ok: r.kind === 'value',
        preview: preview(replyValue),
      });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function.name,
        content: JSON.stringify(replyValue),
      });
    }
  }

  onEvent({
    type: 'error',
    message: `Stopped: hit step cap (${MAX_STEPS}) without calling done().`,
  });
  return messages;
}
