// Chrome's tree-mode viewport captures (automatic screenshots, the screenshot
// tool, visible-media capture: Agent._captureViewportImage) in real Chromium,
// driven by the agent's own code over CDP. A screencast reports every frame
// the tab shows: a clipped capture resizes the tab's view for its duration,
// which the screen shows as a shrunken page, and these captures must leave it
// as it is while still returning the planned image, mapped 1:1 to CSS pixels.
// Vision mode's captures: test/vision-pipeline-browser.mjs.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const AGENT_DIR = path.join(ROOT, 'src/chrome/src/agent');

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome ??= {
  storage: { local: area, session: area, onChanged: { addListener() {} } },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}), getManifest: () => ({ version: '0.0.0' }) },
  tabs: { get: async id => ({ id, active: true }), query: async () => [], sendMessage: async () => ({ ok: true }) },
  webNavigation: { getAllFrames: async () => [] },
  scripting: { executeScript: async () => [{ result: null }] },
};
const { Agent } = await import('../src/chrome/src/agent/agent.js');

// A scrolled page with fixed marks at known CSS positions, and a spinner that
// keeps the screencast sending frames while the captures run.
const FIXTURE = `<!doctype html><meta charset="utf-8"><title>Capture fixture</title>
<style>
  body { margin: 0; height: 3000px; background: linear-gradient(#fff, #eef); }
  #mark { position: fixed; left: 600px; top: 300px; width: 60px; height: 60px; background: rgb(20, 120, 220); }
  #corner { position: fixed; right: 0; bottom: 0; width: 40px; height: 40px; background: rgb(220, 60, 40); }
  #spin { position: fixed; left: 200px; top: 200px; width: 40px; height: 40px; background: #c0c; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style><div id="mark"></div><div id="corner"></div><div id="spin"></div>`;

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

const TAB = 7001;
const savedCdp = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand };
test.afterEach(() => Object.assign(cdpClient, savedCdp));

