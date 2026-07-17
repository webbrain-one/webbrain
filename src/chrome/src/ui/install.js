import { applyDOMTranslations, getLocale, t } from './i18n.js';

const GUIDES = {
  chrome: {
    name: 'Google Chrome',
    intro: 'Chrome usually places new extensions inside its Extensions menu. Pin WebBrain so the side panel stays one click away.',
    firstTitle: 'Open Extensions',
    firstBody: 'Select the puzzle-piece icon to the right of the address bar.',
    secondTitle: 'Pin WebBrain',
    secondBody: 'Find WebBrain, then select the pin icon beside it.',
  },
  edge: {
    name: 'Microsoft Edge',
    intro: 'Edge may keep new extensions inside its Extensions menu. Keep WebBrain on the toolbar so the side panel stays one click away.',
    firstTitle: 'Open Extensions',
    firstBody: 'Select the Extensions icon to the right of the address bar.',
    secondTitle: 'Show WebBrain',
    secondBody: 'Find WebBrain, then choose Show in toolbar.',
  },
  brave: {
    name: 'Brave',
    intro: 'Brave may tuck new extensions into its Extensions menu. Pin WebBrain so the side panel stays one click away.',
    firstTitle: 'Open Extensions',
    firstBody: 'Select the puzzle-piece icon to the right of the address bar.',
    secondTitle: 'Pin WebBrain',
    secondBody: 'Find WebBrain, then select the pin icon beside it.',
  },
  vivaldi: {
    name: 'Vivaldi',
    intro: 'Vivaldi can hide extension buttons beside the Address Bar. Keep WebBrain visible so the side panel stays one click away.',
    firstTitle: 'Check the Address Bar',
    firstBody: 'Look for the extension controls on the right side of the Address Bar.',
    secondTitle: 'Show WebBrain',
    secondBody: 'If it is hidden, open hidden extensions, right-click WebBrain, and choose Show Button.',
  },
  opera: {
    name: 'Opera',
    intro: 'Opera may keep new extensions inside its Extensions menu. Pin WebBrain so the side panel stays one click away.',
    firstTitle: 'Open Extensions',
    firstBody: 'Select the Extensions icon to the right of the address bar.',
    secondTitle: 'Pin WebBrain',
    secondBody: 'Find WebBrain, then use its pin control to keep it on the toolbar.',
  },
  firefox: {
    name: 'Firefox',
    intro: 'Firefox may place new add-ons inside its Extensions panel. Pin WebBrain so the sidebar stays one click away.',
    firstTitle: 'Open Extensions',
    firstBody: 'Select the puzzle-piece icon in the toolbar.',
    secondTitle: 'Pin WebBrain',
    secondBody: 'Open the gear menu beside WebBrain, then choose Pin to Toolbar.',
  },
  chromium: {
    name: 'Chromium',
    intro: 'Your browser may hide new extensions in its extension controls. Keep WebBrain visible so the side panel stays one click away.',
    firstTitle: 'Open extension controls',
    firstBody: 'Look beside the address bar for Extensions or hidden extension buttons.',
    secondTitle: 'Keep WebBrain visible',
    secondBody: 'Find WebBrain and use the pin, show, or keep-in-toolbar control.',
  },
  unknown: {
    name: 'Browser',
    intro: 'Your browser may hide new extensions in its extension controls. Keep WebBrain visible so it stays easy to open.',
    firstTitle: 'Open extension controls',
    firstBody: 'Look near the address bar or in your browser menu for Extensions or Add-ons.',
    secondTitle: 'Keep WebBrain visible',
    secondBody: 'Find WebBrain and choose the option that keeps it in your toolbar.',
  },
};

function browserBrands(navigatorLike) {
  return (navigatorLike?.userAgentData?.brands || [])
    .map((entry) => String(entry?.brand || '').toLowerCase())
    .join(' ');
}

export async function detectBrowser(navigatorLike = globalThis.navigator) {
  try {
    if (await navigatorLike?.brave?.isBrave?.()) return 'brave';
  } catch {
    // Brave detection is an optional progressive enhancement.
  }

  const ua = String(navigatorLike?.userAgent || '');
  const brands = browserBrands(navigatorLike);
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/\bEdg(?:e|A|iOS)?\//i.test(ua) || brands.includes('microsoft edge')) return 'edge';
  if (/\bOPR\//i.test(ua) || brands.includes('opera')) return 'opera';
  if (/\bVivaldi\//i.test(ua) || brands.includes('vivaldi')) return 'vivaldi';
  if (brands.includes('google chrome')) return 'chrome';
  if (/\b(?:Chrome|Chromium)\//i.test(ua) || brands.includes('chromium')) return 'chromium';
  return 'unknown';
}

export function getBrowserGuide(browserKey) {
  return GUIDES[browserKey] || GUIDES.unknown;
}

async function closeGuideTab() {
  const api = globalThis.browser?.tabs ? globalThis.browser : globalThis.chrome;
  try {
    const tab = await api?.tabs?.getCurrent?.();
    if (tab?.id != null) {
      await api.tabs.remove(tab.id);
      return;
    }
  } catch {
    // window.close() is a harmless fallback when tab lookup is unavailable.
  }
  window.close();
}

async function hydrateGuide() {
  const browserKey = await detectBrowser();
  const guide = getBrowserGuide(browserKey);
  applyDOMTranslations(document);
  document.documentElement.dataset.browser = browserKey;
  document.getElementById('browser-label').textContent = t('install.browser.detected', { browser: guide.name });
  if (getLocale() === 'en') {
    document.getElementById('install-intro').textContent = guide.intro;
    document.getElementById('step-one-title').textContent = guide.firstTitle;
    document.getElementById('step-one-body').textContent = guide.firstBody;
    document.getElementById('step-two-title').textContent = guide.secondTitle;
    document.getElementById('step-two-body').textContent = guide.secondBody;
  }
  if (document.documentElement.dataset.build === 'firefox') {
    document.getElementById('shortcut-hint').remove();
  }
  document.getElementById('done-button').addEventListener('click', closeGuideTab);
}

if (typeof document !== 'undefined') {
  hydrateGuide().catch(() => {});
}
