'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadWithElectron(file, mock) {
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'electron' ? mock : original.call(this, name, ...args); };
  try { delete require.cache[require.resolve(file)]; return require(file); } finally { Module._load = original; }
}

test('permissions isolate opaque origins and microphone and camera decisions', async () => {
  let check, request, display;
  const prompts = [];
  const responses = [];
  const ctx = { webBrainId: 'a'.repeat(32), ses: {
    setPermissionCheckHandler(fn) { check = fn; }, setPermissionRequestHandler(fn) { request = fn; },
    setDisplayMediaRequestHandler(fn) { display = fn; },
  }, windowForContents() {}, lastFocusedWindow() {} };
  const electron = { dialog: { showMessageBox(_parent, opts) { prompts.push(opts); return Promise.resolve({ response: responses.shift() }); } },
    desktopCapturer: { getSources: async () => [{ id: 'screen:1:0', name: 'Screen 1' }, { id: 'window:2:0', name: 'Window' }] },
    webContents: { fromFrame: () => ({}) } };
  const { installPermissions } = loadWithElectron('../app/permissions', electron);
  installPermissions(ctx);
  const ask = (url, permission, types) => new Promise(resolve => request({getURL: () => url}, permission, resolve, {requestingUrl:url, mediaTypes: types}));
  responses.push(0);
  assert.equal(await ask('https://example.com/a', 'media', ['audio']), true);
  assert.equal(check(null, 'media', 'https://example.com', {mediaType:'audio'}), true);
  assert.equal(check(null, 'media', 'https://example.com', {mediaType:'video'}), false);
  assert.equal(check(null, 'media', 'https://example.com', {}), false);
  responses.push(1);
  assert.equal(await ask('https://example.com/a', 'media', ['video']), false);
  assert.match(prompts[1].message, /camera/);
  assert.equal(check(null, 'media', 'https://example.com', {mediaType:'audio'}), true);
  assert.equal(await ask(`chrome-extension://${'a'.repeat(32)}/page.html`, 'media', ['audio']), true);
  assert.equal(check(null, 'media', `chrome-extension://${'a'.repeat(32)}`, {mediaType:'audio'}), true);
  responses.push(0, 1);
  assert.equal(await ask('file:///one.html', 'media', ['audio']), true);
  assert.equal(check(null, 'media', 'null', {mediaType:'audio'}), false);
  assert.equal(await ask('file:///two.html', 'media', ['audio']), false);
  assert.match(prompts.at(-1).message, /local file/);
  assert.equal(await ask('https://example.org', 'media', []), false);
  const frame = {url:'https://example.com/a', isDestroyed: () => false};
  responses.push(2);
  const selected = await new Promise(resolve => display({frame, securityOrigin:'https://example.com', videoRequested:true}, resolve));
  assert.equal(selected.video.id, 'window:2:0');
  responses.push(0);
  assert.equal(await new Promise(resolve => display({frame, securityOrigin:'https://example.com', videoRequested:true}, resolve)), null);
  electron.dialog.showMessageBox = async () => { frame.url = 'https://other.test/'; return { response: 1 }; };
  assert.equal(await new Promise(resolve => display({frame, securityOrigin:'https://example.com', videoRequested:true}, resolve)), null);
});

