#!/usr/bin/env node
/**
 * Ensures every documentation page includes the shared site analytics partial,
 * the shared links that belong in its guide navigation, and the footer every
 * webbrain.one page shares.
 *
 * This idempotent pass recursively covers new HTML pages added under web/docs,
 * so authors do not have to copy the analytics block page by page.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAUSIBLE_SCRIPT_URL, withPlausibleAnalytics } from '../web/build/plausible.mjs';
import { WEBSITES_LAUNCHED, withSiteFooter } from '../web/build/site-footer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'web', 'docs');
const LOCALES_DIR = path.join(REPO_ROOT, 'web', 'build', 'locales');

async function listHtmlFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listHtmlFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(fullPath);
  }
  return files.sort();
}

// Guide navigation and footer per translated docs set. English pages live at
// the /docs/ root; each translated set mirrors it under /docs/<code>/.
const GUIDE_LANGUAGES = {
  zh: { overview: '/docs/zh/', faq: '/docs/zh/faq/', faqLabel: '常见问题' },
  hi: { overview: '/docs/hi/', faq: '/docs/hi/faq/', faqLabel: 'अक्सर पूछे जाने वाले सवाल' },
  fr: { overview: '/docs/fr/', faq: '/docs/fr/faq/', faqLabel: 'FAQ' },
  es: { overview: '/docs/es/', faq: '/docs/es/faq/', faqLabel: 'Preguntas frecuentes' },
  de: { overview: '/docs/de/', faq: '/docs/de/faq/', faqLabel: 'FAQ' },
  ar: { overview: '/docs/ar/', faq: '/docs/ar/faq/', faqLabel: 'الأسئلة الشائعة' },
  tr: { overview: '/docs/tr/', faq: '/docs/tr/faq/', faqLabel: 'SSS' },
  nl: { overview: '/docs/nl/', faq: '/docs/nl/faq/', faqLabel: 'FAQ' },
  id: { overview: '/docs/id/', faq: '/docs/id/faq/', faqLabel: 'FAQ' },
  tl: { overview: '/docs/tl/', faq: '/docs/tl/faq/', faqLabel: 'FAQ' },
  en: { overview: '/docs/', faq: '/docs/faq/', faqLabel: 'FAQ' },
};

function guideLanguageFor(normalizedPath) {
  const match = normalizedPath.match(/\/web\/docs\/([a-z]{2})\//);
  return match && GUIDE_LANGUAGES[match[1]] ? match[1] : 'en';
}

function withGuideNavigation(html, file) {
  const normalized = file.replace(/\\/g, '/');
  // FAQ pages have a page-specific topic rail instead of the guide index.
  if (normalized.endsWith('/faq/index.html')) return html;

  const lang = guideLanguageFor(normalized);
  const isEnglish = lang === 'en';
  const { overview: overviewHref, faq: faqHref, faqLabel } = GUIDE_LANGUAGES[lang];
  let generated = html;
  if (!generated.includes(`href="${faqHref}"`)) {
    const escapedOverview = overviewHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const overviewLink = new RegExp(`(<nav><a href="${escapedOverview}"[^>]*>[^<]*<\\/a>)`);
    const withFaq = generated.replace(overviewLink, `$1<a href="${faqHref}">${faqLabel}</a>`);
    if (withFaq === generated) {
      throw new Error(`${path.relative(REPO_ROOT, file)} is missing the docs overview navigation anchor`);
    }
    generated = withFaq;
  }

  const hasApocalypseModeNavigation = /<a href="\/docs\/apocalypse-mode\/"[^>]*>Apocalypse Mode<\/a>/.test(generated);
  if (isEnglish && !hasApocalypseModeNavigation) {
    const safetyLink = /(<a href="\/docs\/safety\/"[^>]*>[^<]*<\/a>)/;
    const withApocalypseMode = generated.replace(
      safetyLink,
      '$1<a href="/docs/apocalypse-mode/">Apocalypse Mode</a>',
    );
    if (withApocalypseMode === generated) {
      throw new Error(`${path.relative(REPO_ROOT, file)} is missing the safety guide navigation anchor`);
    }
    generated = withApocalypseMode;
  }

  const companionHref = '/companion/';
  const companionLabel = 'WebBrain Companion';
  const escapedCompanionHref = companionHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedCompanionLabel = companionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasCompanionNavigation = new RegExp(
    `<a href="${escapedCompanionHref}"[^>]*>${escapedCompanionLabel}<\\/a>`,
  ).test(generated);
  if (!hasCompanionNavigation) {
    const providersHref = `${overviewHref}providers/`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const providersLink = new RegExp(`(<a href="${providersHref}"[^>]*>[^<]*<\\/a>)`);
    const withCompanion = generated.replace(
      providersLink,
      `$1<a href="${companionHref}">${companionLabel}</a>`,
    );
    if (withCompanion === generated) {
      throw new Error(`${path.relative(REPO_ROOT, file)} is missing the providers guide navigation anchor`);
    }
    generated = withCompanion;
  }

  // The WebBrain for websites guide gets its own group after "Use WebBrain",
  // while the site shows that product (WEBSITES_LAUNCHED). English only.
  const websitesGroup = /<div class="sidebar-group"><div class="sidebar-label">On your website<\/div><nav><a href="\/docs\/websites\/"[^>]*>WebBrain for websites<\/a><\/nav><\/div>/;
  if (isEnglish && WEBSITES_LAUNCHED && !websitesGroup.test(generated)) {
    generated = generated.replace(
      /(<a href="\/docs\/ollama\/"[^>]*>Ollama<\/a><\/nav>\s*<\/div>)/,
      '$1<div class="sidebar-group"><div class="sidebar-label">On your website</div><nav><a href="/docs/websites/">WebBrain for websites</a></nav></div>',
    );
  } else if (!WEBSITES_LAUNCHED && !normalized.endsWith('/web/docs/websites/index.html')) {
    generated = generated.replace(websitesGroup, '');
  }

  return generated;
}

function withDocsFooter(html, file, dictionaries) {
  const normalized = file.replace(/\\/g, '/');
  // The FAQ pages are built from web/build/faq-template.html, which already
  // renders the footer in each FAQ's own language.
  if (normalized.endsWith('/faq/index.html')) return html;
  const lang = guideLanguageFor(normalized);
  if (lang !== 'en') {
    const { overview, faq } = GUIDE_LANGUAGES[lang];
    return withSiteFooter(html, dictionaries[lang], {
      browserPath: `/${lang}/`,
      companionPath: `/companion/${lang}/`,
      docsPath: overview,
      faqPath: faq,
    });
  }
  return withSiteFooter(html, dictionaries.en);
}

async function main() {
  const en = JSON.parse(await readFile(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
  const dictionaries = { en };
  for (const code of Object.keys(GUIDE_LANGUAGES)) {
    if (code === 'en') continue;
    dictionaries[code] = { ...en, ...JSON.parse(await readFile(path.join(LOCALES_DIR, `${code}.json`), 'utf8')) };
  }
  const files = await listHtmlFiles(DOCS_DIR);
  for (const file of files) {
    const original = await readFile(file, 'utf8');
    const generated = withDocsFooter(
      withGuideNavigation(withPlausibleAnalytics(original), file),
      file,
      dictionaries,
    );
    const occurrences = generated.split(PLAUSIBLE_SCRIPT_URL).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${path.relative(REPO_ROOT, file)} contains ${occurrences} Plausible scripts`);
    }
    if (generated !== original) await writeFile(file, generated, 'utf8');
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
