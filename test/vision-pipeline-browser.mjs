// Vision mode capture pipeline in real Chromium at device pixel ratios 1, 2
// and 3, on a scrolled page and with an element changing: the planned image
// size is what the model receives, a point mapped image → CSS hits the
// element it shows, trusted pointer events land there, and the diff finds
// exactly the changed control. Browser zoom runs through the extension in
// test/quality/vision-mode-mv3.mjs (chrome.tabs.setZoom). Uses the same CDP calls as the extension's
// _visionPlatformCapture / _visionDispatchClick and the shared modules.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const AGENT_DIR = path.join(ROOT, 'src/chrome/src/agent');

const FIXTURE = `<!doctype html><meta charset="utf-8"><title>Vision fixture</title>
<style>
  body { margin: 0; font: 16px sans-serif; background: #fff; }
  .spacer { height: 600px; background: linear-gradient(#fff, #eef); }
  #target { position: absolute; left: 240px; top: 760px; width: 180px; height: 48px; background: rgb(20, 120, 220); color: #fff; border: 0; }
  #other { position: absolute; left: 700px; top: 900px; width: 120px; height: 40px; background: rgb(220, 60, 40); color: #fff; border: 0; }
  #status { position: absolute; left: 240px; top: 840px; width: 360px; height: 24px; }
  .tall { height: 2400px; }
</style>
<div class="spacer"></div><div class="tall"></div>
<button id="target">Target</button><button id="other">Other</button><div id="status"></div>
<script>
  window.clicks = [];
  for (const id of ['target', 'other']) document.getElementById(id).addEventListener('click', event => {
    window.clicks.push({ id, trusted: event.isTrusted, x: event.clientX, y: event.clientY });
    document.getElementById('status').textContent = id + ' clicked ' + window.clicks.length;
  });
</script>`;

// A right-to-left page wider than the window opens scrolled to its right end.
const RTL_FIXTURE = `<!doctype html><html dir="rtl"><meta charset="utf-8"><title>RTL fixture</title>
<style>
  body { margin: 0; width: 3000px; height: 3000px; background: #fff; }
  #start { position: fixed; left: 0; top: 0; width: 60px; height: 60px; background: rgb(0, 200, 0); }
  #end { position: fixed; right: 0; top: 0; width: 60px; height: 60px; background: rgb(200, 0, 200); }
</style>
<div id="start"></div><div id="end"></div></html>`;

function serve() {
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/agent/')) {
      const file = path.join(AGENT_DIR, path.basename(request.url));
      if (!file.startsWith(AGENT_DIR) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(fs.readFileSync(file));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.url === '/rtl' ? RTL_FIXTURE : FIXTURE);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const server = await serve();
const origin = `http://127.0.0.1:${server.address().port}`;
test.after(() => new Promise(resolve => server.close(resolve)));

for (const dpr of [1, 2, 3]) {
  test(`DPR ${dpr}: planned size, exact mapping, trusted clicks and diffs on a scrolled page`, async () => {
    // No viewport emulation: --force-device-scale-factor is what a retina
    // screen looks like to Chrome (page DPR and compositor scale agree).
    const browser = await chromium.launch({ channel: 'chromium', args: [`--force-device-scale-factor=${dpr}`, '--window-size=1280,860'] });
    try {
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      await page.goto(`${origin}/fixture`);
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const cdp = await context.newCDPSession(page);
      const pageDpr = await page.evaluate(() => devicePixelRatio);
      assert.equal(pageDpr, dpr, 'the page sees the forced device pixel ratio');

      // Probe exactly like _visionPlatformProbe.
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const probe = {
        cssWidth: metrics.cssVisualViewport.clientWidth,
        cssHeight: metrics.cssVisualViewport.clientHeight,
        scrollX: metrics.cssVisualViewport.pageX,
        scrollY: metrics.cssVisualViewport.pageY,
        devicePixelRatio: pageDpr,
      };
      assert.equal(probe.scrollY, 600);

      const plan = await page.evaluate(async ({ probe }) => {
        const budget = await import('/agent/vision-budget.js');
        return budget.planVisionImageSize({ cssWidth: probe.cssWidth, cssHeight: probe.cssHeight, profile: budget.VISION_PROFILES.anthropic, quality: 'economy' });
      }, { probe });
      assert.ok(plan.width < probe.cssWidth, `economy downscales: ${JSON.stringify(plan)} for ${probe.cssWidth}`);

      // Capture exactly like _visionPlatformCapture: the surface as it is on
      // screen, the visual viewport cut out of it and scaled to the plan.
      const capture = async () => {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90, fromSurface: true });
        return page.evaluate(async ({ data, plan, probe }) => {
          const encoder = await import('/agent/vision-encoder.js');
          const dpr = probe.devicePixelRatio;
          return encoder.cropImage(`data:image/jpeg;base64,${data}`,
            { x: 0, y: 0, width: probe.cssWidth * dpr, height: probe.cssHeight * dpr }, plan.width, plan.height);
        }, { data: shot.data, plan, probe });
      };
      const first = await capture();
      const analysis = await page.evaluate(async ({ dataUrl, plan, probe }) => {
        const encoder = await import('/agent/vision-encoder.js');
        const raster = await encoder.rasterizeFrame(dataUrl, plan.width, plan.height);
        window.__visionFirst = raster.pixels;
        // A point on the target button (left of its label) in CSS px → image px.
        const rect = document.getElementById('target').getBoundingClientRect();
        const centre = { x: rect.left + 14, y: rect.top + 12 };
        const img = { x: Math.round(centre.x * plan.width / probe.cssWidth), y: Math.round(centre.y * plan.height / probe.cssHeight) };
        const i = (img.y * plan.width + img.x) * 4;
        const webp = await encoder.encodeCanvasRegion(raster.canvas, null, { mimeType: 'image/webp', quality: 0.8 });
        const jpeg = await encoder.encodeCanvasRegion(raster.canvas, null, { mimeType: 'image/jpeg', quality: 0.8 });
        return {
          decoded: { width: raster.sourceWidth, height: raster.sourceHeight },
          size: { width: raster.width, height: raster.height },
          img,
          rgb: [raster.pixels[i], raster.pixels[i + 1], raster.pixels[i + 2]],
          webp: { bytes: webp.bytes, mime: webp.mimeType, width: webp.width },
          jpeg: { bytes: jpeg.bytes, mime: jpeg.mimeType },
        };
      }, { dataUrl: first, plan, probe });
      // The crop came back at the planned size.
      assert.deepEqual(analysis.size, { width: plan.width, height: plan.height });
      assert.deepEqual(analysis.decoded, { width: plan.width, height: plan.height });
      // The pixel at the mapped point is the blue target, not white page: the
      // surface shows the scrolled viewport, from its top left.
      const [r, g, b] = analysis.rgb;
      assert.ok(b > 180 && r < 80 && g > 80 && g < 170, `mapped pixel is the target button: ${analysis.rgb}`);
      assert.equal(analysis.webp.mime, 'image/webp');
      assert.ok(analysis.webp.bytes < analysis.jpeg.bytes, `WebP is smaller than JPEG (${analysis.webp.bytes} vs ${analysis.jpeg.bytes})`);

      // Model point (image px) → CSS like VisionSession, then a trusted click
      // exactly like _visionDispatchClick.
      const css = { x: analysis.img.x * probe.cssWidth / plan.width, y: analysis.img.y * probe.cssHeight / plan.height };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: css.x, y: css.y, button: 'none', buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: css.x, y: css.y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: css.x, y: css.y, button: 'left', buttons: 0, clickCount: 1 });
      const clicks = await page.evaluate(() => window.clicks);
      assert.equal(clicks.length, 1);
      assert.equal(clicks[0].id, 'target');
      assert.equal(clicks[0].trusted, true);
      assert.ok(Math.abs(clicks[0].x - css.x) <= 1 && Math.abs(clicks[0].y - css.y) <= 1, 'the event carries the exact point');

      // The status line changed; the diff finds that one region.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const second = await capture();
      const change = await page.evaluate(async ({ dataUrl, plan, probe }) => {
        const encoder = await import('/agent/vision-encoder.js');
        const diff = await import('/agent/vision-diff.js');
        const raster = await encoder.rasterizeFrame(dataUrl, plan.width, plan.height);
        const result = diff.diffFrames(window.__visionFirst, raster.pixels, plan.width, plan.height);
        const status = document.getElementById('status').getBoundingClientRect();
        const update = diff.planFrameUpdate(result, { width: plan.width, height: plan.height });
        return {
          regions: result.regions,
          ratio: result.regionAreaRatio,
          kind: update.kind,
          status: { x: status.left * plan.width / probe.cssWidth, y: status.top * plan.height / probe.cssHeight, w: status.width * plan.width / probe.cssWidth },
        };
      }, { dataUrl: second, plan, probe });
      assert.equal(change.kind, 'patch', JSON.stringify(change));
      assert.ok(change.ratio < 0.1, `the patch is a small part of the frame: ${change.ratio}`);
      assert.ok(change.regions.some(region => region.x <= change.status.x + 2 && region.y <= change.status.y + 2
        && region.y + region.height >= change.status.y + 8), `a region covers the status line: ${JSON.stringify(change)}`);
    } finally {
      await browser.close();
    }
  });
}

