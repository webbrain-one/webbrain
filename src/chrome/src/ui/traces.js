/**
 * Traces page — inspects IndexedDB runs recorded by the trace recorder.
 * Supports single-run timeline view and two-run side-by-side compare.
 */

import {
  listRuns, getRun, getRunEvents, getScreenshot,
  deleteRun, clearAllRuns,
} from '../trace/recorder.js';
import { t } from './i18n.js';

const listEl = document.getElementById('run-list');
const mainPane = document.getElementById('main-pane');
const emptyState = document.getElementById('empty-state');
const countPill = document.getElementById('count-pill');
const filterText = document.getElementById('filter-text');
const filterModel = document.getElementById('filter-model');
const imgModal = document.getElementById('img-modal');
const imgModalImg = document.getElementById('img-modal-img');
const initialRunId = new URLSearchParams(location.search).get('runId');

let allRuns = [];
let selectedRunId = null;
let compareMode = false;
let compareIds = []; // length 0..2
let timelineObjectUrls = new Set();
let traceRenderRequestId = 0;

// conversationId → [runs, oldest first]. Rebuilt from allRuns on every refresh.
let conversationMap = new Map();

function rebuildConversationMap() {
  conversationMap = new Map();
  for (const r of allRuns) {
    if (!r.conversationId) continue;
    const arr = conversationMap.get(r.conversationId) || [];
    arr.push(r);
    conversationMap.set(r.conversationId, arr);
  }
  for (const arr of conversationMap.values()) {
    arr.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  }
}

function siblingsOf(run) {
  if (!run || !run.conversationId) return [];
  return conversationMap.get(run.conversationId) || [];
}

/**
 * Render run cost in USD. Returns '' when the provider didn't report cost
 * (older runs from before recorder tracked it, providers that don't bill,
 * BYOK setups without cost data). Sub-cent values get an extra digit so a
 * $0.003 run isn't rendered as $0.00.
 */