test('app links are allowed per site and scheme, the prompt shows the link, and denied schemes never open', async () => {
  let check, request;
  const prompts = [];
  const responses = [];
  const ctx = { ses: {
    setPermissionCheckHandler(fn) { check = fn; }, setPermissionRequestHandler(fn) { request = fn; }, setDisplayMediaRequestHandler() {},
  }, windowForContents() {}, lastFocusedWindow() {} };
  const electron = { dialog: { showMessageBox(_parent, opts) { prompts.push(opts); return Promise.resolve({ response: responses.shift() }); } },
    desktopCapturer: {}, webContents: {} };
  const { installPermissions } = loadWithElectron('../app/permissions', electron);
  installPermissions(ctx);
  const open = (page, externalURL) => new Promise(resolve => request({getURL: () => page}, 'openExternal', resolve, {requestingUrl: page, externalURL}));
  responses.push(0);
  assert.equal(await open('https://example.com/a', 'mailto:someone@example.com'), true);
  assert.match(prompts[0].message, /^example\.com wants to open an app/);
  assert.match(prompts[0].detail, /^mailto:someone@example\.com\n\nYour choice is remembered/);
  // The same kind of link is not asked about again, whatever the case of its scheme.
  assert.equal(await open('https://example.com/b', 'MAILTO:other@example.com'), true);
  assert.equal(prompts.length, 1);
  // One Allow is not every app: another scheme is asked about, with its link.
  responses.push(1);
  assert.equal(await open('https://example.com/a', 'search-ms:query=report'), false);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].detail, /^search-ms:query=report\n/);
  assert.equal(check(null, 'openExternal', 'https://example.com', {}), false);
  // After a Block the site can't ask again with new schemes; what it was allowed still opens.
  assert.equal(await open('https://example.com/a', 'zoommtg://example.com/join'), false);
  assert.equal(await open('https://example.com/a', 'mailto:someone@example.com'), true);
  assert.equal(prompts.length, 2);
  // Other sites are asked on their own.
  responses.push(0);
  assert.equal(await open('https://example.org/', 'zoommtg://example.org/join'), true);
  assert.equal(prompts.length, 3);
  // Schemes Chrome never hands to the system, and links that aren't URLs, are refused without asking.
  for (const link of ['shell:startup', 'VBScript:msgbox(1)', 'file:///C:/Windows/notepad.exe', 'ms-help://topic', 'not a link', undefined]) {
    assert.equal(await open('https://example.org/', link), false, String(link));
  }
  assert.equal(prompts.length, 3);
  // Murshid's own pages open app links without asking, but not the denied schemes.
  assert.equal(await open('murshid://downloads/', 'mailto:someone@example.com'), true);
  assert.equal(await open('murshid://downloads/', 'shell:startup'), false);
  assert.equal(check(null, 'openExternal', 'murshid://downloads', { externalURL: 'shell:startup' }), false);
  assert.equal(prompts.length, 3);
  // A long link shows its start and its end.
  responses.push(1);
  const long = `zoommtg://example.net/join?${'x'.repeat(500)}&end=1`;
  assert.equal(await open('https://example.net/', long), false);
  const shown = prompts[3].detail.split('\n')[0];
  assert.equal(shown, `${long.slice(0, 140)}…${long.slice(-60)}`);
  // The URL parser keeps the spaces of an opaque path. They are encoded, so a
  // page can't pad its link to put words of its own on a line in the dialog.
  responses.push(1);
  const padded = `ms-msdt:${' '.repeat(60)}Trusted by Example`;
  assert.equal(new URL(padded).href, padded);
  assert.equal(await open('https://example.edu/', padded), false);
  const paddedShown = prompts[4].detail.split('\n\n')[0];
  assert.doesNotMatch(paddedShown, /\s/);
  const encoded = padded.replaceAll(' ', '%20');
  assert.equal(paddedShown, `${encoded.slice(0, 140)}…${encoded.slice(-60)}`);
  assert.ok(paddedShown.startsWith('ms-msdt:%20') && paddedShown.endsWith('%20Trusted%20by%20Example'), paddedShown);
  // A local file is asked every time.
  responses.push(0, 0);
  assert.equal(await open('file:///page.html', 'mailto:someone@example.com'), true);
  assert.equal(await open('file:///page.html', 'mailto:someone@example.com'), true);
  assert.equal(prompts.length, 7);
  assert.match(prompts[6].detail, /^mailto:someone@example\.com\n\nThis choice applies only to this request/);
});

test('with browser data kept off, the browser chrome and the address bar list load favicons in their own session', () => {
  const made = [];
  const contents = () => ({ on() {}, loadFile() {}, setWindowOpenHandler() {}, send() {} });
  class BrowserWindow { constructor(options) { made.push(options); this.id = made.length; this.webContents = contents(); } once() {} on() {} }
  class WebContentsView { constructor(options) { made.push(options); this.webContents = contents(); } setBackgroundColor() {} }
  const electron = { BrowserWindow, WebContentsView, dialog: {}, nativeTheme: { shouldUseDarkColors: false, on() {} },
    screen: { getPrimaryDisplay: () => ({ workArea: { width: 1600, height: 1000 } }) } };
  const modules = ['../app/window', '../app/omnibox-popup', '../app/tab'];
  modules.forEach((file) => delete require.cache[require.resolve(file)]);
  try {
    const { MurshidWindow } = loadWithElectron('../app/window', electron);
    for (const uiPartition of [undefined, 'murshid-temporary-ui']) {
      made.length = 0;
      const w = new MurshidWindow({ uiPartition, settings: { get() {} } });
      w.omniPopup.ensure();
      assert.equal(made.length, 2);
      for (const options of made) assert.equal(options.webPreferences.partition, uiPartition);
    }
  } finally { modules.forEach((file) => delete require.cache[require.resolve(file)]); }
});

test('reload and hard reload retry failed destinations', () => {
  const { createCommands } = require('../app/commands');
  const calls = [];
  const tab = {errorFor:'https://example.test/', load: u => calls.push(['load',u]), wc:{reload:()=>calls.push(['reload']),reloadIgnoringCache:()=>calls.push(['hard'])}};
  const commands = createCommands({});
  commands.run.reload({activeTab:tab}); commands.run.hardReload({activeTab:tab});
  tab.errorFor = null; commands.run.reload({activeTab:tab}); commands.run.hardReload({activeTab:tab});
  assert.deepEqual(calls, [['load','https://example.test/'],['load','https://example.test/'],['reload'],['hard']]);
});

test('address bar chooses HTTP for local hosts with or without ports', () => {
  const { resolveInput } = require('../app/url');
  const search = (q) => `search:${q}`;
  for (const value of ['localhost:3000', 'localhost:3000?q=1', 'example.local:8080/path', 'example.test:456', '127.0.0.1:8080', '[::1]:1234']) {
    assert.equal(resolveInput(value, search), `http://${value}`, value);
  }
  assert.equal(resolveInput('example.com:8080/path', search), 'https://example.com:8080/path');
  assert.equal(resolveInput('localhost.example.com:3000', search), 'https://localhost.example.com:3000');
  assert.equal(resolveInput('https://localhost:3000', search), 'https://localhost:3000/');
});

