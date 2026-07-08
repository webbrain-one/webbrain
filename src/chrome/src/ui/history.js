import {
  listChatHistoryRecords,
  getChatHistoryRecord,
  deleteChatHistoryRecord,
  clearChatHistoryRecords,
} from './chat-history-store.js';
import { listRuns } from '../trace/recorder.js';
import { t } from './i18n.js';

const listEl = document.getElementById('history-list');
const mainPane = document.getElementById('main-pane');
const countPill = document.getElementById('count-pill');
const filterText = document.getElementById('filter-text');
const btnRefresh = document.getElementById('btn-refresh');
const btnExport = document.getElementById('btn-export');
const btnDelete = document.getElementById('btn-delete');
const btnClearAll = document.getElementById('btn-clear-all');
const initialUrlFilter = new URLSearchParams(location.search).get('url') || '';

if (initialUrlFilter) {
  filterText.value = initialUrlFilter;
}

let allRecords = [];
let allRuns = [];
let selectedRecordId = null;
let historyRecordRenderRequestId = 0;

function traceRunsForRecord(record) {
  if (!record?.conversationId) return [];
  return allRuns
    .filter((run) => run.conversationId === record.conversationId)
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

function refreshButtons() {
  const hasSelection = !!selectedRecordId;
  btnExport.disabled = !hasSelection;
  btnDelete.disabled = !hasSelection;
}

async function refresh() {
  const [records, runs] = await Promise.all([
    listChatHistoryRecords({ limit: 1000 }),
    listRuns({ limit: 1000 }).catch(() => []),
  ]);
  allRecords = records;
  allRuns = runs;
  countPill.textContent = t(records.length === 1 ? 'hist.record' : 'hist.records', { n: records.length });
  const selectedRecordStillExists = selectedRecordId && allRecords.some((record) => record.id === selectedRecordId);
  if (selectedRecordId && !selectedRecordStillExists) {
    selectedRecordId = null;
    renderEmpty();
  }
  renderList();
  refreshButtons();
  if (selectedRecordStillExists) await renderRecord(selectedRecordId);
}

function renderList() {
  const needle = filterText.value.trim().toLowerCase();
  const filtered = allRecords.filter((record) => {
    if (!needle) return true;
    return [
      record.title,
      record.url,
      record.tabTitle,
      record.providerId,
      record.providerLabel,
      record.mode,
      record.firstUserMessage,
      record.lastAssistantMessage,
    ].some((value) => String(value || '').toLowerCase().includes(needle));
  });

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty-inline">${escapeHtml(t('hist.no_match'))}</div>`;
    return;
  }

  listEl.innerHTML = filtered.map((record) => {
    const traces = traceRunsForRecord(record);
    const selected = record.id === selectedRecordId ? ' selected' : '';
    const updated = formatDate(record.updatedAt);
    const urlLabel = hostLabel(record.url);
    return `
      <div class="history-item${selected}" data-record-id="${escapeAttr(record.id)}">
        <div class="history-title">${escapeHtml(record.title || t('hist.untitled'))}</div>
        <div class="history-meta">
          <span>${escapeHtml(updated)}</span>
          ${record.mode ? `<span>${escapeHtml(record.mode)}</span>` : ''}
          ${urlLabel ? `<span>${escapeHtml(urlLabel)}</span>` : ''}
          ${traces.length ? `<span class="trace-chip">${escapeHtml(t(traces.length === 1 ? 'hist.trace' : 'hist.traces', { n: traces.length }))}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.history-item').forEach((item) => {
    item.addEventListener('click', () => {
      renderRecord(item.dataset.recordId);
    });
  });
}

function renderEmpty() {
  mainPane.innerHTML = `
    <div id="empty-state">
      <div>
        <p style="font-size:14px;margin-bottom:10px;">${escapeHtml(t('hist.empty.title'))}</p>
        <p style="color:var(--text3);">${escapeHtml(t('hist.empty.hint'))}</p>
      </div>
    </div>
  `;
}