test('a vision capture leaves the tab on screen as it is, where a clipped capture shrinks it', async () => {
  // DPR 2, where the clip's scale is smallest. The screencast reports every
  // frame the tab shows; an animation keeps them coming during captures.
  const browser = await chromium.launch({ channel: 'chromium', args: ['--force-device-scale-factor=2', '--window-size=1280,860'] });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><style>body { margin: 0; height: 3000px; }
      #spin { position: fixed; left: 300px; top: 200px; width: 40px; height: 40px; background: #c0c; animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }</style><div id="spin"></div>`);
    await page.evaluate(() => window.scrollTo(0, 400));
    const cdp = await context.newCDPSession(page);
    const { cssVisualViewport: vv } = await cdp.send('Page.getLayoutMetrics');
    const frames = [];
    cdp.on('Page.screencastFrame', frame => {
      const png = Buffer.from(frame.data, 'base64');
      frames.push(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)} image, ${frame.metadata.deviceWidth}x${frame.metadata.deviceHeight} view`);
      cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    // Frames arrive slower on a loaded machine: wait for a few, bounded.
    const awaitFrames = async (count, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      while (frames.length < count && Date.now() < deadline) await page.waitForTimeout(50);
      assert.ok(frames.length >= count, `the screencast sent ${frames.length} frames`);
    };
    await awaitFrames(3);
    const onScreen = [...new Set(frames)];
    assert.equal(onScreen.length, 1, onScreen.join('; '));
    // Like _visionPlatformCapture: no clip. Every frame shown during and
    // after the captures keeps the tab's size and scale.
    frames.length = 0;
    for (let i = 0; i < 3; i++) await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90, fromSurface: true });
    await awaitFrames(3);
    assert.deepEqual([...new Set(frames)], onScreen, 'the tab keeps its size and scale through the captures');
    // The capture before: Chromium resizes the view to the clip's scaled size
    // and renders the page into it, which the screen shows.
    const clip = { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale: 1024 / (vv.clientWidth * 2) };
    const seen = [];
    for (let i = 0; i < 6 && !seen.some(size => size !== onScreen[0]); i++) {
      frames.length = 0;
      await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90, fromSurface: true, clip });
      await awaitFrames(2);
      seen.push(...frames);
    }
    assert.ok(seen.some(size => size !== onScreen[0]), `a clipped capture is seen on screen: ${[...new Set(seen)].join('; ')}`);
  } finally {
    await browser.close();
  }
});

test('a vision capture of a right-to-left page wider than the window shows the screen, scrollbar left out', async () => {
  // Classic scrollbars, as on Windows and Linux. Chromium keeps the page's
  // own on the right in RTL too, so the surface's left edge is CSS x 0.
  const browser = await chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--window-size=1000,700'] });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(`${origin}/rtl`);
    // Reserve classic-scrollbar layout space even with macOS overlay scrollbars.
    await page.addStyleTag({ content: '::-webkit-scrollbar { width: 16px; height: 16px; }' });
    const cdp = await context.newCDPSession(page);
    const { cssVisualViewport: vv } = await cdp.send('Page.getLayoutMetrics');
    const scrollbar = await page.evaluate(() => innerWidth - document.documentElement.clientWidth);
    assert.ok(scrollbar > 0, 'the page has a classic scrollbar');
    assert.equal(vv.clientWidth, await page.evaluate(() => document.documentElement.clientWidth));
    // Like _visionPlatformCapture, at one image pixel per CSS pixel.
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90, fromSurface: true });
    const result = await page.evaluate(async ({ data, vv }) => {
      const encoder = await import('/agent/vision-encoder.js');
      const dataUrl = await encoder.cropImage(`data:image/jpeg;base64,${data}`, { x: 0, y: 0, width: vv.clientWidth, height: vv.clientHeight }, vv.clientWidth, vv.clientHeight);
      const raster = await encoder.rasterizeFrame(dataUrl, vv.clientWidth, vv.clientHeight);
      const at = x => Array.from(raster.pixels.slice((30 * raster.width + x) * 4, (30 * raster.width + x) * 4 + 3));
      return { width: raster.width, start: at(30), end: at(raster.width - 30), right: at(raster.width - 1) };
    }, { data: shot.data, vv });
    const near = (rgb, expected) => rgb.every((value, i) => Math.abs(value - expected[i]) < 40);
    assert.ok(near(result.start, [0, 200, 0]), `the page's left edge: ${result.start}`);
    assert.ok(near(result.end, [200, 0, 200]), `its right edge: ${result.end}`);
    assert.ok(near(result.right, [200, 0, 200]), `the image ends where the page does, before the scrollbar: ${result.right}`);
  } finally {
    await browser.close();
  }
});

test('screenshot redaction pixelates every region, or returns the image untouched when one region cannot be', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/fixture`);
    const result = await page.evaluate(async () => {
      const { pixelateDataUrl } = await import('/agent/screenshot-redaction.js');
      const canvas = new OffscreenCanvas(200, 100);
      const context = canvas.getContext('2d');
      // Fine stripes: pixelation averages them away.
      for (let x = 0; x < 200; x += 2) { context.fillStyle = x % 4 ? '#000' : '#fff'; context.fillRect(x, 0, 2, 100); }
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const dataUrl = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
      const regions = [{ rect: { x: 0, y: 0, w: 60, h: 40 } }, { rect: { x: 100, y: 40, w: 60, h: 40 } }];
      const redacted = await pixelateDataUrl(dataUrl, regions);
      // The second region's scratch canvas cannot draw.
      const getContext = OffscreenCanvas.prototype.getContext;
      let scratch = 0;
      OffscreenCanvas.prototype.getContext = function (...args) {
        if (this.width < 50 && ++scratch === 2) return null;
        return getContext.apply(this, args);
      };
      const partial = await pixelateDataUrl(dataUrl, regions);
      OffscreenCanvas.prototype.getContext = getContext;
      return { changed: redacted !== dataUrl, untouched: partial === dataUrl, scratch };
    });
    assert.equal(result.changed, true, 'both regions pixelated');
    assert.equal(result.scratch, 2, 'the failure hit the second region');
    assert.equal(result.untouched, true, 'a region left sharp fails the whole redaction');
  } finally {
    await browser.close();
  }
});

test('content-script vision input (Firefox path) clicks, double-clicks, focuses, scrolls and drags at the exact point', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<!doctype html><style>body{margin:0}#box{position:absolute;left:100px;top:100px;width:200px;height:80px;background:#08f}
      #field{position:absolute;left:100px;top:220px;width:300px;height:30px}#pane{position:absolute;left:500px;top:100px;width:300px;height:200px;overflow:auto}
      #slider{position:absolute;left:100px;top:320px;width:400px;height:30px;background:#ddd}</style>
      <div id="box"></div><input id="field" value="hello world"><div id="pane"><div style="height:2000px">pane</div></div><div id="slider"></div>
      <script>window.log=[];for(const t of ['mousedown','mouseup','click','dblclick','contextmenu'])document.getElementById('box').addEventListener(t,e=>log.push([t,e.clientX,e.clientY,e.detail,e.button]));
      const s=document.getElementById('slider');let drag=null;s.addEventListener('mousedown',e=>drag={x:e.clientX});document.addEventListener('mousemove',e=>{if(drag)window.dragTo=e.clientX});document.addEventListener('mouseup',()=>{drag=null;window.dragDone=true});</script>`);
    // Load the exact content-script function bodies from content.js.
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const start = source.indexOf('  function _visionTargetAt(');
    const end = source.indexOf('  let _lastClickIdent = null;');
    assert.ok(start > 0 && end > start, 'vision input block present in the Firefox content script');
    const block = source.slice(start, end);
    // The native file-chooser guard every agent click runs inside.
    const guardStart = source.indexOf('  function uniqueFileInputSelector(input) {');
    const guardEnd = source.indexOf('  /**\n   * Click an element by selector or coordinates.');
    assert.ok(guardStart > 0 && guardEnd > guardStart, 'file-chooser guard block present in the Firefox content script');
    const guardBlock = source.slice(guardStart, guardEnd);
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      const content = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn { visionInput, consumeFilePickerGuard };`)();
      window.__visionInput = content.visionInput;
      window.__consumeFilePickerGuard = content.consumeFilePickerGuard;
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    let result = await run({ type: 'click', x: 150, y: 130 });
    assert.equal(result.success, true);
    result = await run({ type: 'click', x: 160, y: 140, clickCount: 2 });
    assert.equal(result.clicks, 2);
    result = await run({ type: 'click', x: 170, y: 150, button: 'right' });
    const log = await page.evaluate(() => window.log);
    assert.deepEqual(log[0], ['mousedown', 150, 130, 1, 0]);
    assert.ok(log.some(entry => entry[0] === 'dblclick'));
    assert.ok(log.some(entry => entry[0] === 'contextmenu' && entry[4] === 2));
    // A press focuses the field under it; three clicks select its text.
    await run({ type: 'click', x: 150, y: 235, clickCount: 3 });
    const focus = await page.evaluate(() => ({ active: document.activeElement.id, selected: document.activeElement.selectionEnd - document.activeElement.selectionStart }));
    assert.deepEqual(focus, { active: 'field', selected: 11 });
    // The wheel scrolls the pane under the point, not the page.
    result = await run({ type: 'wheel', x: 600, y: 200, deltaY: 300 });
    assert.equal(result.moved, true);
    assert.equal(await page.evaluate(() => document.getElementById('pane').scrollTop), 300);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    // A drag moves the pressed pointer to the end point.
    result = await run({ type: 'drag', x: 120, y: 335, toX: 420, toY: 335, steps: 6 });
    assert.equal(result.success, true);
    assert.deepEqual(await page.evaluate(() => [window.dragTo, window.dragDone]), [420, true]);
    // Points outside the viewport are refused without dispatch.
    result = await run({ type: 'click', x: 5000, y: 10 });
    assert.equal(result.noDispatch, true);
  } finally {
    await browser.close();
  }
});

test('content-script vision input (Firefox path) honours a pointerdown the page cancels, as a browser does', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<!doctype html><style>body{margin:0;font:20px monospace}
      #range{position:absolute;left:20px;top:20px;width:300px;height:20px;margin:0}
      #field{position:absolute;left:20px;top:80px;width:300px;height:30px}
      #words{position:absolute;left:20px;top:150px;margin:0;white-space:nowrap}
      #pad{position:absolute;left:20px;top:220px;width:400px;height:60px;background:#ddd}</style>
      <input id="range" type="range" min="0" max="100" step="5" value="10"><input id="field" value="hello">
      <p id="words">alpha bravo charlie</p><div id="pad"></div>
      <script>window.log=[];window.cancel=new Set(['range','field','words','pad']);
      document.addEventListener('pointerdown',e=>{if(cancel.has(e.target.id))e.preventDefault();},true);
      for(const t of ['pointerdown','mousedown','pointermove','mousemove','mouseover','pointerup','mouseup','click','dblclick','input','change'])
        document.addEventListener(t,e=>{if(e.target.id)log.push(t+':'+e.target.id)},true);</script>`);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    const take = () => page.evaluate(() => window.log.splice(0));
    const bravo = await page.evaluate(() => { const text = document.getElementById('words').firstChild; const r = document.createRange();
      r.setStart(text, 6); r.setEnd(text, 11); const b = r.getBoundingClientRect(); return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }; });

    // A click on a range track: no thumb moves and no compatibility mouse
    // events, but the click still fires.
    let result = await run({ type: 'click', x: 170, y: 30 });
    assert.equal(result.success, true);
    assert.equal(result.rangeValue, undefined);
    assert.equal(await page.evaluate(() => document.getElementById('range').value), '10');
    let log = await take();
    assert.ok(log.includes('pointerdown:range') && log.includes('pointerup:range') && log.includes('click:range'), log.join());
    assert.ok(!log.some(entry => /^(mousedown|mouseup|input|change):/.test(entry)), log.join());
    // A click in a text field: no focus.
    await run({ type: 'click', x: 100, y: 95 });
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'field');
    await take();
    // A double click on a word: dblclick fires, but no word is selected.
    await page.evaluate(() => getSelection().removeAllRanges());
    result = await run({ type: 'click', x: bravo.x, y: bravo.y, clickCount: 2 });
    log = await take();
    assert.ok(log.includes('dblclick:words'), log.join());
    assert.equal(await page.evaluate(() => String(getSelection())), '');
    // A drag: pointer moves and the release go out, no mousemove or mouseup,
    // the boundary mouseover still does, and no text is selected.
    result = await run({ type: 'drag', x: 30, y: 250, toX: 380, toY: 250, steps: 4 });
    log = await take();
    assert.equal(result.success, true);
    const pressed = log.slice(log.indexOf('pointerdown:pad'));
    assert.ok(pressed.filter(entry => entry === 'pointermove:pad').length >= 4, log.join());
    assert.ok(pressed.includes('pointerup:pad'), log.join());
    assert.ok(!pressed.some(entry => /^(mousedown|mousemove|mouseup):pad$/.test(entry)), log.join());
    // The same sequences on presses the page lets through are unchanged.
    await page.evaluate(() => window.cancel.clear());
    result = await run({ type: 'click', x: 170, y: 30 });
    assert.equal(result.rangeValue, '50');
    log = await take();
    assert.ok(log.includes('mousedown:range') && log.includes('mouseup:range'), log.join());
    result = await run({ type: 'drag', x: 30, y: 250, toX: 380, toY: 250, steps: 4 });
    log = await take();
    assert.ok(log.includes('mousemove:pad') && log.includes('mouseup:pad'), log.join());
    await run({ type: 'click', x: bravo.x, y: bravo.y, clickCount: 2 });
    assert.equal(await page.evaluate(() => String(getSelection())), 'bravo');
  } finally {
    await browser.close();
  }
});

