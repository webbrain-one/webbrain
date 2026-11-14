import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = async (build, file) => (await fs.readFile(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

// Runs the production composer switch (its whole block in sidepanel.js) against
// the real panel markup, styles and English strings. Only storage, tabs and the
// chat helpers it calls are fixtures, so the test sees every write and notice.
for (const [build, engine, api] of [['chrome', chromium, 'chrome'], ['firefox', firefox, 'browser']]) {
  describe(`${build}: side panel permission switch`, () => {
    let browser, block, gateHelpers, html;
    before(async () => {
      browser = await engine.launch({ headless: true });
      const source = await read(build, 'src/ui/sidepanel.js');
      // The switch combines the stored setting with the browser-session skip
      // through these production helpers.
      const helpersStart = source.indexOf('function syncAskBeforeConsequential() {');
      const helpersEnd = source.indexOf('\n// --- "Dangerously skip permissions" dialog', helpersStart);
      assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'Use the production gate helpers.');
      gateHelpers = source.slice(helpersStart, helpersEnd);
      const start = source.indexOf("const permissionGateMenu = document.getElementById('permission-gate-menu');");
      const end = source.indexOf('\nrenderPermissionGateControl();\n', start);
      assert.ok(start >= 0 && end > start, 'Use the entire production switch block.');
      block = source.slice(start, end + '\nrenderPermissionGateControl();\n'.length);
      html = (await read(build, 'src/ui/sidepanel.html'))
        .split('\n')
        .filter((line) => !line.trim().startsWith('<script'))
        .join('\n');
    });
    after(async () => { await browser?.close(); });

    async function fixture(run, { askBefore = true, sessionOff = false, width = 420, storedPin = null } = {}) {
      const context = await browser.newContext({ viewport: { width, height: 640 } });
      const errors = [];
      try {
        await context.route('**/*', async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname === '/panel') return route.fulfill({ contentType: 'text/html', body: html });
          if (!pathname.startsWith(`/src/${build}/`) || pathname.includes('..')) return route.fulfill({ status: 404, body: '' });
          try {
            const body = await fs.readFile(new URL(`../src/${build}/${pathname.slice(`/src/${build}/`.length)}`, import.meta.url));
            return route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body });
          } catch { return route.fulfill({ status: 404, body: '' }); }
        });
        await context.addInitScript(() => localStorage.setItem('wbLocale', 'en'));
        const page = await context.newPage();
        page.setDefaultTimeout(2500);
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto('https://owned-panel.invalid/panel');
        await page.addStyleTag({ content: await read(build, 'styles/sidepanel.css') });
        await page.addScriptTag({ type: 'module', content: `
          import { t, applyDOMTranslations } from '/src/${build}/src/ui/i18n.js';
          import { createComposerModePins } from '/src/${build}/src/ui/composer-mode-pin.js';
          import { PERMISSION_GATE_SESSION_OFF_KEY } from '/src/${build}/src/agent/permission-gate.js';
          const log = window.__log = { writes: [], sessionWrites: [], sessionRemoves: [], notices: [], toasts: [], opened: [], actWarning: 0, placeholder: 0, scaleClosed: 0, setMode: [], ensure: [], background: [] };
          const sendToBackground = async (action, params = {}) => { log.background.push({ action, params }); return {}; };
          // The mode picker's collaborators: the panel's mode state and checks.
          const session = window.__session = { ${storedPin ? `'composerModePin:7': ${JSON.stringify(storedPin)}` : ''} };
          const sessionArea = {
            async get(key) { return key in session ? { [key]: session[key] } : {}; },
            async set(values) { Object.assign(session, values); },
            async remove(key) { delete session[key]; },
          };
          const isStandaloneWindow = false;
          let autoModeSelection = true;
          let agentMode = 'ask';
          let currentTabId = 7;
          const sameTabId = (a, b) => a != null && b != null && String(a) === String(b);
          const composerModePins = createComposerModePins(sessionArea);
          const setMode = (mode, { pinned = false } = {}) => {
            log.setMode.push({ mode, pinned, auto: autoModeSelection });
            agentMode = autoModeSelection ? 'ask' : mode;
          };
          const blocked = window.__blocked = { act: false, dev: false };
          // A check can be held open to race it against a later pick.
          const gates = window.__gates = { act: null, dev: null };
          const check = async (mode, switchMode) => {
            log.ensure.push({ mode, switchMode });
            if (gates[mode]) await gates[mode];
            return !blocked[mode];
          };
          const ensureActMode = ({ switchMode = true } = {}) => check('act', switchMode);
          const ensureDevMode = ({ switchMode = true } = {}) => check('dev', switchMode);
          let isProcessing = false;
          let composerModePickerReady = false;
          let composerModePickGeneration = 0;
          let composerModePinCheckPending = false;
          let failNextWrite = false;
          window.__failNextWrite = () => { failNextWrite = true; };
          const ${api} = {
            storage: { local: { async set(values) {
              if (failNextWrite) { failNextWrite = false; throw new Error('storage unavailable'); }
              log.writes.push(values);
              if (PERMISSION_GATE_KEY in values) {
                // Chromium dispatches storage.onChanged before the set() callback resumes
                askBeforeConsequential = values[PERMISSION_GATE_KEY] !== false;
              }
            } }, session: {
              async set(values) { log.sessionWrites.push(values); },
              async remove(key) { log.sessionRemoves.push(key); },
            } },
            runtime: { getURL: (path) => 'ext://webbrain/' + path, openOptionsPage() { log.opened.push('options'); } },
            tabs: { async create({ url }) { log.opened.push(url); } },
          };
          const PERMISSION_GATE_KEY = 'askBeforeConsequentialActions';
          let askBeforeConsequential = ${askBefore && !sessionOff};
          let permissionGateStoredOff = ${!askBefore};
          let permissionGateSessionOff = ${sessionOff};
          const updateActWarning = () => { log.actWarning += 1; };
          const updateInputPlaceholder = () => { log.placeholder += 1; };
          const showComposerToast = (message) => { log.toasts.push(message); };
          const addPersistentSlashMessage = (content) => { log.notices.push(content.__systemHtml); };
          const systemHtml = (value) => ({ __systemHtml: value });
          const closeUiScalePopover = () => { log.scaleClosed += 1; return false; };
          applyDOMTranslations(document);
          ${gateHelpers}
          ${block}
          renderComposerModePicker();
          Object.assign(window, {
            restoreComposerModeForCurrentTab, setComposerModePinForTab, revalidateComposerModePin, restoreComposerModeBeforeSend,
            // What setTabProcessing does for the visible tab.
            setProcessing(value) {
              isProcessing = value;
              renderComposerModePicker();
              if (!value && composerModePinCheckPending) void revalidateComposerModePin();
            },
            pinCheckPending: () => composerModePinCheckPending,
            switchTab(id) { currentTabId = id; restoreComposerModeForCurrentTab(); },
            modeState: () => ({ auto: autoModeSelection, agentMode, pin: composerModePins.get(currentTabId) }),
          });
          window.__ready = true;
        ` });
        await page.waitForFunction(() => window.__ready === true);
        const state = () => page.evaluate(() => {
          const btn = document.getElementById('btn-permission-gate');
          const popover = document.getElementById('permission-gate-popover');
          return {
            title: btn.title,
            label: btn.getAttribute('aria-label'),
            expanded: btn.getAttribute('aria-expanded'),
            off: btn.classList.contains('is-gate-off'),
            dot: getComputedStyle(btn, '::after').content,
            open: !popover.classList.contains('hidden'),
            checked: document.getElementById('toggle-permission-gate-panel').checked,
            noteShown: !document.getElementById('permission-gate-off-note').classList.contains('hidden'),
            focus: document.activeElement?.id || '',
            log: structuredClone(window.__log),
          };
        });
        await run({ page, state });
        assert.deepEqual(errors, [], 'The production switch must not throw.');
      } finally { await context.close(); }
    }

    test('opens like the scale menu and turns prompts off with the same notice as the command', async () => {
      await fixture(async ({ page, state }) => {
        let s = await state();
        assert.equal(s.title, 'Permission prompts: on');
        assert.equal(s.label, 'Permission prompts: on');
        assert.equal(s.off, false);
        assert.equal(s.dot, 'none', 'no warning dot while prompts are on');
        assert.equal(s.open, false);
        assert.equal(s.checked, true);
        assert.equal(s.noteShown, false);

        await page.click('#btn-permission-gate');
        s = await state();
        assert.equal(s.open, true);
        assert.equal(s.expanded, 'true');
        assert.equal(s.focus, 'toggle-permission-gate-panel', 'focus moves to the switch');
        assert.equal(s.log.scaleClosed, 1, 'opening it closes the scale menu');
        assert.match(await page.textContent('#permission-gate-popover'), /Ask before consequential actions[\s\S]*WebBrain asks the first time/);

        await page.click('.permission-gate-row');
        await page.waitForFunction(() => window.__log.writes.length === 1);
        s = await state();
        assert.deepEqual(s.log.writes, [{ askBeforeConsequentialActions: false }]);
        assert.deepEqual(s.log.sessionRemoves, [], 'turning prompts off leaves the session flag alone');
        assert.equal(s.log.notices.length, 1);
        assert.match(s.log.notices[0], /Permission prompts are OFF/);
        assert.equal(s.off, true);
        assert.notEqual(s.dot, 'none', 'off state shows a warning dot on the trigger');
        assert.equal(s.title, 'Permission prompts: off');
        assert.equal(s.noteShown, true);
        assert.equal(s.checked, false);
        assert.ok(s.log.actWarning >= 1 && s.log.placeholder >= 1, 'Act warning and placeholder follow the gate');
        // The icon color transitions, so wait for it to settle on the warning color.
        await page.waitForFunction(() => getComputedStyle(document.getElementById('btn-permission-gate')).color
          === getComputedStyle(document.getElementById('permission-gate-off-note')).color);

        await page.keyboard.press('Escape');
        s = await state();
        assert.equal(s.open, false);
        assert.equal(s.expanded, 'false');
        assert.equal(s.focus, 'btn-permission-gate', 'Escape returns focus to the trigger');
      });
    });

    test('turns prompts back on from the switch and closes on an outside click', async () => {
      await fixture(async ({ page, state }) => {
        let s = await state();
        assert.equal(s.off, true);
        assert.equal(s.checked, false);
        await page.click('#btn-permission-gate');
        await page.keyboard.press('Space');
        await page.waitForFunction(() => window.__log.writes.length === 1);
        s = await state();
        assert.deepEqual(s.log.writes, [{ askBeforeConsequentialActions: true }]);
        assert.deepEqual(s.log.toasts, ['Permission prompts are on again.']);
        assert.equal(s.log.notices.length, 0);
        assert.equal(s.off, false);
        assert.equal(s.noteShown, false);
        // Left of the popover, which is anchored to the toolbar's end.
        await page.mouse.click(20, 300);
        assert.equal((await state()).open, false);
      }, { askBefore: false });
    });

    test('a skip for this browser session shows as off, and turning prompts on ends it', async () => {
      await fixture(async ({ page, state }) => {
        let s = await state();
        assert.equal(s.off, true, 'the session skip turns prompts off even with the stored setting on');
        assert.equal(s.checked, false);
        await page.click('#btn-permission-gate');
        await page.keyboard.press('Space');
        await page.waitForFunction(() => window.__log.writes.length === 1);
        s = await state();
        assert.deepEqual(s.log.writes, [{ askBeforeConsequentialActions: true }]);
        assert.deepEqual(s.log.sessionRemoves, ['skipPermissionPromptsThisSession']);
        assert.deepEqual(s.log.sessionWrites, []);
        assert.deepEqual(s.log.toasts, ['Permission prompts are on again.']);
        assert.equal(s.off, false);
        assert.equal(s.checked, true);
      }, { sessionOff: true });
    });

    test('a failed write keeps showing the stored state', async () => {
      await fixture(async ({ page, state }) => {
        await page.click('#btn-permission-gate');
        await page.evaluate(() => window.__failNextWrite());
        await page.click('.permission-gate-row');
        await page.waitForFunction(() => document.getElementById('toggle-permission-gate-panel').checked === true);
        const s = await state();
        assert.deepEqual(s.log.writes, []);
        assert.deepEqual(s.log.notices, []);
        assert.equal(s.off, false);
      });
    });

    test('links to the site permission list and fits a narrow panel', async () => {
      await fixture(async ({ page, state }) => {
        await page.click('#btn-permission-gate');
        const box = await page.locator('#permission-gate-popover').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 360, `popover stays inside a 360px panel (${box.x}+${box.width})`);
        const toolbar = await page.locator('.composer-toolbar').boundingBox();
        assert.ok(box.y >= 0 && box.y + box.height <= toolbar.y, `popover opens upward above the composer toolbar (${box.y}+${box.height} vs ${toolbar.y})`);
        assert.ok(toolbar.height <= 36, 'the composer toolbar stays on one row');
        const header = await page.locator('#header').boundingBox();
        assert.ok(header.height <= 56, 'the header does not wrap');
        await page.click('#btn-permission-gate-settings');
        await page.waitForFunction(() => window.__log.opened.length === 1);
        const s = await state();
        assert.deepEqual(s.log.opened, ['ext://webbrain/src/ui/settings.html#permissions']);
        assert.equal(s.open, false);
      }, { width: 360 });
    });

    const picker = (page) => page.evaluate(() => {
      const btn = document.getElementById('btn-permission-gate');
      const badge = document.getElementById('composer-mode-badge');
      return {
        active: [...document.querySelectorAll('.composer-mode-option.active')].map(option => option.dataset.composerMode),
        checked: [...document.querySelectorAll('.composer-mode-option')].map(option => option.getAttribute('aria-checked')),
        tabbable: [...document.querySelectorAll('.composer-mode-option')].map(option => option.tabIndex),
        badge: badge.hidden ? null : badge.textContent,
        pinned: btn.classList.contains('has-mode-pin'),
        title: btn.title,
        label: btn.getAttribute('aria-label'),
        state: window.modeState(),
        session: { ...window.__session },
        log: structuredClone(window.__log),
      };
    });

    test('the mode picker starts in Auto and keeps Act for the chat', async () => {
      await fixture(async ({ page }) => {
        let p = await picker(page);
        assert.deepEqual(p.active, ['auto']);
        assert.deepEqual(p.checked, ['true', 'false', 'false', 'false']);
        assert.deepEqual(p.tabbable, [0, -1, -1, -1], 'one tab stop, on the chosen mode');
        assert.equal(p.badge, null);
        assert.equal(p.pinned, false);
        assert.equal(p.state.auto, true);
        await page.click('#btn-permission-gate');
        assert.match(await page.textContent('.composer-mode-picker'), /Mode[\s\S]*Auto[\s\S]*Ask[\s\S]*Act[\s\S]*Dev[\s\S]*a new chat starts in Auto/);

        await page.click('.composer-mode-option[data-composer-mode="act"]');
        await page.waitForFunction(() => window.modeState().pin === 'act');
        p = await picker(page);
        assert.deepEqual(p.log.ensure, [{ mode: 'act', switchMode: false }], 'Act is checked like the shortcut, without switching on its own');
        assert.deepEqual(p.active, ['act']);
        assert.deepEqual(p.state, { auto: false, agentMode: 'act', pin: 'act' }, 'Automatic is off and the composer sends Act');
        assert.deepEqual(p.log.setMode.at(-1), { mode: 'act', pinned: true, auto: false });
        assert.equal(p.badge, 'Act', 'the trigger shows the kept mode');
        assert.equal(p.pinned, true);
        assert.equal(p.title, 'Act for this chat · Permission prompts: on');
        assert.equal(p.label, p.title);
        await page.waitForFunction(() => window.__session['composerModePin:7'] === 'act');
        await page.waitForFunction(() => getComputedStyle(document.getElementById('btn-permission-gate')).color
          === getComputedStyle(document.getElementById('permission-gate-off-note')).color);

        await page.click('.composer-mode-option[data-composer-mode="auto"]');
        await page.waitForFunction(() => window.modeState().auto === true);
        p = await picker(page);
        assert.deepEqual(p.active, ['auto']);
        assert.equal(p.badge, null);
        assert.equal(p.title, 'Permission prompts: on');
        assert.equal(p.state.agentMode, 'ask');
        await page.waitForFunction(() => !('composerModePin:7' in window.__session));
      });
    });

    test('the mode picker moves with the arrow keys and refuses a blocked mode', async () => {
      await fixture(async ({ page }) => {
        await page.click('#btn-permission-gate');
        await page.focus('.composer-mode-option[data-composer-mode="auto"]');
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => window.modeState().pin === 'ask');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.composerMode), 'ask');
        await page.keyboard.press('End');
        await page.waitForFunction(() => window.modeState().pin === 'dev');
        let p = await picker(page);
        assert.equal(p.badge, 'Dev');
        await page.keyboard.press('Home');
        await page.waitForFunction(() => window.modeState().auto === true);

        await page.evaluate(() => { window.__blocked.act = true; });
        await page.click('.composer-mode-option[data-composer-mode="act"]');
        await page.waitForFunction(() => window.__log.ensure.length === 2);
        p = await picker(page);
        assert.deepEqual(p.active, ['auto'], 'a mode the checks refuse is not kept');
        assert.equal(p.state.auto, true);
      });
    });

    test('each tab keeps its own mode, and a reopened panel finds it', async () => {
      await fixture(async ({ page }) => {
        await page.evaluate(() => window.restoreComposerModeForCurrentTab());
        await page.waitForFunction(() => window.modeState().pin === 'dev');
        let p = await picker(page);
        assert.deepEqual(p.active, ['dev'], 'the stored choice comes back');
        assert.equal(p.badge, 'Dev');
        await page.evaluate(() => window.switchTab(8));
        p = await picker(page);
        assert.deepEqual(p.state, { auto: true, agentMode: 'ask', pin: null }, 'another tab stays in Auto');
        assert.equal(p.badge, null);
        await page.evaluate(() => window.switchTab(7));
        await page.waitForFunction(() => window.modeState().pin === 'dev');
        // A new chat on the tab clears it.
        await page.evaluate(() => window.setComposerModePinForTab(7, null));
        p = await picker(page);
        assert.deepEqual(p.state, { auto: true, agentMode: 'ask', pin: null });
        await page.waitForFunction(() => !('composerModePin:7' in window.__session));
      }, { storedPin: 'dev' });
    });

    test('the mode picker waits for a run to end', async () => {
      await fixture(async ({ page }) => {
        await page.click('#btn-permission-gate');
        await page.evaluate(() => window.setProcessing(true));
        let state = await page.evaluate(() => ({
          disabled: [...document.querySelectorAll('.composer-mode-option')].map(option => option.disabled),
          desc: document.getElementById('composer-mode-desc').textContent,
        }));
        assert.deepEqual(state.disabled, [true, true, true, true]);
        assert.equal(state.desc, 'You can change the mode when the current task finishes.');
        await page.evaluate(() => document.querySelector('.composer-mode-option[data-composer-mode="dev"]').click());
        assert.equal((await picker(page)).state.auto, true, 'no change during the run');
        await page.evaluate(() => window.setProcessing(false));
        state = await page.evaluate(() => ({
          disabled: [...document.querySelectorAll('.composer-mode-option')].map(option => option.disabled),
          desc: document.getElementById('composer-mode-desc').textContent,
        }));
        assert.deepEqual(state.disabled, [false, false, false, false]);
        assert.match(state.desc, /^Auto picks Ask, Act or Dev/);
      });
    });

    test('the latest pick wins over an older one still being checked', async () => {
      await fixture(async ({ page }) => {
        await page.click('#btn-permission-gate');
        await page.evaluate(() => { window.__release = null; window.__gates.dev = new Promise(resolve => { window.__release = resolve; }); });
        await page.click('.composer-mode-option[data-composer-mode="dev"]');
        await page.click('.composer-mode-option[data-composer-mode="ask"]');
        await page.waitForFunction(() => window.modeState().pin === 'ask');
        await page.evaluate(() => window.__release());
        await page.waitForTimeout(50);
        const p = await picker(page);
        assert.deepEqual(p.state, { auto: false, agentMode: 'ask', pin: 'ask' }, 'the older Dev pick does not overwrite Ask');
        assert.deepEqual(p.active, ['ask']);
      });
    });

    test('a new chat cancels a pick still being checked', async () => {
      await fixture(async ({ page }) => {
        await page.click('#btn-permission-gate');
        await page.evaluate(() => { window.__release = null; window.__gates.act = new Promise(resolve => { window.__release = resolve; }); });
        await page.click('.composer-mode-option[data-composer-mode="act"]');
        // New chat (renderClearedConversationForTab) while the Act check waits.
        await page.evaluate(() => window.setComposerModePinForTab(7, null));
        await page.evaluate(() => window.__release());
        await page.waitForTimeout(50);
        const p = await picker(page);
        assert.deepEqual(p.state, { auto: true, agentMode: 'ask', pin: null }, 'the new chat starts in Auto');
        assert.equal('composerModePin:7' in p.session, false);
      });
    });

    test('a tab switch cancels a pick still being checked, even back to the same tab', async () => {
      await fixture(async ({ page }) => {
        await page.click('#btn-permission-gate');
        await page.evaluate(() => { window.__release = null; window.__gates.act = new Promise(resolve => { window.__release = resolve; }); });
        await page.click('.composer-mode-option[data-composer-mode="act"]');
        await page.evaluate(() => { window.switchTab(8); window.switchTab(7); });
        await page.evaluate(() => window.__release());
        await page.waitForTimeout(50);
        const p = await picker(page);
        assert.deepEqual(p.state, { auto: true, agentMode: 'ask', pin: null });
        assert.equal('composerModePin:7' in p.session, false);
      });
    });

    test('a send waits for a mode pick still being checked', async () => {
      await fixture(async ({ page }) => {
        await page.click('#btn-permission-gate');
        await page.evaluate(() => { window.__release = null; window.__gates.act = new Promise(resolve => { window.__release = resolve; }); });
        await page.click('.composer-mode-option[data-composer-mode="act"]');
        await page.evaluate(() => { window.__sent = null; window.restoreComposerModeBeforeSend(7).then(() => { window.__sent = window.modeState(); }); });
        await page.waitForTimeout(80);
        assert.equal(await page.evaluate(() => window.__sent), null, 'the send is held while Act is checked');
        await page.evaluate(() => window.__release());
        await page.waitForFunction(() => window.__sent !== null);
        assert.deepEqual(await page.evaluate(() => window.__sent), { auto: false, agentMode: 'act', pin: 'act' }, 'it then goes out in Act');
      });
    });

    test('a send waits for a restored mode to be checked against the provider', async () => {
      await fixture(async ({ page }) => {
        // Dev was kept, then the provider became Compact while the panel was closed.
        await page.evaluate(() => {
          window.__blocked.dev = true;
          window.__release = null;
          window.__gates.dev = new Promise(resolve => { window.__release = resolve; });
          window.restoreComposerModeForCurrentTab();
          window.__sent = null;
          window.restoreComposerModeBeforeSend(7).then(() => { window.__sent = window.modeState(); });
        });
        await page.waitForTimeout(80);
        assert.equal(await page.evaluate(() => window.__sent), null, 'the send is held while the restored Dev is checked');
        await page.evaluate(() => window.__release());
        await page.waitForFunction(() => window.__sent !== null);
        assert.deepEqual(await page.evaluate(() => window.__sent), { auto: true, agentMode: 'ask', pin: null }, 'it goes out in Auto, never in a Dev the provider cannot run');
      }, { storedPin: 'dev' });
    });

    test('a kept mode the new provider cannot run goes back to Auto, after the run', async () => {
      await fixture(async ({ page }) => {
        await page.click('#btn-permission-gate');
        await page.click('.composer-mode-option[data-composer-mode="dev"]');
        await page.waitForFunction(() => window.modeState().pin === 'dev');
        // The user switches to a Compact provider while a Dev run is going.
        await page.evaluate(() => { window.__blocked.dev = true; window.setProcessing(true); });
        await page.evaluate(() => window.revalidateComposerModePin());
        assert.equal((await picker(page)).state.pin, 'dev', 'the running Dev task keeps its mode');
        assert.equal(await page.evaluate(() => window.pinCheckPending()), true);
        await page.evaluate(() => window.setProcessing(false));
        await page.waitForFunction(() => window.modeState().auto === true);
        const p = await picker(page);
        assert.deepEqual(p.state, { auto: true, agentMode: 'ask', pin: null });
        assert.equal(p.badge, null);
        assert.deepEqual(p.log.ensure.at(-1), { mode: 'dev', switchMode: false }, 'checked like the shortcut');
        // A provider that can still run it keeps the mode.
        await page.click('.composer-mode-option[data-composer-mode="act"]');
        await page.waitForFunction(() => window.modeState().pin === 'act');
        await page.evaluate(() => window.revalidateComposerModePin());
        await page.waitForTimeout(50);
        assert.equal((await picker(page)).state.pin, 'act');
      });
    });

    test('a tab switch never drains Dev diagnostics; leaving a kept Dev drains only its tab', async () => {
      await fixture(async ({ page }) => {
        await page.click('#btn-permission-gate');
        await page.click('.composer-mode-option[data-composer-mode="dev"]');
        await page.waitForFunction(() => window.modeState().pin === 'dev');
        // Tab 7 runs Dev; the user looks at tab 8 (Auto) and back.
        await page.evaluate(() => { window.switchTab(8); window.switchTab(7); });
        await page.waitForFunction(() => window.modeState().pin === 'dev');
        assert.deepEqual((await picker(page)).log.background, [], 'switching tabs drains nothing');
        await page.click('.composer-mode-option[data-composer-mode="auto"]');
        await page.waitForFunction(() => window.modeState().auto === true);
        assert.deepEqual((await picker(page)).log.background,
          build === 'chrome' ? [{ action: 'disable_dev_diagnostics', params: { tabId: 7 } }] : [],
          'only the tab that left Dev is drained (Chrome has Dev diagnostics)');
      });
    });

    test('a kept mode keeps the toolbar on one row in a narrow panel', async () => {
      await fixture(async ({ page }) => {
        await page.click('#btn-permission-gate');
        await page.click('.composer-mode-option[data-composer-mode="act"]');
        await page.waitForFunction(() => window.modeState().pin === 'act');
        const toolbar = await page.locator('.composer-toolbar').boundingBox();
        assert.ok(toolbar.height <= 36, `the composer toolbar stays on one row (${toolbar.height})`);
        const box = await page.locator('#permission-gate-popover').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 360, 'the popover with the picker fits a 360px panel');
        const options = await page.evaluate(() => [...document.querySelectorAll('.composer-mode-option')]
          .map(option => option.scrollWidth <= option.clientWidth + 1));
        assert.deepEqual(options, [true, true, true, true], 'no mode name is cut off');
      }, { width: 360 });
    });

    test('mode names in every language fit, wrapping rather than being cut off', async () => {
      const codes = ['en', 'tr', 'es', 'fr', 'de', 'nl', 'pt', 'pl', 'ru', 'uk', 'zh', 'ja', 'ko', 'ar', 'he', 'fa', 'hi', 'bn', 'id', 'ms', 'tl', 'th', 'vi'];
      const dicts = {};
      for (const code of codes) dicts[code] = (await import(`../src/${build}/src/ui/locales/${code}.js`)).default;
      await fixture(async ({ page }) => {
        await page.click('#btn-permission-gate');
        const problems = await page.evaluate((all) => {
          const found = [];
          const popover = document.getElementById('permission-gate-popover');
          for (const [code, dict] of Object.entries(all)) {
            for (const el of popover.querySelectorAll('.composer-mode-picker [data-i18n]')) el.textContent = dict[el.dataset.i18n] || el.textContent;
            for (const option of popover.querySelectorAll('.composer-mode-option')) {
              if (option.scrollWidth > option.clientWidth + 1) found.push(`${code}: ${option.textContent} is cut off`);
            }
            if (popover.scrollWidth > popover.clientWidth + 1) found.push(`${code}: the popover overflows`);
          }
          return found;
        }, dicts);
        assert.deepEqual(problems, []);
      }, { width: 360 });
    });

    test('keeps the model picker usable at 175% scale in a narrow panel', async () => {
      await fixture(async ({ page }) => {
        await page.evaluate(() => {
          document.documentElement.dataset.uiScale = '175';
          document.documentElement.style.setProperty('--ui-scale-zoom', '1.75');
          // The name is only the tooltip now: a long one cannot widen the button.
          document.getElementById('provider-picker-label').textContent = 'OpenRouter · a long model name';
        });
        const rects = await page.evaluate(() => {
          const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
          return {
            picker: rect('#provider-picker-btn'),
            icon: rect('#provider-picker-btn .provider-picker-icon'),
            label: getComputedStyle(document.getElementById('provider-picker-label')).display,
            wrapper: rect('#input-wrapper'),
            controls: [...document.querySelectorAll('.composer-toolbar > button, .composer-toolbar > .provider-picker, .composer-toolbar > .permission-gate-menu')]
              .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; })
              .filter((r) => r.width > 0),
          };
        });
        assert.equal(rects.label, 'none', 'the closed picker shows no model name');
        assert.ok(rects.icon.width > 0, 'it shows the engine icon');
        assert.ok(rects.picker.width <= 56 * 1.75, `the picker stays an icon button (${rects.picker.width})`);
        for (const control of rects.controls) {
          assert.ok(control.left >= rects.wrapper.left - 1 && control.right <= rects.wrapper.right + 1, `${control.id} stays inside the composer`);
        }
        for (let i = 0; i < rects.controls.length; i++) {
          for (let j = i + 1; j < rects.controls.length; j++) {
            const a = rects.controls[i], b = rects.controls[j];
            const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
            assert.ok(!overlap, `${a.id} and ${b.id} do not overlap`);
          }
        }
        // No visual reordering: tabbing through the toolbar reads top-to-bottom, left-to-right.
        const order = await page.evaluate(() => [...document.querySelectorAll('.composer-toolbar button:not([hidden]), .composer-toolbar [tabindex]:not([tabindex="-1"])')]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id, top: Math.round((r.top + r.bottom) / 2), left: Math.round(r.left) }; }));
        for (let i = 1; i < order.length; i++) {
          const before = order[i - 1], after = order[i];
          assert.ok(after.top > before.top + 8 || (Math.abs(after.top - before.top) <= 8 && after.left >= before.left),
            `DOM order matches visual order (${before.id} then ${after.id})`);
        }
      }, { width: 360 });
    });
  });
}
