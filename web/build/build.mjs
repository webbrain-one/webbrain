#!/usr/bin/env node
/**
 * WebBrain marketing-site build.
 *
 * Reads web/build/template.html + web/build/locales/*.json and writes:
 *   web/index.html
 *   web/{es,fr,tr,zh}/index.html
 *   web/sitemap.xml
 *   web/robots.txt
 *
 * Template uses {{t:key}} / {{t-html:key}} markers, plus a few build-only
 * placeholders the script fills per locale:
 *   {{locale_code}}      e.g. "en", "es"
 *   {{locale_bcp47}}     e.g. "en-US", "es-ES" (used in og:locale)
 *   {{locale_home_url}}  e.g. "https://webbrain.one/" or ".../es/"
 *   {{hreflang_links}}   <link rel="alternate" ...> block for this page
 *   {{faq_jsonld}}       FAQPage schema block generated from faq.* keys
 *
 * {{t:key}} → plain-text substitution, HTML-escaped.
 * {{t-html:key}} → raw substitution (value is expected to be HTML-ready).
 * Use t-html only for values containing intentional inline HTML like
 * <strong>, <a>, <code>.
 *
 * There is NO dependency on npm packages — pure Node ESM.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');           // web/
const BUILD_DIR = __dirname;                          // web/build/
const LOCALES_DIR = path.join(BUILD_DIR, 'locales');
const TEMPLATE_PATH = path.join(BUILD_DIR, 'template.html');
const SITE_ORIGIN = 'https://webbrain.one';
const SOCIAL_IMAGE_URL = `${SITE_ORIGIN}/og-image.png`;
const FEATURED_HOME_PROMO = {
  urlPath: '/blog/ollama-launch-handoff',
  imagePath: '/assets/webbrain-ollama-heart.png',
};

// Locale config. The default locale (en) renders to web/index.html;
// the others render to web/<code>/index.html.
const LOCALES = [
  { code: 'en', bcp47: 'en-US', label: 'English',          dir: 'ltr', isDefault: true  },
  { code: 'es', bcp47: 'es-ES', label: 'Español',          dir: 'ltr', isDefault: false },
  { code: 'fr', bcp47: 'fr-FR', label: 'Français',         dir: 'ltr', isDefault: false },
  { code: 'tr', bcp47: 'tr-TR', label: 'Türkçe',           dir: 'ltr', isDefault: false },
  { code: 'zh', bcp47: 'zh-CN', label: '中文',             dir: 'ltr', isDefault: false },
  { code: 'ru', bcp47: 'ru-RU', label: 'Русский',          dir: 'ltr', isDefault: false },
  { code: 'uk', bcp47: 'uk-UA', label: 'Українська',       dir: 'ltr', isDefault: false },
  { code: 'ar', bcp47: 'ar',    label: 'العربية',          dir: 'rtl', isDefault: false },
  { code: 'ja', bcp47: 'ja-JP', label: '日本語',           dir: 'ltr', isDefault: false },
  { code: 'ko', bcp47: 'ko-KR', label: '한국어',           dir: 'ltr', isDefault: false },
  { code: 'id', bcp47: 'id-ID', label: 'Bahasa Indonesia', dir: 'ltr', isDefault: false },
  { code: 'th', bcp47: 'th-TH', label: 'ไทย',              dir: 'ltr', isDefault: false },
  { code: 'ms', bcp47: 'ms-MY', label: 'Bahasa Melayu',    dir: 'ltr', isDefault: false },
  { code: 'tl', bcp47: 'fil-PH', label: 'Filipino',        dir: 'ltr', isDefault: false },
];

const FAQ_KEYS = [
  // Order matters — this is the rendered order in-page AND in JSON-LD.
  'faq.alt_claude',
  'faq.cloud_subscription',
  'faq.vs_frameworks',
  'faq.offline',
  'faq.models_supported',
  'faq.recommended_model',
  'faq.cors',
  'faq.ollama_origins',
  'faq.firefox',
  'faq.firefox_sidebar_move',
  'faq.safe',
  'faq.cdp',
  'faq.disable_approval_questions',
  'faq.scraping',
  'faq.api_mutations',
  'faq.lm_studio',
  'faq.tab_switch',
  'faq.profile',
  'faq.cookies_paywalls',
  'faq.multilingual',
  'faq.token_conscious',
  'faq.contribute',
];

const STRIPE_SUBSCRIBE_URL = 'https://buy.stripe.com/bJebJ13at2kc5XP7eY8g00a';
const MASTODON_PROFILE_URL = 'https://mastoturk.org/@webbrain';
const BLUESKY_PROFILE_URL = 'https://bsky.app/profile/webbrain-one.bsky.social';

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escJson(s) {
  // JSON.stringify handles escaping; strip the surrounding quotes.
  return JSON.stringify(String(s == null ? '' : s)).slice(1, -1);
}

function homeUrlFor(locale) {
  return locale.isDefault ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${locale.code}/`;
}

function buildHreflangBlock() {
  const links = LOCALES.map(
    (l) => `  <link rel="alternate" hreflang="${l.code}" href="${homeUrlFor(l)}">`,
  );
  // x-default points at the default (English) homepage.
  const xDefault = `  <link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/">`;
  return [...links, xDefault].join('\n');
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
  return JSON.stringify(payload, null, 2);
}

function buildSoftwareJsonLd(dict, locale) {
  const payload = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'WebBrain',
    applicationCategory: 'BrowserApplication',
    operatingSystem: 'Chrome, Firefox',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    description: dict['meta.description'],
    url: homeUrlFor(locale),
    inLanguage: locale.bcp47,
    downloadUrl: 'https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb',
    softwareVersion: dict['meta.software_version'],
    author: { '@type': 'Person', name: 'Emre Sokullu', url: 'https://emresokullu.com' },
    license: 'https://opensource.org/licenses/MIT',
    isAccessibleForFree: true,
    screenshot: SOCIAL_IMAGE_URL,
  };
  return JSON.stringify(payload, null, 2);
}

function buildSubscribeHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WebBrain Cloud Subscribe</title>
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
    <div class="brand">WebBrain Cloud</div>
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

function applyTemplate(template, dict, locale) {
  const canonical = homeUrlFor(locale);

  // Build-time placeholders first (they're fixed per locale, not per key).
  let out = template
    .replace(/\{\{locale_code\}\}/g, locale.code)
    .replace(/\{\{locale_bcp47\}\}/g, locale.bcp47)
    .replace(/\{\{locale_dir\}\}/g, locale.dir || 'ltr')
    .replace(/\{\{locale_home_url\}\}/g, canonical)
    .replace(/\{\{hreflang_links\}\}/g, buildHreflangBlock())
    .replace(/\{\{faq_jsonld\}\}/g, buildFaqJsonLd(dict, locale.bcp47))
    .replace(/\{\{software_jsonld\}\}/g, buildSoftwareJsonLd(dict, locale));

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

  // Load English first so others can fall back for missing keys.
  const en = JSON.parse(await readFile(path.join(LOCALES_DIR, 'en.json'), 'utf8'));

  let totalMissing = 0;
  for (const locale of LOCALES) {
    let dict = en;
    if (!locale.isDefault) {
      const raw = JSON.parse(await readFile(path.join(LOCALES_DIR, `${locale.code}.json`), 'utf8'));
      // Fall back to English for any untranslated key so the build never
      // produces an empty slot.
      dict = { ...en, ...raw };
    }
    // Synthesize per-locale share-intent URLs from the locale's share text
    // and home URL. Computed here (not in the JSON) so URL encoding stays
    // out of the locale files. The shared URL is the locale's homepage so
    // the recipient lands on a localized version when they open it.
    const homeUrl = homeUrlFor(locale);
    const shareText = dict['share.text'] || '';
    const shareTextWithUrl = `${shareText} ${homeUrl}`.trim();
    dict = {
      ...dict,
      'featured_home_promo.url': `${SITE_ORIGIN}${FEATURED_HOME_PROMO.urlPath}`,
      'featured_home_promo.image': FEATURED_HOME_PROMO.imagePath,
      'share.x_intent_url': `https://x.com/intent/post?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(homeUrl)}`,
      'share.linkedin_intent_url': `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(homeUrl)}`,
      'share.mastodon_intent_url': `https://mastoturk.org/share?text=${encodeURIComponent(shareTextWithUrl)}`,
      'share.bluesky_intent_url': `https://bsky.app/intent/compose?text=${encodeURIComponent(shareTextWithUrl)}`,
      'social.mastodon_url': MASTODON_PROFILE_URL,
      'social.bluesky_url': BLUESKY_PROFILE_URL,
    };

    const { html, missing } = applyTemplate(template, dict, locale);
    if (missing.size) {
      totalMissing += missing.size;
      console.warn(`[${locale.code}] ${missing.size} missing keys:`, [...missing].slice(0, 10).join(', '), missing.size > 10 ? '…' : '');
    }

    const outPath = locale.isDefault
      ? path.join(ROOT, 'index.html')
      : path.join(ROOT, locale.code, 'index.html');
    if (!locale.isDefault) {
      await mkdir(path.dirname(outPath), { recursive: true });
    }
    await writeFile(outPath, html, 'utf8');
    console.log(`✓ wrote ${path.relative(process.cwd(), outPath)} (${html.length.toLocaleString()} bytes)`);
  }

  // sitemap.xml — one URL per localized home, plus privacy + blog index.
  const sitemapUrls = [
    ...LOCALES.map((l) => ({ loc: homeUrlFor(l), hreflang: l.code })),
    { loc: `${SITE_ORIGIN}/privacy` },
    { loc: `${SITE_ORIGIN}/subscribe/` },
    { loc: `${SITE_ORIGIN}/blog/` },
  ];
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...sitemapUrls.map((u) => {
      const alts = u.hreflang
        ? LOCALES.map(
            (l) => `    <xhtml:link rel="alternate" hreflang="${l.code}" href="${homeUrlFor(l)}"/>`,
          ).concat([`    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_ORIGIN}/"/>`]).join('\n') + '\n'
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