test('content-script vision input (Firefox path) marks the element at the point for trusted input, after its checks', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<!doctype html><style>body{margin:0}button,iframe,#host{position:absolute;margin:0;border:0}
      #go{left:100px;top:100px;width:200px;height:60px}#off{left:400px;top:100px;width:200px;height:60px}
      #frame{left:100px;top:300px;width:300px;height:150px}#host{left:500px;top:300px;width:200px;height:80px}</style>
      <button id="go">Go</button><button id="off" disabled>Off</button>
      <iframe id="frame" srcdoc="<button style='width:100%;height:100%'>Inside</button>"></iframe><div id="host"></div>
      <script>window.log=[];for(const t of ['pointerover','pointerdown','mousedown','mouseup','click','wheel'])document.addEventListener(t,e=>log.push(t),true);
      const root=document.getElementById('host').attachShadow({mode:'open'});root.innerHTML='<span id="inner" style="display:block;width:200px;height:80px">In</span>';</script>`);
    await page.waitForFunction(() => document.getElementById('frame').contentDocument?.querySelector('button'));
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    const token = '0b8d6f43-6c3a-4c43-9d0e-5b5b0f7f4c21';
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    const marked = () => page.evaluate(t => [...document.querySelectorAll(`[data-webbrain-bidi="${t}"]`)].map(el => el.id), token);
    const clear = () => page.evaluate(() => { for (const el of document.querySelectorAll('[data-webbrain-bidi]')) el.removeAttribute('data-webbrain-bidi'); window.log.length = 0; });

    // A click: the element at the point is marked, the guard armed, and nothing synthetic is sent.
    let result = await run({ type: 'click', x: 150.6, y: 120.2, _bidiPrepare: token });
    assert.equal(result.bidiPrepared, true);
    assert.equal(result.noDispatch, true);
    assert.deepEqual(result.point, { x: 151, y: 120 });
    assert.deepEqual(result.target, { tag: 'button' });
    assert.match(result._filePickerGuardId, /^fpg_/);
    assert.equal(result.url, await page.evaluate(() => location.href));
    assert.deepEqual(await marked(), ['go']);
    assert.deepEqual(await page.evaluate(() => window.log), [], 'no synthetic event');
    await clear();
    // A hover is marked too, and arms no file-chooser guard.
    result = await run({ type: 'hover', x: 150, y: 120, _bidiPrepare: token });
    assert.equal(result.bidiPrepared, true);
    assert.equal(result._filePickerGuardId, undefined);
    await clear();
    // A point inside an open shadow root stays with the synthetic sequence:
    // the monitor binds the host, but the events come from inside it.
    result = await run({ type: 'click', x: 600, y: 340, _bidiPrepare: token });
    assert.equal(result.bidiUnavailable, true);
    assert.deepEqual(await page.evaluate(() => document.querySelectorAll('[data-webbrain-bidi]').length
      + document.getElementById('host').shadowRoot.querySelectorAll('[data-webbrain-bidi]').length), 0);
    await clear();
    // The synthetic sequence's checks come first: a disabled control is refused.
    result = await run({ type: 'click', x: 500, y: 120, _bidiPrepare: token });
    assert.equal(result.visionInputRefused, 'disabled_control');
    assert.deepEqual(await marked(), []);
    // A point over an embedded frame stays with the synthetic sequence.
    result = await run({ type: 'click', x: 250, y: 375, _bidiPrepare: token });
    assert.equal(result.bidiUnavailable, true);
    assert.deepEqual(await marked(), []);
    // A drag or a wheel is never prepared, and a malformed binding marks nothing.
    for (const params of [{ type: 'drag', x: 150, y: 120, toX: 250, toY: 120 }, { type: 'wheel', x: 150, y: 120, deltaY: 100 }]) {
      result = await run({ ...params, _bidiPrepare: token });
      assert.equal(result.noDispatch, true, params.type);
      assert.equal(result.bidiPrepared, undefined, params.type);
    }
    result = await run({ type: 'click', x: 150, y: 120, _bidiPrepare: 'not-a-token' });
    assert.equal(result.noDispatch, true);
    assert.deepEqual(await page.evaluate(() => document.querySelectorAll('[data-webbrain-bidi]').length), 0);
    assert.deepEqual(await page.evaluate(() => window.log), [], 'still no synthetic event');
  } finally {
    await browser.close();
  }
});

test('content-script vision drag (Firefox path) moves and releases in a same-origin frame\'s own coordinates', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    // A slider inside a same-origin frame at (500, 400) of the page, with a 2 px frame border.
    const frame = `<style>body{margin:0}#s{position:absolute;left:20px;top:20px;width:300px;height:30px;background:#ddd}</style><div id="s"></div>
      <script>window.events=[];const s=document.getElementById('s');let down=false;
      s.addEventListener('mousedown',e=>{down=true;events.push(['down',e.clientX,e.clientY])});
      document.addEventListener('mousemove',e=>{if(down)events.push(['move',e.clientX,e.clientY])});
      document.addEventListener('pointerup',e=>events.push(['pointerup',e.clientX,e.clientY]));
      document.addEventListener('mouseup',e=>{down=false;events.push(['up',e.clientX,e.clientY])});<\/script>`;
    await page.setContent(`<!doctype html><style>body{margin:0}iframe{position:absolute;left:500px;top:400px;width:400px;height:150px;border:2px solid #000}</style>
      <iframe srcdoc="${frame.replace(/"/g, '&quot;')}"></iframe>`);
    await page.waitForFunction(() => document.querySelector('iframe').contentWindow?.events);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    // Page point (532, 437) is frame point (30, 35): 500 + 2 border + 30.
    const result = await page.evaluate(p => window.__visionInput(p), { type: 'drag', x: 532, y: 437, toX: 782, toY: 437, steps: 5 });
    assert.equal(result.success, true, JSON.stringify(result));
    const events = await page.evaluate(() => document.querySelector('iframe').contentWindow.events);
    const moves = events.filter(event => event[0] === 'move');
    const up = events.find(event => event[0] === 'up');
    const pointerUp = events.find(event => event[0] === 'pointerup');
    assert.deepEqual(events[0], ['down', 30, 35], JSON.stringify(events));
    assert.deepEqual(moves.at(-1), ['move', 280, 35], JSON.stringify(events));
    assert.deepEqual(up, ['up', 280, 35], `the release is where the last move was, in frame coordinates: ${JSON.stringify(events)}`);
    assert.deepEqual(pointerUp, ['pointerup', 280, 35], JSON.stringify(events));
  } finally {
    await browser.close();
  }
});

test('content-script vision drag (Firefox path) moves a native range input like a person\'s drag', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    // Synthetic pointer events never move a native slider by themselves.
    const range = (id, top, extra = '') => `<input id="${id}" type="range" ${extra} style="position:absolute;left:100px;top:${top}px;width:300px;height:20px;margin:0">`;
    const frame = `<style>body{margin:0}</style><input id="inner" type="range" min="0" max="100" value="0" style="position:absolute;left:20px;top:20px;width:200px;height:20px;margin:0">
      <script>window.events=[];for(const t of ['input','change'])document.getElementById('inner').addEventListener(t,e=>events.push([t,e.target.value]));<\/script>`;
    await page.setContent(`<!doctype html><style>body{margin:0}iframe{position:absolute;left:500px;top:300px;width:250px;height:80px;border:2px solid #000}</style>
      ${range('steps', 100, 'min="0" max="100" step="5" value="10"')}${range('rtl', 160, 'min="0" max="10" value="0" dir="rtl"')}
      ${range('off', 220, 'min="0" max="100" value="20" disabled')}${range('held', 280, 'min="0" max="100" value="20"')}
      <fieldset disabled style="margin:0;padding:0;border:0">${range('fenced', 340, 'min="0" max="100" value="20"')}</fieldset>
      <iframe srcdoc="${frame.replace(/"/g, '&quot;')}"></iframe>
      <script>window.events=[];for(const id of ['steps','rtl','off','held','fenced'])for(const t of ['input','change'])document.getElementById(id).addEventListener(t,e=>events.push([id,t,e.target.value]));
      document.getElementById('held').addEventListener('mousedown',e=>e.preventDefault());</script>`);
    await page.waitForFunction(() => document.querySelector('iframe').contentWindow?.events);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    const value = id => page.evaluate(id => document.getElementById(id).value, id);
    const eventsOf = id => page.evaluate(id => window.events.filter(event => event[0] === id).map(event => event.slice(1)), id);
    // The thumb's centre spans x 108–392 (300 px less half a 16 px thumb at
    // each end). From the thumb at 10 to the middle: 50, snapped to steps of 5.
    let result = await run({ type: 'drag', x: 136, y: 110, toX: 250, toY: 110, steps: 6 });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.rangeValue, '50');
    assert.equal(await value('steps'), '50');
    const steps = await eventsOf('steps');
    assert.deepEqual(steps.at(-1), ['change', '50'], JSON.stringify(steps));
    assert.ok(steps.filter(event => event[0] === 'input').length >= 3, `an input event per change: ${JSON.stringify(steps)}`);
    assert.ok(steps.every(event => Number(event[1]) % 5 === 0), JSON.stringify(steps));
    assert.equal(steps.filter(event => event[0] === 'change').length, 1);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'steps', 'the press focuses the slider');
    // Right to left: the minimum is at the right end.
    result = await run({ type: 'drag', x: 392, y: 170, toX: 250, toY: 170, steps: 4 });
    assert.equal(await value('rtl'), '5', JSON.stringify(result));
    // A disabled slider (itself or by its fieldset), or one whose press the
    // page cancels, does not move.
    for (const y of [230, 290, 350]) {
      result = await run({ type: 'drag', x: 160, y, toX: 350, toY: y, steps: 4 });
      assert.equal(result.rangeValue, undefined, JSON.stringify(result));
    }
    assert.deepEqual([await value('off'), await value('held'), await value('fenced')], ['20', '20', '20']);
    assert.deepEqual([await eventsOf('off'), await eventsOf('held'), await eventsOf('fenced')], [[], [], []]);
    // In a same-origin frame the thumb follows the pointer past the frame's
    // edge: frame point (28, 30) is page point (530, 332).
    result = await run({ type: 'drag', x: 530, y: 332, toX: 800, toY: 332, steps: 6 });
    assert.equal(result.rangeValue, '100', JSON.stringify(result));
    const inner = await page.evaluate(() => document.querySelector('iframe').contentWindow.events);
    assert.deepEqual(inner.at(-1), ['change', '100'], JSON.stringify(inner));
  } finally {
    await browser.close();
  }
});

