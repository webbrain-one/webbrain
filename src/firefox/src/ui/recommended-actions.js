const SOCIAL_HOST_RE = /(^|\.)(instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|fb\.com|threads\.net|youtube\.com|youtu\.be|reddit\.com|pinterest\.com|snapchat\.com)$/i;
const DATING_HOST_RE = /(^|\.)(tinder\.com|bumble\.com|hinge\.co|okcupid\.com|match\.com|pof\.com|badoo\.com|happn\.com|coffeemeetsbagel\.com)$/i;
const SHOPPING_HOST_RE = /(^|\.)(amazon\.[a-z.]+|ebay\.[a-z.]+|etsy\.com|walmart\.com|target\.com|bestbuy\.com|shopify\.com|aliexpress\.com|mercadolibre\.[a-z.]+|mercadolivre\.com\.br|hepsiburada\.com|trendyol\.com|n11\.com|shopee\.[a-z.]+|lazada\.[a-z.]+)$/i;
const PRODUCT_PATH_RE = /\/(dp|gp\/product|itm|p|product|products|prod|item|listing|ilan|urun)\b/i;
const RELEASES_PATH_RE = /^\/[^/]+\/[^/]+\/releases(?:\/|$)/i;
const SEARCH_INPUT_RE = /^(search|q|query|keyword|keywords|s)$/i;

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function pathFromUrl(url) {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return '/';
  }
}

function addUnique(actions, action) {
  if (!action || !action.label || !action.prompt) return;
  if (actions.some((a) => a.label === action.label || a.prompt === action.prompt)) return;
  actions.push(action);
}

function hasNonSearchForm(forms = []) {
  return forms.some((form) => {
    const inputs = Array.isArray(form?.inputs) ? form.inputs : [];
    const useful = inputs.filter((input) => {
      const type = String(input?.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return false;
      const name = String(input?.name || input?.id || input?.placeholder || '').trim();
      if (type === 'search' || SEARCH_INPUT_RE.test(name)) return false;
      return true;
    });
    return useful.length >= 2 || useful.some((input) => /email|tel|phone|address|name|password|card|checkout|signup|sign-up/i.test(
      `${input?.type || ''} ${input?.name || ''} ${input?.id || ''} ${input?.placeholder || ''}`
    ));
  });
}

function hasMedia(pageInfo = {}) {
  const media = pageInfo.media || {};
  if ((media.videoCount || 0) > 0 || (media.imageCount || 0) > 0) return true;
  const text = `${pageInfo.title || ''} ${pageInfo.description || ''} ${pageInfo.url || ''}`;
  return /\b(video|photo|image|reel|shorts|watch)\b/i.test(text);
}

function hasCartOrPriceSignal(pageInfo = {}) {
  const haystack = [
    pageInfo.title,
    pageInfo.description,
    ...(pageInfo.links || []).slice(0, 40).flatMap((link) => [link?.text, link?.href]),
    ...(pageInfo.forms || []).flatMap((form) => (form?.inputs || []).flatMap((input) => [input?.name, input?.id, input?.placeholder])),
  ].filter(Boolean).join(' ');
  return /\b(add to cart|buy now|checkout|basket|cart|price|discount|sale|shipping|₺|\$|€|£)\b/i.test(haystack);
}

function isLongArticle(pageInfo = {}) {
  const textLen = String(pageInfo.text || '').trim().length;
  const url = String(pageInfo.url || '');
  const path = pathFromUrl(url);
  const articlePath = /\/(article|articles|news|blog|posts?|story|stories|\d{4}\/\d{2})\b/i.test(path);
  return textLen >= 1800 || (textLen >= 900 && articlePath);
}

export function buildRecommendedActions(pageInfo = {}, options = {}) {
  const max = Number.isFinite(options.max) ? options.max : 4;
  const host = hostFromUrl(pageInfo.url || '');
  const path = pathFromUrl(pageInfo.url || '');
  const actions = [];

  if (host === 'github.com' && RELEASES_PATH_RE.test(path)) {
    addUnique(actions, {
      id: 'github-release',
      label: 'Create a new release',
      prompt: 'Create a new GitHub release for this repository. Ask me for the tag, title, and release notes if needed.',
      mode: 'act',
    });
  }

  if (DATING_HOST_RE.test(host) && /\b(profile|discover|app|match|likes?)\b/i.test(`${path} ${pageInfo.title || ''}`)) {
    addUnique(actions, {
      id: 'like-profile',
      label: 'Like this person',
      prompt: 'Like this profile/person on the page.',
      mode: 'act',
    });
  }

  if ((SOCIAL_HOST_RE.test(host) || /\b(post|status|reel|shorts|watch|pin)\b/i.test(path)) && hasMedia(pageInfo)) {
    addUnique(actions, {
      id: 'download-media',
      label: 'Download this video/photo',
      prompt: 'Download the video or photo from this post.',
      mode: 'act',
    });
  }

  if (hasNonSearchForm(pageInfo.forms || [])) {
    addUnique(actions, {
      id: 'fill-profile',
      label: 'Fill this form with my saved profile info',
      prompt: 'Fill this form with my saved profile information. Ask before submitting.',
      mode: 'act',
    });
  }

  if (isLongArticle(pageInfo)) {
    addUnique(actions, {
      id: 'summarize-page',
      label: 'Summarize this page',
      prompt: 'Summarize this page in 5-8 concise bullet points and include any action items.',
    });
  }

  if ((SHOPPING_HOST_RE.test(host) || PRODUCT_PATH_RE.test(path)) && hasCartOrPriceSignal(pageInfo)) {
    addUnique(actions, {
      id: 'compare-price',
      label: 'Compare this price with other stores',
      prompt: 'Compare this product\'s price with other stores and summarize the best alternatives.',
    });
  }

  if (!actions.length && pageInfo.title) {
    addUnique(actions, {
      id: 'explain-page',
      label: 'Explain this page',
      prompt: 'Explain what this page is about and what I can do next.',
    });
  }

  return actions.slice(0, Math.max(0, max));
}
