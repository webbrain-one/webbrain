'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, summarizeCompass, tightestRow } = require('../app/companion');

const row = (window, remaining, extra = {}) => ({ window, label: extra.label || window, scope: extra.scope || '', remaining, reset_at: extra.reset_at || null, detail: extra.detail || '' });

test('tightestRow takes the least of the whole-plan windows', () => {
  const rows = [row('5h', 40), row('week', 90), row('month', 65)];
  assert.equal(tightestRow(rows).remaining, 40);
});

test('tightestRow ignores rows without a number', () => {
  const rows = [row('5h', null, { detail: '12 / 50' }), row('week', 80)];
  assert.equal(tightestRow(rows).remaining, 80);
});

test('tightestRow with only scoped pools picks the healthiest pool', () => {
  const rows = [
    row('5h', 5, { scope: 'Opus' }), row('week', 90, { scope: 'Opus' }),
    row('5h', 70, { scope: 'Sonnet' }), row('week', 60, { scope: 'Sonnet' }),
  ];
  // One exhausted model group must not make the whole plan look empty.
  assert.equal(tightestRow(rows).scope, 'Sonnet');
  assert.equal(tightestRow(rows).remaining, 60);
});

test('tightestRow: unscoped windows beat any pool', () => {
  const rows = [row('5h', 30), row('week', 10, { scope: 'Apps' })];
  assert.equal(tightestRow(rows).remaining, 30);
  assert.equal(tightestRow([]), null);
});

test('summarize narrows the panel snapshot and picks the button value', () => {
  const snapshot = {
    accounts: [
      { name: 'claude.json', provider: 'claude', provider_name: 'Claude', email: 'me@example.com',
        quota: { status: 'ok', plan: 'Max', rows: [row('5h', 40), row('week', 90)] } },
      { name: 'codex.json', provider: 'codex', provider_name: 'ChatGPT',
        quota: { status: 'ok', plan: 'plus', rows: [row('5h', 15)] } },
      { name: 'paused.json', provider: 'kimi', provider_name: 'Kimi', disabled: true,
        quota: { status: 'ok', rows: [row('week', 1)] } },
      { name: 'gpt.json', provider: 'openai', provider_name: 'OpenAI',
        quota: { status: 'unsupported' } },
    ],
  };
  const s = summarize(snapshot);
  assert.equal(s.accounts.length, 4);
  assert.equal(s.accounts[0].who, 'me@example.com');
  assert.equal(s.accounts[0].plan, 'Max');
  assert.equal(s.accounts[1].plan, 'plus');
  assert.equal(s.accounts[3].status, 'unsupported');
  assert.deepEqual(s.tightest, { remaining: 15, account: 'ChatGPT', plan: 'plus', label: '5h' });
});

test('summarize: no usable windows gives no button value', () => {
  const s = summarize({ accounts: [{ name: 'x.json', provider: 'meta', provider_name: 'Meta', quota: { status: 'loading' } }] });
  assert.equal(s.tightest, null);
  assert.equal(s.accounts[0].status, 'loading');
  assert.deepEqual(s.accounts[0].rows, []);
});

test('summarize handles a snapshot without accounts', () => {
  const s = summarize({});
  assert.deepEqual(s.accounts, []);
  assert.equal(s.tightest, null);
});

test('summarizeCompass turns the dollar window into a percent left', () => {
  const c = summarizeCompass({
    tier: 'plus', weekly_used_usd: 10, weekly_limit_usd: 50,
    next_reset_at: '2026-11-23T00:00:00Z', requests: 12,
  });
  assert.equal(c.status, 'ok');
  assert.equal(c.tier, 'plus');
  assert.equal(c.remaining, 80);
  assert.equal(c.resetAt, '2026-11-23T00:00:00Z');
});

test('summarizeCompass counts promotional credit toward what is left', () => {
  const c = summarizeCompass({ weekly_used_usd: 0.5, weekly_limit_usd: 0.5, promotional_balance_usd: 0.5 });
  assert.equal(c.remaining, 50);
});

test('summarizeCompass without a limit reports no percent', () => {
  const c = summarizeCompass({ tier: 'free', weekly_used_usd: 0, weekly_limit_usd: 0 });
  assert.equal(c.remaining, null);
});