test('content-script vision click (Firefox path) moves a native range input\'s thumb to the point', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const range = (id, top, extra = '') => `<input id="${id}" type="range" ${extra} style="position:absolute;left:100px;top:${top}px;width:300px;height:20px;margin:0">`;
    await page.setContent(`<!doctype html><style>body{margin:0}</style>
      ${range('volume', 100, 'min="0" max="100" step="5" value="10"')}${range('held', 160, 'min="0" max="100" value="20"')}
      <script>window.events=[];for(const id of ['volume','held'])for(const t of ['input','change'])document.getElementById(id).addEventListener(t,e=>events.push([id,t,e.target.value]));
      document.getElementById('held').addEventListener('mousedown',e=>e.preventDefault());</script>`);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    // The middle of the track (the thumb's centre spans x 108-392): 50, an `input` then a `change`.
    let result = await run({ type: 'click', x: 250, y: 110 });
    assert.equal(result.rangeValue, '50', JSON.stringify(result));
    assert.deepEqual(await page.evaluate(() => window.events.splice(0)), [['volume', 'input', '50'], ['volume', 'change', '50']]);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'volume');
    // A press the page cancels moves nothing, and neither does a right click.
    result = await run({ type: 'click', x: 300, y: 170 });
    assert.equal(result.rangeValue, undefined, JSON.stringify(result));
    result = await run({ type: 'click', x: 350, y: 110, button: 'right' });
    assert.equal(result.rangeValue, undefined, JSON.stringify(result));
    assert.deepEqual(await page.evaluate(() => [window.events.splice(0), document.getElementById('volume').value, document.getElementById('held').value]), [[], '50', '20']);
  } finally {
    await browser.close();
  }
});

test('content-script vision drag (Firefox path) selects text like a person\'s drag', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const text = (id, top, body, style = '') => `<p id="${id}" style="position:absolute;left:100px;top:${top}px;margin:0;font:20px monospace;white-space:nowrap;${style}">${body}</p>`;
    await page.setContent(`<!doctype html><style>body{margin:0}</style>
      ${text('para', 100, 'alpha beta gamma delta')}
      <textarea id="area" style="position:absolute;left:100px;top:160px;width:500px;height:40px;font:20px monospace;padding:0;border:0;resize:none;outline:0">one two three four</textarea>
      ${text('noselect', 230, '<span>cannot select this</span>', 'user-select:none')}${text('guarded', 280, 'guarded text here')}
      <a id="link" href="#x" style="position:absolute;left:100px;top:330px;font:20px monospace">link text here</a>
      <script>window.starts=[];document.addEventListener('selectstart',e=>starts.push(e.target.id||e.target.parentNode?.id));
      document.getElementById('guarded').addEventListener('selectstart',e=>e.preventDefault());</script>`);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    // Character boxes of a paragraph's text, from the layout itself.
    const charBox = (id, index) => page.evaluate(({ id, index }) => {
      const node = document.getElementById(id).firstChild;
      const range = document.createRange();
      range.setStart(node, index); range.setEnd(node, index + 1);
      const r = range.getBoundingClientRect();
      return { left: r.left, right: r.right, y: r.top + r.height / 2 };
    }, { id, index });
    // "alpha beta gamma delta": from the left half of "b" (6) to the right half of the last "a" of "gamma" (15).
    const from = await charBox('para', 6);
    const to = await charBox('para', 15);
    let result = await run({ type: 'drag', x: from.left + 2, y: from.y, toX: to.right - 2, toY: to.y, steps: 5 });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(await page.evaluate(() => String(document.getSelection())), 'beta gamma');
    assert.equal(result.selectedChars, 10);
    // In a text field the selection is the field's own, past its edge to its end.
    const width = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.font = '20px monospace'; probe.textContent = 'x'.repeat(20);
      document.body.append(probe); const w = probe.getBoundingClientRect().width / 20; probe.remove(); return w;
    });
    result = await run({ type: 'drag', x: 100 + 4.2 * width, y: 172, toX: 100 + 12.7 * width, toY: 172, steps: 4 });
    assert.deepEqual(await page.evaluate(() => { const a = document.getElementById('area'); return [document.activeElement.id, a.value.slice(a.selectionStart, a.selectionEnd)]; }),
      ['area', 'two three'], JSON.stringify(result));
    result = await run({ type: 'drag', x: 100 + 8.2 * width, y: 172, toX: 900, toY: 172, steps: 4 });
    assert.equal(await page.evaluate(() => { const a = document.getElementById('area'); return a.value.slice(a.selectionStart, a.selectionEnd); }), 'three four');
    // No selection where a person's drag would make none.
    for (const [x, y, label] of [[110, 240, 'user-select: none'], [110, 290, 'selectstart cancelled'], [110, 342, 'a link']]) {
      await page.evaluate(() => { document.activeElement?.blur?.(); document.getSelection().removeAllRanges(); });
      result = await run({ type: 'drag', x, y, toX: x + 150, toY: y, steps: 4 });
      assert.equal(result.selectedChars, undefined, `${label}: ${JSON.stringify(result)}`);
      assert.equal(await page.evaluate(() => String(document.getSelection())), '', label);
    }
    assert.ok((await page.evaluate(() => window.starts)).includes('guarded'), 'the page saw the selectstart it cancelled');
  } finally {
    await browser.close();
  }
});

test('content-script vision clicks (Firefox path) put the caret at the point, double clicks select its word, triple clicks its line', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const font = 'font:20px monospace;padding:0;border:0;margin:0;outline:0';
    await page.setContent(`<!doctype html><style>body{margin:0}</style>
      <input id="one" value="alpha beta gamma" style="position:absolute;left:100px;top:100px;width:400px;height:30px;${font}">
      <textarea id="two" style="position:absolute;left:100px;top:160px;width:500px;height:90px;line-height:30px;resize:none;${font}">first line here
second line there
third</textarea>
      <p id="three" style="position:absolute;left:100px;top:280px;white-space:nowrap;${font}">one two three</p>
      <div id="editor" contenteditable="true" style="position:absolute;left:100px;top:340px;width:400px;white-space:nowrap;${font}">edit this text</div>`);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    const w = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.font = '20px monospace'; probe.textContent = 'x'.repeat(20);
      document.body.append(probe); const width = probe.getBoundingClientRect().width / 20; probe.remove(); return width;
    });
    const fieldSelection = id => page.evaluate(id => { const el = document.getElementById(id); return el.value.slice(el.selectionStart, el.selectionEnd); }, id);
    // One click: the caret goes where the pointer is (between "alpha" and its space), in a field and in editable text.
    await run({ type: 'click', x: 100 + 5.2 * w, y: 115 });
    assert.deepEqual(await page.evaluate(() => { const el = document.getElementById('one'); return [document.activeElement.id, el.selectionStart, el.selectionEnd]; }), ['one', 5, 5]);
    await run({ type: 'click', x: 100 + 9.2 * w, y: 350 });
    assert.deepEqual(await page.evaluate(() => { const s = document.getSelection(); return [document.activeElement.id, s.isCollapsed, s.anchorOffset, s.anchorNode?.parentElement?.id]; }),
      ['editor', true, 9, 'editor'], 'the caret before "text"');
    // "alpha beta gamma": inside "beta", on the right half of its last letter, on the left half of "gamma"'s first.
    for (const [at, word] of [[7.5, 'beta'], [9.8, 'beta'], [11.2, 'gamma']]) {
      await run({ type: 'click', x: 100 + at * w, y: 115, clickCount: 2 });
      assert.equal(await fieldSelection('one'), word, `double click at character ${at}`);
    }
    await run({ type: 'click', x: 100 + 7.5 * w, y: 115, clickCount: 3 });
    assert.equal(await fieldSelection('one'), 'alpha beta gamma', 'a triple click takes the whole input');
    // The textarea's second line (y 190–220): the word, then the line.
    await run({ type: 'click', x: 100 + 8.5 * w, y: 205, clickCount: 2 });
    assert.equal(await fieldSelection('two'), 'line');
    await run({ type: 'click', x: 100 + 8.5 * w, y: 205, clickCount: 3 });
    assert.equal(await fieldSelection('two'), 'second line there');
    // Page text: the left half of "two"'s first letter and the right half of its last.
    const charBox = index => page.evaluate(index => {
      const range = document.createRange();
      const node = document.getElementById('three').firstChild;
      range.setStart(node, index); range.setEnd(node, index + 1);
      const r = range.getBoundingClientRect();
      return { left: r.left, right: r.right, y: r.top + r.height / 2 };
    }, index);
    for (const x of [(await charBox(4)).left + 2, (await charBox(6)).right - 2]) {
      await run({ type: 'click', x, y: (await charBox(4)).y, clickCount: 2 });
      assert.equal(await page.evaluate(() => String(document.getSelection())), 'two', `double click at x=${x}`);
    }
  } finally {
    await browser.close();
  }
});

test('content-script vision input (Firefox path) moves the pointer off one element onto the next like a mouse', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const box = (id, left, top, inner = '') => `<div id="${id}" style="position:absolute;left:${left}px;top:${top}px;width:200px;height:100px;background:#eee">${inner}</div>`;
    // #menu holds #item (at its top left); #drop is a drop zone right of #source.
    await page.setContent(`<!doctype html><style>body{margin:0}#item{position:absolute;left:10px;top:10px;width:80px;height:30px;background:#ccc}</style>
      ${box('menu', 100, 100, '<div id="item"></div>')}${box('other', 400, 100)}${box('drop', 300, 300)}${box('source', 100, 300)}
      <script>window.log=[];for(const id of ['menu','item','other','drop','source'])for(const t of ['mouseover','mouseout','mouseenter','mouseleave','pointerleave'])
        document.getElementById(id).addEventListener(t,e=>{if(e.target===e.currentTarget)log.push([id,t,e.relatedTarget?.id||null,e.buttons])});</script>`);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    // Mouse events only (pointer events come first, in the same shape).
    const take = () => page.evaluate(() => window.log.splice(0).filter(entry => entry[1].startsWith('mouse')).map(entry => entry.slice(0, 3)));
    await run({ type: 'hover', x: 130, y: 120 });
    assert.deepEqual(await take(), [['item', 'mouseover', null], ['item', 'mouseenter', null]], 'the first hover arrives on the item');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-webbrain-hover]').length + document.adoptedStyleSheets.length), 0,
      'a page without :hover rules gets no emulated :hover');
    // Item -> its menu: out of the item, over the menu; no leave or enter on the menu.
    await run({ type: 'hover', x: 250, y: 180 });
    assert.deepEqual(await take(), [['item', 'mouseout', 'menu'], ['item', 'mouseleave', 'menu'], ['menu', 'mouseover', 'item']]);
    // Menu -> another element: the menu is left (a hover menu that closes on mouseleave closes).
    await run({ type: 'hover', x: 500, y: 150 });
    const away = await take();
    assert.deepEqual(away.filter(entry => entry[0] === 'menu'), [['menu', 'mouseout', 'other'], ['menu', 'mouseleave', 'other']]);
    assert.deepEqual(away.filter(entry => entry[0] === 'other'), [['other', 'mouseover', 'menu'], ['other', 'mouseenter', 'menu']]);
    // A click elsewhere leaves it too, and a drag crosses into the drop zone pressed.
    await run({ type: 'click', x: 200, y: 350 });
    assert.ok((await take()).some(entry => entry[0] === 'other' && entry[1] === 'mouseleave'));
    await run({ type: 'drag', x: 200, y: 350, toX: 450, toY: 350, steps: 6 });
    const drag = await page.evaluate(() => window.log.splice(0));
    assert.ok(drag.some(entry => entry[0] === 'source' && entry[1] === 'mouseleave' && entry[2] === 'drop' && entry[3] === 1), JSON.stringify(drag));
    assert.ok(drag.some(entry => entry[0] === 'drop' && entry[1] === 'mouseover' && entry[2] === 'source' && entry[3] === 1), JSON.stringify(drag));
  } finally {
    await browser.close();
  }
});

