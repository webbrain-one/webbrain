/**
 * Pre-execution planner for Act mode — proposes a structured plan before the
 * agent tool loop runs. Issue #165.
 */

export const PLANNER_SYSTEM_PROMPT = `You are the planning subsystem for WebBrain, a browser automation agent. Given the user's task and current page context, output ONLY a single JSON object (no markdown fences, no commentary outside the JSON).

Schema:
{
  "summary": "one-line description of what will be done",
  "steps": [
    { "id": "1", "action": "what to do in this step", "tools": ["tool_names"] }
  ],
  "memory": {
    "use_scratchpad": boolean,
    "scratchpad_notes": ["facts to pin that survive context compaction"],
    "use_progress_ledger": boolean,
    "progress_action": "canonical action or null — e.g. follow, collect_email, process_item"
  },
  "scheduling": null | {
    "tool": "schedule_task" | "schedule_resume",
    "hint": "why scheduling applies"
  },
  "risks": ["user-visible risks or confirmations needed"],
  "mode": "act"
}

Rules:
- List 2–8 concrete steps. Name real tools from this catalog when relevant:
  read: get_accessibility_tree, read_page, screenshot, extract_data, fetch_url, research_url
  interact: click_ax, type_ax, set_field, press_keys, scroll, navigate, new_tab
  wait: wait_for_element, wait_for_stable
  memory: scratchpad_write, progress_update, progress_read
  schedule: schedule_task (future/recurring work the user explicitly asked for), schedule_resume (pause CURRENT run blocked on external event)
  finish: done
- scheduling.tool = schedule_task when the user wants reminders, monitors, or recurring checks later.
- scheduling.tool = schedule_resume only when the CURRENT task must pause until an external event (deploy finishes, email arrives) — not for generic waits (use wait_for_stable).
- memory.use_progress_ledger = true for repeated per-item tasks (follow users, collect emails, process each search result). One ledger row per item.
- memory.use_scratchpad = true for download IDs, file paths, multi-step plans, and facts that must survive compaction.
- Do not invent URLs or credentials. If the task is unclear, still output a best-effort plan and note ambiguity in risks.
- mode is always "act" for this planner.`;

function sanitizeText(value, max = 500) {
  if (value == null) return '';
  return String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ').trim().slice(0, max);
}

export function userMessageToText(message) {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message.map((block) => {
      if (typeof block === 'string') return block;
      if (block?.type === 'text' && block.text) return block.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  try { return JSON.stringify(message).slice(0, 4000); } catch { return ''; }
}

export function buildPlannerMessages(enrichedUserMessage, pageUrl, pageTitle) {
  const userText = userMessageToText(enrichedUserMessage);
  return [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Page URL: ${sanitizeText(pageUrl, 300) || 'unknown'}\nPage title: ${sanitizeText(pageTitle, 200)}\n\nUser task:\n${userText}`,
    },
  ];
}

export function parsePlanFromContent(content) {
  const raw = String(content || '').trim();
  if (!raw) return null;

  const tryParse = (text) => {
    try {
      const obj = JSON.parse(text);
      return normalizePlan(obj);
    } catch {
      return null;
    }
  };

  let plan = tryParse(raw);
  if (plan) return plan;

  const fence = raw.match(/```(?:json)?\s*([\{][\s\S]*?)\s*```/i);
  if (fence) {
    plan = tryParse(fence[1]);
    if (plan) return plan;
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    plan = tryParse(raw.slice(start, end + 1));
    if (plan) return plan;
  }

  return null;
}

export function normalizePlan(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const summary = sanitizeText(obj.summary, 400);
  if (!summary) return null;

  const steps = Array.isArray(obj.steps)
    ? obj.steps.slice(0, 12).map((step, i) => ({
      id: sanitizeText(step?.id || String(i + 1), 20) || String(i + 1),
      action: sanitizeText(step?.action, 300),
      tools: Array.isArray(step?.tools)
        ? step.tools.map((t) => sanitizeText(t, 40)).filter(Boolean).slice(0, 8)
        : [],
    })).filter((s) => s.action)
    : [];

  const memory = obj.memory && typeof obj.memory === 'object' ? obj.memory : {};
  const scheduling = obj.scheduling && typeof obj.scheduling === 'object' ? obj.scheduling : null;
  const tool = scheduling ? sanitizeText(scheduling.tool, 40) : '';
  const normalizedScheduling = tool === 'schedule_task' || tool === 'schedule_resume'
    ? { tool, hint: sanitizeText(scheduling.hint, 300) }
    : null;

  return {
    summary,
    steps,
    memory: {
      use_scratchpad: !!memory.use_scratchpad,
      scratchpad_notes: Array.isArray(memory.scratchpad_notes)
        ? memory.scratchpad_notes.map((n) => sanitizeText(n, 200)).filter(Boolean).slice(0, 8)
        : [],
      use_progress_ledger: !!memory.use_progress_ledger,
      progress_action: sanitizeText(memory.progress_action, 40) || null,
    },
    scheduling: normalizedScheduling,
    risks: Array.isArray(obj.risks)
      ? obj.risks.map((r) => sanitizeText(r, 200)).filter(Boolean).slice(0, 6)
      : [],
    mode: 'act',
  };
}

export function formatPlanMarkdown(plan) {
  if (!plan) return '';
  const lines = [`**${plan.summary}**`, ''];

  if (plan.steps?.length) {
    lines.push('### Steps');
    for (const step of plan.steps) {
      const tools = step.tools?.length ? ` (${step.tools.join(', ')})` : '';
      lines.push(`${step.id}. ${step.action}${tools}`);
    }
    lines.push('');
  }

  const mem = plan.memory || {};
  lines.push('### Memory strategy');
  if (mem.use_scratchpad) {
    lines.push('- Scratchpad: yes');
    for (const note of mem.scratchpad_notes || []) lines.push(`  - ${note}`);
  } else {
    lines.push('- Scratchpad: no');
  }
  if (mem.use_progress_ledger) {
    lines.push(`- Progress ledger: yes (${mem.progress_action || 'process_item'})`);
  } else {
    lines.push('- Progress ledger: no');
  }
  lines.push('');

  if (plan.scheduling) {
    lines.push('### Scheduling');
    lines.push(`- ${plan.scheduling.tool}: ${plan.scheduling.hint || 'see plan'}`);
    lines.push('');
  }

  if (plan.risks?.length) {
    lines.push('### Risks / notes');
    for (const risk of plan.risks) lines.push(`- ${risk}`);
  }

  return lines.join('\n').trim();
}

export function formatPlanScratchpad(plan, editedText) {
  if (editedText && String(editedText).trim()) {
    return `[Approved plan]\n${String(editedText).trim().slice(0, 7500)}`;
  }
  const md = formatPlanMarkdown(plan);
  return `[Approved plan — pinned by planner]\n${md}`.slice(0, 8000);
}
