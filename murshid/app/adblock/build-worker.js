'use strict';

// Runs in a utility process started by app/adblock/index.js: parses freshly
// downloaded filter lists into an engine and stores it, about a second of work
// that would otherwise hold up the browser. Gets { texts, file, meta, updated }
// and answers { ok } or { ok: false, error }.

const { buildEngine, describe, pack, writeEngine } = require('./engine');

process.parentPort.once('message', ({ data }) => {
  try {
    const engine = buildEngine(data.texts);
    writeEngine(data.file, data.meta, pack(engine.serialize()), describe(data.texts, data.updated));
    process.parentPort.postMessage({ ok: true });
  } catch (error) {
    process.parentPort.postMessage({ ok: false, error: String(error?.message || error) });
  }
});