test('content-script vision hover (Firefox path) reveals what CSS :hover reveals, until the pointer or a person moves on', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    // A CSS-only menu; a :hover selector listed with another (`, .save`) that
    // a later rule overrides; a later rule of equal specificity that wins
    // over :hover; a rule inside @media; a web component styled by
    // :host(:hover) in its shadow root.
    await page.setContent(`<!doctype html><style>body{margin:0}
      #menu{position:absolute;left:100px;top:100px;width:200px;height:40px;background:#ddd}
      #menu .submenu{display:none;position:absolute;left:0;top:40px;width:200px;height:120px;background:#bbb}
      #menu:hover .submenu, .save{display:block}
      .save{position:absolute;left:400px;top:300px;width:100px;height:30px;display:none}
      .btn{position:absolute;left:400px;top:400px;width:100px;height:30px;color:rgb(0, 0, 0)}
      .btn:hover{color:rgb(255, 0, 0)}
      .btn.on{color:rgb(0, 0, 255)}
      #wide{position:absolute;left:400px;top:100px;width:200px;height:40px;background:#ddd}
      @media (min-width: 600px) { #wide:hover { outline: 3px solid rgb(255, 0, 0); } }
      #away{position:absolute;left:100px;top:400px;width:200px;height:40px}</style>
      <div id="menu">Menu<div class="submenu"><a id="item" href="#item">Item</a></div></div>
      <div class="save" id="save">Save</div><div class="btn on" id="btn">Button</div>
      <div id="wide">Wide</div><x-tip style="position:absolute;left:700px;top:100px;width:200px;height:40px;display:block"></x-tip>
      <div id="away">Away</div>
      <script>customElements.define('x-tip', class extends HTMLElement {
        constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<style>.tip{display:none}:host(:hover) .tip{display:block}</style><span>Tip</span><span class="tip">Shown</span>'; }
      });</script>`);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
      window.__selectors = () => [...document.styleSheets[0].cssRules].flatMap(rule => [rule.selectorText, ...[...(rule.cssRules || [])].map(inner => inner.selectorText)]).filter(Boolean);
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    const state = () => page.evaluate(() => ({
      submenu: getComputedStyle(document.querySelector('#menu .submenu')).display,
      save: getComputedStyle(document.getElementById('save')).display,
      outline: getComputedStyle(document.getElementById('wide')).outlineColor,
      tip: getComputedStyle(document.querySelector('x-tip').shadowRoot.querySelector('.tip')).display,
      marked: document.querySelectorAll('[data-webbrain-hover]').length,
      rewritten: window.__selectors().filter(selector => selector.includes('data-webbrain-hover')).length,
    }));
    const original = await page.evaluate(() => window.__selectors());
    assert.deepEqual(await state(), { submenu: 'none', save: 'none', outline: 'rgb(0, 0, 0)', tip: 'none', marked: 0, rewritten: 0 });
    // Hovering the menu opens it; the pointer can then go down into it. The
    // selector listed beside its :hover keeps its own cascade: Save stays hidden.
    let result = await run({ type: 'hover', x: 150, y: 120 });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual({ ...(await state()), marked: undefined }, { submenu: 'block', save: 'none', outline: 'rgb(0, 0, 0)', tip: 'none', marked: undefined, rewritten: 3 });
    await run({ type: 'hover', x: 150, y: 170 });
    assert.equal((await state()).submenu, 'block', 'still open over its own submenu');
    // A later rule of equal specificity still wins over the hover, as it does for a mouse.
    await run({ type: 'hover', x: 450, y: 415 });
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('btn')).color), 'rgb(0, 0, 255)');
    assert.equal((await state()).submenu, 'none', 'the menu closed behind the pointer');
    // The rule inside @media applies.
    await run({ type: 'hover', x: 450, y: 120 });
    assert.equal((await state()).outline, 'rgb(255, 0, 0)');
    // A shadow root's :host(:hover) rule applies inside it.
    await run({ type: 'hover', x: 750, y: 120 });
    assert.equal((await state()).tip, 'block');
    // A rule the page adds later is read on the next input.
    await page.evaluate(() => document.styleSheets[0].insertRule('#away:hover { color: rgb(0, 128, 0) }', document.styleSheets[0].cssRules.length));
    await run({ type: 'hover', x: 150, y: 420 });
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('away')).color), 'rgb(0, 128, 0)');
    // A click leaves the pointer, and :hover, where it clicked.
    await run({ type: 'click', x: 150, y: 120 });
    assert.equal((await state()).submenu, 'block');
    // A person's own pointer moving ends the emulation and puts the page's selectors back.
    await page.mouse.move(150, 600);
    await page.waitForFunction(() => !document.querySelector('[data-webbrain-hover]'));
    assert.deepEqual(await state(), { submenu: 'none', save: 'none', outline: 'rgb(0, 0, 0)', tip: 'none', marked: 0, rewritten: 0 });
    assert.deepEqual((await page.evaluate(() => window.__selectors())).slice(0, original.length), original);
    assert.equal(await page.evaluate(() => document.querySelector('x-tip').shadowRoot.styleSheets[0].cssRules[1].selectorText), ':host(:hover) .tip');
  } finally {
    await browser.close();
  }
});

test('content-script vision input (Firefox path) honours the pointer capture a page takes on the press', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    // Run as here (the page's own world), and as from a Firefox content
    // script, which reaches the page's prototype through wrappedJSObject and
    // hands it functions with exportFunction (stood in for here).
    for (const firefoxContentScript of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      // #handle is a slider thumb whose pointer handlers are on itself; #track
      // captures the thumb when pressed; #press works like a react-aria button.
      await page.setContent(`<!doctype html><style>body{margin:0}#track{position:absolute;left:100px;top:100px;width:600px;height:20px;background:#ddd}
        #handle{position:absolute;left:100px;top:90px;width:40px;height:40px;background:#08f}#press{position:absolute;left:100px;top:300px;width:120px;height:40px}</style>
        <div id="track"></div><div id="handle"></div><button id="press">Press</button>
        <script>
        // As in Firefox, the browser's capture methods know no pointer with the vision pointer's id.
        for (const name of ['setPointerCapture', 'releasePointerCapture']) {
          const native = Element.prototype[name];
          Element.prototype[name] = function (id) { if (id === 1) throw new DOMException('Invalid pointer id', 'NotFoundError'); return native.call(this, id); };
        }
        window.own = { set: Element.prototype.setPointerCapture, release: Element.prototype.releasePointerCapture, has: Element.prototype.hasPointerCapture };
        window.log = [];
        const handle = document.getElementById('handle');
        let grab = false;
        handle.addEventListener('pointerdown', e => { handle.setPointerCapture(e.pointerId); grab = true; log.push(['down', e.clientX]); });
        handle.addEventListener('pointermove', e => { if (grab) log.push(['move', e.clientX, handle.hasPointerCapture(e.pointerId)]); });
        handle.addEventListener('pointerup', e => { log.push(['up', e.clientX, e.clientY]); grab = false; handle.releasePointerCapture(e.pointerId); });
        handle.addEventListener('mouseup', e => log.push(['mouseup', e.clientX]));
        for (const type of ['gotpointercapture', 'lostpointercapture']) handle.addEventListener(type, e => log.push([type.replace('pointercapture', ''), e.target.id]));
        document.getElementById('track').addEventListener('pointerdown', e => handle.setPointerCapture(e.pointerId));
        const press = document.getElementById('press');
        press.addEventListener('pointerdown', e => {
          e.target.releasePointerCapture(e.pointerId);
          try { press.setPointerCapture(7); } catch (error) { log.push(['other id', error.name]); }
          document.addEventListener('pointerup', () => log.push(['pressed']), { once: true });
        });
        </script>`);
      await page.evaluate(({ code, guardBlock, firefoxContentScript }) => {
        window.__exported = [];
        if (firefoxContentScript) Object.defineProperty(window, 'wrappedJSObject', { value: window, configurable: true });
        const exportFunction = firefoxContentScript ? (fn, scope) => { window.__exported.push(scope === window); return fn; } : undefined;
        // eslint-disable-next-line no-new-func
        window.__visionInput = new Function('exportFunction', `function withLocalPageDispatch(callback) { return callback(); }
          function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
          function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
          ${guardBlock}\n${code}\nreturn visionInput;`)(exportFunction);
      }, { code: block, guardBlock, firefoxContentScript });
      const run = params => page.evaluate(p => window.__visionInput(p), params);
      const take = () => page.evaluate(() => window.log.splice(0));
      const label = firefoxContentScript ? 'Firefox content script' : 'page world';
      // The thumb takes capture on the press: every move and the release reach
      // it, in its document's coordinates, far past its own box.
      let result = await run({ type: 'drag', x: 120, y: 110, toX: 620, toY: 160, steps: 5 });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(await take(), [
        ['down', 120], ['got', 'handle'], ['move', 220, true], ['move', 320, true], ['move', 420, true], ['move', 520, true], ['move', 620, true],
        ['up', 620, 160], ['lost', 'handle'], ['mouseup', 620],
      ], label);
      // A press on the track that captures the thumb is released on the thumb.
      result = await run({ type: 'click', x: 400, y: 110 });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(await take(), [['got', 'handle'], ['up', 400, 110], ['lost', 'handle'], ['mouseup', 400]], label);
      // A control that drops the implicit capture first, then waits for the
      // release, completes its press; other pointer ids stay the page's own.
      result = await run({ type: 'click', x: 160, y: 320 });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.deepEqual(await take(), [['other id', 'NotFoundError'], ['pressed']], label);
      // The page's own capture methods are back once each sequence ends.
      assert.equal(await page.evaluate(() => Element.prototype.setPointerCapture === own.set
        && Element.prototype.releasePointerCapture === own.release && Element.prototype.hasPointerCapture === own.has), true, label);
      assert.deepEqual(await page.evaluate(() => {
        try { document.body.setPointerCapture(1); return 'no error'; } catch (error) { return error.name; }
      }), 'NotFoundError', label);
      if (firefoxContentScript) assert.deepEqual(await page.evaluate(() => window.__exported), Array(9).fill(true), 'each method of each sequence is exported into the page window');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('content-script vision wheel (Firefox path) scrolls what the browser would', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const pane = (id, left, extra = '') => `<div id="${id}" style="position:fixed;left:${left}px;top:100px;width:300px;height:200px;overflow:auto;${extra}"><div style="height:1000px"></div></div>`;
    await page.setContent(`<!doctype html><style>body{margin:0}iframe{position:fixed;left:100px;top:400px;width:300px;height:150px;border:0}</style>
      ${pane('pane', 100)}${pane('kept', 500, 'overscroll-behavior:contain')}<iframe srcdoc="<p>short</p>"></iframe><div style="height:3000px"></div>`);
    await page.waitForFunction(() => document.querySelector('iframe').contentDocument?.body);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    const wheel = (x, y) => page.evaluate(p => window.__visionInput(p), { type: 'wheel', x, y, deltaY: 300 });
    const state = () => page.evaluate(() => [document.getElementById('pane').scrollTop, document.getElementById('kept').scrollTop, window.scrollY]);
    const reset = (pane = 0, kept = 0) => page.evaluate(([pane, kept]) => {
      document.getElementById('pane').scrollTop = pane; document.getElementById('kept').scrollTop = kept; window.scrollTo(0, 0);
    }, [pane, kept]);
    // A pane that can still move takes the wheel.
    assert.equal((await wheel(250, 200)).moved, true);
    assert.deepEqual(await state(), [300, 0, 0]);
    // An exhausted pane passes it to the page; one with overscroll-behavior: contain keeps it.
    await reset(800, 800);
    assert.equal((await wheel(250, 200)).moved, true);
    assert.deepEqual(await state(), [800, 800, 300]);
    await reset(800, 800);
    assert.equal((await wheel(650, 200)).moved, false);
    assert.deepEqual(await state(), [800, 800, 0]);
    // A same-origin frame that cannot scroll passes the wheel to the page around it.
    await reset();
    assert.equal((await wheel(250, 450)).moved, true);
    assert.equal((await state())[2], 300);
    // A page locked behind a modal (overflow: hidden) does not scroll; a pane on it still does.
    await reset();
    await page.evaluate(() => { document.documentElement.style.overflow = 'hidden'; });
    assert.equal((await wheel(450, 650)).moved, false);
    assert.equal((await wheel(250, 200)).moved, true);
    assert.deepEqual(await state(), [300, 0, 0]);
  } finally {
    await browser.close();
  }
});

