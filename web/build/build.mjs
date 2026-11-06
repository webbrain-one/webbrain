#!/usr/bin/env node
/**
 * WebBrain marketing-site build.
 *
 * Reads web/build/template.html (the homepage), web/build/websites-template.html,
 * web/build/faq-template.html, and web/build/locales/*.json and writes:
 *   web/index.html                       the homepage: the browser extension
 *   web/{es,fr,tr,zh,...}/index.html     first, then WebBrain for websites
 *   web/websites/index.html              WebBrain for websites (English)
 *   web/docs/faq/index.html
 *   web/docs/{es,fr,tr,zh,...}/faq/index.html
 *   web/privacy.html                     (footer only; the page is hand-written)
 *   web/sitemap.xml
 *   web/robots.txt
 *
 * Template uses {{t:key}} / {{t-html:key}} markers, plus a few build-only
 * placeholders the script fills per locale:
 *   {{locale_code}}      e.g. "en", "es"
 *   {{locale_bcp47}}     e.g. "en-US", "es-ES" (used in og:locale)
 *   {{locale_home_url}}  e.g. "https://webbrain.one/" or ".../es/" (brand link)
 *   {{page_url}}         canonical URL of the page being rendered
 *   {{browser_path}}     the browser extension's page: the localized homepage
 *                        ("/" or "/es/"); /browser/ redirects there
 *   {{websites_path}}    "/websites/"
 *   <!-- if websites -->…<!-- else websites -->…<!-- end websites -->
 *                        kept or dropped by WEBSITES_LAUNCHED (site-footer.mjs)
 *   {{sites_dashboard_url}} the private WebBrain for websites dashboard
 *   {{docs_url}}         English docs, or the secondary Chinese docs for zh
 *   {{hreflang_links}}   <link rel="alternate" ...> block for this page
 *   {{faq_url}}          localized FAQ path under /docs/
 *   {{faq_language_routes}} safe locale-to-FAQ route map for the selector
 *   {{faq_jsonld}}       FAQPage schema block generated from faq.* keys
 *   {{plausible_analytics}} shared privacy-friendly analytics partial
 *   {{site_footer_styles}} / {{site_footer}} the footer every page shares
 *                        (web/build/site-footer.mjs)
 *   {{sites_demo_site_id}} the site the homepage's live demo loads
 *
 * {{t:key}} → plain-text substitution, HTML-escaped.
 * {{t-html:key}} → raw substitution (value is expected to be HTML-ready).
 * Use t-html only for values containing intentional inline HTML like
 * <strong>, <a>, <code>.
 *
 * There is NO dependency on npm packages — pure Node ESM.
 */

import { copyFile, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLAUSIBLE_ANALYTICS } from './plausible.mjs';
import {
  BLUESKY_PROFILE_URL,
  HUGGINGFACE_PROFILE_URL,
  MASTODON_PROFILE_URL,
  SITE_FOOTER_STYLES,
  WEBSITES_LAUNCHED,
  siteFooter,
  withSiteFooter,
} from './site-footer.mjs';
import { RESEARCH_PATH, renderResearchPages, researchPathFor } from './research.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');           // web/
const BUILD_DIR = __dirname;                          // web/build/
const LOCALES_DIR = path.join(BUILD_DIR, 'locales');
// template.html is the homepage, led by the browser extension.
const TEMPLATE_PATH = path.join(BUILD_DIR, 'template.html');
const WEBSITES_TEMPLATE_PATH = path.join(BUILD_DIR, 'websites-template.html');
const FAQ_TEMPLATE_PATH = path.join(BUILD_DIR, 'faq-template.html');
// Research: web/build/research.json rendered into research-template.html.
const RESEARCH_TEMPLATE_PATH = path.join(BUILD_DIR, 'research-template.html');
const RESEARCH_DATA_PATH = path.join(BUILD_DIR, 'research.json');
const RESEARCH_STYLES_PATH = path.join(BUILD_DIR, 'research.css');
const SITE_ORIGIN = 'https://webbrain.one';
const SOCIAL_IMAGE_URL = `${SITE_ORIGIN}/og-image.png`;
const WEBSITES_PATH = '/websites/';
// WebBrain for websites: the private dashboard that issues embed scripts.
const SITES_DASHBOARD_URL = 'https://sites.webbrain.one';
// The dashboard site the homepage's "Demo" button loads, so visitors try the
// real assistant on webbrain.one itself. The dashboard creates it on first run.
const SITES_DEMO_SITE_ID = 'site_webbrain_one';
const LOGO_IMAGE_URL = `${SITE_ORIGIN}/logo-github.png`;

// Locale config. The default locale (en) renders to web/index.html;
// the others render to web/<code>/index.html.
const LOCALES = JSON.parse(await readFile(new URL('./languages.json', import.meta.url), 'utf8'));

