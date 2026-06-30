import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '../..');

const assets = {
  logo: dataUri('assets/store-icon-128.png'),
  ask: dataUri('assets/screenshot-1-ask-mode.png'),
  act: dataUri('assets/screenshot-2-act-mode.png'),
  settings: dataUri('assets/screenshot-3-settings.png'),
  search: dataUri('assets/screenshots_v1/s6-act-search.png'),
};

const scenes = [
  {
    file: '01-ask-any-page.png',
    width: 1280,
    height: 800,
    theme: 'read',
    label: 'Ask mode',
    title: 'Ask any page. Get the useful part fast.',
    body: 'WebBrain reads the current tab, turns messy pages into clean answers, and stays read-only by default.',
    chips: ['Summaries', 'Links', 'Tables', 'PDFs', 'Page structure'],
    screenshot: assets.ask,
    direction: 'copy-left',
    prompt: 'Summarize this article in 3 bullet points',
    note: 'Read-only by default',
  },
  {
    file: '02-act-browser-control.png',
    width: 1280,
    height: 800,
    theme: 'act',
    label: 'Act mode',
    title: 'Tell the browser what to do.',
    body: 'When you approve Act mode, WebBrain can click, type, scroll, navigate, and complete multi-step tasks in the page.',
    chips: ['Click', 'Type', 'Scroll', 'Navigate', 'Wait and verify'],
    screenshot: assets.act,
    direction: 'copy-left',
    prompt: 'Search for flights and compare the best options',
    note: 'Visible page inspection banner',
  },
  {
    file: '03-plan-before-act.png',
    width: 1280,
    height: 800,
    theme: 'plan',
    label: 'Plan before Act',
    title: 'Review the plan before WebBrain touches the page.',
    body: 'For sensitive workflows, WebBrain can draft the steps first, wait for approval, then pin the approved plan to context.',
    chips: ['Inspect', 'Plan', 'Approve', 'Run', 'Keep context'],
    kind: 'plan',
  },
  {
    file: '04-any-llm-your-choice.png',
    width: 1280,
    height: 800,
    theme: 'provider',
    label: 'Any LLM',
    title: 'Use the model you trust.',
    body: 'Choose WebBrain Cloud, local models, OpenAI, Anthropic, Gemini, OpenRouter, or any OpenAI-compatible endpoint.',
    chips: ['Cloud or local', 'Your keys', 'Open source', 'Per-provider settings'],
    screenshot: assets.settings,
    direction: 'copy-left',
    prompt: 'Switch providers without changing how you browse',
    note: 'Provider-agnostic browser agent',
  },
  {
    file: '05-real-workflows.png',
    width: 1280,
    height: 800,
    theme: 'workflow',
    label: 'Workflows',
    title: 'Not just chat. Real browser workflows.',
    body: 'Research pages, extract data, fill forms, compare results, capture screenshots, record tabs, and keep long tasks moving.',
    chips: ['Research', 'Forms', 'Data extraction', 'Screenshots', 'Scheduled tasks'],
    screenshot: assets.search,
    direction: 'workflow',
    prompt: 'Find the top 3 results and explain why they matter',
    note: 'Multi-step agent loop',
  },
  {
    file: 'promo-1400x560.png',
    width: 1400,
    height: 560,
    theme: 'promo',
    label: 'WebBrain',
    title: 'Open-source AI browser agent',
    body: 'Ask. Act. Automate. Any LLM.',
    chips: ['Chrome and Firefox', 'Local or cloud', 'MIT licensed'],
    kind: 'promo',
  },
  {
    file: 'small-promo-440x280.png',
    width: 440,
    height: 280,
    theme: 'smallpromo',
    label: 'WebBrain',
    title: 'AI browser agent',
    body: 'Ask. Act. Automate.',
    chips: ['Any LLM', 'Open source'],
    kind: 'smallPromo',
  },
];