test('content-script vision drag (Firefox path) runs HTML5 drag and drop for a draggable item', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const at = (left, top) => `position:absolute;left:${left}px;top:${top}px;width:200px;height:60px;margin:0`;
    await page.setContent(`<!doctype html><style>body{margin:0}</style>
      <div id="a" draggable="true" style="${at(50, 50)};background:#fcc">A</div>
      <div id="b" draggable="true" style="${at(50, 150)};background:#cfc">B</div>
      <div id="c" draggable="true" style="${at(50, 250)};background:#ccf">C</div>
      <div id="zone" style="${at(400, 50)};height:200px;background:#eee"></div>
      <div id="plain" style="${at(400, 300)};background:#ddd"></div>
      <script>window.events=[];
      for(const id of ['a','b','c']){const el=document.getElementById(id);
        el.addEventListener('dragstart',e=>{if(id==='c'){e.preventDefault();return;}e.dataTransfer.setData('text/plain',id);e.dataTransfer.effectAllowed='move';events.push('dragstart:'+id)});
        el.addEventListener('dragend',()=>events.push('dragend:'+id))}
      const zone=document.getElementById('zone');
      zone.addEventListener('dragenter',e=>{e.preventDefault();events.push('dragenter:zone')});
      zone.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='move'});
      zone.addEventListener('dragleave',()=>events.push('dragleave:zone'));
      zone.addEventListener('drop',e=>{e.preventDefault();const id=e.dataTransfer.getData('text/plain');events.push('drop:'+id);zone.append(document.getElementById(id))});
      for(const t of ['mousemove','mouseup'])document.addEventListener(t,()=>{if(events.at(-1)!==t)events.push(t)});</script>`);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    // Events from the drag's start on (the pointer arriving on the item moves the mouse first).
    const take = () => page.evaluate(() => {
      const all = window.events.splice(0);
      const start = all.findIndex(event => event.startsWith('dragstart') || event === 'mouseup');
      return start < 0 ? all : all.slice(start);
    });
    // A onto the drop zone: the page's drop handler moves it there; no mouse events while dragging.
    let result = await run({ type: 'drag', x: 150, y: 80, toX: 500, toY: 150, steps: 6 });
    assert.deepEqual(result.html5Drag, { started: true, dropped: true, dropHandled: true }, JSON.stringify(result));
    assert.deepEqual(await take(), ['dragstart:a', 'dragenter:zone', 'drop:a', 'dragend:a']);
    assert.equal(await page.evaluate(() => document.getElementById('a').parentElement.id), 'zone');
    // B onto an element that accepts no drop: no drop, the drag ends with no effect.
    result = await run({ type: 'drag', x: 150, y: 180, toX: 500, toY: 330, steps: 6 });
    assert.deepEqual(result.html5Drag, { started: true, dropped: false, dropHandled: false }, JSON.stringify(result));
    const missed = await take();
    assert.deepEqual(missed.filter(event => !event.startsWith('drag')), [], JSON.stringify(missed));
    assert.deepEqual(missed.filter(event => /^drag(start|end)|^drop/.test(event)), ['dragstart:b', 'dragend:b']);
    assert.notEqual(await page.evaluate(() => document.getElementById('b').parentElement.id), 'zone');
    // C cancels its dragstart: no drag starts and the pointer drag goes on as mouse events.
    result = await run({ type: 'drag', x: 150, y: 280, toX: 500, toY: 150, steps: 6 });
    assert.equal(result.html5Drag, undefined, JSON.stringify(result));
    const plain = await take();
    assert.ok(plain.includes('mouseup') && !plain.some(event => event.startsWith('drop')), JSON.stringify(plain));
  } finally {
    await browser.close();
  }
});

test('content-script vision clicks and drags (Firefox path) leave disabled controls alone', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const at = top => `position:absolute;left:20px;top:${top}px;width:200px;height:30px;margin:0`;
    await page.setContent(`<!doctype html><style>body{margin:0}</style>
      <button id="off" disabled style="${at(20)}">Off</button>
      <button id="inner" disabled style="${at(70)}"><span id="innerSpan">Inner</span></button>
      <fieldset disabled style="position:absolute;left:20px;top:120px;width:300px;height:90px;margin:0;padding:0;border:0">
        <button id="fenced" style="${at(0).replace('left:20px', 'left:0')}">Fenced</button>
        <a id="link" href="#ok" style="${at(50).replace('left:20px', 'left:0')};display:block">Link</a>
      </fieldset>
      <button id="on" style="${at(240)}">On</button>
      <script>window.hits=[];for(const id of ['off','inner','innerSpan','fenced','link','on'])for(const t of ['pointerdown','mousedown','mouseup','click'])
        document.getElementById(id).addEventListener(t,e=>{hits.push(id+':'+t);if(id==='link'&&t==='click')e.preventDefault()});</script>`);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    const hits = () => page.evaluate(() => window.hits.splice(0));
    // A disabled button, a child of one, and a button disabled by its fieldset.
    for (const [y, what] of [[35, 'button'], [85, 'button'], [135, 'button']]) {
      const result = await run({ type: 'click', x: 100, y });
      assert.equal(result.visionInputRefused, 'disabled_control', JSON.stringify(result));
      assert.equal(result.noDispatch, true);
      assert.equal(result.target.disabled, what);
      assert.match(result.error, /is disabled/);
      assert.deepEqual(await hits(), [], `nothing reached the page at y=${y}`);
    }
    const drag = await run({ type: 'drag', x: 100, y: 35, toX: 400, toY: 35, steps: 4 });
    assert.equal(drag.visionInputRefused, 'disabled_control', JSON.stringify(drag));
    assert.deepEqual(await hits(), []);
    // A link inside a disabled fieldset is not a disabled control; an enabled button clicks.
    assert.equal((await run({ type: 'click', x: 100, y: 185 })).success, true);
    assert.ok((await hits()).includes('link:click'));
    assert.equal((await run({ type: 'click', x: 100, y: 255 })).success, true);
    assert.deepEqual(await hits(), ['on:pointerdown', 'on:mousedown', 'on:mouseup', 'on:click']);
  } finally {
    await browser.close();
  }
});

test('content-script vision clicks (Firefox path) never open a native file chooser', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<!doctype html><style>body{margin:0}*{position:absolute}#upload{left:20px;top:20px;width:200px;height:30px}
      #label{left:20px;top:80px;width:200px;height:30px;background:#eee}#pick{left:20px;top:140px;width:200px;height:30px}
      #later{left:20px;top:200px;width:200px;height:30px}#plain{left:20px;top:260px;width:200px;height:30px}#hidden1,#hidden2,#hidden3{display:none}</style>
      <input id="upload" type="file"><label id="label" for="hidden1">Attach</label><input id="hidden1" type="file">
      <button id="pick">Upload</button><input id="hidden2" type="file"><button id="later">Upload later</button><input id="hidden3" type="file">
      <button id="plain">Plain</button>
      <script>window.choosers=[];for(const id of ['upload','hidden1','hidden2','hidden3'])document.getElementById(id).addEventListener('click',e=>{if(!e.defaultPrevented)choosers.push(id)});
      document.getElementById('pick').addEventListener('click',()=>document.getElementById('hidden2').click());
      document.getElementById('later').addEventListener('click',()=>setTimeout(()=>document.getElementById('hidden3').click(),100));</script>`);
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      const content = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn { visionInput, consumeFilePickerGuard };`)();
      window.__visionInput = content.visionInput;
      window.__consumeFilePickerGuard = content.consumeFilePickerGuard;
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    const settle = async guardId => { await page.waitForTimeout(600); return page.evaluate(id => window.__consumeFilePickerGuard(id), guardId); };
    // A file input, a label for one, and a button that clicks one: blocked at once.
    for (const [y, selector] of [[35, '#upload'], [95, '#hidden1'], [155, '#hidden2']]) {
      const result = await run({ type: 'click', x: 100, y });
      assert.equal(result.filePickerBlocked, true, JSON.stringify(result));
      assert.equal(result.dispatched, true);
      assert.equal(result.selector, selector);
      assert.equal(result._filePickerGuardId, undefined);
    }
    // A chooser opened a moment later is caught when the agent settles the guard.
    const later = await run({ type: 'click', x: 100, y: 215 });
    assert.equal(later.success, true, JSON.stringify(later));
    assert.match(later._filePickerGuardId, /^fpg_/);
    const settledLater = await settle(later._filePickerGuardId);
    assert.equal(settledLater.filePickerBlocked, true, JSON.stringify(settledLater));
    assert.equal(settledLater.selector, '#hidden3');
    // An ordinary control settles clean.
    const plain = await run({ type: 'click', x: 100, y: 275 });
    assert.equal(plain.success, true);
    assert.deepEqual(await settle(plain._filePickerGuardId), { success: true, settled: true, filePickerBlocked: false });
    assert.deepEqual(await page.evaluate(() => window.choosers), [], 'no file input received an unblocked click');
  } finally {
    await browser.close();
  }
});

