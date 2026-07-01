const SOCIAL_HOST_RE = /(^|\.)(instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|fb\.com|threads\.net|youtube\.com|youtu\.be|reddit\.com|pinterest\.com|snapchat\.com)$/i;
const DATING_HOST_RE = /(^|\.)(tinder\.com|bumble\.com|hinge\.co|okcupid\.com|match\.com|pof\.com|badoo\.com|happn\.com|coffeemeetsbagel\.com)$/i;
const SHOPPING_HOST_RE = /(^|\.)(amazon\.[a-z.]+|ebay\.[a-z.]+|etsy\.com|walmart\.com|target\.com|bestbuy\.com|shopify\.com|aliexpress\.com|mercadolibre\.[a-z.]+|mercadolivre\.com\.br|hepsiburada\.com|trendyol\.com|n11\.com|shopee\.[a-z.]+|lazada\.[a-z.]+)$/i;
const PRODUCT_PATH_RE = /\/(dp|gp\/product|itm|p|product|products|prod|item|listing|ilan|urun)\b/i;
const RELEASES_PATH_RE = /^\/[^/]+\/[^/]+\/releases(?:\/|$)/i;
const SEARCH_INPUT_RE = /^(search|q|query|keyword|keywords|s)$/i;
const EMAIL_HOST_RE = /(^|\.)(mail\.google\.com|gmail\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|icloud\.com|proton\.me|protonmail\.com|fastmail\.com|hey\.com|mail\.zoho\.com)$/i;
const DM_HOST_RE = /(^|\.)(instagram\.com|x\.com|twitter\.com|facebook\.com|messenger\.com|threads\.net|reddit\.com|linkedin\.com|discord\.com|slack\.com|web\.whatsapp\.com|messages\.google\.com|web\.telegram\.org)$/i;
const DM_PATH_RE = /(?:^|[/?#])(direct|messages?|messaging|inbox|chat|chats|dm|conversation|conversations|t|channels)(?:\b|[/?#])/i;
const COMPOSE_FIELD_RE = /\b(compose|reply|message|comment|post|tweet|share|caption|body|editor|write|what'?s happening|start a post|add a comment|write a reply|email)\b/i;
const X_PROFILE_RESERVED_PATH_RE = /^\/(home|explore|notifications|messages?|i|search|settings|compose|login|signup|jobs|communities|lists|hashtag|intent|share|privacy|tos)(?:\/|$)/i;
const WP_ADMIN_RE = /\/wp-admin(?:\/|$)/i;
const WP_TEMPLATE_ROUTE_RE = /\/wp-admin\/(?:site-editor\.php|themes\.php|customize\.php|widgets\.php|theme-editor\.php)(?:[/?#]|$)|post_type=wp_template|page=gutenberg-edit-site/i;
const WP_TEMPLATE_TITLE_RE = /\b(template|templates|template part|site editor|theme editor|customize|patterns)\b/i;

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
  // Currency symbols are non-word characters, so `\b…\b` around them can never
  // match — keep the word-boundary anchors for the keywords and test the
  // symbols separately so a symbol-only price (e.g. "Total $50") still registers.
  return /\b(add to cart|buy now|checkout|basket|cart|price|discount|sale|shipping)\b/i.test(haystack)
    || /[₺$€£]/.test(haystack);
}

function communicationSignal(pageInfo = {}, { includeUrl = true } = {}) {
  return [
    includeUrl ? pageInfo.url : null,
    pageInfo.title,
    pageInfo.description,
    String(pageInfo.text || '').slice(0, 3000),
    ...(pageInfo.links || []).slice(0, 40).flatMap((link) => [link?.text, link?.href]),
    ...(pageInfo.forms || []).slice(0, 10).flatMap((form) => (form?.inputs || []).flatMap((input) => [input?.type, input?.name, input?.id, input?.placeholder])),
  ].filter(Boolean).join(' ');
}

function hasEmailThreadSignal(pageInfo = {}) {
  const signal = communicationSignal(pageInfo, { includeUrl: false });
  return /\b(reply|reply all|respond|conversation|thread|subject|wrote)\b/i.test(signal) ||
    (/\bfrom\b/i.test(signal) && /\b(subject|sent)\b/i.test(signal));
}

function isCommunicationThread(pageInfo = {}, host = '', path = '/') {
  const signal = communicationSignal(pageInfo);
  const route = `${pageInfo.url || ''} ${path}`;
  if (EMAIL_HOST_RE.test(host)) {
    return hasEmailThreadSignal(pageInfo);
  }
  if (DM_HOST_RE.test(host)) {
    return DM_PATH_RE.test(route) || /\b(reply|respond|conversation|thread|direct message|dm|chat)\b/i.test(signal);
  }
  return false;
}

function hasFocusedComposeBox(pageInfo = {}) {
  const active = pageInfo.activeElement || null;
  if (!active || typeof active !== 'object') return false;
  const tag = String(active.tag || '').toLowerCase();
  const type = String(active.type || '').toLowerCase();
  const role = String(active.role || '').toLowerCase();
  const fieldName = [active.name, active.id, active.placeholder, active.ariaLabel, active.label].filter(Boolean).join(' ').trim();
  if (type === 'search' || role === 'searchbox' || SEARCH_INPUT_RE.test(fieldName)) return false;
  const textPreview = String(active.textPreview || '').trim();
  const signal = `${fieldName} ${textPreview}`;
  const isMultilineOrRich = tag === 'textarea' || active.editable === true || active.isContentEditable === true || (role === 'textbox' && tag !== 'input');
  const isSingleLineCompose = tag === 'input' && COMPOSE_FIELD_RE.test(signal);
  return (isMultilineOrRich && (COMPOSE_FIELD_RE.test(signal) || textPreview.length >= 8)) || isSingleLineCompose;
}

function isPersonProfilePage(host = '', path = '/') {
  const isLinkedIn = host === 'linkedin.com' || host.endsWith('.linkedin.com');
  if (isLinkedIn) return /^\/in\/[^/?#]+(?:\/|$)/i.test(path);
  const isX = host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com');
  return isX && /^\/[^/?#]+\/?$/i.test(path) && !X_PROFILE_RESERVED_PATH_RE.test(path);
}

function isWordPressAdmin(pageInfo = {}, path = '/') {
  return WP_ADMIN_RE.test(path) || WP_ADMIN_RE.test(String(pageInfo.url || ''));
}

function isWordPressTemplatePage(pageInfo = {}, path = '/') {
  const route = `${path} ${pageInfo.url || ''}`;
  if (WP_TEMPLATE_ROUTE_RE.test(route)) return true;
  const pageLocalSignal = `${pageInfo.title || ''} ${pageInfo.description || ''}`;
  return WP_TEMPLATE_TITLE_RE.test(pageLocalSignal);
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

  if (hasFocusedComposeBox(pageInfo)) {
    addUnique(actions, {
      id: 'rewrite-focused-draft',
      label: 'Rewrite this draft',
      prompt: 'Rewrite the text in the currently focused compose box in three versions: softer, shorter, and more formal. Do not type, send, or publish anything unless I ask.',
    });
  }

  if (isCommunicationThread(pageInfo, host, path)) {
    addUnique(actions, {
      id: 'draft-reply',
      label: 'Draft a reply',
      prompt: 'Draft a concise, helpful reply to the currently open email or message. Do not send it or type it into the page unless I ask.',
    });
    addUnique(actions, {
      id: 'summarize-thread',
      label: 'Summarize this thread',
      prompt: 'Summarize the currently open email or message thread, including key points, decisions, and unanswered questions.',
    });
    addUnique(actions, {
      id: 'find-followups',
      label: 'Find follow-ups',
      prompt: 'Extract action items, deadlines, people to follow up with, and open questions from this conversation.',
    });
  }

  if (isPersonProfilePage(host, path)) {
    addUnique(actions, {
      id: 'research-person',
      label: 'Research this person',
      prompt: 'Research the person shown on this profile. Find likely public profiles on other social/web sources, summarize what is known, include links or sources, and clearly label anything uncertain.',
    });
  }

  if (isWordPressAdmin(pageInfo, path)) {
    addUnique(actions, {
      id: 'draft-wp-post',
      label: 'Draft a post',
      prompt: 'Draft a WordPress post for this site. Ask me for the topic, audience, and tone before changing the page.',
      mode: 'act',
    });
    if (isWordPressTemplatePage(pageInfo, path)) {
      addUnique(actions, {
        id: 'change-wp-template',
        label: 'Change template',
        prompt: 'Help change this WordPress template or theme setting. First inspect the current editor/page and ask what template change I want before applying it.',
        mode: 'act',
      });
    }
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
