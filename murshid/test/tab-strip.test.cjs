'use strict';

// The tab strip's layout in Chromium, with Murshid's own ui.css and ui.js's
// narrow-tab rule. Uses Playwright from the repository root; skips where it
// or its Chromium is not installed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch {}

const ui = path.join(__dirname, '..', 'app', 'ui');
const css = fs.readFileSync(path.join(ui, 'ui.css'), 'utf8');
const rule = fs.readFileSync(path.join(ui, 'ui.js'), 'utf8').match(/^function updateNarrowTabs\(\) \{[\s\S]*?^\}/m)?.[0];

const page = (bodyClass, dir) => `<!doctype html><html dir="${dir}"><head><style>${css}</style></head>
<body class="${bodyClass}"><div id="chrome"><div id="strip"><div id="strip-lead"></div><div id="tabs"></div>
<button id="new-tab" class="icon-button"></button><div id="strip-fill"></div></div></div>
<script>
  const els = { tabs: document.getElementById('tabs') };
  const tabEls = new Map();
  ${rule}
  // Opens or closes tabs as renderTabs does (kept elements keep their
  // classes), then applies the rule twice: a settled strip does not flip.
  window.setCount = (n) => {
    for (const [id, el] of [...tabEls].slice(n)) { el.remove(); tabEls.delete(id); }
    while (tabEls.size < n) {
      const el = document.createElement('div');
      el.className = 'tab';
      el.innerHTML = '<span class="favicon"></span><span class="title">A page title ' + tabEls.size + '</span>'
        + '<button class="audio" hidden></button><button class="close"></button>';
      els.tabs.append(el);
      tabEls.set(tabEls.size + 1000 * Math.random(), el);
    }
    [...tabEls.values()].forEach((el, i) => el.classList.toggle('active', i === 0));
    updateNarrowTabs();
    const first = [...tabEls.values()].map(el => el.classList.contains('narrow'));
    updateNarrowTabs();
    const strip = [...tabEls.values()].map(el => ({ width: el.getBoundingClientRect().width, narrow: el.classList.contains('narrow') }));
    return { strip, flipped: strip.some((tab, i) => tab.narrow !== first[i]) };
  };
</script></body></html>`;

test('tabs regain their titles after tabs close or the window grows, the same at every count',
  { skip: !chromium && 'Playwright is not installed' }, async (t) => {
    assert.ok(rule, 'ui.js defines updateNarrowTabs()');
    let browser;
    try { browser = await chromium.launch(); } catch (error) {
      t.skip(`Chromium is not available: ${String(error.message).split('\n')[0]}`);
      return;
    }
    try {
      for (const [label, bodyClass, dir] of [['macOS', 'mac', 'ltr'], ['Windows', '', 'ltr'], ['right-to-left', 'mac', 'rtl']]) {
        const tab = await browser.newPage({ viewport: { width: 1000, height: 200 } });
        await tab.setContent(page(bodyClass, dir));
        const set = n => tab.evaluate(n => window.setCount(n), n);

        const few = await set(3);
        assert.deepEqual(few.strip.map(s => [Math.round(s.width), s.narrow]), [[236, false], [236, false], [236, false]],
          `${label}: three tabs get their full width`);

        // Up to many tabs and back down: each count looks the same both ways.
        const counts = [1, 3, 8, 11, 12, 13, 16, 30];
        const seen = new Map();
        for (const n of [...counts, ...counts.slice(0, -1).reverse()]) {
          const { strip, flipped } = await set(n);
          assert.equal(flipped, false, `${label}: ${n} tabs flipped on a second pass`);
          assert.equal(new Set(strip.map(s => s.narrow)).size, 1, `${label}: ${n} tabs mix icon-only and titled tabs`);
          const widths = strip.map(s => s.width);
          assert.ok(Math.max(...widths) - Math.min(...widths) < 1, `${label}: ${n} tabs have unequal widths ${widths}`);
          const shape = `${Math.round(widths[0])}${strip[0].narrow ? ' narrow' : ''}`;
          if (seen.has(n)) assert.equal(shape, seen.get(n), `${label}: ${n} tabs differ after closing tabs`);
          else seen.set(n, shape);
        }
        assert.match(seen.get(30), /narrow/, `${label}: thirty tabs are icon-only`);

        // Icon-only tabs widen again when the window does.
        assert.equal((await set(14)).strip[0].narrow, true, `${label}: fourteen tabs at 1000px are icon-only`);
        await tab.setViewportSize({ width: 2000, height: 200 });
        const wide = await tab.evaluate(() => { updateNarrowTabs(); return [...tabEls.values()].map(el => el.classList.contains('narrow')); });
        assert.ok(wide.every(narrow => !narrow), `${label}: tabs stayed icon-only in a wider window`);
        await tab.close();
      }
    } finally {
      await browser.close();
    }
  });
