import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../..');

// No product logo or wordmark in this variant — the Web Store already shows both beside the listing.
const assets = {
  ask: dataUri('assets/screenshot-1-ask-mode.png'),
  modelProviders: dataUri('assets/webstore-explainer-2026/model-providers-short.png'),
  safeSocial: dataUri('web/assets/webbrain-36-8-safesocial-instagram.png'),
};

const browserLogos = [
  ['Chrome', svgUri('chrome.svg')],
  ['Firefox', svgUri('firefox.svg')],
  ['Microsoft Edge', svgUri('edge.svg')],
  ['Opera', svgUri('opera.svg')],
  ['Vivaldi', svgUri('vivaldi.svg')],
  ['Brave Browser', svgUri('brave.svg')],
];

// Vendored so renders never depend on what happens to be installed locally. See fonts/OFL-*.txt.
const fonts = {
  display: fontUri('bricolage-grotesque-var.woff2'),
  sans: fontUri('instrument-sans-var.woff2'),
  mono: fontUri('geist-mono-var.woff2'),
};

function dataUri(relativePath) {
  const bytes = readFileSync(path.join(ROOT, relativePath));
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function svgUri(name) {
  const bytes = readFileSync(path.join(DIR, 'browser-logos', name));
  return `data:image/svg+xml;base64,${bytes.toString('base64')}`;
}

function fontUri(name) {
  const bytes = readFileSync(path.join(DIR, 'fonts', name));
  return `data:font/woff2;base64,${bytes.toString('base64')}`;
}

function avatarUri(name) {
  const bytes = readFileSync(path.join(DIR, 'contributor-avatars', name));
  const mime = path.extname(name).toLowerCase() === '.jpg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

const W = 1280;
const H = 800;

const baseCss = `
  @font-face { font-family: 'Bricolage Grotesque'; font-weight: 200 800; font-style: normal;
    src: url(${fonts.display}) format('woff2'); }
  @font-face { font-family: 'Instrument Sans'; font-weight: 400 700; font-style: normal;
    src: url(${fonts.sans}) format('woff2'); }
  @font-face { font-family: 'Geist Mono'; font-weight: 400 700; font-style: normal;
    src: url(${fonts.mono}) format('woff2'); }
  :root {
    color-scheme: light;
    --display: 'Bricolage Grotesque', ui-sans-serif, system-ui, sans-serif;
    --ui: 'Instrument Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
    --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; width: ${W}px; height: ${H}px; overflow: hidden;
    font-family: var(--ui);
    -webkit-font-smoothing: antialiased;
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
  .hero-light { --bg1:#f7f9ff; --bg2:#fff1f6; --ink:#141828; --muted:#586074;
    --accent:#d6417f; --accent2:#12a06a; --border:rgba(28,34,64,0.13);
    --panel:rgba(255,255,255,0.9); --shadow:0 28px 70px rgba(40,44,80,0.18); }
  .plan-light { --bg1:#f5fbf7; --bg2:#eef4ff; --ink:#141b26; --muted:#586374;
    --accent:#12a25f; --accent2:#dd9414; --border:rgba(24,38,48,0.13);
    --panel:rgba(255,255,255,0.9); --shadow:0 28px 70px rgba(28,50,44,0.18); }
  .proof { --bg1:#f7f6ff; --bg2:#eef4ff; --ink:#171a2b; --muted:#5a6274;
    --accent:#6e56cf; --accent2:#f0a52b; --border:rgba(30,34,64,0.13);
    --panel:rgba(255,255,255,0.9); --shadow:0 28px 70px rgba(38,34,78,0.18); }
  .apocalypse { --bg1:#11100e; --bg2:#1c1a14; --ink:#f5f0e6; --muted:#a89e8a;
    --accent:#f7bd5f; --accent2:#f0a72f; --border:rgba(247,189,95,0.22);
    --panel:rgba(247,189,95,0.07); --shadow:0 28px 70px rgba(0,0,0,0.5); }
  .release { --bg1:#f5f7ff; --bg2:#fff3f7; --ink:#171827; --muted:#586174;
    --accent:#6757ff; --accent2:#ec6797; --border:rgba(37,42,66,0.13);
    --panel:rgba(255,255,255,0.9); --shadow:0 28px 70px rgba(46,42,90,0.18); }
  .content { position: relative; z-index: 1; padding: 38px 48px; }
  h1 {
    margin: 18px 0 0; font-family: var(--display); font-size: 62px; line-height: 1.05;
    font-weight: 800; letter-spacing: -0.02em; font-variation-settings: 'opsz' 72;
    text-wrap: balance;
  }
  .sub { margin-top: 16px; color: var(--muted); font-size: 24px; font-weight: 520; letter-spacing: -0.005em; }
  .num { font-family: var(--display); font-weight: 800; letter-spacing: -0.03em;
    font-variation-settings: 'opsz' 96; }
  .stack { height: 100%; display: flex; flex-direction: column; justify-content: center; }
  .crop-frame {
    overflow: hidden; border: 1px solid var(--border); border-radius: 24px;
    background: #ffffff; box-shadow: var(--shadow); position: relative;
  }
  .crop-frame img { display: block; }
`;

/* ---------- 01 HERO (dark + light variant) ---------- */
function hero(light = false) {
  return {
    scale: 1.3,
    file: light ? '01-hero-light.png' : '01-hero.png',
    theme: light ? 'hero-light' : 'dark',
    body: `
      <div style="height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;">
        <div style="font-family:var(--mono); font-size:16px; font-weight:650; letter-spacing:0.2em;
          text-transform:uppercase; color:var(--muted);">WebBrain</div>
        <h1 style="margin-top:26px; font-size:78px; line-height:1.03; max-width:960px;">Your open-source<br>AI browser agent</h1>
        <div class="sub" style="font-size:29px; font-weight:600; color:var(--ink); margin-top:24px;">
          <span style="color:var(--accent);">Ask.</span>
          <span style="color:var(--accent2);">Act.</span>
          Automate. <span style="opacity:0.85;">Any LLM.</span>
        </div>
        <div style="display:flex; gap:10px; margin-top:30px;">
          ${['Chromium browsers and Firefox', 'Local or cloud models', 'GPL-3.0+ licensed'].map((c) => `
            <span style="padding:11px 16px; border:1px solid var(--border); background:var(--panel);
              border-radius:999px; font-family:var(--mono); font-size:13.5px; font-weight:650;
              letter-spacing:0.05em; text-transform:uppercase; color:var(--muted);">${c}</span>`).join('')}
        </div>
        <div style="display:flex; align-items:center; justify-content:center; gap:14px; margin-top:20px;"
          aria-label="Supported browsers">
          ${browserLogos.map(([name, src]) => `
            <span title="${name}" style="width:46px; height:46px; display:grid; place-items:center;
              border:1px solid var(--border); border-radius:14px; background:rgba(255,255,255,0.92);
              box-shadow:0 10px 24px rgba(34,40,72,0.10);">
              <img src="${src}" alt="${name}" style="display:block; width:30px; height:30px; object-fit:contain;">
            </span>`).join('')}
        </div>
      </div>`,
  };
}

/* ---------- 02 TELL THE BROWSER (command front and center) ---------- */
function actScene(onboarding = false) {
  const steps = [
    ['done', 'Found the flight search form'],
    ['done', 'Typed “Istanbul (IST)”'],
    ['done', 'Typed “San Francisco (SFO)”'],
    ['live', 'Clicking Search…'],
  ];
  return {
    scale: 1.08,
    file: '02-tell-the-browser.png',
    onboarding,
    theme: 'act',
    body: `
      <div class="stack">
      ${onboarding
        ? '<div aria-hidden="true" style="height:61px;"></div>'
        : `<div style="text-align:center;">
            <h1 style="margin:0; font-size:58px;">Tell the browser what to do.</h1>
          </div>`}

      <!-- The command, front and center -->
      <div style="width:940px; margin:40px auto 0; display:flex; align-items:center; gap:16px;
        background:#ffffff; border:1px solid var(--border); border-radius:22px; padding:20px 22px;
        box-shadow:0 24px 60px rgba(68,50,40,0.18);">
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
              font-family:var(--mono); font-size:12.5px; font-weight:500; display:flex; align-items:center;
              padding:0 12px;">google.com/travel/flights</span>
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
          <div style="font-family:var(--mono); font-size:13px; font-weight:650; color:#aeb4c9;
            text-transform:uppercase; letter-spacing:0.07em; margin-bottom:16px;">WebBrain is acting</div>
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
      </div>
      </div>`,
  };
}

/* ---------- 03 ASK ANY PAGE (cropped to the answer panel) ---------- */
function askScene(onboarding = false) {
  // Source 1280x800. Relevant UI: sidebar below header x 905-1280, y 122-474. Scale 1.62.
  const s = 1.62;
  const x = 906, y = 122, w = 374, h = 352;
  return {
    scale: 1.03,
    file: '03-ask-any-page.png',
    onboarding,
    theme: 'read',
    body: `
      <div style="display:grid; grid-template-columns: 480px 1fr; gap:48px; align-items:center; height:100%;">
        <div>${onboarding ? '' : `
          <h1>Ask any page.<br>Get the useful part.</h1>
          <div class="sub">Clean answers from messy pages. Read-only by default.</div>
        `}</div>
        <div style="display:flex; justify-content:center;">
          <div class="crop-frame" style="width:${w * s}px; height:${h * s}px; transform:rotate(1.1deg); background:#252838;">
            <img src="${assets.ask}" style="width:${1280 * s}px; margin-left:${-x * s}px; margin-top:${-y * s}px;" alt="">
          </div>
        </div>
      </div>`,
  };
}

/* ---------- 04 ANY LLM (large provider rows, cropped to their useful content) ---------- */
function modelsScene(onboarding = false) {
  // Source 1472x976. Each provider card is isolated so the screenshot's beige
  // backdrop disappears. The left 924px carries the useful identity/model data;
  // the masked edge lets it fade naturally into the slide rather than looking cut.
  const sourceW = 1472;
  const sourceScale = 0.7;
  const cropX = 18;
  const cropW = 924;
  const cropH = 91;
  const rowStarts = [23, 143, 263, 383, 503, 623, 743, 863];
  const displayW = cropW * sourceScale;
  const displayH = cropH * sourceScale;
  return {
    scale: 1.04,
    file: '04-any-llm.png',
    onboarding,
    theme: 'provider',
    body: `
      <div style="display:grid; grid-template-columns: 430px 1fr; gap:28px; align-items:center; height:100%;">
        <div>${onboarding ? '' : `
          <h1>Use the model you trust.</h1>
          <div class="sub">Local, cloud, or your own keys &mdash; switch anytime.</div>
          <div style="display:inline-flex; align-items:center; margin-top:38px; padding:11px 20px;
            border:1px solid var(--border); border-radius:999px; background:rgba(255,255,255,0.68);
            color:var(--muted); font-size:15px; font-weight:700; box-shadow:0 8px 24px rgba(24,52,90,0.06);">
            100+ providers are supported!
          </div>
        `}</div>
        <div style="display:grid; gap:10px; justify-content:start; align-content:center;">
          ${rowStarts.map((y, index) => `
            <div style="position:relative; width:${displayW}px; height:${displayH}px; overflow:hidden;
              border-radius:12px;
              -webkit-mask-image:linear-gradient(to right, #000 0%, #000 86%, transparent 100%);
              mask-image:linear-gradient(to right, #000 0%, #000 86%, transparent 100%);
              filter:drop-shadow(0 9px 14px rgba(24,52,90,${index === 2 ? '0.10' : '0.055'}));">
              <img src="${assets.modelProviders}" alt="" style="position:absolute; display:block;
                width:${sourceW * sourceScale}px; max-width:none;
                left:${-cropX * sourceScale}px; top:${-y * sourceScale}px;">
            </div>`).join('')}
        </div>
      </div>`,
  };
}

/* ---------- 05 PLAN BEFORE ACT (dark + light variant) ---------- */
function planScene(light = false) {
  const steps = [
    'Read the visible form and required fields',
    'Fill only what you asked for',
    'Pause before any purchase or submit',
  ];
  const card = light
    ? { bg: '#ffffff', border: 'var(--border)', shadow: '0 30px 70px rgba(28,50,44,0.18)',
        label: 'var(--muted)', step: 'var(--ink)', onAccent: '#ffffff' }
    : { bg: '#151c2a', border: 'rgba(255,255,255,0.16)', shadow: '0 30px 80px rgba(0,0,0,0.42)',
        label: '#8d99ad', step: '#d7e2ea', onAccent: '#102319' };
  return {
    scale: 1.22,
    file: light ? '05-plan-before-act-light.png' : '05-plan-before-act.png',
    theme: light ? 'plan-light' : 'plan',
    body: `
      <div style="display:grid; grid-template-columns: 440px 1fr; gap:40px; align-items:center; height:100%;">
        <div>
          <h1>See the plan before it touches the page.</h1>
          <div class="sub">Approve first. You stay in the loop.</div>
        </div>
        <div style="display:flex; justify-content:center;">
          <div style="width:470px; padding:28px; background:${card.bg}; border:1px solid ${card.border};
            border-radius:26px; box-shadow:${card.shadow}; transform:rotate(1.1deg);">
            <div style="font-family:var(--mono); font-size:13px; font-weight:650; color:${card.label};
              text-transform:uppercase; letter-spacing:0.07em;">Proposed browser plan</div>
            <div style="display:grid; gap:14px; margin-top:20px;">
              ${steps.map((label, i) => `
                <div style="display:grid; grid-template-columns:36px 1fr; gap:14px; align-items:center; color:${card.step}; font-size:19px; font-weight:640; line-height:1.3;">
                  <span style="width:36px; height:36px; border-radius:12px; display:grid; place-items:center;
                    background:var(--accent); color:${card.onAccent}; font-size:17px; font-weight:850;">${i + 1}</span>
                  <span>${label}</span>
                </div>`).join('')}
            </div>
            <div style="display:flex; gap:12px; margin-top:26px;">
              <span style="display:inline-flex; align-items:center; justify-content:center; min-width:140px; height:50px;
                border-radius:14px; background:var(--accent); color:${card.onAccent}; font-size:17px; font-weight:800;">Approve</span>
              <span style="display:inline-flex; align-items:center; justify-content:center; min-width:140px; height:50px;
                border-radius:14px; border:1px solid ${light ? 'var(--border)' : 'rgba(255,255,255,0.2)'};
                background:${light ? '#f4f6fa' : 'rgba(255,255,255,0.07)'};
                color:${light ? 'var(--ink)' : '#e9eef6'}; font-size:17px; font-weight:800;">Adjust</span>
            </div>
          </div>
        </div>
      </div>`,
  };
}

/* ---------- 06 LAUNCH OFFER ---------- */
function offerScene() {
  return {
    scale: 1.3,
    file: '06-launch-offer.png',
    theme: 'dark',
    body: `
      <div style="height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;">
        <h1 style="font-size:60px;">WebBrain Compass launch pricing</h1>
        <div style="display:flex; align-items:baseline; gap:28px; margin-top:30px;">
          <!-- Bricolage sets line-through low on heavy figures, so the strike is drawn manually. -->
          <span class="num" style="position:relative; font-size:60px; line-height:1; color:var(--muted);">$8
            <span style="position:absolute; left:-8%; right:-8%; top:46%; height:5px; border-radius:3px;
              background:var(--accent); transform:rotate(-7deg);"></span>
          </span>
          <span class="num" style="font-size:122px; line-height:1;">$5<span style="font-family:var(--ui); font-size:32px; font-weight:600; color:var(--muted); letter-spacing:0; margin-left:4px;">/mo</span></span>
          <span style="padding:13px 19px; border-radius:999px; background:var(--accent); color:#fff; font-family:var(--mono); font-size:18px; font-weight:600; letter-spacing:0.06em;
            text-transform:uppercase; transform:rotate(3deg); box-shadow:0 14px 34px rgba(245,108,168,0.35);">Save 35%</span>
        </div>
        <div class="sub" style="font-size:24px; margin-top:30px;">No setup, no API keys &mdash; just install and go.</div>
        <div class="sub" style="font-size:19px; margin-top:12px; opacity:0.8;">Or free forever with your own keys or local models.</div>
      </div>`,
  };
}

/* ---------- 07 SOCIAL PROOF ---------- */
function proofScene() {
  const icon = (paths, color) =>
    `<svg width="46" height="46" viewBox="0 0 24 24" fill="${color}" aria-hidden="true">${paths}</svg>`;
  const stats = [
    [icon('<path d="M12 2.2l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.27l-5.9 3.1 1.13-6.57L2.45 9.14l6.6-.96z"/>', 'var(--accent2)'),
      '1700+', 'GitHub stars'],
    [icon('<path d="M9 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5Zm7.2.3a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2ZM9 13.2c-3.4 0-6.6 1.75-6.6 3.9V20h13.2v-2.9c0-2.15-3.2-3.9-6.6-3.9Zm7.2.2c-.62 0-1.2.05-1.74.14 1.2.94 1.94 2.11 1.94 3.56V20h5.2v-2.5c0-1.9-2.5-3.1-5.4-3.1Z"/>', 'var(--accent)'),
      '100+', 'contributors'],
    [icon('<path d="M12 2.4c.6 0 1.1.5 1.1 1.1v.9l6.4 1.2a1 1 0 0 1-.18 1.98l-.5-.02 2.6 5.9c0 1.9-1.75 3.15-3.6 3.15s-3.6-1.25-3.6-3.15l2.55-5.8-3.67-.68V18.6h3.3a1.1 1.1 0 1 1 0 2.2H7.6a1.1 1.1 0 1 1 0-2.2h3.3V6.81l-3.67.68 2.55 5.8c0 1.9-1.75 3.15-3.6 3.15s-3.6-1.25-3.6-3.15l2.6-5.9-.5.02a1 1 0 0 1-.18-1.98l6.4-1.2v-.9c0-.6.5-1.1 1.1-1.1Zm5.82 7.7-1.5 3.42h3l-1.5-3.42Zm-11.64 0-1.5 3.42h3l-1.5-3.42Z"/>', 'var(--accent)'),
      'GPL', 'open-source forever'],
  ];
  // Human contributors from GitHub, ordered with the project creator first.
  // Bot, automation, AI-agent, and project-brand accounts are intentionally excluded.
  const avatars = [
    ['esokullu', 'esokullu.jpg'],
    ['alectimison-maker', 'alectimison-maker.jpg'],
    ['fly1d', 'fly1d.png'],
    ['Ayush7614', 'Ayush7614.png'],
    ['Elijah-hash7', 'Elijah-hash7.png'],
    ['Ohualtex', 'Ohualtex.jpg'],
    ['EvanLind', 'EvanLind.png'],
    ['azghr', 'azghr.jpg'],
    ['feiniao87968492', 'feiniao87968492.png'],
  ];
  return {
    scale: 1.12,
    file: '07-social-proof.png',
    theme: 'proof',
    body: `

      <div class="stack">
      <div style="text-align:center;">
        <h1 style="margin:0; font-size:64px;">Built in the open.</h1>
      </div>

      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:26px; width:1040px; margin:52px auto 0;">
        ${stats.map(([glyph, value, label]) => `
          <div style="background:var(--panel); border:1px solid var(--border); border-radius:26px;
            padding:40px 24px 36px; text-align:center; box-shadow:var(--shadow);">
            <div style="height:46px; line-height:0;">${glyph}</div>
            <div class="num" style="margin-top:20px; font-size:84px; line-height:1;">${value}</div>
            <div style="margin-top:14px; font-size:22px; font-weight:680; color:var(--muted);">${label}</div>
          </div>`).join('')}
      </div>

      <div style="width:1040px; margin:44px auto 0; display:flex; align-items:center; justify-content:space-between;
        gap:24px; background:#171827; border:1px solid rgba(255,255,255,0.12); border-radius:22px;
        padding:22px 26px; color:#fff; box-shadow:0 24px 60px rgba(23,26,43,0.3);">
        <div style="display:flex; align-items:center; gap:14px; min-width:0;">
          <svg width="34" height="34" viewBox="0 0 16 16" fill="#ffffff" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
          </svg>
          <div style="min-width:0;">
            <div style="font-family:var(--mono); font-size:19px; font-weight:600;">github.com/webbrain-one/webbrain</div>
            <div style="font-size:15px; font-weight:640; color:#9ba3b8; margin-top:4px;">Star it, fork it, ship a PR.</div>
          </div>
        </div>
        <div style="display:flex; align-items:center;">
          <div style="display:flex; align-items:center;">
            ${avatars.map(([handle, src], i) => `
              <span title="@${handle}" style="width:44px; height:44px; border-radius:999px; overflow:hidden;
                display:block; flex:0 0 auto; border:2px solid #171827; margin-left:${i === 0 ? 0 : -12}px;">
                <img src="${avatarUri(src)}" alt="@${handle}" style="width:100%; height:100%; object-fit:cover; display:block;">
              </span>`).join('')}
            <span style="height:44px; padding:0 14px; border-radius:999px; background:rgba(255,255,255,0.14);
              color:#e7eaf3; display:grid; place-items:center; font-size:15px; font-weight:800;
              border:2px solid #171827; margin-left:-12px;">+95</span>
          </div>
        </div>
      </div>
      </div>`,
  };
}

/* ---------- 08 APOCALYPSE MODE ---------- */
function apocalypseScene({ nuke = false, onboarding = false } = {}) {
  const modules = [
    ['T', 'Text Model', 'ON DEVICE · 2.6B', 'LOCAL'],
    ['V', 'Vision Model', 'ON DEVICE · SCREENSHOTS', 'LOCAL'],
    ['W', 'Wikipedia', 'OFFLINE ARCHIVE · SEARCHABLE', 'OFFLINE'],
    ['+', 'Emergency Box', 'PDFs · MANUALS · GUIDES', 'OFFLINE'],
  ];
  return {
    scale: 1.08,
    file: nuke ? '09-apocalypse-mode-nuke.png' : '08-apocalypse-mode.png',
    onboarding,
    theme: 'apocalypse',
    body: `
      <div style="display:grid; grid-template-columns:440px 1fr; gap:48px; align-items:center; height:100%; padding-left:16px;">
        <div>${onboarding ? '' : `
          <div style="display:inline-flex; align-items:center; gap:10px; margin-bottom:20px;">
            ${nuke ? '' : '<span style="width:10px; height:10px; border-radius:99px; background:var(--accent2); box-shadow:0 0 12px var(--accent2), 0 0 24px rgba(247,189,95,0.3);"></span>'}
            <span style="font-family:var(--mono); font-size:15px; font-weight:650; color:var(--accent);
              text-transform:uppercase; letter-spacing:0.14em;">${nuke ? '<span style="font-size:52px; font-family:\'Apple Color Emoji\',\'Segoe UI Emoji\',sans-serif; vertical-align:-6px;">\u2622</span> ' : ''}Apocalypse Mode</span>
          </div>
          <h1 style="font-size:62px; line-height:1.05; max-width:440px;">WebBrain, ready when the internet isn't.</h1>
          <div class="sub" style="font-size:25px; margin-top:24px; color:var(--muted); max-width:420px;">
            Offline knowledge, under your control. Download the essentials while you still can.
          </div>
        `}</div>
        <div style="display:flex; justify-content:center;">
          <div style="width:440px; background:rgba(0,0,0,0.45); border:1px solid var(--border);
            border-radius:22px; padding:0; overflow:hidden; box-shadow:var(--shadow);">
            <div style="display:flex; justify-content:space-between; align-items:center;
              padding:16px 22px; border-bottom:1px solid rgba(247,189,95,0.12);">
              <span style="font-family:var(--mono); font-size:13px; font-weight:650; color:var(--muted);
                letter-spacing:0.07em;">WB // OFFLINE KIT</span>
              <span style="font-family:var(--mono); font-size:12px; font-weight:700; color:var(--accent2);
                background:rgba(240,167,47,0.15); padding:4px 12px; border-radius:999px;
                letter-spacing:0.1em;">READY</span>
            </div>
            <div style="padding:10px 16px 14px; display:grid; gap:0;">
              ${modules.map(([icon, title, subtitle, badge], i) => `
                <div style="display:grid; grid-template-columns:44px 1fr auto; gap:14px; align-items:center;
                  padding:14px 6px; ${i < modules.length - 1 ? 'border-bottom:1px solid rgba(247,189,95,0.1);' : ''}">
                  <span style="width:44px; height:44px; border-radius:12px; background:rgba(247,189,95,0.1);
                    color:var(--accent); display:grid; place-items:center; font-family:var(--mono);
                    font-size:19px; font-weight:700;">${icon}</span>
                  <div style="min-width:0;">
                    <div style="font-size:17px; font-weight:700; color:var(--ink);">${title}</div>
                    <div style="font-family:var(--mono); font-size:12.5px; font-weight:600; color:var(--muted);
                      letter-spacing:0.06em; text-transform:uppercase; margin-top:3px;">${subtitle}</div>
                  </div>
                  <span style="font-family:var(--mono); font-size:11px; font-weight:700;
                    color:${badge === 'LOCAL' ? 'var(--accent2)' : '#65d69d'};
                    background:${badge === 'LOCAL' ? 'rgba(240,167,47,0.15)' : 'rgba(101,214,157,0.15)'};
                    padding:5px 11px; border-radius:999px; letter-spacing:0.1em;
                    white-space:nowrap;">${badge}</span>
                </div>`).join('')}
            </div>
          </div>
        </div>
      </div>`,
  };
}

/* ---------- 10–13 FEATURE SLIDES (same structure as 03–05: big title, one-line sub, one focused card) ---------- */
const featureCard = 'width:470px; padding:28px; background:#ffffff; border:1px solid var(--border); border-radius:26px; box-shadow:var(--shadow); transform:rotate(1deg);';
const cardLabel = 'font-family:var(--mono); font-size:13px; font-weight:650; letter-spacing:0.07em; text-transform:uppercase; color:var(--muted);';

function featureScene(file, title, sub, card) {
  return {
    scale: 1.22,
    file,
    theme: 'release',
    body: `
      <div style="display:grid; grid-template-columns: 440px 1fr; gap:40px; align-items:center; height:100%;">
        <div>
          <h1>${title}</h1>
          <div class="sub">${sub}</div>
        </div>
        <div style="display:flex; justify-content:center;">${card}</div>
      </div>`,
  };
}

/* ---------- 10 FULL-PAGE SCREENSHOTS (/screenshot command) ---------- */
function screenshotScene() {
  const bars = [['#e9e6ff', 44], ['#f1f3f8', 24], ['#ffe9f1', 44], ['#f1f3f8', 24], ['#e4f6ec', 44]];
  return featureScene('10-full-page-screenshots.png', 'Capture the full page.',
    'Just type <span style="font-family:var(--mono); font-weight:650; color:var(--accent);">/screenshot</span>.', `
    <div style="${featureCard}">
      <div style="${cardLabel} ">Full page</div>
      <div style="margin-top:12px; border:2px dashed var(--accent); border-radius:16px; padding:12px; background:rgba(103,87,255,0.04);">
        <div style="display:grid; gap:8px;">
          <div style="height:12px; width:50%; border-radius:99px; background:#cfd5e3;"></div>
          ${bars.map(([c, h]) => `<div style="height:${h}px; border-radius:9px; background:${c};"></div>`).join('')}
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:12px; padding:14px 16px; border:1px solid var(--border); border-radius:16px; background:#fbfbfe; margin-top:20px;">
        <span style="flex:1; font-family:var(--mono); font-size:22px; font-weight:650; color:var(--ink);">/screenshot<span
          style="display:inline-block; width:3px; height:24px; background:var(--accent); margin-left:4px; vertical-align:-4px; border-radius:2px;"></span></span>
        <span style="width:40px; height:40px; border-radius:12px; background:var(--accent); color:#fff; display:grid; place-items:center; font-size:19px; font-weight:900;">&#8593;</span>
      </div>
    </div>`);
}

/* ---------- 11 DOWNLOADS (social media videos/photos + bulk files) ---------- */
function bulkDownloadScene() {
  const files = [
    ['X', 'video.mp4', 'MP4', '#171827'],
    ['YouTube', 'clip.mp4', 'MP4', '#e5484d'],
    ['Instagram', 'photo.jpg', 'JPG', '#d6417f'],
    ['example.com', 'report.pdf', 'PDF', '#3e6ff4'],
  ];
  return featureScene('11-bulk-file-downloads.png', 'Download them all.',
    'Videos and photos from X, YouTube, Instagram, and more.', `
    <div style="${featureCard}">
      <div style="${cardLabel}">4 files · one task</div>
      <div style="display:grid; gap:12px; margin-top:18px;">
        ${files.map(([source, name, type, color]) => `
          <div style="display:grid; grid-template-columns:1fr auto 28px; gap:12px; align-items:center; padding:12px 16px; border:1px solid var(--border); border-radius:14px; background:#fffefd;">
            <span>
              <span style="display:block; font-size:19px; font-weight:750; color:var(--ink);">${name}</span>
              <span style="display:block; margin-top:2px; font-family:var(--mono); font-size:12px; font-weight:650; letter-spacing:0.05em; text-transform:uppercase; color:var(--muted);">${source}</span>
            </span>
            <span style="padding:5px 11px; border-radius:7px; background:${color}1c; color:${color}; font-family:var(--mono); font-size:12.5px; font-weight:800; letter-spacing:0.05em;">${type}</span>
            <span style="width:28px; height:28px; border-radius:9px; display:grid; place-items:center; background:rgba(40,169,107,0.16); color:#1c8a56; font-size:15px; font-weight:900;">&#10003;</span>
          </div>`).join('')}
      </div>
    </div>`);
}

/* ---------- 12 CAPTCHA ASSISTANCE ---------- */
function captchaScene() {
  const steps = [['done', 'Page blocked by a challenge'], ['done', 'Sent to your solving service'], ['live', 'Waiting for the solution…']];
  return featureScene('12-captcha-assistance.png', 'Don’t stall on a CAPTCHA.', 'Connect a supported solving service.', `
    <div style="${featureCard}">
      <div style="${cardLabel}">CAPTCHA assistance</div>
      <div style="border:1px solid #dfe3ee; border-radius:14px; padding:16px; background:#f8f9fc; margin-top:16px;">
        <div style="display:flex; align-items:center; gap:14px; border:1px solid #d3d8e4; border-radius:8px; background:#fff; padding:16px;">
          <span style="width:28px; height:28px; border-radius:6px; border:2px solid #b4bccd;"></span>
          <span style="font-size:19px; font-weight:650; color:#3a4254;">I'm not a robot</span>
        </div>
      </div>
      <div style="display:grid; gap:12px; margin-top:20px;">
        ${steps.map(([state, label]) => `
          <div style="display:grid; grid-template-columns:28px 1fr; gap:12px; align-items:center; font-size:17px; font-weight:720; color:var(--ink);">
            <span style="width:28px; height:28px; border-radius:9px; display:grid; place-items:center; font-size:14px; font-weight:900;
              ${state === 'live' ? 'background:var(--accent); color:#fff;' : 'background:rgba(40,169,107,0.16); color:#1c8a56;'}">${state === 'live' ? '&#9679;' : '&#10003;'}</span>
            <span>${label}</span>
          </div>`).join('')}
      </div>
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--border); font-size:14px; font-weight:600; line-height:1.4; color:var(--muted);">
        Optional setup. Separate service account required; charges may apply.
      </div>
    </div>`);
}

/* ---------- 13 SAFESOCIAL ---------- */
function safeSocialScene() {
  return featureScene('13-safesocial.png', 'Give your mind a break from the feed.', 'A calmer Instagram, filtered on device.', `
    <div style="${featureCard}">
      <div style="${cardLabel}">SafeSocial</div>
      <div style="height:230px; position:relative; overflow:hidden; border-radius:16px; margin-top:16px; background:#ececf2;">
        <img src="${assets.safeSocial}" alt="" style="width:100%; height:100%; object-fit:cover; object-position:70% 51%; display:block; filter:blur(3px) saturate(0.72); transform:scale(1.04); opacity:0.83;">
        <div style="position:absolute; inset:0; background:linear-gradient(90deg, rgba(255,255,255,0.7), rgba(255,255,255,0.2));"></div>
        <div style="position:absolute; inset:0; display:grid; place-items:center;">
          <div style="padding:14px 22px; border-radius:13px; background:#202a3a; color:#fff; font-size:18px; font-weight:750; box-shadow:0 10px 20px rgba(32,42,58,0.22);">Show image</div>
        </div>
      </div>
      <div style="margin-top:18px; font-size:15px; font-weight:650; color:var(--muted);">Optional · runs on your device · off by default</div>
    </div>`);
}

/* ---------- 14 VIDEO RECORDING ---------- */
function recordScene() {
  const participants = [
    ['AL', 'Alex', '#d9d1fb', '#6757b7'], ['JM', 'Jamie', '#cde9df', '#337b67'],
    ['SK', 'Sam', '#f7daca', '#ad6948'], ['YOU', 'You', '#d1dff8', '#4b6eae'],
  ];
  return featureScene('14-record-video.png', 'Keep the whole call.',
    'Record Zoom calls, demos, and more.<br>Just type <span style="font-family:var(--mono); font-weight:650; color:var(--accent);">/record</span>.', `
    <div style="${featureCard}">
      <div style="display:flex; align-items:center; justify-content:space-between;">
        <span style="${cardLabel}">Video recording</span>
        <span style="display:flex; align-items:center; gap:7px; font-family:var(--mono); font-size:13px; font-weight:650; color:#cc4456;">
          <span style="width:9px; height:9px; border-radius:50%; background:#e54f62;"></span>REC · 12:34
        </span>
      </div>
      <div style="margin-top:18px; padding:12px; border-radius:16px; background:#202636;">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
          ${participants.map(([initials, name, bg, ink]) => `
            <div style="height:105px; position:relative; display:grid; place-items:center; background:${bg}; border-radius:9px;">
              <span style="width:52px; height:52px; display:grid; place-items:center; border-radius:50%; background:${ink}; color:#fff; font-size:${initials === 'YOU' ? 15 : 21}px; font-weight:700;">${initials}</span>
              <span style="position:absolute; bottom:6px; left:7px; padding:3px 7px; border-radius:4px; background:rgba(24,32,51,0.76); color:#fff; font-size:11px; font-weight:650;">${name}</span>
            </div>`).join('')}
        </div>
        <div style="display:flex; align-items:center; gap:10px; margin-top:12px; color:#e1e6ef; font-size:12px; font-weight:600;">
          <span style="font-size:16px;">▶</span>
          <span style="height:4px; flex:1; border-radius:8px; background:#51596c;"><span style="display:block; width:65%; height:4px; border-radius:8px; background:#b1a3ff;"></span></span>
          <span>12:34</span>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:12px; padding:14px 16px; border:1px solid var(--border); border-radius:16px; background:#fbfbfe; margin-top:20px;">
        <span style="flex:1; font-family:var(--mono); font-size:22px; font-weight:650; color:var(--ink);">/record<span style="display:inline-block; width:3px; height:24px; background:var(--accent); margin-left:4px; vertical-align:-4px; border-radius:2px;"></span></span>
        <span style="width:40px; height:40px; border-radius:12px; background:var(--accent); color:#fff; display:grid; place-items:center; font-size:19px; font-weight:900;">&#8593;</span>
      </div>
      <div style="margin-top:16px; font-size:14px; font-weight:600; line-height:1.4; color:var(--muted);">Tab: /record · Screen or window: /record --full-screen</div>
    </div>`);
}

const scenes = [
  hero(), actScene(), askScene(), modelsScene(), planScene(), offerScene(), proofScene(),
  apocalypseScene(),
  apocalypseScene({ nuke: true }),
  screenshotScene(), bulkDownloadScene(), captchaScene(), safeSocialScene(), recordScene(),
  hero(true), planScene(true),
  // The install page renders localized HTML over these copy-free variants.
  // Keep the Web Store artwork above unchanged: its English copy is intentional.
  actScene(true), askScene(true), modelsScene(true),
];

function html(scene) {
  return `<!doctype html><html><head><meta charset="utf-8">
    <style>${baseCss}</style></head>
    <body><main class="canvas ${scene.theme}"><div class="content" style="width:${W / (scene.scale ?? 1)}px;
      height:${H / (scene.scale ?? 1)}px; zoom:${scene.scale ?? 1};">${scene.body}</div></main></body></html>`;
}

async function renderAll() {
  await mkdir(DIR, { recursive: true });
  const browser = await chromium.launch();
  const only = new Set((process.env.ONLY ?? '').split(',').map((name) => name.trim()).filter(Boolean));
  for (const scene of scenes.filter((candidate) => {
    const renderName = candidate.onboarding ? `onboarding/${candidate.file}` : candidate.file;
    return only.size === 0 || only.has(renderName);
  })) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await page.setContent(html(scene), { waitUntil: 'load' });
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map((img) => img.complete ? undefined : new Promise((res, rej) => {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', rej, { once: true });
      })));
      await document.fonts.ready;
    });
    const outputPaths = scene.onboarding
      ? ['chrome', 'firefox'].map((browserName) => path.join(
          ROOT, 'src', browserName, 'src', 'ui', 'install-assets', scene.file,
        ))
      : [path.join(DIR, scene.file)];
    await mkdir(path.dirname(outputPaths[0]), { recursive: true });
    await page.screenshot({ path: outputPaths[0] });
    for (const outputPath of outputPaths.slice(1)) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await copyFile(outputPaths[0], outputPath);
    }
    await page.close();
    console.log('rendered', scene.onboarding ? `onboarding/${scene.file}` : scene.file);
  }
  await browser.close();
}

renderAll().catch((error) => { console.error(error); process.exit(1); });
