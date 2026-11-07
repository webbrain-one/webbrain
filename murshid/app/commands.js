'use strict';

// Browser commands and their keyboard shortcuts. On Windows and Linux there is
// no menu bar, so keys are matched in before-input-event on every webContents
// of a window (chrome UI, tabs, side panel). On macOS the same commands hang
// off the application menu (see menu.js), which is how Cmd shortcuts work there.

const isMac = process.platform === 'darwin';

function createCommands(ctx) {
  const tabOf = (w) => w?.activeTab || null;
  const reload = (w, hard = false) => {
    const tab = tabOf(w);
    if (!tab) return;
    if (tab.errorFor) tab.load(tab.errorFor);
    else if (hard) tab.wc.reloadIgnoringCache();
    else tab.wc.reload();
  };
  const zoom = (w, delta) => {
    const tab = tabOf(w);
    if (!tab) return;
    const wc = tab.wc;
    const level = delta === 0 ? 0 : Math.max(-8, Math.min(9, wc.getZoomLevel() + delta));
    wc.setZoomLevel(level);
    w.scheduleState();
  };

  const run = {
    newTab: (w) => (w || ctx.createWindow({ empty: true })).addTab({ url: 'murshid://newtab' }),
    newWindow: () => ctx.createWindow({}),
    closeTab: (w) => w && w.closeTab(tabOf(w)),
    closeWindow: (w) => w?.win.close(),
    reopenTab: (w) => w?.reopenClosedTab(),
    nextTab: (w) => w?.cycleTab(1),
    prevTab: (w) => w?.cycleTab(-1),
    selectIndex: (w, n) => w?.selectTabIndex(n),
    focusOmnibox: (w) => w?.focusOmnibox(),
    reload: (w) => reload(w),
    hardReload: (w) => reload(w, true),
    stop: (w) => tabOf(w)?.wc.stop(),
    back: (w) => { const h = tabOf(w)?.wc.navigationHistory; if (h?.canGoBack()) h.goBack(); },
    forward: (w) => { const h = tabOf(w)?.wc.navigationHistory; if (h?.canGoForward()) h.goForward(); },
    home: (w) => tabOf(w)?.load('murshid://newtab'),
    find: (w) => { if (w) { w.ui.focus(); w.ui.send('murshid:find-open'); } },
    findNext: (w) => w?.ui.send('murshid:find-step', 1),
    findPrev: (w) => w?.ui.send('murshid:find-step', -1),
    zoomIn: (w) => zoom(w, 0.5),
    zoomOut: (w) => zoom(w, -0.5),
    zoomReset: (w) => zoom(w, 0),
    devTools: (w) => {
      const wc = tabOf(w)?.wc;
      if (!wc) return;
      if (wc.isDevToolsOpened()) wc.closeDevTools();
      else wc.openDevTools({ mode: 'detach' });
    },
    panelDevTools: (w) => w?.panelContents()?.openDevTools({ mode: 'detach' }),
    uiDevTools: (w) => w?.ui.openDevTools({ mode: 'detach' }),
    viewSource: (w) => {
      const url = tabOf(w)?.url;
      if (url && /^https?:/i.test(url)) w.addTab({ url: `view-source:${url}`, after: tabOf(w) });
    },
    print: (w) => tabOf(w)?.wc.print(),
    fullscreen: (w) => w && w.win.setFullScreen(!w.win.isFullScreen()),
    webBrain: (w) => w && ctx.crx.togglePanelForActiveTab(w),
    webBrainCommand: (w, name) => ctx.sendExtensionCommand(w, name),
    settings: (w) => (w || ctx.createWindow({ empty: true })).addTab({ url: 'murshid://settings' }),
    about: (w) => (w || ctx.createWindow({ empty: true })).addTab({ url: 'murshid://about' }),
    quit: () => ctx.quit(),
  };

  // [key, modifiers, command, arg]. "mod" is Ctrl (Cmd on macOS).
  const bindings = [
    ['t', 'mod', 'newTab'],
    ['n', 'mod', 'newWindow'],
    ['w', 'mod', 'closeTab'],
    ['F4', 'ctrl', 'closeTab'],
    ['w', 'mod+shift', 'closeWindow'],
    ['t', 'mod+shift', 'reopenTab'],
    ['Tab', 'ctrl', 'nextTab'],
    ['Tab', 'ctrl+shift', 'prevTab'],
    ['PageDown', 'ctrl', 'nextTab'],
    ['PageUp', 'ctrl', 'prevTab'],
    ['l', 'mod', 'focusOmnibox'],
    ['d', 'alt', 'focusOmnibox'],
    ['F6', '', 'focusOmnibox'],
    ['k', 'mod', 'focusOmnibox'],
    ['r', 'mod', 'reload'],
    ['F5', '', 'reload'],
    ['r', 'mod+shift', 'hardReload'],
    ['F5', 'shift', 'hardReload'],
    ['F5', 'ctrl', 'hardReload'],
    ['ArrowLeft', 'alt', 'back'],
    ['ArrowRight', 'alt', 'forward'],
    ['[', 'mod', 'back'],
    [']', 'mod', 'forward'],
    ['Home', 'alt', 'home'],
    ['f', 'mod', 'find'],
    ['F3', '', 'findNext'],
    ['F3', 'shift', 'findPrev'],
    ['g', 'mod', 'findNext'],
    ['g', 'mod+shift', 'findPrev'],
    ['=', 'mod', 'zoomIn'],
    ['+', 'mod', 'zoomIn'],
    ['+', 'mod+shift', 'zoomIn'],
    ['-', 'mod', 'zoomOut'],
    ['0', 'mod', 'zoomReset'],
    ['F12', '', 'devTools'],
    ['i', 'mod+shift', 'devTools'],
    ['j', 'mod+shift', 'devTools'],
    ['u', 'mod', 'viewSource'],
    ['p', 'mod', 'print'],
    ['F11', '', 'fullscreen'],
    ['w', 'alt+shift', 'webBrain'],
    [',', 'alt+shift', 'webBrainCommand', 'decrease-ui-scale'],
    ['.', 'alt+shift', 'webBrainCommand', 'increase-ui-scale'],
    ['q', 'mod+shift', 'quit'],
  ];
  for (let n = 1; n <= 9; n += 1) bindings.push([String(n), isMac ? 'mod' : 'ctrl', 'selectIndex', n]);

  function modifiersMatch(input, spec) {
    const want = new Set(spec ? spec.split('+') : []);
    const ctrl = want.has('ctrl') || (!isMac && want.has('mod'));
    const meta = isMac && want.has('mod');
    return Boolean(input.control) === ctrl
      && Boolean(input.meta) === meta
      && Boolean(input.shift) === want.has('shift')
      && Boolean(input.alt) === want.has('alt');
  }

  function keyMatches(input, key) {
    if (key.length === 1) return input.key.toLowerCase() === key || input.key === key;
    return input.key === key;
  }

  function handleInput(event, input, w) {
    if (input.type !== 'keyDown' || input.isAutoRepeat && !['Tab', 'PageDown', 'PageUp'].includes(input.key)) return;
    // macOS routes Cmd shortcuts through the application menu instead.
    if (isMac && input.meta) return;
    for (const [key, mods, name, arg] of bindings) {
      if (!keyMatches(input, key) || !modifiersMatch(input, mods)) continue;
      event.preventDefault();
      try { run[name](w, arg); } catch (error) { console.error(`[murshid] ${name} failed:`, error); }
      return;
    }
  }

  return { run, bindings, handleInput };
}

module.exports = { createCommands };
