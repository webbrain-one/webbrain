/**
 * The one footer every webbrain.one page shares: the homepage, the browser
 * extension and websites pages, the FAQ, the docs, the blog and the privacy
 * policy.
 *
 * Builders put SITE_FOOTER_STYLES in <head> and render the markup with
 * siteFooter(dict, paths) in the visitor's language. Hand-written pages (docs,
 * privacy) get both through withSiteFooter(), which rewrites them in place
 * and is safe to run on every build.
 *
 * The colors follow each page's own theme tokens (--text/--text-dim/--border
 * on the landing pages and blog, --ink/--muted/--line in the docs). A page
 * whose content column is narrower or wider than the default can line the
 * footer up with its header by setting --wb-footer-width on :root, and can
 * give it a solid background with --wb-footer-bg.
 */

// Whether the site shows WebBrain for websites: the homepage's "On your
// website" block, the For websites links, and the /websites/ actions that lead
// to the dashboard at sites.webbrain.one. Set it to false (or build with
// WEBBRAIN_WEBSITES_LAUNCHED=0 to preview) to hide all of it again; nothing is
// deleted either way.
export const WEBSITES_LAUNCHED = process.env.WEBBRAIN_WEBSITES_LAUNCHED
  ? process.env.WEBBRAIN_WEBSITES_LAUNCHED === '1'
  : true;

export const MASTODON_PROFILE_URL = 'https://mastoturk.org/@webbrain';
export const BLUESKY_PROFILE_URL = 'https://bsky.app/profile/webbrain-one.bsky.social';
export const DISCORD_INVITE_URL = 'https://discord.gg/cgC325ssfw';
export const HUGGINGFACE_PROFILE_URL = 'https://huggingface.co/webbrain-one';

const ICONS = {
  mastodon: '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M21.327 8.566c0-5.035-3.298-6.511-3.298-6.511C16.366 1.292 13.508.971 12.04.947h-.036c-1.468.024-4.326.345-5.989 1.108 0 0-3.298 1.476-3.298 6.511 0 1.153-.022 2.535.014 4.001.12 4.935.907 9.799 5.478 11.007 2.106.557 3.916.674 5.374.594 2.645-.147 4.128-.943 4.128-.943l-.087-1.918s-1.888.595-4.012.523c-2.104-.072-4.326-.227-4.668-2.809a5.289 5.289 0 0 1-.047-.724s2.066.505 4.686.625c1.603.073 3.107-.094 4.632-.276 2.925-.349 5.474-2.149 5.794-3.793.503-2.591.462-6.287.462-6.287ZM8.545 15.023H6.09V8.996c0-2.534 1.627-3.829 3.424-3.829 1.963 0 2.909 1.268 3.35 2.257.44-.989 1.386-2.257 3.349-2.257 1.797 0 3.424 1.295 3.424 3.829v6.027h-2.454V9.174c0-1.233-.519-1.859-1.557-1.859-1.148 0-1.724.742-1.724 2.207v3.203h-2.454V9.522c0-1.465-.576-2.207-1.724-2.207-1.038 0-1.557.626-1.557 1.859v5.849Z"/></svg>',
  bluesky: '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M12 10.8c-1.1-2.1-4-6-6.8-8C2.6.9 1.6 1.3.9 1.6.1 1.9 0 3.1 0 3.8c0 .7.4 5.7.6 6.5.8 2.7 3.7 3.7 5.6 3.4-3.5.6-6.5 2-2.5 6.5 4.3 4.5 5.9-1 6.3-2.8.1-.5.2-.8.3-.8.1 0 .2.3.3.8.4 1.8 2 7.3 6.3 2.8 4-4.5 1-5.9-2.5-6.5 1.9.3 4.8-.7 5.6-3.4.2-.8.6-5.8.6-6.5 0-.7-.1-1.9-.9-2.2-.7-.3-1.7-.6-4.3 1.2-2.8 2-5.7 5.9-6.8 8Z"/></svg>',
  discord: '<svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M13.545 2.907a13.227 13.227 0 0 0-3.257-1.011c.05.069.098.137.142.207a12.471 12.471 0 0 0-3.616 0c.044-.07.093-.138.143-.207A13.207 13.207 0 0 0 3.7 2.907 13.136 13.136 0 0 0 .931 13.362a13.667 13.667 0 0 0 4.022 2.018c.33-.442.623-.907.87-1.396a8.95 8.95 0 0 1-1.37-.652c.114-.083.225-.171.33-.269a9.6 9.6 0 0 0 8.243 0c.108.09.218.18.33.269a8.923 8.923 0 0 1-1.37.652c.248.489.54.954.87 1.396a13.667 13.667 0 0 0 4.022-2.018 13.136 13.136 0 0 0-2.769-10.455zM5.106 11.275c-.788 0-1.438-.72-1.438-1.608 0-.889.625-1.608 1.438-1.608.818 0 1.451.726 1.438 1.608 0 .888-.625 1.608-1.438 1.608zm5.788 0c-.788 0-1.438-.72-1.438-1.608 0-.889.625-1.608 1.438-1.608.818 0 1.451.726 1.438 1.608 0 .888-.625 1.608-1.438 1.608z"/></svg>',
  huggingface: '<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true"><path d="M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624"/></svg>',
};