test('the DOM probe behind the dispatch checks reads controls, text fields, focus, selects and frames', async () => {
  const { visionDomProbeExpression } = await import('../src/chrome/src/agent/vision-dom-probe.js');
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<!doctype html><style>body{margin:0;font:14px sans-serif}*{box-sizing:border-box}
      #btn{position:absolute;left:100px;top:100px;width:200px;height:50px}
      #lab{position:absolute;left:100px;top:180px}#txt{width:200px}
      #num{position:absolute;left:100px;top:240px;width:120px}
      #sel{position:absolute;left:100px;top:300px;width:120px}
      #card{position:absolute;left:100px;top:380px;width:250px;height:100px;display:block;background:#eee}
      #slider{position:absolute;left:400px;top:100px;width:300px;height:30px;background:#ddd}
      #same{position:absolute;left:400px;top:200px;width:300px;height:150px;border:0}
      #cross{position:absolute;left:400px;top:400px;width:200px;height:100px;border:0}
      #divbtn{position:absolute;left:700px;top:100px;width:200px;height:60px;cursor:pointer;background:#cde}
      #track{position:absolute;left:700px;top:200px;width:250px;height:30px;cursor:pointer;background:#ddd}
      #knob{position:absolute;left:0;top:0;width:30px;height:30px;cursor:grab;background:#333}
      #list{position:absolute;left:700px;top:260px;width:250px;cursor:pointer}
      #list div{height:40px;border:1px solid #999}</style>
      <button id="btn"><span>Send</span></button>
      <label id="lab">Name <input id="txt" type="text" value="hello world"></label>
      <input id="num" type="number" value="10">
      <select id="sel"><option>Red</option><option>Blue</option></select>
      <a id="card" href="#card">Card <span>inner</span></a>
      <div id="slider" role="slider" aria-valuenow="1"><div style="width:20px;height:30px;background:#333"></div></div>
      <iframe id="same" srcdoc="<style>body{margin:0}</style><button style='position:absolute;left:20px;top:20px;width:100px;height:40px'>In frame</button>"></iframe>
      <iframe id="cross" src="data:text/html,<button>x</button>"></iframe>
      <div id="divbtn"><span>Framework button</span></div>
      <div id="track"><div id="knob"></div></div>
      <div id="list"><div draggable="true">One</div><div draggable="true">Two</div></div>`);
    await page.waitForFunction(() => document.getElementById('same').contentDocument?.querySelector('button'));
    const probe = request => page.evaluate(visionDomProbeExpression(request));
    const one = async (x, y, extra = {}) => (await probe({ points: [{ x, y }], ...extra })).points[0];

    const onButton = await one(150, 125);
    assert.ok(['button', 'span'].includes(onButton.tag), JSON.stringify(onButton));
    assert.deepEqual({ ...onButton, tag: 'x' }, { found: true, tag: 'x', clickable: true, opaqueFrame: false, control: 'button' });
    const text = await one(200, 190);
    assert.equal(text.tag, 'input');
    assert.equal(text.clickable, false, 'a click in a text field inside a label only places the caret');
    await page.focus('#num');
    assert.equal((await one(130, 250)).focusedNumberInput, true);
    await page.evaluate(() => document.activeElement.blur());
    assert.equal((await one(130, 250)).focusedNumberInput, false);
    const select = await one(130, 310, { focusSelect: true });
    assert.deepEqual(select.select, { current: 'Red', options: ['Red', 'Blue'] });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sel', 'the select is focused for type_text');
    const inFrame = await one(400 + 50, 200 + 30);
    assert.equal(inFrame.tag, 'button');
    assert.equal(inFrame.clickable, true);
    assert.equal(inFrame.opaqueFrame, false, 'same-origin frames are entered');
    assert.equal((await one(450, 430)).opaqueFrame, true, 'a cross-origin frame is opaque');

    const pair = async (a, b) => (await probe({ points: [a, b], pair: true })).pair;
    assert.deepEqual(await pair({ x: 110, y: 110 }, { x: 290, y: 140 }), { known: true, clickEquivalent: true, control: 'button' });
    assert.deepEqual(await pair({ x: 150, y: 125 }, { x: 600, y: 115 }), { known: true, clickEquivalent: false }, 'press on a button, release elsewhere');
    assert.equal((await pair({ x: 110, y: 400 }, { x: 330, y: 470 })).control, 'a', 'inside one link card');
    assert.deepEqual(await pair({ x: 405, y: 115 }, { x: 650, y: 115 }), { known: true, clickEquivalent: false }, 'a slider drag');
    assert.equal((await pair({ x: 425, y: 225 }, { x: 515, y: 255 })).clickEquivalent, true, 'inside a button in a same-origin frame');
    assert.deepEqual(await pair({ x: 150, y: 125 }, { x: 5000, y: 10 }), { known: false });
    // A framework button is often a bare <div> with a listener: its pointer
    // cursor marks it, for repeated clicks and for drags inside it.
    assert.deepEqual(await one(720, 120), { found: true, tag: 'div', clickable: true, opaqueFrame: false, control: 'clickable element' });
    assert.equal((await pair({ x: 710, y: 110 }, { x: 890, y: 150 })).clickEquivalent, true);
    // ...but a handle or draggable item under a pointer cursor still drags.
    assert.equal((await pair({ x: 715, y: 215 }, { x: 900, y: 215 })).clickEquivalent, false, 'a knob with a grab cursor');
    assert.equal((await pair({ x: 720, y: 280 }, { x: 720, y: 320 })).clickEquivalent, false, 'draggable list items');
  } finally {
    await browser.close();
  }
});

// From a trace: ten clicks meant for a Bluesky composer's Post button landed
// on the full-viewport dialog element around the composer card, and each came
// back as a successful click on {div, dialog}. The probe now says when a point
// is an open dialog's own background rather than anything in it.
for (const [engineName, engine] of [['chromium', chromium], ['firefox', firefox]]) {
  test(`the DOM probe tells an open dialog's backdrop and empty area from its controls (${engineName})`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1126, height: 745 } });
      for (const build of ['chrome', 'firefox']) {
        const { visionDomProbeExpression } = await import(`../src/${build}/src/agent/vision-dom-probe.js`);
        const one = async (x, y) => (await page.evaluate(visionDomProbeExpression({ points: [{ x, y }] }))).points[0];
        const label = `${engineName}/${build}`;
        // The composer: a full-viewport dialog element that dims the feed,
        // with the card (and its Post button) drawn inside it.
        await page.setContent(`<!doctype html><style>body{margin:0;font:14px sans-serif}*{box-sizing:border-box}</style>
          <div style="height:2000px">Feed</div>
          <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.5)">
            <div id="card" style="position:absolute;left:263px;top:50px;width:600px;height:320px;background:#fff">
              <button style="position:absolute;right:16px;top:12px;width:64px;height:32px">Post</button>
              <div contenteditable="true" style="position:absolute;left:70px;top:60px;width:500px;height:150px"></div>
            </div>
          </div>`);
        const backdrop = await one(1035, 80);
        assert.equal(backdrop.dialogBackground, 'backdrop', `${label}: ${JSON.stringify(backdrop)}`);
        assert.equal(backdrop.role, 'dialog');
        assert.equal(backdrop.clickable, false);
        const post = await one(815, 78);
        assert.equal(post.control, 'button', `${label}: ${JSON.stringify(post)}`);
        assert.equal(post.dialogBackground, undefined);
        assert.equal((await one(400, 150)).dialogBackground, undefined, `${label}: the text field`);
        assert.equal((await one(300, 330)).dialogBackground, undefined, `${label}: the card itself is not the dialog element`);
        // A modal <dialog>: outside its box is its ::backdrop; its padding is an empty area.
        await page.setContent(`<!doctype html><style>body{margin:0}dialog{padding:40px;width:300px;border:0}</style>
          <p>Page</p><dialog id="d"><button>OK</button></dialog><script>document.getElementById('d').showModal()<\/script>`);
        const rect = await page.evaluate(() => { const r = document.getElementById('d').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
        assert.equal((await one(20, 20)).dialogBackground, 'backdrop', `${label}: a modal dialog's ::backdrop`);
        assert.equal((await one(rect.right - 10, rect.bottom - 10)).dialogBackground, 'empty', `${label}: the dialog's own padding`);
        // A separate fixed overlay beside an aria-modal dialog.
        await page.setContent(`<!doctype html><style>body{margin:0}</style>
          <div id="shade" style="position:fixed;inset:0;background:#0008"></div>
          <div role="dialog" aria-modal="true" style="position:fixed;left:300px;top:200px;width:300px;height:200px;background:#fff"><button>OK</button></div>`);
        assert.equal((await one(50, 50)).dialogBackground, 'backdrop', `${label}: a modal's overlay`);
        // No modal open: a full-viewport layer is just the page; an overlay
        // drawn as clickable (it closes the dialog) is a control.
        await page.setContent(`<!doctype html><style>body{margin:0}</style>
          <div style="position:fixed;inset:0;background:#eee">App</div>`);
        assert.equal((await one(50, 50)).dialogBackground, undefined, `${label}: no modal`);
        await page.setContent(`<!doctype html><style>body{margin:0}</style>
          <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#0008;cursor:pointer"><div style="margin:200px auto;width:200px;height:100px;background:#fff;cursor:auto"></div></div>`);
        const closer = await one(20, 20);
        assert.equal(closer.clickable, true, `${label}: ${JSON.stringify(closer)}`);
        assert.equal(closer.dialogBackground, undefined, `${label}: a clickable backdrop`);
      }
    } finally {
      await browser.close();
    }
  });
}