// Keep the website on the same bundled 4:3 flag artwork as the extension
// language picker. The web build copies only the flags used by web locales.
const LANGUAGE_FLAG_CODES = {
  en: 'us',
  es: 'es',
  fr: 'fr',
  tr: 'tr',
  zh: 'cn',
  ru: 'ru',
  uk: 'ua',
  ar: 'sa',
  ja: 'jp',
  ko: 'kr',
  id: 'id',
  th: 'th',
  ms: 'my',
  tl: 'ph',
  he: 'il',
  hi: 'in',
  pt: 'br',
  vi: 'vn',
  bn: 'bd',
  fa: 'ir',
  nl: 'nl',
  de: 'de',
};
const FLAG_SOURCE_DIR = path.resolve(ROOT, '../src/chrome/icons/flags');
const FLAG_OUTPUT_DIR = path.join(ROOT, 'assets', 'flags');

// Reuse the exact provider marks shown in Settings instead of maintaining a
// second website-only icon set. These filenames intentionally match provider
// ids so adding or auditing a homepage node stays straightforward.
const PROVIDER_ICON_FILES = [
  'llamacpp.svg',
  'ollama.svg',
  'openai.svg',
  'anthropic.svg',
  'openrouter.svg',
  'lmstudio.svg',
  'vllm.svg',
  'xai.svg',
  'gemini.svg',
  'deepseek.svg',
  'mistral.svg',
];
const PROVIDER_ICON_SOURCE_DIR = path.resolve(ROOT, '../src/chrome/icons/providers');
const PROVIDER_ICON_OUTPUT_DIR = path.join(ROOT, 'assets', 'providers');

async function syncLanguageFlagAssets() {
  const missingFlagLocale = LOCALES.find((locale) => !LANGUAGE_FLAG_CODES[locale.code]);
  if (missingFlagLocale) {
    throw new Error(`Missing website flag mapping for locale: ${missingFlagLocale.code}`);
  }

  await mkdir(FLAG_OUTPUT_DIR, { recursive: true });
  await Promise.all([
    ...new Set(LOCALES.map((locale) => LANGUAGE_FLAG_CODES[locale.code])),
  ].map((flagCode) => copyFile(
    path.join(FLAG_SOURCE_DIR, `${flagCode}.svg`),
    path.join(FLAG_OUTPUT_DIR, `${flagCode}.svg`),
  )));
  await copyFile(
    path.join(FLAG_SOURCE_DIR, 'LICENSE.flag-icons.txt'),
    path.join(FLAG_OUTPUT_DIR, 'LICENSE.flag-icons.txt'),
  );
}

async function syncProviderIconAssets() {
  await mkdir(PROVIDER_ICON_OUTPUT_DIR, { recursive: true });
  await Promise.all(PROVIDER_ICON_FILES.map((file) => copyFile(
    path.join(PROVIDER_ICON_SOURCE_DIR, file),
    path.join(PROVIDER_ICON_OUTPUT_DIR, file),
  )));
}

const FAQ_KEYS = [
  // Order matters — this is the rendered order in-page AND in JSON-LD.
  'faq.alt_claude',
  'faq.cloud_subscription',
  'faq.manage_subscription',
  'faq.subscription_unrecognized',
  'faq.cloud_sync',
  'faq.vs_frameworks',
  'faq.workflow_editor',
  'faq.offline',
  'faq.emergency_box',
  'faq.models_supported',
  'faq.recommended_model',
  'faq.webgpu_apocalypse',
  'faq.cors',
  'faq.ollama_origins',
  'faq.firefox',
  'faq.firefox_sidebar_move',
  'faq.vivaldi_dialogs',
  'faq.safe',
  'faq.cdp',
  'faq.disable_approval_questions',
  'faq.scraping',
  'faq.api_mutations',
  'faq.lm_studio',
  'faq.scroll_during_run',
  'faq.tab_switch_during_run',
  'faq.profile',
  'faq.screenshot_redaction',
  'faq.cookies_paywalls',
  'faq.multilingual',
  'faq.page_context',
  'faq.offline_licensing',
  'faq.token_conscious',
  'faq.contribute',
];

const FAQ_GROUPS = ['about', 'cloud', 'models', 'browsers', 'safety'];
const FAQ_CATEGORY = {
  'faq.alt_claude': 'about',
  'faq.vs_frameworks': 'about',
  'faq.workflow_editor': 'about',
  'faq.firefox': 'about',
  'faq.scraping': 'about',
  'faq.multilingual': 'about',
  'faq.contribute': 'about',
  'faq.cloud_subscription': 'cloud',
  'faq.manage_subscription': 'cloud',
  'faq.subscription_unrecognized': 'cloud',
  'faq.cloud_sync': 'cloud',
  'faq.token_conscious': 'cloud',
  'faq.offline': 'models',
  'faq.emergency_box': 'models',
  'faq.models_supported': 'models',
  'faq.recommended_model': 'models',
  'faq.webgpu_apocalypse': 'models',
  'faq.cors': 'models',
  'faq.ollama_origins': 'models',
  'faq.lm_studio': 'models',
  'faq.firefox_sidebar_move': 'browsers',
  'faq.vivaldi_dialogs': 'browsers',
  'faq.scroll_during_run': 'browsers',
  'faq.tab_switch_during_run': 'browsers',
  'faq.cookies_paywalls': 'browsers',
  'faq.safe': 'safety',
  'faq.cdp': 'safety',
  'faq.disable_approval_questions': 'safety',
  'faq.api_mutations': 'safety',
  'faq.profile': 'safety',
  'faq.screenshot_redaction': 'safety',
  'faq.page_context': 'safety',
  'faq.offline_licensing': 'safety',
};

