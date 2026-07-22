import { isDirectPublicMediaUrl } from '../agent/public-media-url.js';
import { t } from './i18n.js';

const SOCIAL_HOST_RE = /(^|\.)(instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|fb\.com|threads\.net|youtube\.com|youtu\.be|reddit\.com|pinterest\.com|snapchat\.com)$/i;
const PUBLIC_MEDIA_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|x\.com|twitter\.com|reddit\.com|redd\.it|facebook\.com|fb\.com|fb\.watch|pinterest\.com|pin\.it|linkedin\.com|threads\.net)$/i;
const MEETING_HOST_RE = /(^|\.)(zoom\.us|meet\.google\.com|teams\.microsoft\.com|whereby\.com|webex\.com|gotomeeting\.com)$/i;
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

function webbrainTweetRunOptions(postText) {
  const exactPost = String(postText || '').trim();
  return {
    id: 'tweet-webbrain',
    skipPlanner: true,
    tool: 'navigate',
    summary: 'Publish the reviewed localized WebBrain post exactly as supplied.',
    steps: [
      'Open https://x.com/compose/post in the current tab through the visible browser UI.',
      `Enter this exact reviewed text in the visible X composer without translating, rewriting, or adding anything: ${JSON.stringify(exactPost)}`,
      'Publish only after the composer text exactly matches the supplied text.',
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
  const webbrainPostText = t('sp.recommended.tweet.text');
  const webbrainPromotionVariant = options.webbrainPromotionVariant === 'linkedin' ? 'linkedin' : 'x';

  addUnique(actions, webbrainPromotionVariant === 'linkedin'
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
    });

  if (MEETING_HOST_RE.test(host)) {
    addUnique(actions, {
      id: 'record-meeting',
      label: 'Record this meeting',
      prompt: '/record',
      mode: 'ask',
    });
  }

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
      prompt: 'Use get_accessibility_tree with filter:"visible" first to read the currently open email or message thread. Summarize key points, decisions, and unanswered questions.',
      runOptions: firstToolRunOptions(
        'summarize-thread',
        'get_accessibility_tree',
        visibleTreeArgs(12),
        'Read the visible conversation thread before summarizing it.',
        ['Call get_accessibility_tree with filter:"visible" and maxDepth:12.', 'Summarize the thread from the returned page data.'],
      ),
    });
    addUnique(actions, {
      id: 'find-followups',
      label: 'Find follow-ups',
      prompt: 'Use get_accessibility_tree with filter:"visible" first to read the current conversation. Extract action items, deadlines, people to follow up with, and open questions.',
      runOptions: firstToolRunOptions(
        'find-followups',
        'get_accessibility_tree',
        visibleTreeArgs(12),
        'Read the visible conversation thread before extracting follow-ups.',
        ['Call get_accessibility_tree with filter:"visible" and maxDepth:12.', 'Extract follow-ups from the returned page data.'],
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

  const publicMediaHost = PUBLIC_MEDIA_HOST_RE.test(host);
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
      prompt: 'Use read_page first for the current long-form page. Summarize it in 5-8 concise bullet points and include any action items.',
      runOptions: firstToolRunOptions(
        'summarize-page',
        'read_page',
        { includeChrome: false },
        'Read the long-form page before summarizing it.',
        ['Call read_page with includeChrome:false.', 'Summarize the returned article/page text in 5-8 concise bullets.'],
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

  if (!actions.some((action) => !['tweet-webbrain', 'post-webbrain-linkedin'].includes(action.id)) && pageInfo.title) {
    const explainUsesArticleRead = isLongArticle(pageInfo);
    addUnique(actions, {
      id: 'explain-page',
      label: 'Explain this page',
      prompt: explainUsesArticleRead
        ? 'Use read_page first for the current long-form page. Explain what this page is about and what I can do next.'
        : 'Use get_accessibility_tree with filter:"visible" first for the current page. Explain what this page is about and what I can do next.',
      runOptions: explainUsesArticleRead
        ? firstToolRunOptions(
          'explain-page',
          'read_page',
          { includeChrome: false },
          'Read the long-form page before explaining it.',
          ['Call read_page with includeChrome:false.', 'Explain the page from the returned page text.'],
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