test('vision input (Firefox path) and the DOM probe place points inside scaled same-origin frames, and refuse frames they cannot enter', async () => {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    // Each frame holds a button at its own (200,100)-(300,140) and a track at
    // (0,180)-(400,220) whose document logs the press, the moves and the release.
    const inner = (left = 200, top = 100) => `<style>body{margin:0}#b{position:absolute;left:${left}px;top:${top}px;width:100px;height:40px}
      #t{position:absolute;left:0;top:180px;width:400px;height:40px;background:#ddd}</style><button id="b">Go</button><div id="t"></div>
      <script>window.log=[];let down=false;document.getElementById('b').addEventListener('click',e=>log.push(['click',e.clientX,e.clientY]));
      document.getElementById('t').addEventListener('mousedown',e=>{down=true;log.push(['down',e.clientX,e.clientY])});
      document.addEventListener('mousemove',e=>{if(down)log.push(['move',e.clientX,e.clientY])});
      document.addEventListener('mouseup',e=>{if(down)log.push(['up',e.clientX,e.clientY]);down=false});<\/script>`;
    const frame = (id, style, html = inner()) => `<iframe id="${id}" style="${style}" srcdoc="${html.replace(/"/g, '&quot;')}"></iframe>`;
    await page.setContent(`<!doctype html><style>body{margin:0}iframe{position:absolute;width:400px;height:300px;border:3px solid #000}</style>
      ${frame('scaled', 'left:100px;top:50px;transform:scale(0.5);transform-origin:0 0')}
      ${frame('tilted', 'left:600px;top:50px;transform:rotate(10deg)')}
      <iframe id="cross" style="left:600px;top:420px;width:200px;height:100px" src="data:text/html,<button>Elsewhere</button>"></iframe>
      <div style="position:absolute;left:100px;top:400px;transform:scale(1.5);transform-origin:0 0">${frame('nested', 'position:static;width:200px;height:100px;border:1px solid #000', inner(20, 10))}</div>`);
    await page.waitForFunction(() => ['scaled', 'tilted', 'nested'].every(id => document.getElementById(id).contentWindow?.log));
    const source = fs.readFileSync(path.join(ROOT, 'src/firefox/src/content/content.js'), 'utf8');
    const block = source.slice(source.indexOf('  function _visionTargetAt('), source.indexOf('  let _lastClickIdent = null;'));
    const guardBlock = source.slice(source.indexOf('  function uniqueFileInputSelector(input) {'), source.indexOf('  /**\n   * Click an element by selector or coordinates.'));
    await page.evaluate(({ code, guardBlock }) => {
      // eslint-disable-next-line no-new-func
      window.__visionInput = new Function(`function withLocalPageDispatch(callback) { return callback(); }
        function _uniqueFileInputSelector(input) { return input.id ? '#' + input.id : ''; }
        function _deepSelectorMatches(selector) { return [...document.querySelectorAll(selector)]; }
        ${guardBlock}\n${code}\nreturn visionInput;`)();
    }, { code: block, guardBlock });
    const run = params => page.evaluate(p => window.__visionInput(p), params);
    const take = id => page.evaluate(id => document.getElementById(id).contentWindow.log.splice(0), id);
    // The scaled frame's (x, y) is drawn at its box (100, 50) plus its 3 px border, at half size.
    const scaled = (x, y) => ({ x: 100 + (3 + x) * 0.5, y: 50 + (3 + y) * 0.5 });
    let result = await run({ type: 'click', ...scaled(250, 120) });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(await take('scaled'), [['click', 250, 120]]);
    // An ancestor's scale counts too: the nested frame is drawn at 1.5x inside its 1 px border.
    result = await run({ type: 'click', x: 100 + (1 + 70) * 1.5, y: 400 + (1 + 30) * 1.5 });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(await take('nested'), [['click', 70, 30]]);
    // A drag gives every point in the scaled frame's own coordinates.
    const from = scaled(50, 200);
    const to = scaled(350, 200);
    result = await run({ type: 'drag', x: from.x, y: from.y, toX: to.x, toY: to.y, steps: 6 });
    assert.equal(result.success, true, JSON.stringify(result));
    const drag = await take('scaled');
    assert.deepEqual(drag[0], ['down', 50, 200], JSON.stringify(drag));
    assert.deepEqual(drag.filter(entry => entry[0] === 'move').map(entry => entry[1]), [100, 150, 200, 250, 300, 350], JSON.stringify(drag));
    assert.deepEqual(drag.at(-1), ['up', 350, 200], JSON.stringify(drag));
    // No scale maps a rotated frame: the click is refused, nothing is sent.
    const rect = await page.evaluate(() => { const box = document.getElementById('tilted').getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });
    result = await run({ type: 'click', ...rect });
    assert.equal(result.visionInputRefused, 'frame_unmappable', JSON.stringify(result));
    assert.equal(result.noDispatch, true);
    assert.deepEqual(await take('tilted'), []);
    // A frame from another origin is never entered: a click there would stop at the frame element.
    result = await run({ type: 'click', x: 700, y: 470 });
    assert.equal(result.visionInputRefused, 'opaque_frame', JSON.stringify(result));
    assert.equal(result.noDispatch, true);
    // The DOM probe behind the dispatch checks reads the same elements, in both builds.
    for (const build of ['chrome', 'firefox']) {
      const { visionDomProbeExpression } = await import(`../src/${build}/src/agent/vision-dom-probe.js`);
      const probe = async point => (await page.evaluate(visionDomProbeExpression({ points: [point] }))).points[0];
      assert.deepEqual(await probe(scaled(250, 120)), { found: true, tag: 'button', clickable: true, opaqueFrame: false, control: 'button' }, build);
      assert.equal((await probe(scaled(250, 200))).tag, 'div', build);
      assert.equal((await probe(rect)).opaqueFrame, true, `${build}: a rotated frame cannot be read`);
    }
  } finally {
    await browser.close();
  }
});

test('the click submit probe (Chrome) reads a point inside a scaled, bordered child frame', async () => {
  const { Agent } = await import('../src/chrome/src/agent/agent.js');
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const inner = `<style>body{margin:0}button{position:absolute;left:200px;top:100px;width:100px;height:40px}</style>
      <form action="/pay" method="post"><input name="amount" value="5"><button type="submit">Pay now</button></form>`;
    await page.setContent(`<!doctype html><style>body{margin:0}</style>
      <iframe style="position:absolute;left:100px;top:50px;width:400px;height:300px;border:3px solid #000;transform:scale(0.5);transform-origin:0 0"
        srcdoc="${inner.replace(/"/g, '&quot;')}"></iframe>`);
    await page.waitForFunction(() => document.querySelector('iframe').contentDocument?.querySelector('button'));
    // The frame rectangles come from the agent's own top-frame script.
    const agent = new Agent({ getVisionProvider: async () => null });
    const realChrome = globalThis.chrome;
    globalThis.chrome = { scripting: { executeScript: async ({ func, args }) => [{ result: await page.evaluate(({ source, args }) => new Function(`return (${source})`)()(...args), { source: func.toString(), args }) }] } };
    let rects;
    // The button's centre, (250, 120) in the frame, is drawn at (100 + (3 + 250) / 2, 50 + (3 + 120) / 2).
    const point = { x: 226.5, y: 111.5 };
    try { rects = await agent._iframeRectsForCoordinate(1, point.x, point.y); } finally { globalThis.chrome = realChrome; }
    assert.equal(rects.length, 1, JSON.stringify(rects));
    assert.deepEqual({ scaleX: rects[0].scaleX, scaleY: rects[0].scaleY, insetLeft: rects[0].insetLeft, insetTop: rects[0].insetTop }, { scaleX: 0.5, scaleY: 0.5, insetLeft: 3, insetTop: 3 });
    const child = page.frames().find(item => item !== page.mainFrame());
    const result = await child.evaluate(({ source, args }) => new Function(`return (${source})`)()('click', args), {
      source: Agent._submitActionProbe.toString(),
      args: { ...point, coordinate_space: 'css', __wbTopLevelCoordinateFrames: rects, __wbCaptionPass: 'final', __wbCaptionReadings: {} },
    });
    assert.equal(result?.isSubmit, true, JSON.stringify(result)?.slice(0, 400));
  } finally {
    await browser.close();
  }
});

test('the click submit probe reads a vision point inside open shadow roots and on plain content (both builds)', async () => {
  const page_ = `<!doctype html><meta charset="utf-8"><title>Probe fixture</title>
<style>body{margin:0;font:16px sans-serif}#post{position:absolute;left:20px;top:20px;width:400px;height:120px;cursor:pointer}
#post p{margin:0;padding:10px}my-pay{position:absolute;left:20px;top:200px;width:300px;height:80px;display:block}
#menu{position:absolute;left:500px;top:20px;width:120px;height:40px}</style>
<article id="post"><p>Owned QA post text that opens the post when clicked</p></article>
<my-pay></my-pay><div id="menu" role="button" aria-label="Post actions">More</div>
<x-chip role="button" aria-label="Follow" style="position:absolute;left:500px;top:120px;width:120px;height:40px;display:block"></x-chip>
<iframe id="pay-frame" srcdoc="<button>Pay</button>" style="position:absolute;left:500px;top:220px;width:200px;height:80px;border:0"></iframe>
<script>
document.getElementById('post').addEventListener('click', () => { window.opened = true; });
customElements.define('x-chip', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<span style="display:block;width:120px;height:40px">Follow</span>'; }
});
customElements.define('my-pay', class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = '<form action="/pay" method="post"><input name="amount" value="5" style="position:absolute;left:150px;top:10px;width:100px">'
      + '<button type="submit" style="position:absolute;left:10px;top:10px;width:120px;height:40px">Pay now</button></form>';
  }
});
</script>`;
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.setContent(page_);
    for (const build of ['chrome', 'firefox']) {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const probe = args => page.evaluate(({ source, args }) => {
        const fn = new Function(`return (${source})`)();
        return fn('click', args);
      }, { source: Agent._submitActionProbe.toString(), args });
      // Plain content under a vision point: a non-submit target.
      const plain = await probe({ x: 120, y: 50, coordinate_space: 'css', __wbCaptionPass: 'final', __wbCaptionReadings: {} });
      assert.equal(plain?.resolvedPlainContent, true, `${build}: ${JSON.stringify(plain)}`);
      assert.equal(plain.isSubmit, false);
      // The same point from a coordinate click outside a vision run is not classified.
      assert.equal((await probe({ x: 120, y: 50, __wbCaptionPass: 'final', __wbCaptionReadings: {} }))?.resolvedPlainContent, undefined);
      // A control is never plain content.
      assert.notEqual((await probe({ x: 560, y: 40, coordinate_space: 'css', __wbCaptionPass: 'final', __wbCaptionReadings: {} }))?.resolvedPlainContent, true);
      // A frame is opaque to the top document's probe, never plain content.
      assert.notEqual((await probe({ x: 600, y: 260, coordinate_space: 'css', __wbCaptionPass: 'final', __wbCaptionReadings: {} }))?.resolvedPlainContent, true);
      // Text inside a web component whose host is the button is that button.
      assert.notEqual((await probe({ x: 560, y: 140, coordinate_space: 'css', __wbCaptionPass: 'final', __wbCaptionReadings: {} }))?.resolvedPlainContent, true);
      // The submit button inside the web component is the submit, not its host.
      const pay = await probe({ x: 90, y: 230, coordinate_space: 'css', __wbCaptionPass: 'final', __wbCaptionReadings: {} });
      assert.equal(pay?.isSubmit, true, `${build}: ${JSON.stringify(pay)?.slice(0, 400)}`);
    }
  } finally {
    await browser.close();
  }
});
