/**
 * Pure trace → Markdown serializer for /export --traces.
 *
 * Consumes the trace store's per-run event log (trace/recorder.js) — an
 * append-only, compaction-immune record whose tool results are the RAW structured
 * values (pre-truncated by the recorder, never `_wrapUntrusted`-wrapped). That is
 * the right source for a tool chain; `this.conversations` is not (it is compacted,
 * enriched, and wrapped — see the closed PR #348 review).
 *
 * This renders the TOOL CHAIN: user/assistant/planner prose, tool calls (name,
 * args, result), and errors — in order. Screenshot / note / vision_sub_call events
 * are recorded but deliberately not rendered; the file says so in its footer, so it
 * never claims to be a complete record. The complete record is the Traces-page JSON.
 *
 * Pure and browser-neutral → unit-tested in test/run.js without a DOM or IndexedDB.
 *
 * @param {Array<{run: object, events: Array}>} runsWithEvents  chronological runs,
 *   each with its ordered event list.
 */

const ARGS_LIMIT = 300;
const RESULT_LIMIT = 600;
const FOOTER = '_Screenshots, notes and vision sub-calls are recorded but not rendered here — see the Traces page for the complete record._';

function oneLine(t) { return String(t ?? '').replace(/\s+/g, ' ').trim(); }
function humanSize(n) { return n >= 1024 ? `${(n / 1024).toFixed(1)}kb` : `${n}b`; }

function truncate(text, limit) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}… +${humanSize(s.length - limit)} truncated`;
}

// Wrap text in a fenced code block that survives content which is ITSELF fenced.
// Planner responses usually arrive already wrapped in ```json … ```; naively
// re-fencing them produces ```\n```json\n…, which no Markdown renderer parses.
// So: unwrap a single enclosing fence (keeping its language hint), then choose a
// fence longer than any backtick run left inside, per CommonMark, so nothing can
// close the block early.
function fencedBlock(content) {
  let body = String(content ?? '').trim();
  let info = '';
  const wrapped = body.match(/^```([^\n]*)\n([\s\S]*?)\n```$/);
  if (wrapped) { info = wrapped[1].trim(); body = wrapped[2].trim(); }
  const longestRun = (body.match(/`+/g) || []).reduce((n, s) => Math.max(n, s.length), 0);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${info}\n${body}\n${fence}`;
}

// IndexedDB can retain values that JSON.stringify rejects (circular / bigint /
// sparse). Never throw mid-export — fall back to a readable marker.
function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '(unserializable)';
    }
  }
}

function stringifyArgs(args) {
  if (args == null) return '';
  const s = typeof args === 'string' ? args : safeJsonStringify(args);
  return truncate(oneLine(s), ARGS_LIMIT);
}

// A trace tool result is a RAW value: a structured object ({success,error,...}),
// a string, or the recorder's large-result marker { _truncated, length, head }.
function renderResult(result) {
  if (result == null) return { text: '(missing tool result)', failed: true };
  if (typeof result === 'object' && result._truncated) {
    return {
      text: `${truncate(oneLine(String(result.head ?? '')), RESULT_LIMIT)}  [recorder-truncated, ${humanSize(result.length || 0)} total]`,
      failed: false,
    };
  }
  const failed = typeof result === 'object' ? (result.success === false || !!result.error) : false;
  const s = typeof result === 'string' ? result : safeJsonStringify(result);
  return { text: truncate(oneLine(s), RESULT_LIMIT), failed };
}

function exportedRunStatus(run, events = []) {
  const status = oneLine(run?.status || '');
  const sawLoopError = events.some(ev => ev?.kind === 'error' && ev?.data?.phase === 'loop');
  if (status === 'done' && sawLoopError) {
    return 'loop_stopped';
  }
  return status;
}

export function tracesToMarkdown(runsWithEvents, {
  title = 'WebBrain Conversation — tool chain',
  notes = [],
  exportedByWebBrainVersion = '',
} = {}) {
  const runs = Array.isArray(runsWithEvents) ? runsWithEvents : [];
  let md = `# ${title}\n\n`;
  const exportVersion = oneLine(exportedByWebBrainVersion);
  if (exportVersion) md += `_Exported with WebBrain v${exportVersion}_\n\n`;
  let turnCount = 0;
  let toolCount = 0;

  for (const entry of runs) {
    if (!entry || !entry.run) continue;
    turnCount += 1;
    const run = entry.run;
    const user = oneLine(run.userMessage || '');
    const recordedVersion = oneLine(run.webbrainVersion || '');
    const events = Array.isArray(entry.events) ? [...entry.events].sort((a, b) => (a?.seq || 0) - (b?.seq || 0)) : [];
    const meta = [
      recordedVersion ? `recorded with WebBrain v${recordedVersion}` : 'recorded WebBrain version unavailable',
      run.model,
      exportedRunStatus(run, events),
    ].filter(Boolean).join(' · ');
    md += `## Turn ${turnCount}${user ? ` — ${user}` : ''}\n`;
    if (meta) md += `_${meta}_\n`;
    md += '\n';

    let lastAssistantContent = '';
    for (const ev of events) {
      const d = (ev && ev.data) || {};
      if (ev.kind === 'llm_response') {
        const content = String(d.content || '').trim();
        if (!content) continue;
        // Plan-before-Act runs record the planner call with phase:'planner'; keep
        // it (derails often start in the plan) but label it and preserve its shape.
        if (d.phase === 'planner') {
          md += `**Planner:**\n${fencedBlock(content)}\n`;
        } else {
          md += `**WebBrain:** ${oneLine(content)}\n`;
          lastAssistantContent = content;
        }
      } else if (ev.kind === 'tool') {
        toolCount += 1;
        const { text, failed } = renderResult(d.result);
        md += `- 🔧 \`${d.name || 'tool'}\`(${stringifyArgs(d.args)}) → ${failed ? '✗ ' : ''}${text}\n`;
      } else if (ev.kind === 'error') {
        md += `- ⚠️ error${d.phase ? ` (${d.phase})` : ''}: ${oneLine(d.message || '')}\n`;
      }
      // screenshot / note / vision_sub_call intentionally omitted — see FOOTER.
    }
    const finalContent = String(run.finalContent || '').trim();
    if (finalContent && oneLine(finalContent) !== oneLine(lastAssistantContent)) {
      md += `**Final:** ${oneLine(finalContent)}\n`;
    }
    md += '\n';
  }

  for (const note of Array.isArray(notes) ? notes : []) {
    const line = oneLine(note);
    if (line) md += `_Note: ${line}_\n`;
  }
  md += `${FOOTER}\n`;
  return { markdown: md, turnCount, toolCount };
}
