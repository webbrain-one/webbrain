import { isDirectPublicMediaUrl, isMastodonMediaPage } from '../agent/public-media-url.js';
import { isCommunicationThreadContext } from '../agent/read-completeness.js';
import { COUPON_MERCHANT_DOMAINS } from './coupon-domains.js';
import { t } from './i18n.js';

const SOCIAL_HOST_RE = /(^|\.)(instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|fb\.com|threads\.net|youtube\.com|youtu\.be|reddit\.com|pinterest\.com|snapchat\.com)$/i;
const PUBLIC_MEDIA_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|x\.com|twitter\.com|reddit\.com|redd\.it|facebook\.com|fb\.com|fb\.watch|pinterest\.com|pin\.it|linkedin\.com|threads\.net|bsky\.app)$/i;
const DATING_HOST_RE = /(^|\.)(tinder\.com|bumble\.com|hinge\.co|okcupid\.com|match\.com|pof\.com|badoo\.com|happn\.com|coffeemeetsbagel\.com)$/i;
const SHOPPING_HOST_RE = /(^|\.)(amazon\.(?:(?:com|co)\.)?[a-z]{2,}|ebay\.(?:(?:com|co)\.)?[a-z]{2,}|etsy\.com|walmart\.com|target\.com|bestbuy\.com|shopify\.com|aliexpress\.com|mercadolibre\.(?:(?:com|co)\.)?[a-z]{2,}|mercadolivre\.com\.br|hepsiburada\.com|trendyol\.com|n11\.com|shopee\.(?:(?:com|co)\.)?[a-z]{2,}|shopeekh\.com|lazada\.(?:(?:com|co)\.)?[a-z]{2,})$/i;
const PRODUCT_PATH_RE = /\/(dp|gp\/product|itm|p|product|products|prod|item|listing|ilan|urun)\b/i;
const COUPON_PRODUCT_PATH_RE = /\/(?:dp|gp\/product|itm|p|product|products|prod|item|listing|ilan|urun|ip|detail)(?:\/|$)/i;
const COUPON_BESTBUY_PRODUCT_PATH_RE = /\/site\/[^/]+\/\d+\.p(?:\/|$)/i;
const COUPON_CHECKOUT_PATH_RE = /\/(?:cart|basket|bag|checkout|checkouts|shopping-cart|shopping-bag|warenkorb|panier|carrito|carrinho|sacola|sepet|troli|keranjang|gio-hang|koszyk|korzina)(?:\/|$)/i;
const COUPON_CHECKOUT_HOST_RE = /^(?:checkout|cart)\./i;
const COUPON_FIELD_RE = /\b(coupon|promo(?:tional)?|voucher|discount)\b/i;
const COUPON_EMPTY_CART_RE = /\b(?:your\s+)?(?:cart|basket|bag)\s+(?:is\s+)?empty\b|\b(?:no|zero)\s+items?\s+in\s+(?:your\s+)?(?:cart|basket|bag)\b/i;
const COUPON_PRICE_RE = /[₺$€£¥₹₩]|\b(?:USD|EUR|GBP|TRY|CAD|AUD|JPY|BRL|MXN|INR)\s*\d|\d\s*(?:USD|EUR|GBP|TRY|CAD|AUD|JPY|BRL|MXN|INR)\b/i;
const RELEASES_PATH_RE = /^\/[^/]+\/[^/]+\/releases(?:\/|$)/i;
const GITHUB_PR_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/i;
const GITHUB_PULLS_PATH_RE = /^\/([^/]+)\/([^/]+)\/pulls(?:\/|$)/i;
const SEARCH_INPUT_RE = /^(search|q|query|keyword|keywords|s)$/i;
const EMAIL_HOST_RE = /(^|\.)(mail\.google\.com|gmail\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|icloud\.com|proton\.me|protonmail\.com|fastmail\.com|hey\.com|mail\.zoho\.com)$/i;
const DM_HOST_RE = /(^|\.)(instagram\.com|x\.com|twitter\.com|facebook\.com|messenger\.com|threads\.net|reddit\.com|linkedin\.com|discord\.com|slack\.com|web\.whatsapp\.com|messages\.google\.com|web\.telegram\.org)$/i;
const DM_PATH_RE = /(?:^|[/?#])(direct|messages?|messaging|inbox|chat|chats|dm|conversation|conversations|channels)(?:\b|[/?#])/i;
const MESSENGER_THREAD_PATH_RE = /^\/t(?:\/|$)/i;
const COMPOSE_FIELD_RE = /\b(compose|reply|message|comment|post|tweet|share|caption|body|editor|write|what'?s happening|start a post|add a comment|write a reply|email)\b/i;
const X_PROFILE_RESERVED_PATH_RE = /^\/(home|explore|notifications|messages?|i|search|settings|compose|login|signup|jobs|communities|lists|hashtag|intent|share|privacy|tos)(?:\/|$)/i;
const WP_ADMIN_RE = /\/wp-admin(?:\/|$)/i;
const WP_TEMPLATE_ROUTE_RE = /\/wp-admin\/(?:site-editor\.php|themes\.php|customize\.php|widgets\.php|theme-editor\.php)(?:[/?#]|$)|post_type=wp_template|page=gutenberg-edit-site/i;
const WP_TEMPLATE_TITLE_RE = /\b(template|templates|template part|site editor|theme editor|customize|patterns)\b/i;
const REMOTE_MEDIA_LOGIN_NOTE = 'FreeSkillz runs on a separate server: signing into this browser or rerunning while logged in cannot affect download_public_media because browser cookies are not sent to FreeSkillz. Never suggest browser sign-in as a fix.';

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

function githubPullRequestContext(path = '') {
  const match = GITHUB_PR_PATH_RE.exec(String(path));
  return match ? { owner: match[1], repo: match[2], number: match[3] } : null;
}

function githubPullsContext(path = '') {
  const match = GITHUB_PULLS_PATH_RE.exec(String(path));
  return match ? { owner: match[1], repo: match[2] } : null;
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

function isYouTubeVideoPage(host = '', path = '/', url = '') {
  if (host === 'youtu.be') return /^\/[^/?#]+/.test(path);
  if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return false;
  if (/^\/(?:shorts|live)\/[^/?#]+/i.test(path)) return true;
  try {
    const u = new URL(url);
    return path === '/watch' && !!u.searchParams.get('v');
  } catch {
    return false;
  }
}

function publicMediaKind(pageInfo = {}, path = '/') {
  const media = pageInfo.media || {};
  if ((media.videoCount || 0) > 0) return 'video';
  if (/\b(video|reel|shorts|watch|live)\b/i.test(`${path} ${pageInfo.title || ''}`)) return 'video';
  if (/\b(photo|image|picture|pin)\b/i.test(`${path} ${pageInfo.title || ''}`)) return 'image';
  if ((media.imageCount || 0) > 0) return 'auto';
  return 'auto';
}

function publicMediaDownloadPrompt(kind = 'auto', needsExplicitUrl = false) {
  const args = kind === 'auto' ? '{ "kind": "auto" }' : `{ "kind": "${kind}" }`;
  if (needsExplicitUrl) {
    return `Download the single public media item currently visible in this feed. First use the attached screenshot to identify the intended post/video, then inspect visible links with get_accessibility_tree and obtain that item's exact public post/reel URL. Call download_public_media with ${args} and that explicit url. Never send the feed/profile URL to download_public_media. FreeSkillz must return one final file; do not report separate video/audio tracks or tell the user to merge them with ffmpeg. ${REMOTE_MEDIA_LOGIN_NOTE} Do not make a separate plan.`;
  }
  return `Download this public media from the current page. Call download_public_media first with ${args} and omit url so it uses the active media page. Do not make a separate plan. FreeSkillz must return one final file; do not report separate video/audio tracks or tell the user to merge them with ffmpeg. ${REMOTE_MEDIA_LOGIN_NOTE} Only call download_social_media if download_public_media fails, then report the saved downloadId/result.`;
}

function publicMediaDownloadRunOptions(kind = 'auto', needsExplicitUrl = false) {
  const args = kind === 'auto' ? 'kind:"auto"' : `kind:"${kind}"`;
  const options = {
    id: 'download-media',
    skipPlanner: true,
    tool: 'download_public_media',
    summary: 'Download the public media from the current page.',
    steps: needsExplicitUrl
      ? [
        'Inspect the preflight screenshot to identify the single visible media item.',
        'Read the visible accessibility tree and obtain the exact post/reel permalink for that item.',
        `Call download_public_media with ${args} and the explicit permalink; never pass the feed URL.`,
        'Report the one completed file and downloadId; never hand separate tracks or ffmpeg work to the user.',
        'If FreeSkillz fails, never suggest signing into this browser; its remote request cannot use browser login state or cookies.',
      ]
      : [
        `Call download_public_media with ${args} and no url so it uses the active media page.`,
        'Report the one completed file and downloadId. Use download_social_media only if download_public_media fails.',
        'If FreeSkillz fails, never suggest signing into this browser; its remote request cannot use browser login state or cookies.',
      ],
  };
  if (needsExplicitUrl) {
    options.autoExecute = true;
    options.firstTool = 'screenshot';
    options.args = { save: false };
  }
  return options;
}

function firstToolRunOptions(id, tool, args = {}, summary = '', steps = []) {
  return {
    id,
    autoExecute: true,
    tool,
    args,
    summary: summary || 'Read the current page before answering.',
    steps: steps.length ? steps : [`Call ${tool} first for this recommended action.`],
  };
}

function visibleTreeArgs(maxDepth = 10) {
  return { filter: 'visible', maxDepth };
}

function completeTreeArgs(maxDepth = 15) {
  return { filter: 'all', maxDepth };
}

function couponRunOptions() {
  return {
    id: 'find-coupons',
    skipPlanner: true,
    autoExecute: true,
    tool: 'get_accessibility_tree',
    args: visibleTreeArgs(12),
    summary: 'Find bounded coupon candidates and verify savings only through the merchant checkout UI.',
    steps: [
      'Read the visible product, cart, or checkout first; record the exact item, seller, subtotal, current discount or coupon, and payable total that are actually shown.',
      'Check merchant-provided offers first, then research at most five external candidate codes relevant to this exact merchant and item.',
      'Without a visible coupon field, report only unverified candidates; never add an item or start checkout merely to test a code.',
      'Preserve the existing coupon, gift cards, store credit, and loyalty rewards; replace it only if safely restorable. Try codes one at a time. Call one active only when the merchant accepts it and the payable total or explicit discount changes. Keep the best saving or restore the original state.',
      'Report sources, rejections, restrictions, and before/after savings. Never place the order, pay, enter or change address, shipping, or payment details, or join a membership or subscription. Stop on CAPTCHA or rate limit. Never follow affiliate redirects or install extensions.',
    ],
  };
}

function webbrainTweetRunOptions(postText) {
  const exactPost = String(postText || '').trim();
  return {
    id: 'tweet-webbrain',
    skipPlanner: true,
    tool: 'navigate',
    summary: 'Publish the reviewed localized WebBrain post exactly as supplied.',
    steps: [
      'Open https://x.com/compose/post in the current tab through the visible browser UI.',
      'Wait for the visible X composer to become stable before entering text.',
      `Enter this exact reviewed text in the visible X composer without translating, rewriting, or adding anything: ${JSON.stringify(exactPost)}`,
      'Publish only after the composer text exactly matches the supplied text and the Post control is enabled. If it remains disabled, keep the composer open and refill it through the trusted typing path.',
      'Treat an unverified or no-progress Post click as not submitted; keep the composer open and recover instead of dismissing it.',
      'Verify the new tweet appears, then report its URL when available.',
    ],
  };
}

function webbrainLinkedInRunOptions(postText) {
  const exactPost = String(postText || '').trim();
  return {
    id: 'post-webbrain-linkedin',
    skipPlanner: true,
    tool: 'navigate',
    summary: 'Publish the reviewed localized WebBrain post on LinkedIn exactly as supplied.',
    steps: [
      'Open https://www.linkedin.com/feed/ in the current tab through the visible browser UI.',
      'Select Start a post to open LinkedIn\'s visible composer.',
      `Enter this exact reviewed text without translating, rewriting, or adding anything: ${JSON.stringify(exactPost)}`,
      'Publish only after the composer text exactly matches the supplied text.',
      'Verify the new LinkedIn post appears, then report its URL when available.',
    ],
  };
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

function isKnownCouponShoppingHost(host = '') {
  let candidate = host;
  while (candidate.includes('.')) {
    if (COUPON_MERCHANT_DOMAINS.has(candidate)) return true;
    candidate = candidate.slice(candidate.indexOf('.') + 1);
  }
  return false;
}

function hasCouponFieldSignal(pageInfo = {}) {
  const signal = (pageInfo.forms || []).slice(0, 20).flatMap((form) => {
    const inputs = (form?.inputs || []).slice(0, 40).filter((input) => {
      const type = String(input?.type || '').toLowerCase();
      return !['hidden', 'submit', 'button', 'reset', 'image'].includes(type);
    });
    return inputs.flatMap((input) => [input?.type, input?.name, input?.id, input?.placeholder, input?.ariaLabel, input?.label]);
  }).filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return COUPON_FIELD_RE.test(signal);
}

function couponPageSignal(pageInfo = {}) {
  return [pageInfo.title, pageInfo.description, String(pageInfo.text || '').slice(0, 6000)].filter(Boolean).join(' ');
}

function hasCouponProductSignal(signal = '') {
  return COUPON_PRICE_RE.test(signal) || /\b(add to (?:cart|basket|bag)|buy now|in stock|out of stock|sale price|list price|current price)\b/i.test(signal);
}

function hasCouponCheckoutValueSignal(signal = '') {
  return COUPON_PRICE_RE.test(signal) || /\b(subtotal|order total|payable total|amount due|cart total|estimated total|quantity|qty|\d+\s+items?)\b/i.test(signal);
}

function isCouponShoppingContext(pageInfo = {}, host = '', path = '/') {
  if (!isKnownCouponShoppingHost(host)) return false;
  const pageSignal = couponPageSignal(pageInfo);
  if (COUPON_EMPTY_CART_RE.test(pageSignal)) return false;
  const isCheckoutPage = COUPON_CHECKOUT_HOST_RE.test(host) || COUPON_CHECKOUT_PATH_RE.test(path);
  if (isCheckoutPage) return hasCouponFieldSignal(pageInfo) || hasCouponCheckoutValueSignal(pageSignal);
  const isProductPage = COUPON_PRODUCT_PATH_RE.test(path) || COUPON_BESTBUY_PRODUCT_PATH_RE.test(path);
  return isProductPage && hasCouponProductSignal(pageSignal);
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
  if (/^(?:web|webk|weba|webz|k)\.telegram\.org$/i.test(host)) {
    return isCommunicationThreadContext(pageInfo.url || '', 'telegram');
  }
  const signal = communicationSignal(pageInfo);
  const route = `${pageInfo.url || ''} ${path}`;
  if (EMAIL_HOST_RE.test(host)) {
    return hasEmailThreadSignal(pageInfo);
  }
  if (DM_HOST_RE.test(host)) {
    const isMessengerThread = (host === 'messenger.com' || host.endsWith('.messenger.com')) && MESSENGER_THREAD_PATH_RE.test(path);
    return isMessengerThread || DM_PATH_RE.test(route) || /\b(reply|respond|conversation|thread|direct message|dm|chat)\b/i.test(signal);
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
  const webbrainPostText = t('sp.recommended.tweet.text');
  const webbrainPromotionVariant = options.webbrainPromotionVariant === 'linkedin' ? 'linkedin' : 'x';

  const webbrainPromotion = webbrainPromotionVariant === 'linkedin'
    ? {
      id: 'post-webbrain-linkedin',
      label: t('sp.recommended.linkedin.label'),
      prompt: t('sp.recommended.linkedin.prompt', { post: webbrainPostText }),
      mode: 'act',
      runOptions: webbrainLinkedInRunOptions(webbrainPostText),
    }
    : {
      id: 'tweet-webbrain',
      label: t('sp.recommended.tweet.label'),
      prompt: t('sp.recommended.tweet.prompt', { post: webbrainPostText }),
      mode: 'act',
      runOptions: webbrainTweetRunOptions(webbrainPostText),
    };

  if (host === 'github.com' && RELEASES_PATH_RE.test(path)) {
    addUnique(actions, {
      id: 'github-release',
      label: 'Create a new release',
      prompt: 'Create a new GitHub release for this repository. Ask me for the tag, title, and release notes if needed.',
      mode: 'act',
    });
  }

  const pullRequest = githubPullRequestContext(path);
  if (host === 'github.com' && pullRequest) {
    const reference = `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`;
    addUnique(actions, {
      id: 'review-pull-request',
      label: 'Review this pull request',
      prompt: `Review GitHub pull request ${reference}. Read its description, full diff, conversation, and checks. Report prioritized correctness, security, compatibility, and test-coverage findings with exact file and line references. Do not post the review, comment, approve, close, or modify the pull request unless I explicitly ask.`,
      mode: 'ask',
    });
    addUnique(actions, {
      id: 'summarize-pull-request',
      label: 'Summarize this pull request',
      prompt: `Read GitHub pull request ${reference}, including its description, changed files, review comments, and checks. Summarize the intent, implementation, material risks, review status, and remaining blockers. Do not post or modify anything.`,
      mode: 'ask',
    });
  }

  const pulls = githubPullsContext(path);
  if (host === 'github.com' && pulls) {
    addUnique(actions, {
      id: 'summarize-recent-pr-activity',
      label: 'Summarize recent PR activity',
      prompt: `Read the visible pull-request list for ${pulls.owner}/${pulls.repo}, including open and recently updated pull requests. Summarize activity by theme, review status, stale items, blockers, and which pull requests need attention. Do not open, comment on, or modify any pull request.`,
      mode: 'ask',
    });
  }

  if (hasFocusedComposeBox(pageInfo)) {
    addUnique(actions, {
      id: 'rewrite-focused-draft',
      label: 'Rewrite this draft',
      prompt: 'Use get_accessibility_tree with filter:"visible" first to read the currently focused compose box. Rewrite that draft in three versions: softer, shorter, and more formal. Do not type, send, or publish anything unless I ask.',
      runOptions: firstToolRunOptions(
        'rewrite-focused-draft',
        'get_accessibility_tree',
        visibleTreeArgs(8),
        'Read the focused compose box before rewriting the draft.',
        ['Call get_accessibility_tree with filter:"visible" and maxDepth:8.', 'Use the focused textbox/input text from the result to write variants only.'],
      ),
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
      prompt: 'Read the complete active email or message thread with get_accessibility_tree. In Gmail, use the first result\'s trusted conversationRootRefId as ref_id with filter:"all" and maxDepth:15 instead of paginating the document root. Follow every exact returned continuationArgs until hasMore:false, then summarize key points, decisions, and unanswered questions.',
      runOptions: firstToolRunOptions(
        'summarize-thread',
        'get_accessibility_tree',
        completeTreeArgs(15),
        'Read the complete conversation thread before summarizing it.',
        ['Discover the active thread, then anchor Gmail reads to its trusted conversationRootRefId.', 'Follow every exact continuationArgs until hasMore:false.', 'Summarize the complete thread from the returned thread data.'],
      ),
    });
    addUnique(actions, {
      id: 'find-followups',
      label: 'Find follow-ups',
      prompt: 'Read the complete active conversation with get_accessibility_tree. In Gmail, use the first result\'s trusted conversationRootRefId as ref_id with filter:"all" and maxDepth:15 instead of paginating the document root. Follow every exact returned continuationArgs until hasMore:false, then extract action items, deadlines, people to follow up with, and open questions.',
      runOptions: firstToolRunOptions(
        'find-followups',
        'get_accessibility_tree',
        completeTreeArgs(15),
        'Read the complete conversation thread before extracting follow-ups.',
        ['Discover the active thread, then anchor Gmail reads to its trusted conversationRootRefId.', 'Follow every exact continuationArgs until hasMore:false.', 'Extract follow-ups from the complete thread data.'],
      ),
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

  if (isYouTubeVideoPage(host, path, pageInfo.url || '')) {
    addUnique(actions, {
      id: 'summarize-youtube-video',
      label: 'Summarize this video',
      prompt: 'Use read_youtube_transcript for the current YouTube video first, omitting url so it uses the active tab. Summarize the transcript in concise bullets with key points and timestamps when available. If the transcript tool is unavailable or returns no transcript, say that and use only the visible page context.',
      mode: 'ask',
      runOptions: firstToolRunOptions(
        'summarize-youtube-video',
        'read_youtube_transcript',
        { timestamps: true, text_limit: 6000, include_segments: false },
        'Read the YouTube transcript before summarizing the video.',
        ['Call read_youtube_transcript for the active tab with timestamps:true, text_limit:6000, and include_segments:false.', 'Summarize the transcript with key points and timestamps when available.'],
      ),
    });
  }

  const publicMediaHost = PUBLIC_MEDIA_HOST_RE.test(host) || isMastodonMediaPage(pageInfo.url || '');
  if ((publicMediaHost || SOCIAL_HOST_RE.test(host) || /\b(post|status|reel|shorts|watch|pin)\b/i.test(path)) && hasMedia(pageInfo)) {
    const kind = publicMediaKind(pageInfo, path);
    const needsExplicitUrl = publicMediaHost && !isDirectPublicMediaUrl(pageInfo.url || '');
    addUnique(actions, {
      id: 'download-media',
      label: 'Download this video/photo',
      prompt: publicMediaHost ? publicMediaDownloadPrompt(kind, needsExplicitUrl) : 'Download the video or photo from this post.',
      mode: 'act',
      ...(publicMediaHost ? { runOptions: publicMediaDownloadRunOptions(kind, needsExplicitUrl) } : {}),
    });
  }

  if (isYouTubeVideoPage(host, path, pageInfo.url || '')) {
    addUnique(actions, {
      id: 'loop-youtube-video',
      label: 'Loop this video',
      prompt: `Use execute_js once with exactly this function body, then report whether a video was found and looping was enabled:
const KEY = '__webbrainYouTubeLoop';
const previous = window[KEY];
if (typeof previous?.stop === 'function') {
  previous.stop();
} else {
  if (previous?.timer) clearInterval(previous.timer);
  if (previous?.video && previous?.endedHandler) previous.video.removeEventListener('ended', previous.endedHandler);
}
const state = {
  route: location.href,
  video: document.querySelector('video'),
  player: document.querySelector('#movie_player'),
  endedHandler: null,
  navigationHandler: null,
  pagehideHandler: null,
  timer: null,
  stop: null,
};
const stop = () => {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.video && state.endedHandler) state.video.removeEventListener('ended', state.endedHandler);
  if (state.navigationHandler) document.removeEventListener('yt-navigate-start', state.navigationHandler);
  if (state.pagehideHandler) window.removeEventListener('pagehide', state.pagehideHandler);
  try {
    if (state.video) state.video.loop = false;
    if (state.player && typeof state.player.setLoop === 'function') state.player.setLoop(false);
  } catch {}
  if (window[KEY] === state) delete window[KEY];
};
state.stop = stop;
const targetIsCurrent = () => location.href === state.route && document.querySelector('video') === state.video;
const enforceLoop = () => {
  if (!state.video || !targetIsCurrent()) {
    stop();
    return false;
  }
  state.video.loop = true;
  try {
    if (state.player && typeof state.player.setLoop === 'function') state.player.setLoop(true);
  } catch {}
  return true;
};
const found = Boolean(state.video);
if (found) {
  state.endedHandler = () => {
    if (!targetIsCurrent()) {
      stop();
      return;
    }
    state.video.currentTime = 0;
    state.video.play().catch(() => {});
  };
  state.navigationHandler = stop;
  state.pagehideHandler = stop;
  state.video.addEventListener('ended', state.endedHandler);
  document.addEventListener('yt-navigate-start', state.navigationHandler);
  window.addEventListener('pagehide', state.pagehideHandler);
  window[KEY] = state;
  enforceLoop();
  if (window[KEY] === state) state.timer = setInterval(enforceLoop, 1000);
}
return { found, loop: state.video?.loop === true, intervalSet: Boolean(state.timer), paused: state.video?.paused ?? null, duration: state.video?.duration ?? null };`,
      mode: 'dev',
    });
  }

  if (isCouponShoppingContext(pageInfo, host, path)) {
    addUnique(actions, {
      id: 'find-coupons',
      label: 'Find coupon codes',
      prompt: 'Inspect this exact product, cart, or checkout through the visible page first. Check merchant-provided offers before researching at most five external candidate codes. If no coupon field is visible, report them only as unverified candidates and never add an item or start checkout merely to test them. If a field is visible, preserve the existing coupon, gift cards, store credit, and loyalty rewards; replace it only if safely restorable. Try codes one at a time, and call one active only when the merchant explicitly accepts it and the payable total or explicit discount changes. Keep the best saving or restore the original state. Report restrictions and before/after totals. Never place the order, pay, enter or change address, shipping, or payment details, or join a membership or subscription. Stop on CAPTCHA or rate limit. Never follow affiliate redirects or install extensions.',
      mode: 'act',
      runOptions: couponRunOptions(),
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
      prompt: 'Use read_page first for the current long-form page. While read_page returns hasMore:true, call it again with its exact continuationArgs until hasMore is false. Then summarize the page in 5-8 concise bullet points and include any action items. If you stop reading early, say which part of the page the summary covers.',
      runOptions: firstToolRunOptions(
        'summarize-page',
        'read_page',
        { includeChrome: false },
        'Read the long-form page before summarizing it.',
        ['Call read_page with includeChrome:false.', 'While read_page returns hasMore:true, call it again with the exact returned continuationArgs until hasMore is false.', 'Summarize the text read in 5-8 concise bullets; if you stopped before hasMore:false, say which part of the page it covers.'],
      ),
    });
  }

  if ((SHOPPING_HOST_RE.test(host) || PRODUCT_PATH_RE.test(path)) && hasCartOrPriceSignal(pageInfo)) {
    addUnique(actions, {
      id: 'compare-price',
      label: 'Compare this price with other stores',
      prompt: 'Use get_accessibility_tree with filter:"visible" first to read the product title, price, and purchase context. Compare this product\'s price with other stores and summarize the best alternatives.',
      runOptions: firstToolRunOptions(
        'compare-price',
        'get_accessibility_tree',
        visibleTreeArgs(10),
        'Read the visible product details before comparing prices.',
        ['Call get_accessibility_tree with filter:"visible" and maxDepth:10.', 'Use the product title, price, and store context from the result before comparing alternatives.'],
      ),
    });
  }

  if (actions.length === 0 && pageInfo.title) {
    const explainUsesArticleRead = isLongArticle(pageInfo);
    addUnique(actions, {
      id: 'explain-page',
      label: 'Explain this page',
      prompt: explainUsesArticleRead
        ? 'Use read_page first for the current long-form page. If read_page returns hasMore:true, continue with its exact continuationArgs as needed. Explain what this page is about and what I can do next, and say if you read only part of it.'
        : 'Use get_accessibility_tree with filter:"visible" first for the current page. Explain what this page is about and what I can do next.',
      runOptions: explainUsesArticleRead
        ? firstToolRunOptions(
          'explain-page',
          'read_page',
          { includeChrome: false },
          'Read the long-form page before explaining it.',
          ['Call read_page with includeChrome:false.', 'If read_page returns hasMore:true, continue with the exact returned continuationArgs as needed.', 'Explain the page from the text read; say if it covers only part of the page.'],
        )
        : firstToolRunOptions(
          'explain-page',
          'get_accessibility_tree',
          visibleTreeArgs(10),
          'Read the visible page state before explaining it.',
          ['Call get_accessibility_tree with filter:"visible" and maxDepth:10.', 'Explain the page from the returned page data.'],
        ),
    });
  }

  // Promotion is a fallback, not page context: fill only a remaining slot and
  // keep it after every action derived from the active page.
  addUnique(actions, webbrainPromotion);

  return actions.slice(0, Math.max(0, max));
}

/**
 * Whether the suggested-action pill row should be visible. Pills live in the
 * chat body and disappear once the user has sent a message or a run is active.
 */
export function shouldShowRecommendedActions({ tabId, isProcessing, hasUserMessages }) {
  if (tabId == null || isProcessing) return false;
  if (hasUserMessages) return false;
  return true;
}