function dataUri(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  const bytes = readFileSync(path.join(ROOT, relativePath));
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function css(width, height) {
  return `
    :root {
      color-scheme: light;
    }
    * {
      box-sizing: border-box;
    }
    html,
    body {
      margin: 0;
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    body {
      background: #11131f;
    }
    .canvas {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      overflow: hidden;
      color: #171827;
      isolation: isolate;
    }
    .canvas:before,
    .canvas:after {
      content: "";
      position: absolute;
      z-index: 0;
      pointer-events: none;
    }
    .canvas:before {
      inset: 0;
      background: linear-gradient(135deg, var(--bg1), var(--bg2));
    }
    .canvas:after {
      right: -120px;
      bottom: -140px;
      width: 540px;
      height: 360px;
      background:
        linear-gradient(90deg, transparent 0 28px, rgba(255,255,255,0.16) 28px 30px, transparent 30px 72px),
        linear-gradient(0deg, transparent 0 28px, rgba(255,255,255,0.14) 28px 30px, transparent 30px 72px);
      transform: rotate(-8deg);
      opacity: 0.8;
    }
    .read {
      --bg1: #fffaf3;
      --bg2: #eef5ff;
      --ink: #171827;
      --muted: #565e70;
      --accent: #6757ff;
      --accent2: #ff6f9d;
      --panel: rgba(255, 255, 255, 0.88);
      --border: rgba(37, 42, 66, 0.12);
      --shadow: 0 28px 70px rgba(31, 35, 62, 0.20);
    }
    .act {
      --bg1: #f7fbff;
      --bg2: #fff4ef;
      --ink: #182033;
      --muted: #596473;
      --accent: #df573f;
      --accent2: #4d7df5;
      --panel: rgba(255, 255, 255, 0.9);
      --border: rgba(31, 40, 64, 0.14);
      --shadow: 0 28px 70px rgba(68, 50, 40, 0.20);
    }
    .plan {
      --bg1: #111827;
      --bg2: #223040;
      --ink: #f8fafc;
      --muted: #c7d2de;
      --accent: #45d483;
      --accent2: #ffc857;
      --panel: rgba(255, 255, 255, 0.08);
      --border: rgba(255, 255, 255, 0.18);
      --shadow: 0 28px 80px rgba(0, 0, 0, 0.34);
    }
    .provider {
      --bg1: #f6f8fb;
      --bg2: #eef8f1;
      --ink: #182033;
      --muted: #5b6574;
      --accent: #3e6ff4;
      --accent2: #28a96b;
      --panel: rgba(255, 255, 255, 0.9);
      --border: rgba(25, 38, 68, 0.13);
      --shadow: 0 28px 70px rgba(24, 52, 90, 0.19);
    }
    .workflow {
      --bg1: #fbfbfd;
      --bg2: #eff7f9;
      --ink: #171827;
      --muted: #566070;
      --accent: #8d47e8;
      --accent2: #0aa5b8;
      --panel: rgba(255, 255, 255, 0.9);
      --border: rgba(33, 38, 60, 0.13);
      --shadow: 0 28px 70px rgba(42, 54, 84, 0.18);
    }
    .promo {
      --bg1: #121525;
      --bg2: #243044;
      --ink: #ffffff;
      --muted: #d5d9e3;
      --accent: #f56ca8;
      --accent2: #65d69d;
      --panel: rgba(255, 255, 255, 0.08);
      --border: rgba(255, 255, 255, 0.16);
      --shadow: 0 28px 70px rgba(0, 0, 0, 0.32);
    }
    .smallpromo {
      --bg1: #121525;
      --bg2: #253247;
      --ink: #ffffff;
      --muted: #d8deea;
      --accent: #f56ca8;
      --accent2: #65d69d;
      --panel: rgba(255, 255, 255, 0.09);
      --border: rgba(255, 255, 255, 0.16);
      --shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
    }
    .content {
      position: relative;
      z-index: 1;
      width: 100%;
      height: 100%;
      padding: 46px 54px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      color: var(--ink);
      font-size: 23px;
      font-weight: 760;
      line-height: 1;
    }
    .brand img {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.13);
    }
    .brand .sub {
      padding-left: 14px;
      border-left: 1px solid var(--border);
      color: var(--muted);
      font-size: 15px;
      font-weight: 620;
    }
    .stage {
      display: grid;
      grid-template-columns: 0.9fr 1.35fr;
      gap: 36px;
      align-items: center;
      height: calc(100% - 62px);
      padding-top: 34px;
    }
    .copy-right .stage {
      grid-template-columns: 705px 1fr;
      gap: 28px;
    }
    .copy {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      max-width: 470px;
    }
    .copy-right .copy {
      order: 2;
      max-width: 425px;
    }
    .copy-right .copy h1 {
      max-width: 425px;
      font-size: 54px;
    }
    .copy-right .copy p {
      max-width: 405px;
    }
    .copy-right .prompt-card {
      min-width: 380px;
      max-width: 418px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 9px 13px;
      color: var(--accent);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 14px;
      font-weight: 760;
      text-transform: uppercase;
      line-height: 1;
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.07);
    }
    .eyebrow .dot {
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--accent2);
      box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent2) 18%, transparent);
    }
    h1 {
      margin: 22px 0 16px;
      color: var(--ink);
      font-size: 58px;
      line-height: 1.03;
      font-weight: 820;
      max-width: 560px;
      text-wrap: balance;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 22px;
      line-height: 1.38;
      font-weight: 480;
      max-width: 510px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 26px;
      max-width: 520px;
    }
    .chip {
      padding: 10px 13px;
      color: var(--ink);
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 15px;
      font-weight: 700;
      line-height: 1;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.06);
      white-space: nowrap;
    }
    .prompt-card {
      position: relative;
      margin-top: 26px;
      padding: 15px 17px;
      min-width: 420px;
      color: var(--ink);
      background: rgba(255, 255, 255, 0.82);
      border: 1px solid var(--border);
      border-left: 5px solid var(--accent);
      border-radius: 14px;
      font-size: 17px;
      font-weight: 700;
      line-height: 1.35;
      box-shadow: 0 18px 45px rgba(0, 0, 0, 0.08);
    }
    .plan .prompt-card,
    .promo .prompt-card {
      background: rgba(255, 255, 255, 0.08);
      color: var(--ink);
    }
    .note {
      margin-top: 12px;
      color: var(--muted);
      font-size: 14px;
      font-weight: 760;
      text-transform: uppercase;
    }
    .visual {
      position: relative;
      min-width: 0;
    }
    .browser-frame {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 26px;
      background: #ffffff;
      box-shadow: var(--shadow);
    }
    .browser-frame img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .browser-frame.large {
      width: 760px;
      height: 475px;
    }
    .copy-right .browser-frame.large {
      width: 690px;
      height: 431px;
    }
    .copy-right .floating-panel {
      right: auto;
      left: 105px;
      bottom: -42px;
    }
    .browser-frame.tilt-left {
      transform: rotate(-1.5deg);
    }
    .browser-frame.tilt-right {
      transform: rotate(1.25deg);
    }
    .floating-panel {
      position: absolute;
      right: -8px;
      bottom: -36px;
      width: 360px;
      padding: 20px;
      color: #ffffff;
      background: #171827;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 22px;
      box-shadow: 0 26px 70px rgba(0, 0, 0, 0.30);
    }
    .floating-panel .mini-title {
      color: #ffffff;
      font-size: 17px;
      font-weight: 790;
      margin-bottom: 13px;
    }
    .mini-list {
      display: grid;
      gap: 9px;
    }
    .mini-item {
      display: grid;
      grid-template-columns: 28px 1fr;
      align-items: center;
      gap: 10px;
      color: #d9deea;
      font-size: 14px;
      font-weight: 650;
    }
    .mini-icon {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      color: #ffffff;
      background: var(--accent);
      border-radius: 9px;
      font-size: 12px;
      font-weight: 850;
    }
    .plan-layout {
      display: grid;
      grid-template-columns: 0.9fr 1.12fr;
      gap: 42px;
      align-items: center;
      height: calc(100% - 62px);
      padding-top: 32px;
    }
    .plan-mock {
      position: relative;
      height: 542px;
    }
    .page-shell {
      position: absolute;
      inset: 32px 28px 36px 0;
      padding: 28px;
      background: #f8fafc;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 26px;
      box-shadow: var(--shadow);
    }
    .page-bar {
      display: flex;
      align-items: center;
      gap: 9px;
      height: 36px;
      padding: 0 13px;
      background: #e5e9f0;
      border-radius: 12px;
      color: #667085;
      font-size: 12px;
      font-weight: 700;
    }
    .page-dots {
      display: flex;
      gap: 6px;
    }
    .page-dots span {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #a7b0bf;
    }
    .fake-page {
      margin-top: 24px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 18px;
    }
    .fake-card {
      min-height: 124px;
      padding: 18px;
      border-radius: 17px;
      background: #ffffff;
      border: 1px solid #e5e7ef;
    }
    .line {
      height: 11px;
      margin-bottom: 12px;
      border-radius: 999px;
      background: #d7ddea;
    }
    .line.short {
      width: 58%;
    }
    .line.mid {
      width: 78%;
    }
    .field {
      height: 44px;
      margin-top: 15px;
      border: 1px solid #ccd4e0;
      border-radius: 11px;
      background: #f8fafc;
    }
    .plan-card {
      position: absolute;
      top: 0;
      right: 0;
      width: 425px;
      padding: 22px;
      color: #eef8f3;
      background: #151c2a;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 25px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.42);
    }
    .plan-card h2 {
      margin: 0 0 16px;
      font-size: 24px;
      line-height: 1.2;
    }
    .steps {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .steps li {
      display: grid;
      grid-template-columns: 30px 1fr;
      gap: 10px;
      align-items: start;
      color: #d7e2ea;
      font-size: 15px;
      line-height: 1.32;
      font-weight: 630;
    }
    .step-num {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      color: #102319;
      background: var(--accent);
      border-radius: 10px;
      font-weight: 850;
    }
    .approve-row {
      display: flex;
      gap: 10px;
      margin-top: 18px;
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 116px;
      height: 42px;
      padding: 0 16px;
      border-radius: 13px;
      font-size: 14px;
      font-weight: 790;
    }
    .button.primary {
      color: #102319;
      background: var(--accent);
    }
    .button.secondary {
      color: #e9eef6;
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.08);
    }
    .provider-grid {
      position: absolute;
      left: 64px;
      bottom: -28px;
      width: 520px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .provider-tile {
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.92);
      box-shadow: 0 16px 38px rgba(24, 52, 90, 0.12);
    }
    .provider-tile b {
      display: block;
      color: var(--ink);
      font-size: 17px;
      margin-bottom: 4px;
    }
    .provider-tile span {
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    .workflow-layout {
      display: grid;
      grid-template-columns: 0.86fr 1.1fr;
      gap: 36px;
      align-items: center;
      height: calc(100% - 62px);
      padding-top: 32px;
    }
    .workflow-board {
      position: relative;
      height: 535px;
    }
    .workflow-board .browser-frame {
      position: absolute;
      right: 0;
      top: 16px;
      width: 642px;
      height: 402px;
      transform: rotate(1.2deg);
    }
    .task-stack {
      position: absolute;
      left: 0;
      bottom: 0;
      display: grid;
      gap: 13px;
      width: 450px;
    }
    .task-card {
      display: grid;
      grid-template-columns: 46px 1fr;
      gap: 13px;
      align-items: center;
      padding: 16px;
      background: rgba(255, 255, 255, 0.94);
      border: 1px solid var(--border);
      border-radius: 19px;
      box-shadow: 0 16px 40px rgba(34, 44, 70, 0.13);
    }
    .task-card .badge {
      display: grid;
      place-items: center;
      width: 46px;
      height: 46px;
      border-radius: 15px;
      color: #ffffff;
      background: var(--accent);
      font-size: 15px;
      font-weight: 850;
    }
    .task-card b {
      display: block;
      color: var(--ink);
      font-size: 17px;
      margin-bottom: 4px;
    }
    .task-card span {
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    .promo .content {
      padding: 44px 56px;
    }
    .promo-layout {
      display: grid;
      grid-template-columns: 0.9fr 1.1fr;
      align-items: center;
      gap: 34px;
      height: calc(100% - 38px);
      padding-top: 22px;
    }
    .promo-copy h1 {
      color: var(--ink);
      font-size: 72px;
      line-height: 1.02;
      margin: 20px 0 14px;
      max-width: 650px;
    }
    .promo-copy p {
      color: var(--muted);
      font-size: 30px;
      line-height: 1.2;
    }
    .promo-visual {
      position: relative;
      height: 420px;
    }
    .promo-panel {
      position: absolute;
      width: 590px;
      right: 0;
      top: 14px;
      padding: 22px;
      border: 1px solid var(--border);
      border-radius: 26px;
      background: rgba(255, 255, 255, 0.08);
      box-shadow: var(--shadow);
    }
    .mini-browser {
      height: 330px;
      overflow: hidden;
      border-radius: 18px;
      background: #f7f8fb;
    }
    .mini-browser-top {
      height: 42px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 14px;
      background: #e9edf4;
    }
    .mini-browser-top span {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #aeb7c7;
    }
    .mini-browser-body {
      display: grid;
      grid-template-columns: 1fr 260px;
      height: 288px;
    }
    .site-side {
      padding: 26px;
      background: #ffffff;
    }
    .panel-side {
      padding: 20px;
      background: #151827;
      color: #ffffff;
    }
    .webbrain-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 999px;
      color: #ffffff;
      background: #635bff;
      font-size: 13px;
      font-weight: 800;
    }
    .mini-message {
      margin-top: 18px;
      padding: 14px;
      border-radius: 14px;
      background: #2d3050;
      font-size: 14px;
      line-height: 1.35;
      font-weight: 680;
    }
    .mini-result {
      margin-top: 12px;
      padding: 14px;
      border-radius: 14px;
      background: #202338;
      color: #dce2ef;
      font-size: 12px;
      line-height: 1.45;
      font-weight: 650;
    }
    .smallpromo .content {
      padding: 22px 24px;
    }
    .smallpromo .brand {
      gap: 10px;
      font-size: 20px;
      color: var(--ink);
    }
    .smallpromo .brand img {
      width: 34px;
      height: 34px;
      border-radius: 10px;
    }
    .smallpromo .brand .sub {
      display: none;
    }
    .small-layout {
      display: grid;
      grid-template-columns: 1fr 148px;
      gap: 16px;
      align-items: center;
      height: calc(100% - 38px);
      padding-top: 14px;
    }
    .small-copy h1 {
      margin: 0 0 8px;
      color: var(--ink);
      font-size: 42px;
      line-height: 0.98;
      font-weight: 840;
      max-width: 230px;
    }
    .small-copy p {
      color: var(--muted);
      font-size: 18px;
      line-height: 1.2;
      font-weight: 720;
    }
    .small-copy .chips {
      margin-top: 16px;
      gap: 7px;
    }
    .small-copy .chip {
      padding: 8px 10px;
      color: #ffffff;
      background: rgba(255, 255, 255, 0.11);
      border-color: rgba(255, 255, 255, 0.17);
      font-size: 12px;
    }
    .small-card {
      position: relative;
      height: 178px;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.08);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .small-card-top {
      height: 28px;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0 10px;
      background: rgba(255, 255, 255, 0.15);
    }
    .small-card-top span {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.5);
    }
    .small-card-body {
      display: grid;
      grid-template-columns: 1fr 58px;
      height: 150px;
      background: #ffffff;
    }
    .small-page {
      padding: 16px 12px;
    }
    .small-page .line {
      height: 8px;
      margin-bottom: 8px;
      background: #d6dce8;
    }
    .small-page .fake-card {
      margin-top: 12px;
      min-height: 48px;
      padding: 10px;
      border-radius: 10px;
    }
    .small-side {
      padding: 13px 9px;
      background: #151827;
    }
    .small-side .bubble {
      height: 23px;
      margin-bottom: 8px;
      border-radius: 8px;
      background: #635bff;
    }
    .small-side .bubble.dark {
      height: 48px;
      background: #252840;
    }
  `;
}

function standardScene(scene) {
  const copy = copyBlock(scene);
  const visual = `
    <div class="visual">
      <div class="browser-frame large ${scene.direction === 'copy-left' ? 'tilt-right' : 'tilt-left'}">
        <img src="${scene.screenshot}" alt="">
      </div>
      <div class="floating-panel">
        <div class="mini-title">${esc(scene.prompt)}</div>
        <div class="mini-list">
          ${scene.chips.slice(0, 5).map((chip, index) => `
            <div class="mini-item">
              <div class="mini-icon">${index + 1}</div>
              <div>${esc(chip)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  return `
    <div class="stage ${scene.direction}">
      ${scene.direction === 'copy-right' ? visual + copy : copy + visual}
    </div>
  `;
}

function copyBlock(scene) {
  return `
    <section class="copy">
      <div class="eyebrow"><span class="dot"></span>${esc(scene.label)}</div>
      <h1>${esc(scene.title)}</h1>
      <p>${esc(scene.body)}</p>
      <div class="prompt-card">${esc(scene.prompt)}</div>
      <div class="note">${esc(scene.note)}</div>
      <div class="chips">
        ${scene.chips.map((chip) => `<span class="chip">${esc(chip)}</span>`).join('')}
      </div>
    </section>
  `;
}

function planScene(scene) {
  return `
    <div class="plan-layout">
      ${copyBlock({ ...scene, prompt: 'Check availability, compare options, then stop before submitting.', note: 'Human approval stays in the loop' })}
      <div class="plan-mock">
        <div class="page-shell">
          <div class="page-bar">
            <div class="page-dots"><span></span><span></span><span></span></div>
            checkout.example / travel / dashboard
          </div>
          <div class="fake-page">
            <div class="fake-card">
              <div class="line mid"></div>
              <div class="line"></div>
              <div class="field"></div>
            </div>
            <div class="fake-card">
              <div class="line short"></div>
              <div class="line mid"></div>
              <div class="field"></div>
            </div>
            <div class="fake-card">
              <div class="line"></div>
              <div class="line short"></div>
              <div class="field"></div>
            </div>
            <div class="fake-card">
              <div class="line mid"></div>
              <div class="line"></div>
              <div class="field"></div>
            </div>
          </div>
        </div>
        <div class="plan-card">
          <h2>Proposed browser plan</h2>
          <ol class="steps">
            <li><span class="step-num">1</span><span>Read the visible form and identify required fields.</span></li>
            <li><span class="step-num">2</span><span>Fill only the fields the user asked for.</span></li>
            <li><span class="step-num">3</span><span>Pause before any purchase, submit, or irreversible action.</span></li>
            <li><span class="step-num">4</span><span>Keep the approved plan pinned while the agent works.</span></li>
          </ol>
          <div class="approve-row">
            <div class="button primary">Approve</div>
            <div class="button secondary">Adjust</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function providerScene(scene) {
  return `
    <div class="stage ${scene.direction}">
      ${copyBlock(scene)}
      <div class="visual">
        <div class="browser-frame large tilt-right">
          <img src="${scene.screenshot}" alt="">
        </div>
        <div class="provider-grid">
          <div class="provider-tile"><b>WebBrain Cloud</b><span>No local setup required</span></div>
          <div class="provider-tile"><b>Local models</b><span>llama.cpp, Ollama, LM Studio</span></div>
          <div class="provider-tile"><b>Cloud APIs</b><span>OpenAI, Anthropic, Gemini</span></div>
          <div class="provider-tile"><b>Compatible APIs</b><span>OpenRouter and custom endpoints</span></div>
        </div>
      </div>
    </div>
  `;
}

function workflowScene(scene) {
  return `
    <div class="workflow-layout">
      ${copyBlock(scene)}
      <div class="workflow-board">
        <div class="browser-frame">
          <img src="${scene.screenshot}" alt="">
        </div>
        <div class="task-stack">
          <div class="task-card"><div class="badge">R</div><div><b>Research across pages</b><span>Read search results, articles, docs, and PDFs.</span></div></div>
          <div class="task-card"><div class="badge">F</div><div><b>Fill and verify forms</b><span>Use page refs, wait for changes, stop at risky actions.</span></div></div>
          <div class="task-card"><div class="badge">D</div><div><b>Extract structured data</b><span>Turn pages into tables, summaries, and next steps.</span></div></div>
        </div>
      </div>
    </div>
  `;
}

function promoScene(scene) {
  return `
    <div class="promo-layout">
      <section class="promo-copy">
        <div class="eyebrow"><span class="dot"></span>${esc(scene.label)}</div>
        <h1>${esc(scene.title)}</h1>
        <p>${esc(scene.body)}</p>
        <div class="chips">
          ${scene.chips.map((chip) => `<span class="chip">${esc(chip)}</span>`).join('')}
        </div>
      </section>
      <div class="promo-visual">
        <div class="promo-panel">
          <div class="mini-browser">
            <div class="mini-browser-top"><span></span><span></span><span></span></div>
            <div class="mini-browser-body">
              <div class="site-side">
                <div class="line mid"></div>
                <div class="line"></div>
                <div class="line short"></div>
                <div class="fake-card" style="margin-top:24px; min-height:118px;">
                  <div class="line"></div>
                  <div class="line mid"></div>
                  <div class="line short"></div>
                </div>
              </div>
              <div class="panel-side">
                <div class="webbrain-pill"><img src="${assets.logo}" style="width:18px;height:18px;border-radius:5px;"> WebBrain</div>
                <div class="mini-message">Summarize this page and find the best next action.</div>
                <div class="mini-result">Reading page...<br>Extracting key points...<br>Preparing answer...</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function smallPromoScene(scene) {
  return `
    <div class="small-layout">
      <section class="small-copy">
        <h1>${esc(scene.title)}</h1>
        <p>${esc(scene.body)}</p>
        <div class="chips">
          ${scene.chips.map((chip) => `<span class="chip">${esc(chip)}</span>`).join('')}
        </div>
      </section>
      <div class="small-card">
        <div class="small-card-top"><span></span><span></span><span></span></div>
        <div class="small-card-body">
          <div class="small-page">
            <div class="line mid"></div>
            <div class="line"></div>
            <div class="line short"></div>
            <div class="fake-card">
              <div class="line mid"></div>
              <div class="line short"></div>
            </div>
          </div>
          <div class="small-side">
            <div class="bubble"></div>
            <div class="bubble dark"></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function sceneMarkup(scene) {
  if (scene.kind === 'plan') return planScene(scene);
  if (scene.kind === 'promo') return promoScene(scene);
  if (scene.kind === 'smallPromo') return smallPromoScene(scene);
  if (scene.theme === 'provider') return providerScene(scene);
  if (scene.direction === 'workflow') return workflowScene(scene);
  return standardScene(scene);
}

function html(scene) {
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=${scene.width}, initial-scale=1">
      <style>${css(scene.width, scene.height)}</style>
    </head>
    <body>
      <main class="canvas ${scene.theme}">
        <div class="content">
          <div class="brand">
            <img src="${assets.logo}" alt="">
            <span>WebBrain</span>
            <span class="sub">Open-source AI browser agent</span>
          </div>
          ${sceneMarkup(scene)}
        </div>
      </main>
    </body>
  </html>`;
}

async function renderAll() {
  await mkdir(DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const scene of scenes) {
    const page = await browser.newPage({
      viewport: { width: scene.width, height: scene.height },
      deviceScaleFactor: 1,
    });
    await page.setContent(html(scene), { waitUntil: 'load' });
    await page.evaluate(async () => {
      const images = Array.from(document.images);
      await Promise.all(images.map((img) => img.complete ? undefined : new Promise((resolve, reject) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', reject, { once: true });
      })));
      await document.fonts.ready;
    });
    await page.screenshot({ path: path.join(DIR, scene.file) });
    await page.close();
  }
  await browser.close();

  const readme = `# Web Store explainer visuals 2026

Generated Chrome Web Store-style visuals for WebBrain.

Files:
- 01-ask-any-page.png: Ask mode page reading and summarization
- 02-act-browser-control.png: Act mode browser control
- 03-plan-before-act.png: Plan review before browser actions
- 04-any-llm-your-choice.png: Provider choice and local/cloud setup
- 05-real-workflows.png: Multi-step workflows
- promo-1400x560.png: Wide promotional tile
- small-promo-440x280.png: Small promotional tile

Regenerate:

\`\`\`bash
node assets/webstore-explainer-2026/render.mjs
\`\`\`
`;
  await writeFile(path.join(DIR, 'README.md'), readme, 'utf8');
}

renderAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