export const SITE_FOOTER_STYLES = `  <!-- Site footer styles: start -->
  <style>
    .wb-footer {
      --wb-footer-text: var(--text, var(--ink, #2c1810));
      --wb-footer-dim: var(--text-dim, var(--muted, #6b5b47));
      --wb-footer-line: var(--border, var(--line, rgba(89, 55, 25, 0.15)));
      margin: 0;
      padding: 0;
      border-top: 1px solid var(--wb-footer-line);
      background: var(--wb-footer-bg, none);
      color: var(--wb-footer-dim);
      font-size: 13px;
      line-height: 1.5;
      text-align: start;
    }
    .wb-footer-inner {
      width: var(--wb-footer-width, min(calc(100% - 48px), 1100px));
      margin: 0 auto;
      padding: 26px 0 30px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    /* Page links start on the brand's left edge; the social icons sit at
       the far end of the same row. */
    .wb-footer-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px 32px; }
    .wb-footer-brand { display: flex; flex-direction: column; gap: 5px; }
    .wb-footer-tagline { margin: 0; color: var(--wb-footer-text); font-size: 15px; font-weight: 700; line-height: 1.4; }
    .wb-footer-copy { margin: 0; }
    .wb-footer-copy a { color: var(--wb-footer-text); font-weight: 650; text-decoration: none; }
    .wb-footer-links { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; }
    .wb-footer-social { display: flex; align-items: center; gap: 8px; }
    .wb-footer-links a { color: var(--wb-footer-dim); font-weight: 600; text-decoration: none; }
    .wb-footer a:hover { color: var(--wb-footer-text); text-decoration: none; }
    .wb-footer a:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; border-radius: 4px; }
    .wb-footer-icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; margin: -4px 0; border-radius: 6px; }
    .wb-footer-icon:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
    .wb-footer-icon svg { display: block; width: 15px; height: 15px; }
    /* Only shown without JavaScript, when the language picker can't run. */
    .wb-footer-languages { display: none; flex-wrap: wrap; gap: 6px 12px; width: 100%; direction: ltr; }
    .wb-footer-languages span { color: var(--wb-footer-text); font-weight: 700; }
    @media (max-width: 860px) {
      .wb-footer-inner { width: var(--wb-footer-width, calc(100% - 32px)); }
    }
  </style>
  <!-- Site footer styles: end -->`;

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function socialLink(href, label, icon, rel = 'me noopener') {
  return `<a href="${href}" target="_blank" rel="${rel}" aria-label="${label}" title="${label}" class="wb-footer-icon">${icon}</a>`;
}

/**
 * Renders the footer in the language of `dict` (a locale dictionary from
 * web/build/locales). Paths default to the English pages; localized pages pass
 * their own. `languages` ([{ code, label, href }]) adds the no-JavaScript
 * language list that the landing pages reveal from a <noscript> style.
 */