async function renderRecord(recordId) {
  const requestId = ++historyRecordRenderRequestId;
  selectedRecordId = recordId;
  renderList();
  refreshButtons();

  const record = await getChatHistoryRecord(recordId);
  if (requestId !== historyRecordRenderRequestId || selectedRecordId !== recordId) return;
  if (!record) {
    selectedRecordId = null;
    renderEmpty();
    await refresh();
    return;
  }

  selectedRecordId = record.id;
  const traces = traceRunsForRecord(record);
  renderList();
  refreshButtons();

  const providerText = [record.providerLabel, record.providerId && record.providerId !== record.providerLabel ? record.providerId : '']
    .filter(Boolean)
    .join(' / ');
  const urlBlock = record.url
    ? `<a class="record-url" href="${escapeAttr(record.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(record.url)}</a>`
    : '';
  const traceBlock = renderTraceBlock(traces);
  const messages = Array.isArray(record.messages) ? record.messages : [];

  mainPane.innerHTML = `
    <div class="record-header">
      <h2>${escapeHtml(record.title || t('hist.untitled'))}</h2>
      <div class="record-meta">
        <span>${escapeHtml(t('hist.meta.created', { date: formatDate(record.createdAt) }))}</span>
        <span>${escapeHtml(t('hist.meta.updated', { date: formatDate(record.updatedAt) }))}</span>
        ${record.mode ? `<span>${escapeHtml(t('hist.meta.mode', { mode: record.mode }))}</span>` : ''}
        ${providerText ? `<span>${escapeHtml(providerText)}</span>` : ''}
        <span>${escapeHtml(t('hist.meta.messages', { n: record.messageCount || messages.length }))}</span>
      </div>
      ${urlBlock}
    </div>
    ${traceBlock}
    <div class="messages">
      ${messages.map(renderMessage).join('')}
    </div>
  `;
}

function renderTraceBlock(traces) {
  if (!traces.length) {
    return `
      <div class="trace-panel">
        <div class="trace-panel-title">${escapeHtml(t('hist.traces.title'))}</div>
        <div class="empty-inline" style="padding:4px 0;text-align:left;">${escapeHtml(t('hist.traces.none'))}</div>
      </div>
    `;
  }
  const links = traces.map((run, index) => {
    const href = `traces.html?runId=${encodeURIComponent(run.runId)}`;
    const label = t('hist.traces.open_run', { n: index + 1 });
    const meta = [run.model, run.status, run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '']
      .filter(Boolean)
      .join(' / ');
    return `<a class="trace-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}${meta ? `<span>${escapeHtml(meta)}</span>` : ''}</a>`;
  }).join('');
  return `
    <div class="trace-panel">
      <div class="trace-panel-title">${escapeHtml(t('hist.traces.title'))}</div>
      <div class="trace-list">${links}</div>
    </div>
  `;
}

function renderMessage(message) {
  const role = ['user', 'assistant', 'system', 'error'].includes(message?.role) ? message.role : 'unknown';
  return `
    <article class="message ${escapeAttr(role)}">
      <div class="message-role">${escapeHtml(t(`hist.role.${role}`))}</div>
      <div class="message-text">${escapeHtml(message?.text || '')}</div>
    </article>
  `;
}

function recordToMarkdown(record) {
  const traces = traceRunsForRecord(record);
  const lines = [
    `# ${record.title || t('hist.untitled')}`,
    '',
    `Created: ${formatDate(record.createdAt)}`,
    `Updated: ${formatDate(record.updatedAt)}`,
    record.url ? `URL: ${record.url}` : '',
    record.tabTitle ? `Page title: ${record.tabTitle}` : '',
    record.mode ? `Mode: ${record.mode}` : '',
    record.providerLabel || record.providerId ? `Provider: ${[record.providerLabel, record.providerId].filter(Boolean).join(' / ')}` : '',
    traces.length ? `Trace runs: ${traces.map((run) => run.runId).join(', ')}` : '',
    '',
  ].filter((line, index) => index < 2 || line !== '');

  for (const message of record.messages || []) {
    lines.push(`## ${t(`hist.role.${message.role}`)}`);
    lines.push('');
    lines.push(message.text || '');
    lines.push('');
  }
  return lines.join('\n');
}

function exportSelected() {
  const record = allRecords.find((item) => item.id === selectedRecordId);
  if (!record) return alert(t('hist.select_first'));
  const blob = new Blob([recordToMarkdown(record)], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `webbrain-chat-${safeFilename(record.title || record.id)}.md`;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 7000);
  }
}

async function deleteSelected() {
  if (!selectedRecordId) return alert(t('hist.select_first'));
  if (!confirm(t('hist.confirm_delete'))) return;
  await deleteChatHistoryRecord(selectedRecordId);
  selectedRecordId = null;
  renderEmpty();
  await refresh();
}

async function clearAll() {
  if (!confirm(t('hist.confirm_clear_all'))) return;
  await clearChatHistoryRecords();
  selectedRecordId = null;
  renderEmpty();
  await refresh();
}

function formatDate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '-';
  return new Date(n).toLocaleString();
}

function hostLabel(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return String(url).slice(0, 60);
  }
}

function safeFilename(value) {
  return String(value || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'conversation';
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function escapeAttr(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

btnRefresh.addEventListener('click', refresh);
btnExport.addEventListener('click', exportSelected);
btnDelete.addEventListener('click', deleteSelected);
btnClearAll.addEventListener('click', clearAll);
filterText.addEventListener('input', renderList);

document.addEventListener('wb-locale-changed', () => {
  renderList();
  if (selectedRecordId) renderRecord(selectedRecordId);
  else renderEmpty();
});

(async () => {
  await refresh();
})();
