// Vision mode's input in a real Firefox. Installs the Firefox build into an
// isolated headless Firefox over WebDriver BiDi, opens a local fixture and
// sends `vision_input` to the real content script (its Xray world,
// wrappedJSObject and exportFunction included), then reads what the page saw.
// Trusted input (point_input: a click and a hover) runs through the
// production companion session on the element the real content script marked.
// FIREFOX_BINARY picks the Firefox to run; without it, the system Firefox (on
// PATH or in the macOS default place), else Playwright's Firefox.
//
//   npm run test:firefox-vision:e2e
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BidiSession } from '../firefox-companion/session.mjs';
import { firefoxBinary } from './firefox-binary.mjs';

const temporaryRoot = await realpath(tmpdir());
const profilePrefix = 'webbrain-firefox-vision-test-';
const profile = await mkdtemp(join(temporaryRoot, profilePrefix));
const assertOwnedProfile = async () => {
  const resolved = await realpath(profile);
  const equal = (left, right) => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase() : left === right;
  assert.ok(equal(dirname(resolved), temporaryRoot) && basename(resolved).startsWith(profilePrefix),
    'Firefox cleanup must remain inside its owned temporary profile prefix.');
  return resolved;
};
await assertOwnedProfile();
await writeFile(join(profile, 'user.js'), 'user_pref("ui.prefersReducedMotion", 1);\n');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let locatedByScript = false;
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, ...(ok ? {} : { detail: String(detail).slice(0, 800) }) });
};