export function siteFooter(dict, {
  browserPath = '/',
  // null leaves the link out (see WEBSITES_LAUNCHED).
  websitesPath = WEBSITES_LAUNCHED ? '/websites/' : null,
  companionPath = '/companion/',
  researchPath = '/research/',
  docsPath = '/docs/',
  faqPath = '/docs/faq/',
  blogPath = '/blog/',
  privacyPath = '/privacy',
  languages = [],
} = {}) {
  const t = (key) => {
    if (!(key in dict)) throw new Error(`Site footer: missing locale key ${key}`);
    return esc(dict[key]);
  };
  if (!('footer.copyright_html' in dict)) throw new Error('Site footer: missing locale key footer.copyright_html');
  const languageList = languages.length
    ? `
    <div class="wb-footer-languages">
      <span>${t('nav.language_aria')}</span>
${languages.map((l) => `      <a href="${esc(l.href)}" hreflang="${esc(l.code)}" lang="${esc(l.code)}">${esc(l.label)}</a>`).join('\n')}
    </div>`
    : '';
  return `<!-- Site footer: start -->
<footer class="wb-footer">
  <div class="wb-footer-inner">
    <div class="wb-footer-brand">
      <p class="wb-footer-tagline">${t('footer.tagline')}</p>
      <p class="wb-footer-copy">${dict['footer.copyright_html']}</p>
    </div>
    <div class="wb-footer-row">
      <div class="wb-footer-links">
        <a href="${esc(browserPath)}">${t('nav.browser_extension')}</a>
${websitesPath ? `        <a href="${esc(websitesPath)}">${t('nav.for_websites')}</a>
` : ''}        <a href="${esc(companionPath)}">${t('footer.link_companion')}</a>
        <a href="${esc(researchPath)}">${t('nav.research')}</a>
        <a href="${esc(docsPath)}">${t('nav.docs')}</a>
        <a href="${esc(faqPath)}">${t('nav.faq')}</a>
        <a href="${esc(blogPath)}">${t('nav.blog')}</a>
        <a href="${esc(privacyPath)}">${t('footer.link_privacy')}</a>
        <a href="https://github.com/webbrain-one/webbrain/issues" target="_blank" rel="noopener">${t('footer.link_report_bug')}</a>
        <a href="https://github.com/webbrain-one/webbrain/blob/main/LICENSE" target="_blank" rel="noopener">${t('footer.link_license')}</a>
        <a href="https://pressreleases.online/org/webbrain.one" target="_blank" rel="noopener">${t('footer.link_press_releases')}</a>
        <a href="https://api.webbrain.one/account" target="_blank" rel="noopener">${t('footer.link_compass_subscription')}</a>
      </div>
      <div class="wb-footer-social">
        ${socialLink(MASTODON_PROFILE_URL, t('social.mastodon_label'), ICONS.mastodon)}
        ${socialLink(BLUESKY_PROFILE_URL, t('social.bluesky_label'), ICONS.bluesky)}
        ${socialLink(DISCORD_INVITE_URL, t('social.discord_label'), ICONS.discord, 'noopener')}
        ${socialLink(HUGGINGFACE_PROFILE_URL, t('social.huggingface_label'), ICONS.huggingface)}
      </div>
    </div>${languageList}
  </div>
</footer>
<!-- Site footer: end -->`;
}

const STYLES_BLOCK_RE = /[ \t]*<!-- Site footer styles: start -->[\s\S]*?<!-- Site footer styles: end -->/;
const FOOTER_BLOCK_RE = /<!-- Site footer: start -->[\s\S]*?<!-- Site footer: end -->/;
const LEGACY_FOOTER_RE = /<footer\b[^>]*>[\s\S]*?<\/footer>/;

/**
 * Puts the shared footer and its styles into a hand-written page. Replaces a
 * previous copy, or the page's own <footer> the first time.
 */
export function withSiteFooter(html, dict, paths = {}) {
  let out = html;
  if (STYLES_BLOCK_RE.test(out)) {
    out = out.replace(STYLES_BLOCK_RE, () => SITE_FOOTER_STYLES);
  } else if (out.includes('</head>')) {
    out = out.replace('</head>', () => `${SITE_FOOTER_STYLES}\n</head>`);
  } else {
    throw new Error('Cannot add the site footer styles: document has no </head> tag');
  }

  const footer = siteFooter(dict, paths);
  if (FOOTER_BLOCK_RE.test(out)) return out.replace(FOOTER_BLOCK_RE, () => footer);
  if (LEGACY_FOOTER_RE.test(out)) return out.replace(LEGACY_FOOTER_RE, () => footer);
  throw new Error('Cannot add the site footer: document has no <footer> to replace');
}
