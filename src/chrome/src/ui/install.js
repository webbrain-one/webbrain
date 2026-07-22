import { applyDOMTranslations, t } from './i18n.js';

const GUIDES = {
  chrome: { name: 'Google Chrome', openKey: 'install.open_panel', nextKey: 'install.pin.next', failureKey: 'install.open_failed_chromium' },
  edge: { name: 'Microsoft Edge', openKey: 'install.open_panel', nextKey: 'install.pin.next', failureKey: 'install.open_failed_chromium' },
  brave: { name: 'Brave', openKey: 'install.open_panel', nextKey: 'install.pin.next', failureKey: 'install.open_failed_chromium' },
  vivaldi: { name: 'Vivaldi', openKey: 'install.open_panel', nextKey: 'install.pin.next', failureKey: 'install.open_failed_chromium' },
  opera: { name: 'Opera', openKey: 'install.open_panel', nextKey: 'install.pin.next', failureKey: 'install.open_failed_chromium' },
  firefox: { name: 'Firefox', openKey: 'install.open_sidebar', nextKey: 'install.firefox_pin.body', failureKey: 'install.open_failed_firefox' },
  chromium: { name: 'Chromium', openKey: 'install.open_panel', nextKey: 'install.pin.next', failureKey: 'install.open_failed_chromium' },
  unknown: { name: 'Browser', openKey: 'install.open_panel', nextKey: 'install.pin.next', failureKey: 'install.open_failed_chromium' },
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

/**
 * Keep the open calls in the click handler's synchronous turn. Both Chrome's
 * sidePanel.open() and Firefox's sidebarAction.open() require a user gesture.
 */
export function openInstalledPanel({ build, tabId, chromeApi = globalThis.chrome, browserApi = globalThis.browser } = {}) {
  if (build === 'firefox') {
    if (!browserApi?.sidebarAction?.open) {
      throw new Error('Sidebar API unavailable');
    }
    return browserApi.sidebarAction.open();
  }

  if (tabId == null || !chromeApi?.sidePanel?.open) {
    throw new Error('Side panel API unavailable');
  }
  chromeApi.sidePanel.setOptions({
    tabId,
    path: 'src/ui/sidepanel.html',
    enabled: true,
  }).catch?.(() => {});
  return chromeApi.sidePanel.open({ tabId });
}

export function reportInstalledPanelOpened({
  build,
  tabId,
  chromeApi = globalThis.chrome,
  browserApi = globalThis.browser,
} = {}) {
  const runtime = build === 'firefox' ? browserApi?.runtime : chromeApi?.runtime;
  if (!runtime?.sendMessage || tabId == null) return Promise.resolve(false);
  return Promise.resolve(runtime.sendMessage({
    type: 'WB_INSTALL_PANEL_OPENED',
    tabId,
  })).then(() => true);
}

async function getInstallTab(build) {
  const tabs = build === 'firefox'
    ? globalThis.browser?.tabs
    : globalThis.chrome?.tabs;
  try {
    return await tabs?.getCurrent?.();
  } catch {
    return null;
  }
}

async function hydrateGuide() {
  applyDOMTranslations(document);

  const build = document.documentElement.dataset.build;
  const [browserKey, installTab] = await Promise.all([
    detectBrowser(),
    getInstallTab(build),
  ]);
  const guide = getBrowserGuide(browserKey);
  document.documentElement.dataset.browser = browserKey;
  document.getElementById('browser-label').textContent = t('install.browser.detected', { browser: guide.name });

  const openButton = document.getElementById('open-panel-button');
  const openLabel = document.getElementById('open-panel-label');
  const status = document.getElementById('open-panel-status');
  const nextStepBody = document.getElementById('next-step-body');
  openLabel.textContent = t(guide.openKey);
  nextStepBody.textContent = t(guide.nextKey);

  openButton.addEventListener('click', () => {
    openButton.classList.add('is-opening');
    openButton.disabled = true;
    openButton.setAttribute('aria-busy', 'true');
    status.classList.remove('is-error');
    status.textContent = '';

    let opening;
    try {
      opening = openInstalledPanel({ build, tabId: installTab?.id });
    } catch {
      opening = Promise.reject(new Error('Panel unavailable'));
    }

    Promise.resolve(opening).then(() => {
      openButton.classList.remove('is-opening');
      openButton.disabled = false;
      openButton.removeAttribute('aria-busy');
      status.textContent = t(guide.nextKey);
      reportInstalledPanelOpened({ build, tabId: installTab?.id }).catch(() => {});
    }).catch(() => {
      openButton.classList.remove('is-opening');
      openButton.disabled = false;
      openButton.removeAttribute('aria-busy');
      status.classList.add('is-error');
      status.textContent = t(guide.failureKey);
    });
  });
  openButton.disabled = false;

  if (build === 'firefox') {
    document.getElementById('shortcut-hint')?.remove();
  }
}

if (typeof document !== 'undefined') {
  hydrateGuide().catch(() => {
    const build = document.documentElement.dataset.build;
    const guide = getBrowserGuide(build === 'firefox' ? 'firefox' : 'unknown');
    const status = document.getElementById('open-panel-status');
    if (status) {
      status.classList.add('is-error');
      status.textContent = t(guide.failureKey);
    }
  });
}