/** A real page, with the agent's CDP traffic going to it. */
async function open({ dpr = 1, windowSize = '1280,860', url = '/fixture', scrollbars = false } = {}) {
  const browser = await chromium.launch({
    channel: 'chromium',
    args: [`--force-device-scale-factor=${dpr}`, `--window-size=${windowSize}`],
    ...(scrollbars ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {}),
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  await page.goto(`${origin}${url}`);
  const session = await context.newCDPSession(page);
  Object.assign(cdpClient, {
    attach: async () => ({ attached: true }),
    sendCommand: (_tabId, method, params) => session.send(method, params),
  });
  const agent = new Agent({ getActive: () => null, getProvider: () => null, getVisionProvider: async () => null });
  // The local crop runs where a canvas is: in the page, with the shared encoder.
  agent._cropAndScaleImage = (dataUrl, rect, width, height, options) => page.evaluate(async args => {
    const { cropImage } = await import('/agent/vision-encoder.js');
    return cropImage(args.dataUrl, args.rect, args.width, args.height, args.options);
  }, { dataUrl, rect, width, height, options });
  return { browser, page, session, agent };
}

/** Every frame the tab shows: its image size and the view it was drawn for. */
function watchScreen(page, session) {
  const frames = [];
  session.on('Page.screencastFrame', frame => {
    const png = Buffer.from(frame.data, 'base64');
    frames.push(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)} image, ${frame.metadata.deviceWidth}x${frame.metadata.deviceHeight} view`);
    session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  // Frames arrive slower on a loaded machine: wait for a few, bounded.
  const awaitFrames = async (count, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (frames.length < count && Date.now() < deadline) await page.waitForTimeout(50);
    assert.ok(frames.length >= count, `the screencast sent ${frames.length} frames`);
  };
  return { frames, awaitFrames, start: () => session.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }) };
}

/** The decoded size of a data URL and its RGB at image points. */
function readPixels(page, dataUrl, points) {
  return page.evaluate(async ({ dataUrl, points }) => {
    const { decodeImage } = await import('/agent/vision-encoder.js');
    const image = await decodeImage(dataUrl);
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const rgb = points.map(([x, y]) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)));
    return { width: image.width, height: image.height, rgb };
  }, { dataUrl, points });
}

const near = (rgb, expected) => rgb.every((value, i) => Math.abs(value - expected[i]) < 40);
const BLUE = [20, 120, 220];
const RED = [220, 60, 40];

// DPR 2 shrinks a clipped capture by 1/DPR; at DPR 1 a window wider than the
// image budget shrinks the budget-scaled one.
for (const { dpr, windowSize } of [{ dpr: 2, windowSize: '1280,860' }, { dpr: 1, windowSize: '1920,1080' }]) {
  test(`DPR ${dpr}: tree-mode captures leave the tab on screen as it is and map 1:1 to CSS pixels, where a clipped capture shrinks it`, async () => {
    const { browser, page, session, agent } = await open({ dpr, windowSize });
    try {
      await page.evaluate(() => window.scrollTo(0, 400));
      const { cssW, cssH } = await page.evaluate(() => ({ cssW: innerWidth, cssH: innerHeight }));
      const screen = watchScreen(page, session);
      await screen.start();
      await screen.awaitFrames(3);
      const onScreen = [...new Set(screen.frames)];
      assert.equal(onScreen.length, 1, onScreen.join('; '));

      screen.frames.length = 0;
      const aligned = await agent._captureAutoScreenshot(TAB, { coordAligned: true });
      const budgeted = await agent._captureAutoScreenshot(TAB);
      const media = await agent._captureVisibleMediaScreenshot(TAB);
      const native = await agent._captureViewportImage(TAB, await agent._captureViewportProbe(TAB), cssW, cssH, { format: 'png' });
      await screen.awaitFrames(3);
      assert.deepEqual([...new Set(screen.frames)], onScreen, 'the tab keeps its size and scale through the captures');

      // Each image is the scrolled viewport from its top left, at the size it
      // reports: the mark and the bottom-right corner sit where CSS has them.
      const [targetW, targetH] = Agent._fitImageDimensions(cssW, cssH, agent._budgetForCapture());
      if (dpr === 1) assert.ok(targetW < cssW, `the budget scales this window down: ${targetW} of ${cssW}`);
      for (const [label, dataUrl, width, height] of [
        ['coordinate-aligned', aligned?.dataUrl, aligned?.width, aligned?.height],
        ['budget', budgeted?.dataUrl, targetW, targetH],
        ['visible media', media?.cropDataUrl, cssW, cssH],
        ['native', native?.data && `data:image/png;base64,${native.data}`, Math.round(cssW * dpr), Math.round(cssH * dpr)],
      ]) {
        assert.ok(dataUrl, `${label}: captured`);
        const sx = width / cssW;
        const sy = height / cssH;
        const shot = await readPixels(page, dataUrl, [[630 * sx, 330 * sy], [(cssW - 20) * sx, (cssH - 20) * sy]]);
        assert.deepEqual([shot.width, shot.height], [width, height], `${label}: the reported size`);
        assert.ok(near(shot.rgb[0], BLUE), `${label}: the mark at CSS 630,330: ${shot.rgb[0]}`);
        assert.ok(near(shot.rgb[1], RED), `${label}: the corner: ${shot.rgb[1]}`);
      }
      assert.equal(budgeted.width, targetW);
      assert.equal(budgeted.height, targetH);
      if (dpr === 2) assert.deepEqual([aligned.width, aligned.height, aligned.coordAligned], [cssW, cssH, true]);

      // The capture before this change, which a failed local crop still falls
      // back to: Chromium resizes the view to the clip's scaled size and
      // renders the page into it, which the screen shows.
      agent._cropAndScaleImage = async () => { throw new Error('no canvas'); };
      const seen = [];
      for (let i = 0; i < 6 && !seen.some(size => size !== onScreen[0]); i++) {
        screen.frames.length = 0;
        assert.ok(await agent._captureAutoScreenshot(TAB), 'the clipped fallback still captures');
        await screen.awaitFrames(2);
        seen.push(...screen.frames);
      }
      assert.ok(seen.some(size => size !== onScreen[0]), `a clipped capture is seen on screen: ${[...new Set(seen)].join('; ')}`);
    } finally {
      await browser.close();
    }
  });
}

test('a tree-mode capture of a right-to-left page wider than the window shows the screen', async () => {
  // Classic scrollbars, as on Windows and Linux; Chromium keeps the page's
  // own on the right in RTL too. The clip captured this page's left end,
  // off screen, as a blank frame.
  const { browser, page, agent } = await open({ url: '/rtl', windowSize: '1000,700', scrollbars: true });
  try {
    // A styled scrollbar reserves layout space even on macOS with overlay
    // scrollbars, so this exercises the same classic-scrollbar geometry.
    await page.addStyleTag({ content: '::-webkit-scrollbar { width: 16px; height: 16px; }' });
    const { cssW, clientW } = await page.evaluate(() => ({ cssW: innerWidth, clientW: document.documentElement.clientWidth }));
    assert.ok(cssW > clientW, 'the page has a classic scrollbar');
    const shot = await agent._captureAutoScreenshot(TAB, { coordAligned: true });
    assert.deepEqual([shot?.width, shot?.coordAligned], [cssW, true]);
    const { rgb: [start, end] } = await readPixels(page, shot.dataUrl, [[30, 30], [clientW - 30, 30]]);
    assert.ok(near(start, [0, 200, 0]), `the page's left edge: ${start}`);
    assert.ok(near(end, [200, 0, 200]), `its right edge, before the scrollbar: ${end}`);
  } finally {
    await browser.close();
  }
});
