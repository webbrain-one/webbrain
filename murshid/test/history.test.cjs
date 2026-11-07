'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadHistory(profile) {
  const original = Module._load;
  const electron = { app: { getPath: () => profile } };
  Module._load = function (name, ...args) { return name === 'electron' ? electron : original.call(this, name, ...args); };
  try {
    delete require.cache[require.resolve('../app/history')];
    return require('../app/history').History;
  } finally {
    Module._load = original;
  }
}

test('history is saved in the profile, and kept in memory only for temporary sessions', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-history-'));
  const file = path.join(profile, 'murshid-history.json');
  try {
    const History = loadHistory(profile);
    const saved = new History();
    saved.recordVisit('https://example.com/', { typed: true });
    saved.flush();
    assert.ok(fs.existsSync(file));

    const temporary = new History({ persist: false });
    assert.equal(temporary.count(), 0, 'a temporary session does not read saved history');
    temporary.recordVisit('https://example.org/secret', {});
    temporary.flush();
    assert.equal(temporary.count(), 1);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /example\.org/);

    temporary.clear();
    assert.equal(fs.existsSync(file), false, 'Clear removes saved history too');
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
