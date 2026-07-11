import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../..');

const assets = {
  logo: dataUri('assets/store-icon-128.png'),
  ask: dataUri('assets/screenshot-1-ask-mode.png'),
  models: dataUri('assets/screenshots_v1/s7-model-selector.png'),
};

function dataUri(relativePath) {
  const bytes = readFileSync(path.join(ROOT, relativePath));
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const W = 1280;
const H = 800;

const baseCss = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; width: ${W}px; height: ${H}px; overflow: hidden;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .canvas {
    position: relative; width: ${W}px; height: ${H}px; overflow: hidden;
    background: linear-gradient(135deg, var(--bg1), var(--bg2));
    color: var(--ink); isolation: isolate;
  }
  .canvas:after {
    content: ""; position: absolute; z-index: 0; pointer-events: none;
    right: -120px; bottom: -140px; width: 540px; height: 360px;
    background:
      linear-gradient(90deg, transparent 0 28px, rgba(255,255,255,0.14) 28px 30px, transparent 30px 72px),
      linear-gradient(0deg, transparent 0 28px, rgba(255,255,255,0.12) 28px 30px, transparent 30px 72px);
    transform: rotate(-8deg); opacity: 0.8;
  }
  .dark { --bg1:#121525; --bg2:#243044; --ink:#ffffff; --muted:#d5d9e3;
    --accent:#f56ca8; --accent2:#65d69d; --border:rgba(255,255,255,0.16);
    --panel:rgba(255,255,255,0.08); --shadow:0 28px 70px rgba(0,0,0,0.32); }
  .act { --bg1:#f7fbff; --bg2:#fff4ef; --ink:#182033; --muted:#596473;
    --accent:#df573f; --accent2:#4d7df5; --border:rgba(31,40,64,0.14);
    --panel:rgba(255,255,255,0.9); --shadow:0 28px 70px rgba(68,50,40,0.20); }
  .read { --bg1:#fffaf3; --bg2:#eef5ff; --ink:#171827; --muted:#565e70;
    --accent:#6757ff; --accent2:#ff6f9d; --border:rgba(37,42,66,0.12);
    --panel:rgba(255,255,255,0.88); --shadow:0 28px 70px rgba(31,35,62,0.20); }
  .plan { --bg1:#111827; --bg2:#223040; --ink:#f8fafc; --muted:#c7d2de;
    --accent:#45d483; --accent2:#ffc857; --border:rgba(255,255,255,0.18);
    --panel:rgba(255,255,255,0.08); --shadow:0 28px 80px rgba(0,0,0,0.34); }
  .provider { --bg1:#f6f8fb; --bg2:#eef8f1; --ink:#182033; --muted:#5b6574;
    --accent:#3e6ff4; --accent2:#28a96b; --border:rgba(25,38,68,0.13);
    --panel:rgba(255,255,255,0.9); --shadow:0 28px 70px rgba(24,52,90,0.19); }
  .content { position: relative; z-index: 1; width: 100%; height: 100%; padding: 44px 56px; }
  .brand { display: flex; align-items: center; gap: 13px; font-size: 22px; font-weight: 760; }
  .brand img { width: 40px; height: 40px; border-radius: 11px; box-shadow: 0 10px 24px rgba(0,0,0,0.13); }
  .eyebrow {
    display: inline-flex; align-items: center; gap: 10px; padding: 9px 14px;
    color: var(--accent); background: var(--panel); border: 1px solid var(--border);
    border-radius: 999px; font-size: 14px; font-weight: 780; text-transform: uppercase;
    letter-spacing: 0.06em; line-height: 1;
  }
  .eyebrow .dot { width: 9px; height: 9px; border-radius: 999px; background: var(--accent2);
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent2) 18%, transparent); }
  h1 { margin: 18px 0 0; font-size: 60px; line-height: 1.04; font-weight: 830; text-wrap: balance; }
  .sub { margin-top: 14px; color: var(--muted); font-size: 24px; font-weight: 540; }
  .crop-frame {
    overflow: hidden; border: 1px solid var(--border); border-radius: 24px;
    background: #ffffff; box-shadow: var(--shadow); position: relative;
  }
  .crop-frame img { display: block; }
