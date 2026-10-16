import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function fixture(build, { title = 'Project dashboard', icons = ['https://site.test/favicon.png'], visibilityState = 'hidden' } = {}) {
  const source = readFileSync(new URL(`../src/${build}/src/content/content.js`, import.meta.url), 'utf8');
  const start = source.indexOf('  // ─── Tab attention flash');
  const end = source.lastIndexOf('\n})();');
  assert.ok(start >= 0 && end > start, `${build}: production attention implementation exists`);
  const listeners = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const paintedMarkers = [];
  const links = [];
  let now = 0;
  let nextTimer = 1;
  const link = href => {
    const attrs = new Map([['rel', 'icon']]);
    if (href != null) attrs.set('href', href);
    return {
      isConnected: true,
      getAttribute: key => attrs.get(key) ?? null,
      setAttribute: (key, value) => attrs.set(key, value),
      removeAttribute: key => attrs.delete(key),
      remove() { this.isConnected = false; links.splice(links.indexOf(this), 1); },
    };
  };
  links.push(...icons.map(link));
  const document = {
    title, visibilityState,
    head: { appendChild: element => links.push(element) },
    querySelectorAll: () => links.filter(element => element.isConnected),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
    createElement: tag => {
      if (tag === 'link') return link();
      assert.equal(tag, 'canvas');
      let marker = '';
      return {
        getContext: () => ({ fillText(value) { marker = value; paintedMarkers.push(value); } }),
        toDataURL: () => `data:image/png,${encodeURIComponent(marker)}`,
      };
    },
  };
  const api = vm.runInNewContext(`${source.slice(start, end)}\n({ startAttentionFlash, stopAttentionFlash })`, {
    document, Date: { now: () => now },
    setInterval: fn => { const id = nextTimer++; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: fn => { const id = nextTimer++; timeouts.set(id, fn); return id; },
    clearTimeout: id => timeouts.delete(id),
  });
  return {
    ...api, source, document, links, paintedMarkers, intervals, timeouts, listeners,
    tick() { now += 700; for (const fn of intervals.values()) fn(); },
    show() { document.visibilityState = 'visible'; listeners.get('visibilitychange')?.(); },
  };
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: plan review flashes warning title and favicon and restores the page`, () => {
    const page = fixture(build);
    assert.equal(page.startAttentionFlash({ reason: 'plan_review' }), true);
    assert.equal(page.document.title, '⚠️ Project dashboard');
    assert.deepEqual(page.paintedMarkers, ['⚠️']);
    assert.equal(page.links[0].getAttribute('href'), `data:image/png,${encodeURIComponent('⚠️')}`);
    page.tick();
    assert.equal(page.document.title, 'Project dashboard');
    assert.equal(page.links[0].getAttribute('href'), 'https://site.test/favicon.png');
    page.tick();
    page.stopAttentionFlash();
    assert.equal(page.document.title, 'Project dashboard');
    assert.equal(page.links[0].getAttribute('href'), 'https://site.test/favicon.png');
    assert.equal(page.intervals.size + page.timeouts.size + page.listeners.size, 0);
  });

  test(`${build}: switching completion and plan flashes preserves original title and favicon`, () => {
    const page = fixture(build);
    page.startAttentionFlash();
    assert.equal(page.document.title, '🔔 Project dashboard');
    page.startAttentionFlash({ reason: 'plan_review' });
    assert.equal(page.document.title, '⚠️ Project dashboard');
    page.startAttentionFlash({ reason: 'completion' });
    assert.equal(page.document.title, '🔔 Project dashboard');
    assert.deepEqual(page.paintedMarkers, ['🔔', '⚠️', '🔔']);
    assert.equal(page.intervals.size, 1);
    assert.equal(page.timeouts.size, 1);
    assert.equal(page.listeners.size, 1);
    page.stopAttentionFlash();
    assert.equal(page.document.title, 'Project dashboard');
    assert.equal(page.links[0].getAttribute('href'), 'https://site.test/favicon.png');
  });

  test(`${build}: targeted cancellation stops its plan without clearing a newer alert`, () => {
    const page = fixture(build);
    page.startAttentionFlash({ reason: 'plan_review', attentionId: 'plan-1' });
    page.startAttentionFlash({ reason: 'plan_review', attentionId: 'plan-2' });
    page.stopAttentionFlash({ attentionId: 'plan-1' });
    assert.equal(page.document.title, '⚠️ Project dashboard');
    assert.equal(page.links[0].getAttribute('href'), `data:image/png,${encodeURIComponent('⚠️')}`);
    assert.equal(page.intervals.size, 1);
    assert.equal(page.timeouts.size, 1);
    assert.equal(page.listeners.size, 0);
    page.stopAttentionFlash({ attentionId: 'plan-2' });
    assert.equal(page.document.title, 'Project dashboard');
    assert.equal(page.links[0].getAttribute('href'), 'https://site.test/favicon.png');
    assert.equal(page.intervals.size + page.timeouts.size + page.listeners.size, 0);

    page.startAttentionFlash({ reason: 'plan_review', attentionId: 'plan-3' });
    page.startAttentionFlash({ reason: 'completion' });
    page.stopAttentionFlash({ attentionId: 'plan-3' });
    assert.equal(page.document.title, '🔔 Project dashboard');
    assert.equal(page.links[0].getAttribute('href'), `data:image/png,${encodeURIComponent('🔔')}`);
    assert.equal(page.intervals.size, 1);
    page.stopAttentionFlash();
    assert.equal(page.document.title, 'Project dashboard');
    assert.equal(page.links[0].getAttribute('href'), 'https://site.test/favicon.png');
    assert.equal(page.intervals.size + page.timeouts.size + page.listeners.size, 0);
  });

  test(`${build}: plan flashes preserve site-owned warnings and later title/icon updates`, () => {
    const page = fixture(build, { title: '⚠️ Site warning' });
    page.startAttentionFlash({ reason: 'plan_review' });
    assert.equal(page.document.title, '⚠️ ⚠️ Site warning');
    page.stopAttentionFlash();
    assert.equal(page.document.title, '⚠️ Site warning');
    page.startAttentionFlash({ reason: 'plan_review' });
    page.document.title = '⚠️ Updated by site';
    page.links[0].setAttribute('href', 'https://site.test/new-icon.png');
    page.stopAttentionFlash();
    assert.equal(page.document.title, '⚠️ Updated by site');
    assert.equal(page.links[0].getAttribute('href'), 'https://site.test/new-icon.png');
  });

  test(`${build}: showing a completed tab clears its temporary favicon and stops the flash`, () => {
    const page = fixture(build, { icons: [] });
    page.startAttentionFlash({ reason: 'completion' });
    assert.equal(page.links.length, 1);
    page.show();
    assert.equal(page.document.title, 'Project dashboard');
    assert.equal(page.links.length, 0);
    assert.equal(page.intervals.size + page.timeouts.size + page.listeners.size, 0);
    assert.equal(page.startAttentionFlash({ reason: 'completion' }), false);
    assert.equal(page.document.title, 'Project dashboard');
    assert.equal(page.links.length, 0);
  });

  for (const reason of ['plan_review', 'clarify']) {
    test(`${build}: visible ${reason} requests identify their tab until their exact alert is resolved`, () => {
      const page = fixture(build, { visibilityState: 'visible' });
      const attentionId = `${reason}-1`;
      assert.equal(page.startAttentionFlash({ reason, attentionId }), true);
      assert.equal(page.document.title, '⚠️ Project dashboard');
      assert.deepEqual(page.paintedMarkers, ['⚠️']);
      assert.equal(page.links[0].getAttribute('href'), `data:image/png,${encodeURIComponent('⚠️')}`);
      page.show();
      page.stopAttentionFlash({ attentionId: 'old-alert' });
      assert.equal(page.document.title, '⚠️ Project dashboard');
      assert.equal(page.intervals.size, 1);
      assert.equal(page.timeouts.size, 1);
      assert.equal(page.listeners.size, 0);
      page.tick();
      page.tick();
      assert.equal(page.document.title, '⚠️ Project dashboard');
      page.stopAttentionFlash({ attentionId });
      assert.equal(page.document.title, 'Project dashboard');
      assert.equal(page.links[0].getAttribute('href'), 'https://site.test/favicon.png');
      assert.equal(page.intervals.size + page.timeouts.size + page.listeners.size, 0);
    });

    test(`${build}: a hidden ${reason} request keeps blinking when its tab is shown and still expires`, () => {
      const page = fixture(build, { icons: [] });
      assert.equal(page.startAttentionFlash({ reason, attentionId: `${reason}-1` }), true);
      page.show();
      assert.equal(page.document.title, '⚠️ Project dashboard');
      assert.equal(page.links.length, 1);
      assert.equal(page.intervals.size, 1);
      for (const expire of [...page.timeouts.values()]) expire();
      assert.equal(page.document.title, 'Project dashboard');
      assert.equal(page.links.length, 0);
      assert.equal(page.intervals.size + page.timeouts.size + page.listeners.size, 0);
    });
  }

  test(`${build}: attention message forwards the plan reason to the flash`, () => {
    const { source } = fixture(build);
    const start = source.indexOf("'attention_flash_start': () => {");
    const end = source.indexOf("'attention_flash_stop':", start);
    assert.ok(start >= 0 && end > start);
    const params = { reason: 'plan_review', attentionId: 'plan-1' };
    let received;
    const result = vm.runInNewContext(`({ ${source.slice(start, end)} })['attention_flash_start']()`, {
      msg: { params }, startAttentionFlash: value => { received = value; return true; },
    });
    assert.equal(result.success, true);
    assert.equal(result.started, true);
    assert.equal(received, params);
  });

  test(`${build}: cancellation message forwards its attention ID`, () => {
    const { source } = fixture(build);
    const start = source.indexOf("'attention_flash_stop': () => {");
    const end = source.indexOf('\n      },', start);
    assert.ok(start >= 0 && end > start);
    const params = { attentionId: 'plan-1' };
    let received;
    const result = vm.runInNewContext(`({ ${source.slice(start, end + 9)} })['attention_flash_stop']()`, {
      msg: { params }, stopAttentionFlash: value => { received = value; },
    });
    assert.equal(result.success, true);
    assert.equal(received, params);
  });
}