const scaledFrame = `<style>body{margin:0}#b{position:absolute;left:200px;top:100px;width:100px;height:40px}</style><button id="b">Go</button>
<script>window.log=[];document.getElementById('b').addEventListener('click',e=>log.push(['click',e.clientX,e.clientY]));<\/script>`;
const page = port => `<!doctype html><meta charset="utf-8"><title>vision in Firefox</title>
<style>body{margin:0;font:14px sans-serif}
#menu{position:absolute;left:20px;top:20px;width:200px;height:40px;background:#ddd}
#menu .submenu{display:none;position:absolute;left:0;top:40px;width:200px;height:80px;background:#bbb}
#menu:hover .submenu, .save{display:block}
.save{position:absolute;left:260px;top:20px;width:80px;height:30px;display:none}
#track{position:absolute;left:20px;top:200px;width:600px;height:20px;background:#eee}
#handle{position:absolute;left:20px;top:190px;width:40px;height:40px;background:#08f}
#press{position:absolute;left:700px;top:20px;width:120px;height:40px}
#volume{position:absolute;left:20px;top:280px;width:300px;height:20px;margin:0}
#words{position:absolute;left:20px;top:330px;margin:0;font:20px monospace;white-space:nowrap}
#scroller{position:absolute;left:20px;top:380px;width:200px;height:100px;overflow:auto;background:#f4f4f4}
#trust{position:absolute;left:700px;top:250px;width:120px;height:40px}
#scaled{position:absolute;left:400px;top:300px;width:400px;height:300px;border:3px solid #000;transform:scale(0.5);transform-origin:0 0}
#cross{position:absolute;left:700px;top:100px;width:200px;height:100px;border:0}</style>
<div id="menu">Menu<div class="submenu">Item</div></div><div class="save" id="save">Save</div>
<div id="track"></div><div id="handle"></div><button id="press">Press</button>
<input id="volume" type="range" min="0" max="100" step="5" value="10">
<p id="words">alpha bravo charlie</p>
<div id="scroller"><div style="height:1000px"></div></div><button id="trust">Trust</button>
<iframe id="scaled" srcdoc="${scaledFrame.replace(/"/g, '&quot;')}"></iframe>
<iframe id="cross" src="http://localhost:${port}/cross"></iframe>
<script>
window.log=[];
const handle=document.getElementById('handle');let grab=false;
handle.addEventListener('pointerdown',e=>{handle.setPointerCapture(e.pointerId);grab=true;log.push(['down',e.clientX]);});
handle.addEventListener('pointermove',e=>{if(grab)log.push(['move',e.clientX,handle.hasPointerCapture(e.pointerId)]);});
handle.addEventListener('pointerup',e=>{log.push(['up',e.clientX]);grab=false;handle.releasePointerCapture(e.pointerId);});
for(const t of ['gotpointercapture','lostpointercapture'])handle.addEventListener(t,()=>log.push([t.replace('pointercapture','')]));
const press=document.getElementById('press');
press.addEventListener('pointerdown',e=>{e.target.releasePointerCapture(e.pointerId);document.addEventListener('pointerup',()=>log.push(['pressed']),{once:true});});
for(const t of ['input','change'])document.getElementById('volume').addEventListener(t,e=>log.push([t,e.target.value]));
window.nativeCapture=Element.prototype.setPointerCapture;
window.trusted=[];for(const t of ['pointerdown','click'])document.addEventListener(t,e=>trusted.push([t,e.isTrusted,Math.round(e.clientX),Math.round(e.clientY),e.target.id||e.target.tagName]),true);
// The centre of a word of #words, from the layout this Firefox drew.
window.wordPoint=(word,edge)=>{const text=document.getElementById('words').firstChild;const start=text.nodeValue.indexOf(word);
const range=document.createRange();range.setStart(text,start);range.setEnd(text,start+word.length);const r=range.getBoundingClientRect();
return {x:edge==='start'?r.left+1:edge==='end'?r.right-1:(r.left+r.right)/2,y:(r.top+r.bottom)/2};};
</script>`;

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(req.url.startsWith('/cross') ? '<button style="width:100%;height:100%">Elsewhere</button>' : page(server.address().port));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const firefox = spawn((await firefoxBinary()).binary,
  ['--headless', '--remote-allow-system-access', '--no-remote', '--profile', profile, '--remote-debugging-port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let session;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firefox did not start BiDi')), 30000);
    let output = '';
    const onData = data => {
      output += data;
      const match = output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    firefox.stderr.on('data', onData);
    firefox.stdout.on('data', onData);
    firefox.on('error', error => { clearTimeout(timer); reject(error); });
  });
  session = new BidiSession();
  await session.connect(port);
  await session.send('webExtension.install', { extensionData: { type: 'path', path: fileURLToPath(new URL('../src/firefox/', import.meta.url)) } });
  // The window's first tab: some Firefox builds (Playwright's) cannot open
  // a tab over BiDi.
  const initial = await session.send('browsingContext.getTree', {});
  const context = initial.contexts.find(item => !String(item.url || '').startsWith('moz-extension://'))?.context;
  assert.ok(context, 'Firefox has a tab to use');
  try { await session.send('browsingContext.setViewport', { context, viewport: { width: 1000, height: 700 } }); } catch { /* keep the window's size */ }
  await session.send('browsingContext.navigate', { context, url, wait: 'complete' });
  const evaluate = async expression => {
    const response = await session.send('script.evaluate', { target: { context }, expression, awaitPromise: true });
    if (response.type === 'exception') throw new Error(response.exceptionDetails.text);
    return response.result.value;
  };
  const evaluateJson = async expression => JSON.parse(await evaluate(`JSON.stringify(${expression})`));
  // The extension's install page drives the content script, as the
  // background page does.
  let extensionContext = null;
  for (let i = 0; i < 60 && !extensionContext; i++) {
    const tree = await session.send('browsingContext.getTree', {});
    extensionContext = tree.contexts.find(item => item.url?.startsWith('moz-extension://'))?.context || null;
    if (!extensionContext) await delay(250);
  }
  assert.ok(extensionContext, 'the installed extension opens a page');
  const extensionEval = async expression => {
    const response = await session.send('script.evaluate', { target: { context: extensionContext }, expression, awaitPromise: true });
    if (response.type === 'exception') throw new Error(response.exceptionDetails.text);
    return response.result.value;
  };
  const tabId = await extensionEval(`browser.tabs.query({}).then(tabs => tabs.find(tab => tab.url === ${JSON.stringify(url)}).id)`);
  const vision = async params => JSON.parse(await extensionEval(`browser.tabs.sendMessage(${tabId}, { target: 'content', action: 'vision_input', params: ${JSON.stringify(params)} }, { frameId: 0 }).then(value => JSON.stringify(value ?? null))`));
  const take = async () => evaluateJson('window.log.splice(0)');
  const viewport = await evaluateJson('({ width: innerWidth, height: innerHeight })');
  assert.ok(viewport.width >= 920 && viewport.height >= 620, `the fixture needs a 920x620 viewport, got ${JSON.stringify(viewport)}`);

  // The content script answers once it has loaded (document_idle).
  let ready = null;
  for (let i = 0; i < 40 && !ready?.success; i++) {
    try { ready = await vision({ type: 'hover', x: 900, y: 600 }); } catch { ready = null; }
    if (!ready?.success) await delay(250);
  }
  check('the content script answers vision_input', ready?.success, JSON.stringify(ready));
  check('this Firefox throws for setPointerCapture(1) without the emulation',
    (await evaluate(`(() => { try { document.body.setPointerCapture(1); return 'no error'; } catch (error) { return error.name; } })()`)) === 'NotFoundError');

  // 1. CSS :hover reaches a CSS-only menu; the selector listed beside it keeps its cascade.
  let result = await vision({ type: 'hover', x: 120, y: 40 });
  const hovered = await evaluateJson(`({ submenu: getComputedStyle(document.querySelector('#menu .submenu')).display,
    save: getComputedStyle(document.getElementById('save')).display,
    rewritten: [...document.styleSheets[0].cssRules].some(rule => (rule.selectorText || '').includes('data-webbrain-hover')) })`);
  check('hover_at opens a CSS :hover menu', result?.success && hovered.submenu === 'block', JSON.stringify({ result, hovered }));
  check('a selector listed beside :hover keeps its own cascade', hovered.save === 'none', JSON.stringify(hovered));
  check('the :hover selector is rewritten in place', hovered.rewritten, JSON.stringify(hovered));
  // A person's own (trusted) pointer movement ends it and restores the page's selectors.
  await session.send('input.performActions', { context, actions: [{ type: 'pointer', id: 'person', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: 600, y: 660, origin: 'viewport' }] }] });
  let restored = null;
  for (let i = 0; i < 20; i++) {
    restored = await evaluateJson(`({ marked: document.querySelectorAll('[data-webbrain-hover]').length,
      submenu: getComputedStyle(document.querySelector('#menu .submenu')).display,
      rewritten: [...document.styleSheets[0].cssRules].some(rule => (rule.selectorText || '').includes('data-webbrain-hover')) })`);
    if (!restored.marked && !restored.rewritten) break;
    await delay(100);
  }
  check('a person moving the mouse ends the emulation and restores the selectors',
    !restored.marked && !restored.rewritten && restored.submenu === 'none', JSON.stringify(restored));

  // 2. Pointer capture: a thumb whose handlers are on itself gets every move and the release.
  await take();
  result = await vision({ type: 'drag', x: 40, y: 210, toX: 540, toY: 210, steps: 5 });
  const dragLog = await take();
  const moves = dragLog.filter(entry => entry[0] === 'move');
  check('drag_at succeeds on a capturing thumb', result?.success, JSON.stringify(result));
  check('the capturing thumb gets the press', dragLog[0]?.[0] === 'down', JSON.stringify(dragLog));
  check('gotpointercapture before the moves, lostpointercapture after the release',
    dragLog.findIndex(entry => entry[0] === 'got') === 1
      && dragLog.findIndex(entry => entry[0] === 'lost') > dragLog.findIndex(entry => entry[0] === 'up'), JSON.stringify(dragLog));
  check('every move reaches the thumb, far past its box, with capture held',
    moves.length === 5 && moves.at(-1)[1] === 540 && moves.every(entry => entry[2] === true), JSON.stringify(dragLog));
  check('the release reaches the thumb at the end point',
    JSON.stringify(dragLog.find(entry => entry[0] === 'up')) === JSON.stringify(['up', 540]), JSON.stringify(dragLog));
  check("the page's own setPointerCapture is back after the sequence", await evaluate('Element.prototype.setPointerCapture === window.nativeCapture'));

  // 3. A control that drops the implicit capture first completes its press.
  result = await vision({ type: 'click', x: 760, y: 40 });
  check('a react-aria style press completes', result?.success && (await take()).some(entry => entry[0] === 'pressed'), JSON.stringify(result));

  // 4. A click on a range track moves the thumb.
  result = await vision({ type: 'click', x: 170, y: 290 });
  const rangeLog = await take();
  check('click_at on a range track sets its value', result?.rangeValue === '50'
    && JSON.stringify(rangeLog) === JSON.stringify([['input', '50'], ['change', '50']]), JSON.stringify({ result, rangeLog }));

  // 5. Text: a double click selects the word under the pointer, a drag the text it crosses.
  const bravo = await evaluateJson("wordPoint('bravo')");
  result = await vision({ type: 'click', x: bravo.x, y: bravo.y, clickCount: 2 });
  const word = await evaluate('String(getSelection())');
  check('a double click selects the word under the pointer', result?.success && word === 'bravo', JSON.stringify({ result, word }));
  const from = await evaluateJson("wordPoint('alpha', 'start')");
  const to = await evaluateJson("wordPoint('charlie', 'end')");
  result = await vision({ type: 'drag', x: from.x, y: from.y, toX: to.x, toY: to.y, steps: 6 });
  const dragged = await evaluate('String(getSelection())');
  check('a drag across text selects it', result?.success && /^alpha bravo charli/.test(dragged), JSON.stringify({ result, dragged }));
  await evaluate('getSelection().removeAllRanges()');

  // 6. A wheel scrolls the box under the pointer.
  result = await vision({ type: 'wheel', x: 120, y: 430, deltaY: 200 });
  const scrolled = await evaluate("document.getElementById('scroller').scrollTop");
  check('a wheel scrolls the box under the pointer', result?.success && result.moved === true && Math.abs(scrolled - 200) <= 1, JSON.stringify({ result, scrolled }));

  // 7. A scaled same-origin frame takes the click where it is drawn.
  result = await vision({ type: 'click', x: 400 + (3 + 250) * 0.5, y: 300 + (3 + 120) * 0.5 });
  const frameLog = await evaluateJson("document.getElementById('scaled').contentWindow.log.splice(0)");
  check('a click in a scale(0.5) frame lands on the drawn button',
    result?.success && JSON.stringify(frameLog) === JSON.stringify([['click', 250, 120]]), JSON.stringify({ result, frameLog }));

  // 8. Another origin's frame is refused instead of clicked at its element.
  result = await vision({ type: 'click', x: 800, y: 150 });
  check('a click on a cross-origin frame is refused',
    result?.visionInputRefused === 'opaque_frame' && result?.noDispatch === true, JSON.stringify(result));

  // 9. Trusted input: the content script marks the element at the point and
  // the companion session moves (and for a click presses) the real pointer there.
  // Playwright's Firefox build answers browsingContext.locateNodes with no
  // node at all. There the marked node is found by script instead, exactly
  // one in the frames at the binding's URL as BidiSession.locate requires;
  // every other step is the production session's.
  const locator = await session.send('browsingContext.locateNodes', { context, locator: { type: 'css', value: 'html' } });
  if (!locator.nodes?.length) {
    locatedByScript = true;
    session.locate = async (token, targetUrl, root = null) => {
      if (!/^[a-f0-9-]{36}$/.test(token) || !/^https?:\/\//.test(targetUrl)) throw new Error('Invalid tab binding');
      const tree = await session.send('browsingContext.getTree', root ? { root } : {});
      const contexts = [];
      const visit = nodes => { for (const node of nodes || []) { contexts.push(node); visit(node.children); } };
      visit(tree.contexts);
      const matches = [];
      for (const frame of contexts) {
        if (frame.url !== targetUrl) continue;
        const found = await session.send('script.evaluate', { target: { context: frame.context }, awaitPromise: false,
          expression: `(() => { const nodes = document.querySelectorAll('[data-webbrain-bidi="${token}"]'); return nodes.length === 1 ? nodes[0] : nodes.length; })()` });
        if (found.result?.sharedId) matches.push({ context: frame.context, node: { sharedId: found.result.sharedId } });
        else if (found.result?.value > 1) matches.push(null, null);
      }
      if (matches.length !== 1) throw new Error('Tab or element binding is stale or ambiguous; re-read the page');
      return matches[0];
    };
  }
  const bindToken = crypto.randomUUID();
  await evaluate(`document.documentElement.setAttribute('data-webbrain-bidi', ${JSON.stringify(bindToken)})`);
  const runId = crypto.randomUUID();
  await session.openRun(runId, bindToken, url);
  const trustedLog = async () => evaluateJson('window.trusted.splice(0)');
  const perform = (action, payload) => session.perform(runId, action, payload)
    .catch(error => ({ success: false, error: error.message, ...error.dispatchState }));
  await trustedLog();
  const markedToken = () => evaluate(`document.querySelector('[data-webbrain-bidi]')?.getAttribute('data-webbrain-bidi') || null`);
  let prepared = await vision({ type: 'click', x: 760.4, y: 269.6, _bidiPrepare: crypto.randomUUID() });
  const clickToken = await evaluate(`document.getElementById('trust').getAttribute('data-webbrain-bidi')`);
  check('the content script marks the element at a trusted click point', prepared?.bidiPrepared === true && prepared?.noDispatch === true
    && JSON.stringify(prepared.point) === JSON.stringify({ x: 760, y: 270 }) && typeof clickToken === 'string' && /^fpg_/.test(prepared._filePickerGuardId || ''), JSON.stringify({ prepared, clickToken }));
  check('preparing sends nothing to the page', (await trustedLog()).length === 0);
  result = await perform('click_at', { token: clickToken, url: prepared.url, point: prepared.point });
  const clicked = await trustedLog();
  check('click_at is one trusted press and click at the point', result?.success === true
    && JSON.stringify(clicked) === JSON.stringify([['pointerdown', true, 760, 270, 'trust'], ['click', true, 760, 270, 'trust']]), JSON.stringify({ result, clicked }));
  // The companion checks the marked element is still the one at the point.
  prepared = await vision({ type: 'click', x: 760, y: 270, _bidiPrepare: crypto.randomUUID() });
  const staleToken = await markedToken();
  const refusal = await perform('click_at', { token: staleToken, url: prepared.url, point: { x: 120, y: 40 } });
  check('a point that no longer hits the marked element sends nothing', refusal?.success === false && refusal.noDispatch === true
    && (await trustedLog()).length === 0, JSON.stringify(refusal));
  // A trusted hover is the browser's own :hover, with no emulation.
  prepared = await vision({ type: 'hover', x: 120, y: 40, _bidiPrepare: crypto.randomUUID() });
  const hoverToken = await markedToken();
  result = await perform('hover_at', { token: hoverToken, url: prepared.url, point: prepared.point });
  const realHover = await evaluateJson(`({ submenu: getComputedStyle(document.querySelector('#menu .submenu')).display,
    emulated: document.querySelectorAll('[data-webbrain-hover]').length, matches: document.getElementById('menu').matches(':hover') })`);
  check('hover_at opens a CSS :hover menu through the real :hover', result?.success === true && realHover.submenu === 'block'
    && realHover.emulated === 0 && realHover.matches === true, JSON.stringify({ result, realHover }));
  await session.closeRun(runId);
} catch (error) {
  check('harness', false, error?.stack || error);
} finally {
  try { await session?.send('browser.close', {}); } catch { /* already gone */ }
  await session?.close?.().catch(() => {});
  await new Promise(resolve => { if (firefox.exitCode != null) resolve(); else { firefox.once('exit', resolve); setTimeout(resolve, 3000); } });
  if (firefox.exitCode == null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(firefox.pid), '/T', '/F']);
    else firefox.kill('SIGKILL');
    await delay(500);
  }
  server.close();
  const ownedProfile = await assertOwnedProfile();
  await rm(ownedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const failed = results.filter(item => !item.ok);
if (failed.length) {
  console.error(JSON.stringify(failed, null, 1));
  console.error(`FAIL: ${failed.length} of ${results.length} Firefox vision input checks`);
  process.exitCode = 1;
} else {
  console.log(`PASS: ${results.length} Firefox vision input checks (CSS :hover and its restore, pointer capture, react-aria press, range track click, word and drag text selection, wheel, scaled frame click, cross-origin frame refusal; trusted click_at and hover_at through the companion session${locatedByScript ? ', its marked node found by script' : ''})`);
}
