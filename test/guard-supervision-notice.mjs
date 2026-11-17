import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8');
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: runtime guard notice links to supervision without retrying or changing settings`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<main class="message-content"></main>');
      const source = read(build, 'src/ui/sidepanel.js');
      const start = source.indexOf('function renderGuardSupervisionNotice(');
      const fn = source.slice(start, source.indexOf('\n}', start) + 2);
      await page.addScriptTag({ content: `
        var persisted = 0;
        var chrome = { runtime: { getURL: path => 'https://extension.test/' + path } };
        function t(key) { return key; }
        function schedulePersist() { persisted++; }
        function scrollToBottom() {}
        ${fn}
        renderGuardSupervisionNotice(document.body);
        renderGuardSupervisionNotice(document.body);
        renderGuardSupervisionNotice(null);
      ` });
      assert.equal(await page.locator('.guard-supervision-notice').count(), 1);
      assert.equal(await page.locator('.guard-supervision-notice').getAttribute('role'), 'note');
      assert.equal(await page.locator('.guard-supervision-notice a').getAttribute('href'), 'https://extension.test/src/ui/settings.html#supervision');
      assert.equal(await page.evaluate(() => persisted), 1);
      assert.match(read(build, 'src/agent/agent.js'), /if \(refusalStop\) \{\s*if \(this\._actionGuardsEnabled\(tabId\)\) onUpdate\('guard_supervision_notice'/);
      assert.match(source, /case 'guard_supervision_notice':\s*renderGuardSupervisionNotice/);
      // A deep link overrides the last selected settings tab and focuses the control.
      await page.route('https://extension.test/**', route => route.fulfill({ body: '<html></html>', contentType: 'text/html' }));
      await page.goto('https://extension.test/settings');
      await page.setContent('<nav class="tabs" data-default-tab="display"></nav><button class="tab-btn" data-tab="display"></button><button class="tab-btn" data-tab="permissions"></button><section class="tab-panel" data-panel="display"><select id="select-preset-supervision"><option>Balanced</option></select></section>');
      await page.evaluate(() => { location.hash = 'supervision'; localStorage.setItem('webbrainSettingsTab', 'permissions'); });
      await page.addScriptTag({ content: read(build, 'src/ui/settings-tabs.js') });
      assert.equal(await page.locator('[data-tab="display"]').getAttribute('aria-current'), 'page');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'select-preset-supervision');
    } finally { await browser.close(); }
  });
}