`;

function brandRow(light) {
  return `
    <div class="brand" style="${light ? '' : ''}">
      <img src="${assets.logo}" alt="">
      <span>WebBrain</span>
    </div>`;
}

/* ---------- 01 HERO ---------- */
function hero() {
  return {
    file: '01-hero.png',
    theme: 'dark',
    body: `
      <div style="height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;">
        <img src="${assets.logo}" style="width:112px; height:112px; border-radius:28px; box-shadow:0 26px 60px rgba(0,0,0,0.4);" alt="">
        <div style="margin-top:26px; font-size:34px; font-weight:800; letter-spacing:0.01em;">WebBrain</div>
        <h1 style="margin-top:20px; font-size:76px; max-width:900px;">Your open-source<br>AI browser agent</h1>
        <div class="sub" style="font-size:30px; font-weight:640; color:#ffffff; margin-top:22px;">
          <span style="color:var(--accent);">Ask.</span>
          <span style="color:var(--accent2);">Act.</span>
          Automate. <span style="opacity:0.85;">Any LLM.</span>
        </div>
        <div style="display:flex; gap:10px; margin-top:30px;">
          ${['Chrome & Firefox', 'Local or cloud models', 'MIT licensed'].map((c) => `
            <span style="padding:10px 15px; border:1px solid var(--border); background:var(--panel);
              border-radius:999px; font-size:15px; font-weight:700; color:var(--muted);">${c}</span>`).join('')}
        </div>
      </div>`,
  };
}

/* ---------- 02 TELL THE BROWSER (command front and center) ---------- */
function actScene() {
  const steps = [
    ['done', 'Found the flight search form'],
    ['done', 'Typed “Istanbul (IST)”'],
    ['done', 'Typed “San Francisco (SFO)”'],
    ['live', 'Clicking Search…'],
  ];
  return {
    file: '02-tell-the-browser.png',
    theme: 'act',
    body: `
      <div style="display:flex; align-items:center; justify-content:space-between;">
        ${brandRow()}
        <span class="eyebrow"><span class="dot"></span>Act mode</span>
      </div>
      <div style="text-align:center; margin-top:34px;">
        <h1 style="margin:0; font-size:58px;">Tell the browser what to do.</h1>
      </div>

      <!-- The command, front and center -->
      <div style="width:940px; margin:40px auto 0; display:flex; align-items:center; gap:16px;
        background:#ffffff; border:1px solid var(--border); border-radius:22px; padding:20px 22px;
        box-shadow:0 24px 60px rgba(68,50,40,0.18);">
        <img src="${assets.logo}" style="width:38px; height:38px; border-radius:10px;" alt="">
        <div style="flex:1; font-size:25px; font-weight:680; color:var(--ink); line-height:1.25;">
          Search for the cheapest flights from Istanbul to San Francisco<span
            style="display:inline-block; width:3px; height:26px; background:var(--accent); margin-left:5px; vertical-align:-4px; border-radius:2px;"></span>
        </div>
        <div style="width:52px; height:52px; border-radius:16px; background:var(--accent); color:#fff;
          display:grid; place-items:center; font-size:24px; font-weight:900; box-shadow:0 12px 26px rgba(223,87,63,0.4);">&#8593;</div>
      </div>

      <!-- The browser acting on it -->
      <div style="display:grid; grid-template-columns: 1fr 360px; gap:24px; width:1060px; margin:44px auto 0; align-items:stretch;">
        <div class="crop-frame" style="border-radius:20px;">
          <div style="height:44px; display:flex; align-items:center; gap:10px; padding:0 16px; background:#e9edf4;">
            <span style="width:10px;height:10px;border-radius:99px;background:#aeb7c7;"></span>
            <span style="width:10px;height:10px;border-radius:99px;background:#aeb7c7;"></span>
            <span style="width:10px;height:10px;border-radius:99px;background:#aeb7c7;"></span>
            <span style="flex:1; height:26px; border-radius:8px; background:#f6f8fb; color:#667085;
              font-size:13px; font-weight:650; display:flex; align-items:center; padding:0 12px;">google.com/travel/flights</span>
          </div>
          <div style="padding:26px 28px 30px; background:#ffffff;">
            <div style="font-size:27px; font-weight:800;"><span style="color:#4285f4;">Google</span> <span style="color:#5f6368; font-weight:500;">Flights</span></div>
            <div style="display:grid; grid-template-columns:1fr 34px 1fr; gap:10px; align-items:center; margin-top:20px;">
              <div style="border:2px solid var(--accent2); border-radius:12px; padding:14px 16px; font-size:18px; font-weight:650; color:#202124; background:#fbfdff;">Istanbul (IST)</div>
              <div style="text-align:center; color:#5f6368; font-size:20px;">&#8594;</div>
              <div style="border:2px solid var(--accent2); border-radius:12px; padding:14px 16px; font-size:18px; font-weight:650; color:#202124; background:#fbfdff;">San Francisco (SFO)</div>
            </div>
            <div style="position:relative; margin-top:22px; display:flex; justify-content:center;">
              <div style="padding:13px 34px; border-radius:999px; background:#1a73e8; color:#fff; font-size:17px; font-weight:750; box-shadow:0 10px 24px rgba(26,115,232,0.35);">Search</div>
              <svg width="30" height="30" viewBox="0 0 24 24" style="position:absolute; right:calc(50% - 66px); top:26px; filter:drop-shadow(0 3px 5px rgba(0,0,0,0.35));">
                <path d="M5 3 L19 12 L12 13.5 L9.5 20 Z" fill="#111" stroke="#fff" stroke-width="1.6"/>
              </svg>
            </div>
            <div style="display:grid; gap:10px; margin-top:26px;">
              <div style="display:flex; justify-content:space-between; align-items:center; border:1px solid #e5e7ef; border-radius:12px; padding:12px 16px;">
                <span style="height:10px; width:42%; border-radius:99px; background:#d7ddea;"></span>
                <span style="font-size:15px; font-weight:750; color:#188038;">$612</span>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; border:1px solid #e5e7ef; border-radius:12px; padding:12px 16px;">
                <span style="height:10px; width:56%; border-radius:99px; background:#e2e7f0;"></span>
                <span style="font-size:15px; font-weight:750; color:#5f6368;">$688</span>
              </div>
            </div>
          </div>
        </div>
        <div style="background:#171827; border:1px solid rgba(255,255,255,0.12); border-radius:20px; padding:20px;
          color:#fff; box-shadow:0 24px 60px rgba(0,0,0,0.28);">
          <div style="font-size:15px; font-weight:800; color:#aeb4c9; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:14px;">WebBrain is acting</div>
          <div style="display:grid; gap:11px;">
            ${steps.map(([state, label]) => `
              <div style="display:grid; grid-template-columns:26px 1fr; gap:10px; align-items:center; font-size:15.5px; font-weight:640; color:${state === 'live' ? '#ffffff' : '#c9d0e0'};">
                <span style="width:26px; height:26px; border-radius:9px; display:grid; place-items:center; font-size:14px; font-weight:900;
                  background:${state === 'live' ? 'var(--accent2)' : 'rgba(101,214,157,0.22)'}; color:${state === 'live' ? '#fff' : '#65d69d'};">${state === 'live' ? '&#9679;' : '&#10003;'}</span>
                <span>${label}</span>
              </div>`).join('')}
          </div>
          <div style="margin-top:16px; padding-top:14px; border-top:1px solid rgba(255,255,255,0.1); color:#8d93a8; font-size:13px; font-weight:700;">
            Pauses before anything irreversible
          </div>
        </div>
      </div>`,
  };
}

/* ---------- 03 ASK ANY PAGE (cropped to the answer panel) ---------- */
function askScene() {
  // Source 1280x800. Relevant UI: sidebar below header x 905-1280, y 122-474. Scale 1.62.
  const s = 1.62;
  const x = 906, y = 122, w = 374, h = 352;
  return {
    file: '03-ask-any-page.png',
    theme: 'read',
    body: `
      <div style="display:flex; align-items:center; justify-content:space-between;">
        ${brandRow()}
        <span class="eyebrow"><span class="dot"></span>Ask mode</span>
      </div>
      <div style="display:grid; grid-template-columns: 480px 1fr; gap:48px; align-items:center; height:calc(100% - 60px);">
        <div>
          <h1>Ask any page.<br>Get the useful part.</h1>
          <div class="sub">Clean answers from messy pages. Read-only by default.</div>
        </div>
        <div style="display:flex; justify-content:center;">
          <div class="crop-frame" style="width:${w * s}px; height:${h * s}px; transform:rotate(1.1deg); background:#252838;">
            <img src="${assets.ask}" style="width:${1280 * s}px; margin-left:${-x * s}px; margin-top:${-y * s}px;" alt="">
          </div>
        </div>
      </div>`,
  };
}

/* ---------- 04 ANY LLM (cropped to model dropdown) ---------- */
function modelsScene() {
  // Source 1280x800. Relevant UI: dropdown+header x 418-1162, y 6-748. Scale 0.82.
  const s = 0.82;
  const x = 418, y = 6, w = 744, h = 742;
  return {
    file: '04-any-llm.png',
    theme: 'provider',
    body: `
      <div style="display:flex; align-items:center; justify-content:space-between;">
        ${brandRow()}
        <span class="eyebrow"><span class="dot"></span>Any LLM</span>
      </div>
      <div style="display:grid; grid-template-columns: 470px 1fr; gap:44px; align-items:center; height:calc(100% - 60px);">
        <div>
          <h1>Use the model you trust.</h1>
          <div class="sub">Local, cloud, or your own keys &mdash; switch anytime.</div>
        </div>
        <div style="display:flex; justify-content:center;">
          <div class="crop-frame" style="width:${w * s}px; height:${h * s}px; transform:rotate(-1.1deg);">
            <img src="${assets.models}" style="width:${1280 * s}px; margin-left:${-x * s}px; margin-top:${-y * s}px;" alt="">
          </div>
        </div>
      </div>`,
  };
}

/* ---------- 05 PLAN BEFORE ACT ---------- */
function planScene() {
  const steps = [
    'Read the visible form and required fields',
    'Fill only what you asked for',
    'Pause before any purchase or submit',
  ];
  return {
    file: '05-plan-before-act.png',
    theme: 'plan',
    body: `
      <div style="display:flex; align-items:center; justify-content:space-between;">
        ${brandRow()}
        <span class="eyebrow"><span class="dot"></span>Plan before Act</span>
      </div>
      <div style="display:grid; grid-template-columns: 500px 1fr; gap:48px; align-items:center; height:calc(100% - 60px);">
        <div>
          <h1>See the plan before it touches the page.</h1>
          <div class="sub">Approve first. You stay in the loop.</div>
        </div>
        <div style="display:flex; justify-content:center;">
          <div style="width:470px; padding:28px; background:#151c2a; border:1px solid rgba(255,255,255,0.16);
            border-radius:26px; box-shadow:0 30px 80px rgba(0,0,0,0.42); transform:rotate(1.1deg);">
            <div style="font-size:15px; font-weight:800; color:#8d99ad; text-transform:uppercase; letter-spacing:0.05em;">Proposed browser plan</div>
            <div style="display:grid; gap:14px; margin-top:20px;">
              ${steps.map((label, i) => `
                <div style="display:grid; grid-template-columns:36px 1fr; gap:14px; align-items:center; color:#d7e2ea; font-size:19px; font-weight:640; line-height:1.3;">
                  <span style="width:36px; height:36px; border-radius:12px; display:grid; place-items:center;
                    background:var(--accent); color:#102319; font-size:17px; font-weight:850;">${i + 1}</span>
                  <span>${label}</span>
                </div>`).join('')}
            </div>
            <div style="display:flex; gap:12px; margin-top:26px;">
              <span style="display:inline-flex; align-items:center; justify-content:center; min-width:140px; height:50px;
                border-radius:14px; background:var(--accent); color:#102319; font-size:17px; font-weight:800;">Approve</span>
              <span style="display:inline-flex; align-items:center; justify-content:center; min-width:140px; height:50px;
                border-radius:14px; border:1px solid rgba(255,255,255,0.2); background:rgba(255,255,255,0.07);
                color:#e9eef6; font-size:17px; font-weight:800;">Adjust</span>
            </div>
          </div>
        </div>
      </div>`,
  };
}

/* ---------- 06 LAUNCH OFFER ---------- */
function offerScene() {
  return {
    file: '06-launch-offer.png',
    theme: 'dark',
    body: `
      <div style="display:flex; align-items:center; justify-content:space-between;">
        ${brandRow()}
        <span class="eyebrow"><span class="dot"></span>Launch offer</span>
      </div>
      <div style="height:calc(100% - 60px); display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;">
        <h1 style="font-size:64px;">WebBrain Cloud launch pricing</h1>
        <div style="display:flex; align-items:baseline; gap:22px; margin-top:34px;">
          <span style="font-size:44px; font-weight:700; color:var(--muted); text-decoration:line-through; text-decoration-thickness:4px; text-decoration-color:var(--accent);">$8</span>
          <span style="font-size:120px; font-weight:850; line-height:1;">$5<span style="font-size:38px; font-weight:700; color:var(--muted);">/mo</span></span>
          <span style="padding:12px 18px; border-radius:999px; background:var(--accent); color:#fff; font-size:22px; font-weight:820; transform:rotate(3deg); box-shadow:0 14px 34px rgba(245,108,168,0.35);">Save 35%</span>
        </div>
        <div class="sub" style="font-size:24px; margin-top:30px;">No setup, no API keys &mdash; just install and go.</div>
        <div class="sub" style="font-size:19px; margin-top:12px; opacity:0.8;">Or free forever with your own keys or local models.</div>
      </div>`,
  };
}

const scenes = [hero(), actScene(), askScene(), modelsScene(), planScene(), offerScene()];

function html(scene) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <style>${baseCss}</style></head>
    <body><main class="canvas ${scene.theme}"><div class="content">${scene.body}</div></main></body></html>`;
}

async function renderAll() {
  await mkdir(DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const scene of scenes) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await page.setContent(html(scene), { waitUntil: 'load' });
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map((img) => img.complete ? undefined : new Promise((res, rej) => {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', rej, { once: true });
      })));
      await document.fonts.ready;
    });
    await page.screenshot({ path: path.join(DIR, scene.file) });
    await page.close();
    console.log('rendered', scene.file);
  }
  await browser.close();
}

renderAll().catch((error) => { console.error(error); process.exit(1); });