function formatCost(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

// ----- List -----------------------------------------------------------------

async function refresh() {
  allRuns = await listRuns({ limit: 500 });
  rebuildConversationMap();
  countPill.textContent = t(allRuns.length === 1 ? 'tr.run' : 'tr.runs', { n: allRuns.length });
  // Populate model filter.
  const models = Array.from(new Set(allRuns.map(r => r.model).filter(Boolean))).sort();
  const prev = filterModel.value;
  filterModel.innerHTML = `<option value="">${escapeHtml(t('tr.filter.all_models'))}</option>` +
    models.map(m => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`).join('');
  filterModel.value = models.includes(prev) ? prev : '';
  renderList();
}

async function ensureRunLoaded(runId) {
  if (!runId || allRuns.some((run) => run.runId === runId)) return true;
  const run = await getRun(runId).catch(() => null);
  if (!run) return false;
  allRuns.push(run);
  allRuns.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  rebuildConversationMap();
  countPill.textContent = t(allRuns.length === 1 ? 'tr.run' : 'tr.runs', { n: allRuns.length });
  return true;
}

function renderList() {
  const needle = filterText.value.trim().toLowerCase();
  const modelFilter = filterModel.value;
  const filtered = allRuns.filter(r => {
    if (modelFilter && r.model !== modelFilter) return false;
    if (!needle) return true;
    return [r.userMessage, r.model, r.tabUrl, r.tabTitle, r.providerId]
      .some(v => (v || '').toLowerCase().includes(needle));
  });
  if (filtered.length === 0) {
    listEl.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px;">${escapeHtml(t('tr.no_match'))}</div>`;
    return;
  }
  listEl.innerHTML = filtered.map(r => {
    const status = r.status || 'done';
    const statusClass = safeClassToken(status, 'done');
    const started = new Date(r.startedAt).toLocaleString();
    const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—';
    const steps = r.stepCount || 0;
    const tokens = (r.totalInputTokens || 0) + (r.totalOutputTokens || 0);
    const costStr = formatCost(r.totalCost);
    const cls = [
      'run-item',
      selectedRunId === r.runId ? 'selected' : '',
      compareIds.includes(r.runId) ? 'compare' : '',
    ].filter(Boolean).join(' ');
    const title = r.userMessage || t('tr.no_task');
    const siblings = siblingsOf(r);
    const convChip = siblings.length > 1
      ? `<span class="conv-chip" title="${escapeAttr(t('tr.conversation.tooltip', { n: siblings.length, id: r.conversationId }))}">🧵 ${siblings.length}</span>`
      : '';
    // Highlight costly-but-empty runs (≥$0.50 spent with no final text) so
    // users can spot expensive failures at a glance.
    const isCostlyFailure = (r.totalCost || 0) >= 0.5 && (!r.finalContent || !r.finalContent.trim());
    const costClass = isCostlyFailure ? 'cost-warn' : '';
    return `
      <div class="${cls}" data-run-id="${escapeAttr(r.runId)}">
        <div class="run-title"><span class="status-dot ${statusClass}"></span>${escapeHtml(title.slice(0, 120))}${convChip}</div>
        <div class="run-meta">
          <span class="run-model">${escapeHtml(r.model || '?')}</span>
          <span>${escapeHtml(r.providerId || '')}</span>
          <span>${escapeHtml(t(steps === 1 ? 'tr.step' : 'tr.steps_plural', { n: steps }))}</span>
          <span>${dur}</span>
          ${tokens ? `<span>${escapeHtml(t('tr.tokens_short', { n: tokens.toLocaleString() }))}</span>` : ''}
          ${costStr ? `<span class="${costClass}" title="${escapeAttr(t('tr.cost.tooltip'))}">${escapeHtml(costStr)}</span>` : ''}
        </div>
        <div class="run-meta" style="margin-top:3px;"><span>${started}</span></div>
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('.run-item').forEach(el => {
    el.addEventListener('click', () => handleRunClick(el.dataset.runId));
  });
}

function handleRunClick(runId) {
  if (compareMode) {
    const idx = compareIds.indexOf(runId);
    if (idx >= 0) compareIds.splice(idx, 1);
    else compareIds.push(runId);
    if (compareIds.length > 2) compareIds.shift();
    renderList();
    if (compareIds.length === 2) renderCompare(compareIds[0], compareIds[1]);
    else {
      mainPane.classList.remove('compare-mode');
      replaceTimelineObjectUrls(new Set());
      mainPane.innerHTML = `<div id="empty-state"><div><p style="font-size:14px;">${escapeHtml(t('tr.compare_mode.title'))}</p><p style="color:var(--text3);">${escapeHtml(t('tr.compare_mode.picked', { n: compareIds.length }))}</p></div></div>`;
    }
  } else {
    selectedRunId = runId;
    renderList();
    renderRun(runId);
  }
}

// ----- Single run view ------------------------------------------------------

function isCurrentRunRender(requestId, runId) {
  return requestId === traceRenderRequestId && !compareMode && selectedRunId === runId;
}

function isCurrentCompareRender(requestId, aId, bId) {
  return requestId === traceRenderRequestId &&
    compareMode &&
    compareIds.length === 2 &&
    compareIds[0] === aId &&
    compareIds[1] === bId;
}

async function renderRun(runId) {
  const requestId = ++traceRenderRequestId;
  const run = await getRun(runId);
  if (!isCurrentRunRender(requestId, runId)) return;
  if (!run) {
    replaceTimelineObjectUrls(new Set());
    return;
  }
  const events = await getRunEvents(runId).catch(() => []);
  if (!isCurrentRunRender(requestId, runId)) return;
  const objectUrls = new Set();
  const html = await buildRunView(run, events, false, objectUrls);
  if (!isCurrentRunRender(requestId, runId)) {
    revokeObjectUrls(objectUrls);
    return;
  }
  mainPane.classList.remove('compare-mode');
  replaceTimelineObjectUrls(objectUrls);
  mainPane.innerHTML = html;
  wireTimelineImages(mainPane);
}

async function renderCompare(aId, bId) {
  const requestId = ++traceRenderRequestId;
  const [a, b, aEv, bEv] = await Promise.all([
    getRun(aId), getRun(bId),
    getRunEvents(aId).catch(() => []),
    getRunEvents(bId).catch(() => []),
  ]);
  if (!isCurrentCompareRender(requestId, aId, bId)) return;
  if (!a || !b) {
    replaceTimelineObjectUrls(new Set());
    return;
  }
  const objectUrls = new Set();
  const aHtml = await buildRunView(a, aEv, true, objectUrls);
  const bHtml = await buildRunView(b, bEv, true, objectUrls);
  if (!isCurrentCompareRender(requestId, aId, bId)) {
    revokeObjectUrls(objectUrls);
    return;
  }
  mainPane.classList.add('compare-mode');
  replaceTimelineObjectUrls(objectUrls);
  mainPane.innerHTML = `<div class="pane">${aHtml}</div><div class="pane">${bHtml}</div>`;
  wireTimelineImages(mainPane);
}

/**
 * Render a "Conversation" panel listing sibling runs (turns of the same
 * chat) so users can jump between them. Hidden in compare mode (panes are
 * already two-up) and when there's only one run in the conversation.
 */
function renderConversationPanel(run, compact) {
  if (compact) return '';
  const siblings = siblingsOf(run);
  if (siblings.length < 2) return '';
  const turnNumber = siblings.findIndex(r => r.runId === run.runId) + 1;
  const items = siblings.map((r, i) => {
    const isCurrent = r.runId === run.runId;
    const label = (r.userMessage || t('tr.no_task')).slice(0, 60);
    const cls = `conv-turn${isCurrent ? ' current' : ''}`;
    return `<button class="${cls}" data-jump-run-id="${escapeAttr(r.runId)}" title="${escapeAttr(r.userMessage || '')}">
      <span class="conv-turn-n">#${i + 1}</span>
      <span class="conv-turn-msg">${escapeHtml(label)}</span>
    </button>`;
  }).join('');
  return `
    <div class="conv-panel">
      <div class="conv-panel-label">${escapeHtml(t('tr.conversation.label'))} · ${escapeHtml(t('tr.conversation.turn_of', { n: turnNumber, total: siblings.length }))}</div>
      <div class="conv-turns">${items}</div>
    </div>
  `;
}

async function buildRunView(run, events, compact, objectUrls = new Set()) {
  const header = `
    <div class="run-header">
      <h2>${escapeHtml(run.model || t('tr.unknown_model'))}</h2>
      <span class="meta">${escapeHtml(run.providerId || '')} · ${new Date(run.startedAt).toLocaleString()}</span>
    </div>
    <div class="stats-row">
      <span class="stat">${escapeHtml(t('tr.status.label'))} <b>${escapeHtml(run.status || '')}</b></span>
      <span class="stat">${escapeHtml(t('tr.steps.label'))} <b>${run.stepCount || 0}</b></span>
      <span class="stat">${escapeHtml(t('tr.duration.label'))} <b>${run.durationMs ? (run.durationMs / 1000).toFixed(1) + 's' : '—'}</b></span>
      <span class="stat">${escapeHtml(t('tr.intokens.label'))} <b>${(run.totalInputTokens || 0).toLocaleString()}</b></span>
      <span class="stat">${escapeHtml(t('tr.outtokens.label'))} <b>${(run.totalOutputTokens || 0).toLocaleString()}</b></span>
      ${formatCost(run.totalCost) ? `<span class="stat">${escapeHtml(t('tr.cost.label'))} <b>${escapeHtml(formatCost(run.totalCost))}</b></span>` : ''}
    </div>
    ${renderConversationPanel(run, compact)}
    <div class="run-task">${escapeHtml(run.userMessage || '')}</div>
    ${run.finalContent ? `<div class="run-task" style="border-left-color:var(--success);"><b style="color:var(--success);">${escapeHtml(t('tr.final_label'))}</b> ${escapeHtml(run.finalContent)}</div>` : ''}
  `;
  // Build timeline — collect screenshot blobs for img src.
  const shotCache = new Map();
  for (const ev of events) {
    if (ev.kind === 'screenshot') {
      const shot = await getScreenshot(run.runId, ev.seq);
      if (shot) shotCache.set(ev.seq, shot);
    }
  }
  const items = events.map(ev => renderEvent(ev, shotCache, compact, objectUrls)).join('');
  return `${header}<div class="timeline">${items}</div>`;
}

function renderEvent(ev, shotCache, compact, objectUrls = new Set()) {
  const ts = new Date(ev.ts).toLocaleTimeString();
  const stepBadge = ev.data?.step != null ? `<span class="step">${escapeHtml(t('tr.event.step', { step: ev.data.step }))}</span>` : '';
  switch (ev.kind) {
    case 'llm_request': {
      return `
        <div class="event llm_request">
          <div class="event-head"><span class="kind">${escapeHtml(t('tr.event.llm_request'))}</span>${stepBadge}<span class="latency">${ts}</span></div>
          <span class="tool-args">${escapeHtml(t('tr.event.messages_tools', {
            m: ev.data?.messageCount || 0,
            t: ev.data?.toolsCount || 0,
            model: ev.data?.model || '',
          }))}</span>
        </div>`;
    }
    case 'llm_response': {
      const u = ev.data?.usage;
      const usage = u ? `<span class="latency">${(u.prompt_tokens || 0).toLocaleString()} in / ${(u.completion_tokens || 0).toLocaleString()} out</span>` : '';
      const lat = ev.data?.latencyMs != null ? `<span class="latency">${ev.data.latencyMs} ms</span>` : '';
      const content = ev.data?.content;
      const toolCalls = ev.data?.toolCalls || [];
      let body = '';
      if (content) {
        body += `<div class="content-text">${escapeHtml(content)}</div>`;
      }
      if (toolCalls.length > 0) {
        const tcList = toolCalls.map(tc => {
          let args = tc.args || '';
          try { args = JSON.stringify(JSON.parse(args), null, 2); } catch {}
          return `<details><summary><span class="tool-name">${escapeHtml(tc.name)}</span>()</summary><pre>${escapeHtml(args)}</pre></details>`;
        }).join('');
        body += `<div style="margin-top:6px;">${tcList}</div>`;
      }
      return `
        <div class="event llm_response">
          <div class="event-head"><span class="kind">${escapeHtml(t('tr.event.llm_response'))}</span>${stepBadge}${usage}${lat}<span class="latency">${ts}</span></div>
          ${body}
        </div>`;
    }
    case 'tool': {
      const name = ev.data?.name || '?';
      const lat = ev.data?.latencyMs != null ? `<span class="latency">${ev.data.latencyMs} ms</span>` : '';
      const args = ev.data?.args ? JSON.stringify(ev.data.args, null, 2) : '';
      let result = ev.data?.result;
      try { result = typeof result === 'string' ? result : JSON.stringify(result, null, 2); } catch { result = String(result); }
      if (typeof result === 'string' && result.length > 4000 && compact) result = result.slice(0, 4000) + '\n' + t('tr.event.description_truncated');
      const ok = ev.data?.result && !ev.data.result.error && ev.data.result.success !== false;
      return `
        <div class="event tool">
          <div class="event-head">
            <span class="kind">${ok ? '✓' : '✗'} <span class="tool-name">${escapeHtml(name)}</span></span>
            ${lat}<span class="latency">${ts}</span>
          </div>
          ${args ? `<details><summary>${escapeHtml(t('tr.event.args'))}</summary><pre>${escapeHtml(args)}</pre></details>` : ''}
          <details ${ok ? '' : 'open'}><summary>${escapeHtml(t('tr.event.result'))}</summary><pre>${escapeHtml(result || '')}</pre></details>
        </div>`;
    }
    case 'screenshot': {
      const shot = shotCache.get(ev.seq);
      let src = '';
      if (shot?.blob) src = createTrackedObjectUrl(shot.blob, objectUrls);
      else if (shot?.dataUrl) src = shot.dataUrl;
      const caption = ev.data?.caption || t('tr.event.screenshot_caption');
      return `
        <div class="event screenshot">
          <div class="event-head"><span class="kind">📷 ${escapeHtml(caption)}</span>${stepBadge}<span class="latency">${ts}</span></div>
          ${src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(caption)}" loading="lazy">` : `<span class="latency">${escapeHtml(t('tr.event.screenshot_missing'))}</span>`}
        </div>`;
    }
    case 'error': {
      return `
        <div class="event error">
          <div class="event-head"><span class="kind">${escapeHtml(t('tr.event.error_kind'))}</span>${stepBadge}<span class="latency">${ts}</span></div>
          <div class="content-text">${escapeHtml(ev.data?.phase || '')}: ${escapeHtml(ev.data?.message || '')}</div>
        </div>`;
    }
    case 'vision_sub_call': {
      const lat = ev.data?.latencyMs != null ? `<span class="latency">${ev.data.latencyMs} ms</span>` : '';
      const model = ev.data?.model ? `<span class="latency">${escapeHtml(ev.data.model)}</span>` : '';
      const ctx = ev.data?.context ? `<span class="tool-args">${escapeHtml(ev.data.context)}</span>` : '';
      const body = ev.data?.error
        ? `<div class="content-text" style="color:#f88;">${escapeHtml(t('tr.event.vision_failed', { error: ev.data.error }))}</div>`
        : (ev.data?.description
            ? `<details open><summary>${escapeHtml(t('tr.event.description'))}</summary><pre>${escapeHtml(ev.data.description)}</pre></details>`
            : '');
      return `
        <div class="event vision_sub_call">
          <div class="event-head"><span class="kind">${escapeHtml(t('tr.event.vision_sub_call'))}</span>${ctx}${model}${lat}<span class="latency">${ts}</span></div>
          ${body}
        </div>`;
    }
    case 'note':
    default: {
      return `
        <div class="event note">
          <div class="event-head"><span class="kind">${escapeHtml(ev.kind)}</span>${stepBadge}<span class="latency">${ts}</span></div>
          <pre>${escapeHtml(JSON.stringify(ev.data, null, 2))}</pre>
        </div>`;
    }
  }
}

function createTrackedObjectUrl(blob, objectUrls) {
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  return url;
}

function revokeObjectUrls(urls) {
  for (const url of urls) URL.revokeObjectURL(url);
}

function replaceTimelineObjectUrls(nextUrls) {
  const oldUrls = timelineObjectUrls;
  if (oldUrls.size > 0) {
    const modalSrc = imgModalImg?.src || '';
    const modalUsesOldUrl = oldUrls.has(modalSrc);
    revokeObjectUrls(oldUrls);
    if (modalUsesOldUrl) {
      imgModal.classList.remove('show');
      imgModalImg.removeAttribute('src');
    }
  }
  timelineObjectUrls = nextUrls;
}

function wireTimelineImages(root) {
  root.querySelectorAll('.event.screenshot img').forEach(img => {
    img.addEventListener('click', () => {
      imgModalImg.src = img.src;
      imgModal.classList.add('show');
    });
  });
  // Conversation panel: jumping between sibling runs.
  root.querySelectorAll('button[data-jump-run-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.jumpRunId;
      if (!id || id === selectedRunId) return;
      selectedRunId = id;
      renderList();
      renderRun(id);
    });
  });
}

imgModal.addEventListener('click', () => imgModal.classList.remove('show'));

// ----- Toolbar handlers ------------------------------------------------------

document.getElementById('btn-refresh').addEventListener('click', async () => {
  await refresh();
  // Manual refresh might surface a newly-started run; kick polling back on
  // if so. Idempotent — does nothing if a timer is already pending.
  if (hasRunningJob()) scheduleAutoRefresh();
});

document.getElementById('btn-compare').addEventListener('click', () => {
  compareMode = !compareMode;
  const btn = document.getElementById('btn-compare');
  if (compareMode) {
    btn.classList.add('primary');
    btn.textContent = t('tr.btn.compare.picking');
    compareIds = [];
    selectedRunId = null;
    mainPane.classList.remove('compare-mode');
    replaceTimelineObjectUrls(new Set());
    mainPane.innerHTML = `<div id="empty-state"><div><p style="font-size:14px;">${escapeHtml(t('tr.compare_mode.title'))}</p><p style="color:var(--text3);">${escapeHtml(t('tr.compare_mode.hint'))}</p></div></div>`;
  } else {
    btn.classList.remove('primary');
    btn.textContent = t('tr.btn.compare');
    compareIds = [];
    mainPane.classList.remove('compare-mode');
    replaceTimelineObjectUrls(new Set());
    mainPane.innerHTML = `<div id="empty-state"><div><p style="font-size:14px;">${escapeHtml(t('tr.empty.title'))}</p></div></div>`;
  }
  renderList();
});

document.getElementById('btn-export').addEventListener('click', async () => {
  if (!selectedRunId) return alert(t('tr.select_first'));
  const runId = selectedRunId;
  const run = await getRun(runId);
  if (!run) return alert(t('tr.select_first'));
  const events = await getRunEvents(runId).catch(() => []);
  // Resolve screenshot blobs to base64 for portability.
  for (const ev of events) {
    if (ev.kind === 'screenshot') {
      const shot = await getScreenshot(runId, ev.seq);
      if (shot?.blob) {
        ev.data = ev.data || {};
        ev.data.screenshot_base64 = await blobToBase64(shot.blob);
      } else if (shot?.dataUrl) {
        ev.data.screenshot_dataUrl = shot.dataUrl;
      }
    }
  }
  const payload = {
    run,
    events,
    exportedAt: Date.now(),
    exportedByWebBrainVersion: chrome.runtime.getManifest().version || '',
    schema: 'webbrain-trace/1',
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `webbrain-trace-${run.model || 'unknown'}-${run.runId}.json`;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 7000);
  }
});

document.getElementById('btn-delete').addEventListener('click', async () => {
  if (!selectedRunId) return alert(t('tr.select_first'));
  const runId = selectedRunId;
  if (!confirm(t('tr.confirm_delete'))) return;
  await deleteRun(runId);
  if (selectedRunId === runId) {
    selectedRunId = null;
    replaceTimelineObjectUrls(new Set());
    mainPane.innerHTML = `<div id="empty-state"><div><p>${escapeHtml(t('tr.deleted'))}</p></div></div>`;
  }
  await refresh();
});

document.getElementById('btn-clear-all').addEventListener('click', async () => {
  if (!confirm(t('tr.confirm_delete_all'))) return;
  await clearAllRuns();
  selectedRunId = null;
  compareIds = [];
  replaceTimelineObjectUrls(new Set());
  mainPane.innerHTML = `<div id="empty-state"><div><p>${escapeHtml(t('tr.all_deleted'))}</p></div></div>`;
  refresh();
});

// Re-render on locale change so already-rendered content updates in place.
document.addEventListener('wb-locale-changed', async () => {
  await refresh();
  const compareBtn = document.getElementById('btn-compare');
  compareBtn.textContent = compareMode ? t('tr.btn.compare.picking') : t('tr.btn.compare');
  if (compareMode) {
    if (compareIds.length === 2) {
      renderCompare(compareIds[0], compareIds[1]);
    } else {
      mainPane.classList.remove('compare-mode');
      replaceTimelineObjectUrls(new Set());
      const textKey = compareIds.length === 0 ? 'tr.compare_mode.hint' : 'tr.compare_mode.picked';
      const textParams = compareIds.length === 0 ? undefined : { n: compareIds.length };
      mainPane.innerHTML = `<div id="empty-state"><div><p style="font-size:14px;">${escapeHtml(t('tr.compare_mode.title'))}</p><p style="color:var(--text3);">${escapeHtml(t(textKey, textParams))}</p></div></div>`;
    }
  } else if (selectedRunId) {
    renderRun(selectedRunId);
  } else {
    replaceTimelineObjectUrls(new Set());
    mainPane.innerHTML = `<div id="empty-state"><div><p style="font-size:14px;">${escapeHtml(t('tr.empty.title'))}</p></div></div>`;
  }
});

filterText.addEventListener('input', renderList);
filterModel.addEventListener('change', renderList);

// ----- Utils -----------------------------------------------------------------

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeClassToken(value, fallback = 'unknown') {
  const token = String(value == null ? '' : value).trim();
  return /^[A-Za-z0-9_-]+$/.test(token) ? token : fallback;
}
function blobToBase64(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

// Auto-refresh while visible AND while at least one run is still running —
// so a live job shows new steps but a finished page doesn't keep re-rendering
// under the user's cursor while they're trying to examine a single run.
// Self-rescheduling setTimeout (not setInterval) so the gating check can
// short-circuit the next tick.
const AUTO_REFRESH_MS = 30000;
let _autoTimer = null;
function hasRunningJob() {
  return allRuns.some((r) => r.status === 'running');
}
async function autoRefreshTick() {
  _autoTimer = null;
  if (document.hidden) return;
  await refresh();
  if (selectedRunId && !compareMode) renderRun(selectedRunId);
  if (hasRunningJob()) scheduleAutoRefresh();
}
function scheduleAutoRefresh() {
  if (_autoTimer || document.hidden) return;
  _autoTimer = setTimeout(autoRefreshTick, AUTO_REFRESH_MS);
}
function stopAutoRefresh() {
  if (_autoTimer) { clearTimeout(_autoTimer); _autoTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAutoRefresh();
  else if (hasRunningJob()) scheduleAutoRefresh();
});

// Initial load: always do one refresh so the list populates, then only keep
// polling if the freshly-loaded data shows a live run.
(async () => {
  await refresh();
  if (initialRunId && await ensureRunLoaded(initialRunId)) {
    selectedRunId = initialRunId;
    renderList();
    await renderRun(initialRunId);
  }
  if (hasRunningJob()) scheduleAutoRefresh();
})();