const FAQ_PAGE_KEYS = [
  'faq.label',
  'faq.title',
  'faq.page.skip_to_main',
  'faq.page.lede',
  'faq.page.search',
  'faq.page.no_results',
  'faq.page.topics',
  ...FAQ_GROUPS.map((group) => `faq.category.${group}`),
  ...FAQ_KEYS.flatMap((base) => [`${base}.q`, `${base}.a_html`]),
];

const STRIPE_SUBSCRIBE_URL = 'https://buy.stripe.com/bJebJ13at2kc5XP7eY8g00a';

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function serializeScriptJson(value, space) {
  // JSON string escaping does not protect an HTML script element's raw-text
  // boundary. Encode HTML-significant characters without changing JSON data.
  return JSON.stringify(value, null, space)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function escJson(s) {
  return serializeScriptJson(String(s == null ? '' : s)).slice(1, -1);
}

function homeUrlFor(locale) {
  return locale.isDefault ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${locale.code}/`;
}

function homePathFor(locale) {
  return locale.isDefault ? '/' : `/${locale.code}/`;
}

// The browser extension lives on the homepage; /browser/ redirects there.
function browserPathFor(locale) {
  return homePathFor(locale);
}

function pageUrlFor(page, locale) {
  if (page === 'websites') return `${SITE_ORIGIN}${WEBSITES_PATH}`;
  return homeUrlFor(locale);
}

// The desktop Companion app's page exists in every site language.
function companionPathFor(locale) {
  return locale.isDefault ? '/companion/' : `/companion/${locale.code}/`;
}

function faqPathFor(locale) {
  return locale.isDefault ? '/docs/faq/' : `/docs/${locale.code}/faq/`;
}

function faqUrlFor(locale) {
  return `${SITE_ORIGIN}${faqPathFor(locale)}`;
}

const TRANSLATED_DOCS = { zh: '/docs/zh/', hi: '/docs/hi/' };

function docsPathFor(locale) {
  return TRANSLATED_DOCS[locale.code] || '/docs/';
}

// The footer's no-JavaScript language list, in the language picker's order.
const FOOTER_LANGUAGE_ORDER = ['en', 'hi', 'zh', 'ar', 'bn', 'nl', 'tl', 'fr', 'de', 'he', 'id', 'ja', 'ko', 'ms', 'fa', 'pt', 'ru', 'es', 'th', 'tr', 'uk', 'vi'];

function validateFooterLanguageOrder() {
  const codes = LOCALES.map((l) => l.code);
  const unlisted = codes.filter((code) => !FOOTER_LANGUAGE_ORDER.includes(code));
  const unknown = FOOTER_LANGUAGE_ORDER.filter((code) => !codes.includes(code));
  if (unlisted.length || unknown.length) {
    throw new Error(`FOOTER_LANGUAGE_ORDER is out of date (unlisted: ${unlisted.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`);
  }
}

function siteFooterFor(dict, locale, page) {
  // The homepage exists in every language, so its footer also lists the
  // other languages for visitors without JS.
  const languagePathFor = page === 'home' ? homePathFor : null;
  const languages = languagePathFor
    ? FOOTER_LANGUAGE_ORDER.map((code) => {
        const target = LOCALES.find((l) => l.code === code);
        return { code, label: target.label, href: languagePathFor(target) };
      })
    : [];
  return siteFooter(dict, {
    browserPath: browserPathFor(locale),
    websitesPath: WEBSITES_LAUNCHED ? WEBSITES_PATH : null,
    companionPath: companionPathFor(locale),
    docsPath: docsPathFor(locale),
    faqPath: faqPathFor(locale),
    languages,
  });
}

function buildHreflangBlock(urlFor = homeUrlFor) {
  const links = LOCALES.map(
    (l) => `  <link rel="alternate" hreflang="${l.code}" href="${urlFor(l)}">`,
  );
  // x-default points at the default (English) version of the page.
  const xDefault = `  <link rel="alternate" hreflang="x-default" href="${urlFor(LOCALES[0])}">`;
  return [...links, xDefault].join('\n');
}

// Headlines in most languages run longer than the English one. Measure
// roughly how wide the homepage headline will be (CJK and Hangul glyphs are
// about twice as wide as Latin letters) so long ones get the full-width layout.
function headlineWidth(text) {
  let width = 0;
  for (const ch of String(text || '')) {
    width += /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u.test(ch) ? 2 : 1;
  }
  return width;
}

function homeTitleSize(dict) {
  const suffix = WEBSITES_LAUNCHED ? '' : '_browser';
  return headlineWidth(`${dict[`home.title_line1${suffix}`] || ''} ${dict[`home.title_line2${suffix}`] || ''}`) > 45 ? 'long' : 'short';
}

function hreflangBlockFor(page) {
  // The websites page is English-only, so it has no alternates to announce.
  if (page === 'websites' || page === 'research') return '';
  return buildHreflangBlock(homeUrlFor);
}

function buildFaqHreflangBlock() {
  const links = LOCALES.map(
    (locale) => `  <link rel="alternate" hreflang="${locale.code}" href="${faqUrlFor(locale)}">`,
  );
  const xDefault = `  <link rel="alternate" hreflang="x-default" href="${faqUrlFor(LOCALES[0])}">`;
  return [...links, xDefault].join('\n');
}

function faqAnchorFor(base) {
  return base.replace(/^faq\./, '').replace(/_/g, '-');
}

function faqKeysForGroup(group) {
  return FAQ_KEYS.filter((base) => FAQ_CATEGORY[base] === group);
}

function answerHtml(value) {
  const html = String(value || '').trim();
  return /^<p(?:\s|>)/i.test(html) ? html : `<p>${html}</p>`;
}

function buildFaqSections(dict) {
  return FAQ_GROUPS.map((group) => {
    const items = faqKeysForGroup(group);
    const questions = items.map((base) => {
      const id = faqAnchorFor(base);
      return `      <details class="faq-question" id="${id}" data-faq-item>
        <summary><span>${escHtml(dict[`${base}.q`])}</span><span class="faq-question-mark" aria-hidden="true"></span></summary>
        <div class="faq-answer">${answerHtml(dict[`${base}.a_html`])}</div>
      </details>`;
    }).join('\n');
    return `    <section class="faq-topic" id="topic-${group}" data-faq-topic>
      <header class="faq-topic-header">
        <h2>${escHtml(dict[`faq.category.${group}`])}</h2>
        <span aria-label="${items.length}">${items.length}</span>
      </header>
${questions}
    </section>`;
  }).join('\n');
}

function buildFaqSidebarLinks(dict) {
  return FAQ_GROUPS.map((group) => (
    `<a href="#topic-${group}">${escHtml(dict[`faq.category.${group}`])}</a>`
  )).join('');
}

function buildFaqLanguageOptions(activeLocale) {
  return LOCALES.map((locale) => (
    `<option value="${locale.code}"${locale.code === activeLocale.code ? ' selected' : ''}>${escHtml(locale.label)}</option>`
  )).join('');
}

function buildFaqLanguageRoutes() {
  return serializeScriptJson(Object.fromEntries(
    LOCALES.map((locale) => [locale.code, faqPathFor(locale)]),
  ));
}

function validateFaqLocale(dict, localeCode) {
  const missing = FAQ_PAGE_KEYS.filter((key) => !String(dict[key] || '').trim());
  if (missing.length) {
    throw new Error(`[${localeCode}] missing FAQ translations: ${missing.join(', ')}`);
  }
}

function validateFaqRegistry() {
  const uncategorized = FAQ_KEYS.filter((base) => !FAQ_CATEGORY[base]);
  const unknown = Object.keys(FAQ_CATEGORY).filter((base) => !FAQ_KEYS.includes(base));
  if (uncategorized.length || unknown.length) {
    throw new Error(`Invalid FAQ category registry. Uncategorized: ${uncategorized.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}`);
  }
}

function htmlToPlain(html) {
  // Good-enough HTML → plain text for JSON-LD. Strips tags, collapses
  // whitespace, keeps entities like &amp; readable.
  return String(html)
    .replace(/<\/?(p|br|li|ul|ol|div)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildFaqJsonLd(dict, localeBcp47) {
  // We build the JSON object first, then stringify — safer than string concat
  // on every answer body.
  const mainEntity = [];
  for (const base of FAQ_KEYS) {
    const q = dict[`${base}.q`];
    const aHtml = dict[`${base}.a_html`];
    if (!q || !aHtml) continue;
    mainEntity.push({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: htmlToPlain(aHtml) },
    });
  }
  const payload = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: localeBcp47,
    mainEntity,
  };
  return serializeScriptJson(payload, 2);
}

function buildSoftwareJsonLd(dict, locale) {
  const payload = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'WebBrain',
    applicationCategory: 'BrowserApplication',
    operatingSystem: 'Chrome, Edge, Firefox',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    description: dict['meta.description'],
    url: homeUrlFor(locale),
    inLanguage: locale.bcp47,
    downloadUrl: 'https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb',
    softwareVersion: dict['meta.software_version'],
    author: { '@type': 'Person', name: 'Emre Sokullu', url: 'https://emresokullu.com' },
    license: 'https://www.gnu.org/licenses/gpl-3.0.html',
    isAccessibleForFree: true,
    image: LOGO_IMAGE_URL,
    screenshot: SOCIAL_IMAGE_URL,
  };
  return serializeScriptJson(payload, 2);
}

function buildHomeJsonLd(dict, locale) {
  const payload = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${SITE_ORIGIN}/#organization`,
        name: 'WebBrain',
        url: `${SITE_ORIGIN}/`,
        logo: LOGO_IMAGE_URL,
        sameAs: [
          'https://github.com/webbrain-one/webbrain',
          MASTODON_PROFILE_URL,
          BLUESKY_PROFILE_URL,
          HUGGINGFACE_PROFILE_URL,
        ],
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_ORIGIN}/#website`,
        name: 'WebBrain',
        url: homeUrlFor(locale),
        inLanguage: locale.bcp47,
        // home.meta.description also pitches WebBrain for websites.
        description: WEBSITES_LAUNCHED ? dict['home.meta.description'] : dict['meta.description'],
        publisher: { '@id': `${SITE_ORIGIN}/#organization` },
      },
    ],
  };
  return serializeScriptJson(payload, 2);
}

function buildSubscribeHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebBrain Compass Subscribe</title>
  <meta name="robots" content="noindex, follow">
  <link rel="canonical" href="${SITE_ORIGIN}/subscribe/">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #0b0e17;
      color: #e4e4ec;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
      line-height: 1.6;
    }
    main { max-width: 520px; text-align: center; }
    .brand {
      font-size: 20px;
      font-weight: 800;
      margin-bottom: 22px;
      color: #a78bfa;
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(28px, 5vw, 42px);
      line-height: 1.1;
    }
    p {
      margin: 0 auto 18px;
      color: #a7adbd;
      font-size: 16px;
    }
    a {
      color: #a78bfa;
      font-weight: 700;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    .spinner {
      width: 30px;
      height: 30px;
      margin: 26px auto;
      border: 3px solid rgba(167, 139, 250, 0.25);
      border-top-color: #a78bfa;
      border-radius: 50%;
      animation: spin 0.85s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main>
    <div class="brand">WebBrain Compass</div>
    <h1 id="subscribe-title">Redirecting to Stripe</h1>
    <p id="subscribe-copy">The payment page will open in a few seconds.</p>
    <p id="checkout-row">If redirect does not work, <a id="checkout-link" href="${STRIPE_SUBSCRIBE_URL}">open Stripe checkout</a>.</p>
    <div class="spinner" aria-hidden="true"></div>
  </main>
  <script>
    const checkoutUrl = new URL(${JSON.stringify(STRIPE_SUBSCRIBE_URL)});
    const clientReferenceId = new URLSearchParams(window.location.search).get('client_reference_id');
    if (clientReferenceId) {
      checkoutUrl.searchParams.set('client_reference_id', clientReferenceId);
      document.getElementById('checkout-link').href = checkoutUrl.toString();
      setTimeout(function () {
        window.location.href = checkoutUrl.toString();
      }, 3500);
    } else {
      document.getElementById('subscribe-title').textContent = 'Open this link from WebBrain';
      document.getElementById('subscribe-copy').textContent = 'You may be using an outdated version of the WebBrain plugin on your browser, please update.';
      document.getElementById('checkout-row').style.display = 'none';
    }
  </script>
</body>
</html>
`;
}

// Templates mark what depends on WebBrain for websites being open:
//   <!-- if websites -->shown once it launches<!-- else websites -->shown until then<!-- end websites -->
// The else part is optional. See WEBSITES_LAUNCHED in site-footer.mjs.
const WEBSITES_BLOCK_RE = /<!-- if websites -->([\s\S]*?)(?:<!-- else websites -->([\s\S]*?))?<!-- end websites -->/g;

function applyLaunchBlocks(html, launched = WEBSITES_LAUNCHED) {
  return html.replace(WEBSITES_BLOCK_RE, (_, on, off = '') => (launched ? on : off));
}

function applyTemplate(template, dict, locale, page = 'home') {
  const canonical = homeUrlFor(locale);
  const docsUrl = docsPathFor(locale);

  // Build-time placeholders first (they're fixed per locale, not per key).
  let out = applyLaunchBlocks(template)
    .replace(/\{\{locale_code\}\}/g, locale.code)
    .replace(/\{\{locale_code_upper\}\}/g, locale.code.toUpperCase())
    .replace(/\{\{locale_flag_code\}\}/g, LANGUAGE_FLAG_CODES[locale.code])
    .replace(/\{\{language_flag_codes\}\}/g, () => serializeScriptJson(LANGUAGE_FLAG_CODES))
    .replace(/\{\{locale_bcp47\}\}/g, locale.bcp47)
    .replace(/\{\{locale_dir\}\}/g, locale.dir || 'ltr')
    .replace(/\{\{locale_home_url\}\}/g, canonical)
    .replace(/\{\{page_url\}\}/g, pageUrlFor(page, locale))
    .replace(/\{\{browser_path\}\}/g, browserPathFor(locale))
    .replace(/\{\{websites_path\}\}/g, WEBSITES_PATH)
    .replace(/\{\{sites_dashboard_url\}\}/g, SITES_DASHBOARD_URL)
    .replace(/\{\{sites_demo_site_id\}\}/g, SITES_DEMO_SITE_ID)
    .replace(/\{\{home_title_size\}\}/g, homeTitleSize(dict))
    .replace(/\{\{docs_url\}\}/g, docsUrl)
    .replace(/\{\{docs_language_label\}\}/g, locale.code === 'zh' ? '中文' : locale.code === 'hi' ? 'हिन्दी' : 'EN')
    .replace(/\{\{faq_url\}\}/g, faqPathFor(locale))
    .replace(/\{\{faq_canonical\}\}/g, faqUrlFor(locale))
    .replace(/\{\{plausible_analytics\}\}/g, PLAUSIBLE_ANALYTICS)
    .replace(/\{\{site_footer_styles\}\}/g, () => SITE_FOOTER_STYLES)
    .replace(/\{\{site_footer\}\}/g, () => siteFooterFor(dict, locale, page))
    .replace(/\{\{hreflang_links\}\}/g, () => hreflangBlockFor(page))
    .replace(/\{\{faq_hreflang_links\}\}/g, buildFaqHreflangBlock())
    .replace(/\{\{faq_language_options\}\}/g, buildFaqLanguageOptions(locale))
    .replace(/\{\{faq_language_routes\}\}/g, () => buildFaqLanguageRoutes())
    .replace(/\{\{faq_sidebar_links\}\}/g, buildFaqSidebarLinks(dict))
    .replace(/\{\{faq_sections\}\}/g, buildFaqSections(dict))
    .replace(/\{\{faq_jsonld\}\}/g, () => buildFaqJsonLd(dict, locale.bcp47))
    .replace(/\{\{software_jsonld\}\}/g, () => buildSoftwareJsonLd(dict, locale))
    .replace(/\{\{home_jsonld\}\}/g, () => buildHomeJsonLd(dict, locale));

  // String substitutions. Missing keys fall back to English (already loaded
  // via the English dict being the default we pass in); we flag them below.
  const missing = new Set();

  // t-html first so {{t:...}} inside t-html values (rare but possible) is
  // replaced. Most values don't need both.
  out = out.replace(/\{\{t-html:([a-zA-Z0-9_.-]+)\}\}/g, (_, k) => {
    if (!(k in dict)) { missing.add(k); return ''; }
    return dict[k];
  });
  out = out.replace(/\{\{t:([a-zA-Z0-9_.-]+)\}\}/g, (_, k) => {
    if (!(k in dict)) { missing.add(k); return ''; }
    return escHtml(dict[k]);
  });
  // JSON-embedded values use {{j:key}} so we escape for JSON string context.
  out = out.replace(/\{\{j:([a-zA-Z0-9_.-]+)\}\}/g, (_, k) => {
    if (!(k in dict)) { missing.add(k); return ''; }
    return escJson(dict[k]);
  });
  // URL-encoded values for share intents etc. — {{u:key}} → encodeURIComponent.
  out = out.replace(/\{\{u:([a-zA-Z0-9_.-]+)\}\}/g, (_, k) => {
    if (!(k in dict)) { missing.add(k); return ''; }
    return encodeURIComponent(dict[k]);
  });

  return { html: out, missing };
}

async function main() {
  const template = await readFile(TEMPLATE_PATH, 'utf8');
  const websitesTemplate = await readFile(WEBSITES_TEMPLATE_PATH, 'utf8');
  const faqTemplate = await readFile(FAQ_TEMPLATE_PATH, 'utf8');
  const researchTemplate = await readFile(RESEARCH_TEMPLATE_PATH, 'utf8');
  const researchData = JSON.parse(await readFile(RESEARCH_DATA_PATH, 'utf8'));
  const researchStyles = await readFile(RESEARCH_STYLES_PATH, 'utf8');
  validateFaqRegistry();
  validateFooterLanguageOrder();
  await syncLanguageFlagAssets();
  await syncProviderIconAssets();
  // Keep the published Companion download page in sync with the standalone app.
  await cp(path.join(ROOT, '..', 'webbrain-systray', 'web'), path.join(ROOT, 'companion'), {
    recursive: true,
    force: true,
    filter: (source) => !['build.py', 'README.md', 'tools', 'locales', '__pycache__'].includes(path.basename(source)),
  });

  // Load English first so others can fall back for missing keys.
  const en = JSON.parse(await readFile(path.join(LOCALES_DIR, 'en.json'), 'utf8'));

  let totalMissing = 0;
  for (const locale of LOCALES) {
    const raw = locale.isDefault
      ? en
      : JSON.parse(await readFile(path.join(LOCALES_DIR, `${locale.code}.json`), 'utf8'));
    validateFaqLocale(raw, locale.code);

    let dict = raw;
    if (!locale.isDefault) {
      // Fall back to English for any untranslated key so the build never
      // produces an empty slot.
      dict = { ...en, ...raw };
    }
    // Synthesize per-locale share-intent URLs from the locale's share text
    // and page URL. Computed here (not in the JSON) so URL encoding stays
    // out of the locale files. The share buttons share the homepage in the
    // visitor's language.
    const shareUrl = homeUrlFor(locale);
    const shareText = dict['share.text'] || '';
    const shareTextWithUrl = `${shareText} ${shareUrl}`.trim();
    dict = {
      ...dict,
      'share.x_intent_url': `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`,
      'share.linkedin_intent_url': `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`,
      'share.mastodon_intent_url': `https://mastoturk.org/share?text=${encodeURIComponent(shareTextWithUrl)}`,
      'share.bluesky_intent_url': `https://bsky.app/intent/compose?text=${encodeURIComponent(shareTextWithUrl)}`,
    };

    const localeDir = locale.isDefault ? ROOT : path.join(ROOT, locale.code);
    const pages = [
      { page: 'home', source: template, outPath: path.join(localeDir, 'index.html') },
    ];
    // WebBrain for websites launches in English only.
    if (locale.isDefault) {
      pages.push({ page: 'websites', source: websitesTemplate, outPath: path.join(ROOT, 'websites', 'index.html') });
      // Research is English-only too: the mosaic plus one page per research line.
      for (const research of renderResearchPages(researchTemplate, researchData, { origin: SITE_ORIGIN, styles: researchStyles })) {
        pages.push({
          page: 'research',
          source: research.html,
          outPath: path.join(ROOT, researchPathFor(research.slug).replace(/^\//, ''), 'index.html'),
        });
      }
    }
    for (const { page, source, outPath } of pages) {
      const { html, missing } = applyTemplate(source, dict, locale, page);
      if (missing.size) {
        totalMissing += missing.size;
        console.warn(`[${locale.code}/${page}] ${missing.size} missing keys:`, [...missing].slice(0, 10).join(', '), missing.size > 10 ? '…' : '');
      }
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, html, 'utf8');
      console.log(`✓ wrote ${path.relative(process.cwd(), outPath)} (${html.length.toLocaleString()} bytes)`);
    }

    const { html: faqHtml, missing: faqMissing } = applyTemplate(faqTemplate, dict, locale, 'faq');
    if (faqMissing.size) {
      totalMissing += faqMissing.size;
      console.warn(`[${locale.code}] ${faqMissing.size} missing FAQ page keys:`, [...faqMissing].join(', '));
    }
    const faqOutPath = path.join(ROOT, faqPathFor(locale).replace(/^\//, ''), 'index.html');
    await mkdir(path.dirname(faqOutPath), { recursive: true });
    await writeFile(faqOutPath, faqHtml, 'utf8');
    console.log(`✓ wrote ${path.relative(process.cwd(), faqOutPath)} (${faqHtml.length.toLocaleString()} bytes)`);
  }

  // The privacy policy is written by hand; keep its footer the same as every
  // other page's.
  const privacyPath = path.join(ROOT, 'privacy.html');
  const privacy = await readFile(privacyPath, 'utf8');
  const privacyWithFooter = withSiteFooter(privacy, en);
  if (privacyWithFooter !== privacy) {
    await writeFile(privacyPath, privacyWithFooter, 'utf8');
    console.log('✓ updated privacy.html footer');
  }

  // sitemap.xml — localized homes, the websites page, plus
  // public utility, blog, and user-doc pages.
  const sitemapUrls = [
    ...LOCALES.map((l) => ({ loc: homeUrlFor(l), alternates: 'home' })),
    ...(WEBSITES_LAUNCHED ? [{ loc: `${SITE_ORIGIN}${WEBSITES_PATH}` }] : []),
    { loc: `${SITE_ORIGIN}${RESEARCH_PATH}` },
    ...researchData.projects.map((project) => ({ loc: `${SITE_ORIGIN}${researchPathFor(project.slug)}` })),
    ...LOCALES.map((l) => ({ loc: faqUrlFor(l), alternates: 'faq' })),
    { loc: `${SITE_ORIGIN}/privacy` },
    { loc: `${SITE_ORIGIN}/subscribe/` },
    { loc: `${SITE_ORIGIN}/blog/` },
    { loc: `${SITE_ORIGIN}/docs/` },
    { loc: `${SITE_ORIGIN}/docs/settings/` },
    { loc: `${SITE_ORIGIN}/docs/captcha/` },
    { loc: `${SITE_ORIGIN}/docs/providers/` },
    ...LOCALES.map((locale) => ({ loc: `${SITE_ORIGIN}${companionPathFor(locale)}` })),
    { loc: `${SITE_ORIGIN}/docs/easy-cli-proxy/`, alternates: 'easy-cli-proxy' },
    { loc: `${SITE_ORIGIN}/docs/safety/` },
    { loc: `${SITE_ORIGIN}/docs/apocalypse-mode/` },
    { loc: `${SITE_ORIGIN}/docs/mcp/` },
    { loc: `${SITE_ORIGIN}/docs/lm-studio/` },
    { loc: `${SITE_ORIGIN}/docs/ollama/` },
    { loc: `${SITE_ORIGIN}/docs/zh/` },
    { loc: `${SITE_ORIGIN}/docs/zh/settings/` },
    { loc: `${SITE_ORIGIN}/docs/zh/providers/` },
    { loc: `${SITE_ORIGIN}/docs/zh/easy-cli-proxy/`, alternates: 'easy-cli-proxy' },
    { loc: `${SITE_ORIGIN}/docs/zh/safety/` },
    { loc: `${SITE_ORIGIN}/docs/zh/apocalypse-mode/` },
    { loc: `${SITE_ORIGIN}/docs/zh/formats/` },
    { loc: `${SITE_ORIGIN}/docs/zh/mcp/` },
    { loc: `${SITE_ORIGIN}/docs/zh/lm-studio/` },
    { loc: `${SITE_ORIGIN}/docs/zh/ollama/` },
    { loc: `${SITE_ORIGIN}/docs/hi/` },
    { loc: `${SITE_ORIGIN}/docs/hi/settings/` },
    { loc: `${SITE_ORIGIN}/docs/hi/providers/` },
    { loc: `${SITE_ORIGIN}/docs/hi/easy-cli-proxy/`, alternates: 'easy-cli-proxy' },
    { loc: `${SITE_ORIGIN}/docs/hi/safety/` },
    { loc: `${SITE_ORIGIN}/docs/hi/apocalypse-mode/` },
    { loc: `${SITE_ORIGIN}/docs/hi/formats/` },
    { loc: `${SITE_ORIGIN}/docs/hi/mcp/` },
    { loc: `${SITE_ORIGIN}/docs/hi/lm-studio/` },
    { loc: `${SITE_ORIGIN}/docs/hi/ollama/` },
  ];
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...sitemapUrls.map((u) => {
      const alternateUrlFor = u.alternates === 'faq'
        ? faqUrlFor
        : homeUrlFor;
      const alts = u.alternates === 'easy-cli-proxy'
        ? [
            `    <xhtml:link rel="alternate" hreflang="en" href="${SITE_ORIGIN}/docs/easy-cli-proxy/"/>`,
            `    <xhtml:link rel="alternate" hreflang="hi" href="${SITE_ORIGIN}/docs/hi/easy-cli-proxy/"/>`,
            `    <xhtml:link rel="alternate" hreflang="zh" href="${SITE_ORIGIN}/docs/zh/easy-cli-proxy/"/>`,
            `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/docs/easy-cli-proxy/"/>`,
          ].join('\n') + '\n'
        : u.alternates
          ? LOCALES.map(
              (l) => `    <xhtml:link rel="alternate" hreflang="${l.code}" href="${alternateUrlFor(l)}"/>`,
            ).concat([`    <xhtml:link rel="alternate" hreflang="x-default" href="${alternateUrlFor(LOCALES[0])}"/>`]).join('\n') + '\n'
          : '';
      return `  <url>\n    <loc>${u.loc}</loc>\n${alts}  </url>`;
    }),
    '</urlset>',
  ].join('\n');
  await writeFile(path.join(ROOT, 'sitemap.xml'), sitemap, 'utf8');
  console.log('✓ wrote sitemap.xml');

  const subscribeDir = path.join(ROOT, 'subscribe');
  await mkdir(subscribeDir, { recursive: true });
  await writeFile(path.join(subscribeDir, 'index.html'), buildSubscribeHtml(), 'utf8');
  console.log('✓ wrote subscribe/index.html');

  // robots.txt
  const robots = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    '',
  ].join('\n');
  await writeFile(path.join(ROOT, 'robots.txt'), robots, 'utf8');
  console.log('✓ wrote robots.txt');

  if (totalMissing) {
    console.warn(`\nBuild finished with ${totalMissing} missing translation keys (filled with English fallback).`);
  } else {
    console.log('\nBuild OK — all locales translated fully.');
  }
}

export {
  serializeScriptJson, escJson, htmlToPlain, buildFaqJsonLd,
  buildSoftwareJsonLd, buildFaqLanguageRoutes, applyTemplate, applyLaunchBlocks,
};

// Importing the pure builders must not generate site files.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