test('open arguments convert Windows paths, including spaces and hash signs', () => {
  const original = Module._load;
  const path = 'C:\\Users\\Alice\\a # page.html';
  let converted;
  Module._load = function (name, ...args) {
    if (name === 'node:fs') return { statSync: (value) => { assert.equal(value, path); return { isFile: () => true }; } };
    if (name === 'node:url') return { pathToFileURL: (value) => { converted = value; return { href: 'file:///C:/Users/Alice/a%20%23%20page.html' }; } };
    return original.call(this, name, ...args);
  };
  let urlsFromArgs;
  try { delete require.cache[require.resolve('../app/open-arguments')]; ({ urlsFromArgs } = require('../app/open-arguments')); }
  finally { Module._load = original; }
  assert.deepEqual(urlsFromArgs(['electron', path, 'https://example.com/']), ['file:///C:/Users/Alice/a%20%23%20page.html', 'https://example.com/']);
  assert.equal(converted, path);
  delete require.cache[require.resolve('../app/open-arguments')];
});

test('interrupted download returns to active when progress resumes', () => {
  const { EventEmitter } = require('node:events');
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-download-test-'));
  try {
    const electron = { app: { getPath: () => folder }, shell: {} };
    const { Downloads } = loadWithElectron('../app/downloads', electron);
    const events = [];
    const ctx = {ses: new EventEmitter(), webBrainId: 'extension', crx: {emit: (...args) => events.push(args)}};
    const downloads = new Downloads(ctx);
    const item = new EventEmitter();
    Object.assign(item, {getURLChain:()=>['https://example.com/file'], getURL:()=> 'https://example.com/file', getFilename:()=> 'file', getMimeType:()=> 'text/plain', getStartTime:()=> 0, getTotalBytes:()=> 100, getReceivedBytes:()=> 42, getSavePath:()=> path.join(folder, 'file'), setSavePath:()=> {}, isPaused:()=> false, canResume:()=> true});
    downloads.onWillDownload(item);
    item.emit('updated', {}, 'interrupted');
    assert.equal(downloads.search({id:1})[0].state, 'interrupted');
    assert.equal(downloads.summary().active, 0);
    assert.equal(downloads.summary().recent[0].canResume, true);
    item.emit('updated', {}, 'progressing');
    assert.equal(downloads.search({id:1})[0].state, 'in_progress');
    assert.equal(downloads.summary().active, 1);
    assert.equal(downloads.summary().recent[0].canResume, false);
    assert(events.some(e => e[1] === 'downloads.onChanged' && e[2][0].state?.current === 'in_progress'));
  } finally { fs.rmSync(folder, {recursive:true, force:true}); }
});

test('save image as routes the source download to a save dialog', async () => {
  const { EventEmitter } = require('node:events');
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-save-as-'));
  try {
    const electron = {
      app: { getPath: () => folder }, shell: {}, clipboard: {},
      Menu: class { constructor() { this.items = []; } append(item) { this.items.push(item); } popup() {} },
      MenuItem: class { constructor(options) { Object.assign(this, options); } },
    };
    const { Downloads } = loadWithElectron('../app/downloads', electron);
    const { showContextMenu } = loadWithElectron('../app/context-menu', electron);
    let opened;
    electron.Menu.prototype.popup = function () { opened = this; };
    const ses = new EventEmitter();
    const ctx = {ses, webBrainId: 'extension', extensions: {getContextMenuItems: () => []}, crx: {emit() {}}, lastFocusedWindow: () => null};
    ctx.downloads = new Downloads(ctx);
    const wc = {downloadURL(url) { assert.equal(url, 'blob:https://example.com/image'); }};
    showContextMenu(ctx, {wc, owner: {win: {}}}, {mediaType:'image', srcURL:'blob:https://example.com/image'}, wc);
    opened.items.find(item => item.label === 'Save image as…').click();
    assert.equal(ctx.downloads.pending.length, 1);
    const item = new EventEmitter(); let dialogOptions; let saved = false;
    Object.assign(item, {getURLChain:()=>['blob:https://example.com/image'], getURL:()=> 'blob:https://example.com/image', getFilename:()=> 'image.png', getMimeType:()=> 'image/png', getStartTime:()=> 0, getTotalBytes:()=> 1, getReceivedBytes:()=> 0, getSavePath:()=> '', setSavePath:()=> { saved = true; }, setSaveDialogOptions:opts=>{dialogOptions=opts;}, isPaused:()=> false, canResume:()=> true});
    ses.emit('will-download', {}, item, wc);
    assert.equal(saved, false);
    assert.equal(dialogOptions.defaultPath, path.join(folder, 'image.png'));
    assert.equal(ctx.downloads.search({id:1})[0].byExtensionId, undefined);
  } finally { fs.rmSync(folder, {recursive:true, force:true}); }
});
