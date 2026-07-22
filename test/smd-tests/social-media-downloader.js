/* =====================================================================
 * SocialMediaDownloader v4
 * Generic, in-browser media downloader for:
 *   Facebook · Instagram · X/Twitter · LinkedIn · Reddit · Pinterest · YouTube
 *
 * --------------------------------------------------------------------
 * Quick start (paste into the page's DevTools console):
 *
 *   await SocialMediaDownloader.run()           // focused/open media item
 *   await SocialMediaDownloader.single()        // just the main photo/video
 *   await SocialMediaDownloader.run({ mode:"all", all:true }) // intentional bulk
 *   SocialMediaDownloader.list()                // print URLs, don't download
 *
 * For VIDEOS played through MediaSource Extensions (Facebook, IG reels,
 * X amplify, LinkedIn HLS, etc. — anywhere <video src="blob:..."> appears):
 *
 *   SocialMediaDownloader.armMseRecorder()      // BEFORE the player loads:
 *                                               //   paste → arm → reload → play
 *   SocialMediaDownloader.getMseRecording()     // inspect captured buffers
 *   await SocialMediaDownloader.saveMse()       // download captured bytes
 *
 * Options for run():
 *   mode:    'auto' (default) - focused/open/centered media item only
 *            'main'           - force "main content" mode
 *            'all'            - force "everything on page" mode
 *   all:     true|false       - scroll-and-collect (only useful in 'all')
 *   target:  'auto'|'media'|'image'|'video' - filter before saving
 *   limit:   N                - max downloads
 *
 * --------------------------------------------------------------------
 * What's NEW in v4
 *   1. MSE/SourceBuffer recorder. Patches `SourceBuffer.prototype.appendBuffer`
 *      so every byte the player feeds the MediaSource is teed into a Blob.
 *      Works for Facebook fbcdn videos, Instagram Reels, X amplify_video,
 *      LinkedIn native video, and any other site that uses MSE for playback.
 *      MUST be armed BEFORE the player starts (paste → arm → reload → play).
 *      Output is concatenated fMP4 fragments — playable as-is for most
 *      video-only buffers; A/V remux required if video and audio are
 *      captured into separate buffers.
 *   2. AES-128 HLS decryption. stitchHls() now parses `#EXT-X-KEY`,
 *      fetches the key, derives the IV (explicit or from media-sequence),
 *      and decrypts each segment with WebCrypto before concatenating.
 *      Many "premium-ish" streams (LinkedIn Learning samples, news clips,
 *      some podcasts) use AES-128 — those are now downloadable.
 *      Widevine/FairPlay/SAMPLE-AES are still unsupported.
 *   3. YouTube progressive formats. On /watch URLs the script now parses
 *      `ytInitialPlayerResponse` and surfaces any pre-signed progressive
 *      MP4 URLs (usually itag 18, 360p). Higher-resolution DASH and
 *      signatureCipher streams remain out of scope — use yt-dlp.
 *
 * What's NEW in v3
 *   1. Per-site profiles. Each platform now has a profile that knows:
 *        · how to detect a single-photo/video page
 *        · where the main content lives in the DOM
 *        · which elements to EXCLUDE (your own avatar, nav icons,
 *          sidebar widgets, "people you may know" thumbnails, etc.)
 *      This fixes the v1/v2 bug where a Facebook /photo/ page would
 *      return the viewer's own profile photo instead of the open photo.
 *   2. og:image / og:video priority on single-content pages.
 *      These meta tags are what the site itself declares as "the" image
 *      for a URL, so they are nearly always correct.
 *   3. single() now returns the *main* item, not just the first-scored
 *      one. It looks at og:image, then the main-content container, then
 *      ranks by area+position in the viewport.
 *
 * --------------------------------------------------------------------
 * LIMITATIONS — please read before relying on this
 *
 *   AUTHENTICATION
 *     · The script runs in YOUR browser session, so anything you can
 *       see while logged in, it can fetch. Anything behind a login wall
 *       you are NOT logged into will fail.
 *
 *   DRM / ENCRYPTION
 *     · Cannot bypass Widevine / FairPlay / PlayReady. Premium video
 *       (Netflix, Prime, paid IG live replays, etc.) will not download.
 *
 *   MSE / blob: URLs
 *     · HTML5 video players that use Media Source Extensions expose a
 *       blob: URL on the <video> element. The bytes live in the
 *       player's internal buffer and cannot be fetched directly. v4
 *       adds an opt-in workaround: `armMseRecorder()` patches
 *       `SourceBuffer.prototype.appendBuffer` so every byte the player
 *       feeds the buffer is teed into a Blob you can save with
 *       `saveMse()`. Arm BEFORE the player initializes (reload after
 *       arming), otherwise the init segment is missed and the captured
 *       bytes will not be playable. As a fallback, the run() download
 *       loop still opens raw blob: URLs in a new tab.
 *
 *   HLS (.m3u8) STREAMS
 *     · The script stitches segments of HLS streams into a single .ts.
 *       v4 adds AES-128 decryption (METHOD=AES-128, fixed or rotating
 *       keys) — fetches the key URI, derives the IV from the explicit
 *       tag or the media-sequence number, and decrypts each segment
 *       with WebCrypto before concatenation. SAMPLE-AES, full Widevine
 *       DRM, and PlayReady remain unsupported.
 *
 *   REDDIT VIDEOS (v.redd.it)
 *     · Reddit serves DASH where VIDEO and AUDIO are SEPARATE files
 *       (DASH_720.mp4 + DASH_AUDIO_128.mp4). The browser CANNOT remux
 *       them. The script downloads both and prints the ffmpeg command:
 *           ffmpeg -i video.mp4 -i audio.mp4 -c copy out.mp4
 *
 *   INSTAGRAM
 *     · IG carousels: only the *currently visible* slide is in the DOM.
 *       Click through the carousel arrows first, then re-run.
 *     · Stories/Reels often use blob: URLs (see MSE limitation).
 *
 *   FACEBOOK
 *     · Some videos play via MSE with blob: URLs (unfetchable).
 *     · Photos in private groups need you to be a member.
 *
 *   LINKEDIN
 *     · The feed lazy-loads aggressively. Use { all:true } and a
 *       generous maxScrolls to capture posts beyond the initial view.
 *     · Native LinkedIn video uses HLS — see HLS notes above.
 *
 *   PINTEREST
 *     · Pin closeup uses i.pinimg.com; script auto-upgrades the size
 *       folder to /originals/ for max resolution. Pinterest videos
 *       come in tiers (h264-pt-mp4, h265-pt-mp4); all tiers are listed.
 *
 *   YOUTUBE
 *     · Thumbnails (i.ytimg.com) extract reliably — useful for grabbing
 *       a video's poster image.
 *     · The actual VIDEO stream is NOT downloadable via this script.
 *       YouTube uses MSE with DASH adaptive segments served as blob:
 *       URLs from googlevideo.com, with rotating signed parameters and
 *       in many cases Widevine DRM. Use yt-dlp for real YouTube video
 *       downloads — that's its job, not a browser script's.
 *     · YouTube Shorts and reels behave the same way.
 *
 *   EXPIRING / SIGNED URLs
 *     · fbcdn, cdninstagram, Reddit preview URLs are signed and expire
 *       in minutes/hours. Download them right after extracting.
 *
 *   CORS / CDN HEADERS — IMPORTANT
 *     · For the script to fetch bytes and trigger a true file download,
 *       the media CDN must send CORS headers. Verified behavior:
 *         pinimg.com       — works (anonymous fetch)
 *         pbs.twimg.com    — works
 *         fbcdn.net        — works (credentialed fetch)
 *         cdninstagram.com — works (credentialed fetch)
 *         i.redd.it        — works
 *         media.licdn.com  — DOES NOT send CORS headers. Fetch fails,
 *                            script falls back to opening the image in
 *                            a new tab. You must right-click → Save
 *                            image as to save it. This is a LinkedIn
 *                            CDN policy, not a script bug.
 *     · Downloads land in the BROWSER'S download folder (default
 *       ~/Downloads or C:\Users\<you>\Downloads), not next to this
 *       script. Check your Chrome download settings.
 *
 *   PERMISSION PROMPTS (Claude in Chrome users)
 *     · If you use this through the Claude in Chrome extension instead
 *       of pasting into DevTools console, the extension asks for
 *       per-domain permission on first visit. That's the extension's
 *       security model — independent of this script. Click "Always
 *       allow" on a domain to skip future prompts there.
 *
 *   CHILD-SAFE & TOS NOTES
 *     · Respect each platform's Terms of Service. Don't redistribute
 *       copyrighted content. Don't scrape private profiles. Don't
 *       download images of minors for any non-personal purpose.
 * ===================================================================== */

window.SocialMediaDownloader = (() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- known media hosts ----------
  const MEDIA_HOSTS = [
    "fbcdn.net", "fbsbx.com",
    "cdninstagram.com",
    "twimg.com", "video.twimg.com", "pbs.twimg.com",
    "licdn.com", "licdnmedia.com", "media.licdn.com",
    "i.redd.it", "v.redd.it", "preview.redd.it",
    "external-preview.redd.it", "redditmedia.com",
    "pinimg.com", "i.pinimg.com", "v1.pinimg.com",
    // YouTube — thumbnails and (encrypted, expiring) video URLs.
    // Channel/comment avatars use yt3.ggpht.com but are excluded below.
    "i.ytimg.com", "ytimg.com", "yt3.ggpht.com",
    "googlevideo.com"
  ];

  const MEDIA_EXT_RE =
    /\.(jpe?g|png|webp|gif|mp4|mov|m4v|webm|m3u8|mpd|ts)(\?|#|$)/i;

  // ---------- per-site profiles ----------
  // exclude  : CSS selectors whose contents should be ignored entirely
  //            (avatars, nav, sidebar, "people you may know", etc.)
  // mainSel  : CSS selector for the main content container on a
  //            single-content page (used to find the primary item)
  // isSingle : returns true when the current page shows ONE main item
  const SITE_PROFILES = {
    facebook: {
      match: () => /(?:^|\.)facebook\.com$/i.test(location.hostname),
      // Single-viewer pages: /photo/, /photo.php?, /videos/ (NOT /photos/ —
      // that is the album grid, handled by isGallery below).
      isSingle: () =>
        /\/photo(?:\.php)?\/?(?:\?|$)|\/videos\//i
          .test(location.pathname + location.search),
      // Gallery / album list page — a grid of photo thumbnails rather
      // than a single open viewer. `/photos/?tab=album`, `/<page>/photos`,
      // etc. We pick this up so collect('all') uses gallerySel and the
      // urlFilter, instead of scanning the whole document and hauling in
      // the page logo, nav avatars, suggested-pages ads, etc.
      isGallery: () =>
        /\/photos(?:\/|$|\?)/i.test(location.pathname + location.search) &&
        !/\/photo(?:\.php)?\/?(?:\?|$)/i.test(location.pathname + location.search),
      // Narrow to the actual media container — NOT the whole [role="dialog"]
      // (which also wraps comments, reactions, emoji pickers, etc.)
      mainSel:
        '[data-pagelet*="MediaViewer" i] img, ' +
        '[data-pagelet*="MediaViewer" i] video, ' +
        '[data-visualcompletion="media-vc-image"], ' +
        '[role="dialog"] [data-visualcompletion="media-vc-image"], ' +
        '[role="dialog"] img[data-imgperflogname]',  // FB tags the main photo
      focusSel:
        '[data-pagelet*="MediaViewer" i], ' +
        '[role="dialog"]',
      // Each album thumbnail is a `<a href="/photo/?fbid=…">` wrapping an
      // `<img>`. Scoping to that link pattern excludes the page profile
      // pic, cover photo, nav avatars, ads, and the "Suggested for you"
      // strip — all of which the v3 'all' mode was sweeping in.
      gallerySel:
        'a[href*="/photo/?fbid="] img, ' +
        'a[href*="/photo.php?fbid="] img, ' +
        'a[href*="/photo/"][href*="set="] img',
      exclude: [
        '[role="banner"]', '[role="navigation"]',
        '[aria-label*="profile photo" i]',
        '[aria-label*="Your profile" i]',
        '[data-pagelet="LeftRail"]',
        '[data-pagelet="RightRail"]',
        '[data-pagelet*="Stories" i]',
        // Photo-viewer modal also contains comments — each comment is
        // a [role="article"] with avatars, emoji, reactions inside.
        '[role="article"]',
        '[aria-label*="Comment" i]',
        '[aria-label*="Reactions" i]',
        'header', 'nav', 'aside', 'svg'
      ],
      // Per-profile URL filter — strips known non-content patterns from
      // the candidate list AFTER DOM extraction. Facebook embeds a size
      // tag in the `stp=…` query param of every CDN URL: e.g. `…s80x80…`
      // is an avatar or icon thumbnail, `…s552x414…` is a real album
      // image. Anything under ~300×300 is almost never user content.
      urlFilter: url => {
        // Static Facebook chrome (logo, fb_icon, sprite, emoji).
        if (/\/(fb_icon|rsrc\.php|emoji\.php|reactions|favicon)/i.test(url)) return false;
        // stp= contains the size slug; pull width × height when present.
        const stp = /[?&]stp=([^&]+)/i.exec(url);
        if (stp) {
          // Match the LAST size slug (FB chains transforms separated by `_`)
          const sizes = [...stp[1].matchAll(/_s(\d+)x(\d+)/gi)];
          if (sizes.length) {
            const last = sizes[sizes.length - 1];
            const w = parseInt(last[1], 10), h = parseInt(last[2], 10);
            if (w && h && w < 300 && h < 300) return false;
          }
          // Tiny-crop variants (cp0_dst-jpg_s80x80) also signal thumbs.
          if (/\bp\d+x\d+\b/i.test(stp[1]) && /_s(?:80|96|120|144|160|180|200|240)x/i.test(stp[1])) {
            return false;
          }
        }
        return true;
      },
    },

    instagram: {
      match: () => /(?:^|\.)instagram\.com$/i.test(location.hostname),
      isSingle: () => /^\/(p|reel|tv)\//i.test(location.pathname),
      // Tighter than 'article img': IG /p/ pages also include a
      // "More posts from this user" grid where each suggestion is wrapped
      // in <article>. Scope to the FIRST article in <main>, which is the
      // actual post being viewed.
      mainSel:
        'main article:first-of-type img, ' +
        'main article:first-of-type video, ' +
        'main article:first-of-type source, ' +
        // role=presentation is the IG main-post marker on some layouts
        'main article[role="presentation"] img, ' +
        'main article[role="presentation"] video',
      focusSel:
        '[role="dialog"], ' +
        'main article[role="presentation"], ' +
        'main article:first-of-type',
      exclude: [
        'header', 'nav', 'aside',
        '[role="navigation"]',
        '[role="dialog"] header',           // story progress bar / avatar
        'img[alt*="profile picture" i]',
        'a[role="link"][href^="/"] img',    // header avatar links
        // "More posts from this user" / suggestions sections
        '[aria-label*="More posts" i]',
        '[aria-label*="Suggested" i]',
        'a[href*="/explore/" i]'
      ]
    },

    twitter: {
      match: () => /(?:^|\.)(twitter|x)\.com$/i.test(location.hostname),
      isSingle: () =>
        /\/photo\/\d+/i.test(location.pathname) ||
        !!document.querySelector('[aria-modal="true"][role="dialog"] img'),
      // On /photo/N URLs, X renders the photo in a modal OVER the timeline.
      // [data-testid="tweetPhoto"] alone matches every photo in the
      // background timeline too — so scope strictly to the modal when one
      // exists, falling back to the primary column on direct status pages.
      mainSel:
        '[aria-modal="true"] [data-testid="tweetPhoto"] img, ' +
        '[aria-modal="true"] [data-testid="videoPlayer"] video, ' +
        '[aria-modal="true"] video, ' +
        // Status page without modal — grab only the FIRST tweet's media
        'main article[data-testid="tweet"]:first-of-type [data-testid="tweetPhoto"] img, ' +
        'main article[data-testid="tweet"]:first-of-type [data-testid="videoPlayer"] video',
      focusSel:
        '[aria-modal="true"], ' +
        'main article[data-testid="tweet"]:first-of-type',
      exclude: [
        'header', 'nav', 'aside',
        '[data-testid*="UserAvatar"]',
        '[data-testid="DM_Conversation_Avatar"]',
        '[data-testid="primaryColumn"] header',
        '[data-testid="SideNav_AccountSwitcher_Button"]',
        '[aria-label*="Profile" i]'
      ]
    },

    reddit: {
      match: () => /(?:^|\.)reddit\.com$/i.test(location.hostname),
      isSingle: () => /\/comments\//i.test(location.pathname),
      mainSel:
        'shreddit-post img, shreddit-post video, shreddit-player, ' +
        '[data-test-id="post-content"] img, ' +
        '[data-test-id="post-content"] video, ' +
        '[slot="post-media-container"] img, ' +
        '[slot="post-media-container"] video',
      focusSel:
        'shreddit-post, ' +
        '[data-test-id="post-content"], ' +
        '[slot="post-media-container"]',
      exclude: [
        'header', 'nav', 'aside',
        'faceplate-tracker[noun="avatar"]',
        '[aria-label*="avatar" i]',
        'shreddit-subreddit-icon',
        'reddit-header-large',
        '[data-testid="subreddit-sidebar"]'
      ]
    },

    pinterest: {
      match: () => /(?:^|\.)pinterest\./i.test(location.hostname),
      isSingle: () => /^\/pin\//i.test(location.pathname),
      mainSel:
        '[data-test-id="pin-closeup-image"] img, ' +
        '[data-test-id="visual-content-container"] img, ' +
        '[data-test-id="visual-content-container"] video',
      focusSel:
        '[data-test-id="pin-closeup-image"], ' +
        '[data-test-id="visual-content-container"]',
      exclude: [
        'header', 'nav', 'aside',
        '[data-test-id="user-profile-thumbnail"]',
        '[data-test-id="header-profile-image"]',
        '[data-test-id="related-pins"]'    // sidebar pins
      ]
    },

    linkedin: {
      match: () => /(?:^|\.)linkedin\.com$/i.test(location.hostname),
      isSingle: () => /\/posts\/|\/feed\/update\/|\/pulse\//i
                        .test(location.pathname),
      mainSel:
        '.feed-shared-update-v2__content img, ' +
        '.feed-shared-update-v2__content video, ' +
        '.feed-shared-image img, ' +
        '.feed-shared-linkedin-video video, ' +
        'article img, article video',
      focusSel:
        '.feed-shared-update-v2__content, ' +
        'article',
      exclude: [
        'header', 'nav', 'aside',
        // Generic
        '[class*="EntityPhoto" i]', '[class*="profile-photo" i]',
        '[class*="presence-entity" i]', '[class*="EntityLockup" i]',
        '[data-test-component="entity-image"]',
        '.global-nav', '.scaffold-layout__sidebar',
        // Company/org pages — top-card logo & header
        '[class*="org-top-card" i]',
        '[class*="org-top-card-primary-content__logo" i]',
        // Post-level author avatar / circular images / promo cards
        '[class*="update-components-actor" i]',          // author header on a post
        '[class*="update-components-promo" i]',          // promoted side images
        '[class*="update-components-mini-update" i]',    // mini "context" cards
        '[class*="ivm-view-attr__img-wrapper" i] [class*="--circle" i]',
        'img[class*="--circle" i]',                      // any circular img = avatar
        // Suggested / "people you may know" sidebars
        '[class*="entity-result__image" i]',
        '[class*="suggested-actions" i]'
      ]
    },

    youtube: {
      match: () => /(?:^|\.)(youtube\.com|youtu\.be)$/i.test(location.hostname),
      // /watch?v=… is the single-video page
      isSingle: () => /\/watch/i.test(location.pathname + location.search) ||
                       /\/shorts\//i.test(location.pathname),
      // Main player element on watch pages.
      mainSel:
        '#movie_player video, ' +
        '#movie_player img, ' +
        'ytd-player video, ytd-player img, ' +
        'ytd-watch-flexy video, ' +
        'ytd-reel-player-renderer video',
      focusSel:
        '#movie_player, ' +
        'ytd-player, ' +
        'ytd-reel-player-renderer',
      exclude: [
        'header', 'nav', 'aside',
        '#secondary',                              // right rail (up-next videos)
        'ytd-watch-next-secondary-results-renderer',
        'ytd-comments', 'ytd-comment-thread-renderer',
        'ytd-mini-guide-renderer', '#mini-guide',
        '#related',                                // mobile related strip
        '#chips-wrapper',                          // category chips
        'ytd-rich-grid-renderer',                  // home/feed grid in sidebar
        'tp-yt-iron-iconset-svg'
      ]
    },

    // Fallback for any other site
    generic: {
      match: () => true,
      isSingle: () => false,
      mainSel: 'main img, main video, article img, article video',
      focusSel: 'main, article',
      exclude: ['header', 'nav', 'aside', 'svg', '[role="navigation"]']
    }
  };

  const activeProfile = () => {
    for (const [name, p] of Object.entries(SITE_PROFILES)) {
      if (name !== 'generic' && p.match()) return Object.assign({ name }, p);
    }
    return Object.assign({ name: 'generic' }, SITE_PROFILES.generic);
  };

  // ---------- helpers ----------
  const clean = s =>
    String(s || "").replace(/&amp;/g, "&")
                   .replace(/\\u0026/g, "&")
                   .replace(/\\\//g, "/");

  const filenameSafe = s =>
    String(s || "media")
      .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 140);

  const getExt = url => {
    const u = clean(url).split("?")[0].split("#")[0];
    const m = u.match(/\.(jpe?g|png|webp|gif|mp4|mov|m4v|webm|m3u8|mpd|ts)$/i);
    return m ? "." + m[1].toLowerCase().replace("jpeg", "jpg") : "";
  };

  // URL patterns that are NEVER user-content media. Anything matching
  // is filtered out before scoring. Tested on FB / IG / X / Reddit / LI.
  const URL_BLOCKLIST_RE = /(?:\/emoji\.php\/|\/rsrc\.php\/|\/reactions\/|\/avatars\/defaults\/|\/static\/images\/|favicon|sprite|spinner|placeholder)/i;

  const isMediaUrl = url => {
    if (!url || typeof url !== "string") return false;
    url = clean(url);
    if (url.startsWith("data:")) return false;
    if (url.startsWith("blob:")) return true;
    if (!/^https?:\/\//i.test(url)) return false;
    if (URL_BLOCKLIST_RE.test(url)) return false;
    return MEDIA_HOSTS.some(h => url.includes(h)) || MEDIA_EXT_RE.test(url);
  };

  const absoluteUrl = url => {
    if (!url) return "";
    url = clean(url);
    try { return new URL(url, location.href).href; }
    catch { return url; }
  };

  const parseSrcset = srcset =>
    !srcset ? []
            : srcset.split(",")
                    .map(p => p.trim().split(/\s+/)[0])
                    .filter(Boolean);

  // Build a Set of elements that should be ignored, based on profile.exclude
  const buildExclusionSet = profile => {
    const excluded = new Set();
    for (const sel of profile.exclude || []) {
      try {
        document.querySelectorAll(sel).forEach(root => {
          excluded.add(root);
          root.querySelectorAll('*').forEach(el => excluded.add(el));
        });
      } catch { /* selector unsupported in this browser, skip */ }
    }
    return excluded;
  };

  const isExcluded = (el, excluded) => {
    while (el) {
      if (excluded.has(el)) return true;
      el = el.parentElement;
    }
    return false;
  };

  const viewportSize = () => ({
    w: Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0),
    h: Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0),
  });

  const visibleArea = rect => {
    const vp = viewportSize();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(vp.w, rect.right);
    const bottom = Math.min(vp.h, rect.bottom);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  };

  const isVisibleElement = el => {
    if (!el || !el.getBoundingClientRect) return false;
    const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) return false;
    return visibleArea(rect) >= 1024;
  };

  const mediaBoxElement = el => {
    if (!el) return null;
    const tag = el.tagName;
    if (tag === 'SOURCE') return el.closest('picture,video') || el.parentElement;
    return el;
  };

  const addMediaCandidateUrls = (el, add) => {
    if (!el) return;
    const tag = el.tagName;
    if (tag === 'IMG') {
      [el.currentSrc, el.src,
       el.getAttribute('src'), el.getAttribute('data-src'),
       el.getAttribute('data-original'), el.getAttribute('data-url')]
        .forEach(add);
      parseSrcset(el.getAttribute('srcset')).forEach(add);
      const picture = el.closest('picture');
      if (picture) {
        picture.querySelectorAll('source').forEach(s => {
          [s.src, s.getAttribute('src'), s.getAttribute('srcset')]
            .forEach(v => { parseSrcset(v).forEach(add); add(v); });
        });
      }
      return;
    }
    if (tag === 'VIDEO') {
      [el.currentSrc, el.src, el.poster,
       el.getAttribute('src'), el.getAttribute('poster')]
        .forEach(add);
      el.querySelectorAll('source').forEach(s => {
        [s.src, s.getAttribute('src'), s.getAttribute('srcset')]
          .forEach(v => { parseSrcset(v).forEach(add); add(v); });
      });
      return;
    }
    if (tag === 'SOURCE') {
      [el.src, el.getAttribute('src'), el.getAttribute('srcset')]
        .forEach(v => { parseSrcset(v).forEach(add); add(v); });
    }
  };

  const directMediaUrls = el => {
    const urls = new Set();
    const add = url => {
      url = absoluteUrl(url);
      if (isMediaUrl(url)) urls.add(url);
    };
    addMediaCandidateUrls(el, add);
    return [...urls];
  };

  const mediaElementsIn = root => {
    if (!root) return [];
    const out = [];
    if (root.matches && root.matches('img, video, source')) out.push(root);
    if (root.querySelectorAll) {
      root.querySelectorAll('img, video, source').forEach(el => out.push(el));
    }
    return out;
  };

  const mediaElementScore = el => {
    const box = mediaBoxElement(el);
    if (!box || !box.getBoundingClientRect) return -Infinity;
    const rect = box.getBoundingClientRect();
    const area = visibleArea(rect);
    if (area <= 0) return -Infinity;
    const vp = viewportSize();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const maxDist = Math.hypot(vp.w / 2, vp.h / 2) || 1;
    const centered = 1 - Math.min(1, Math.hypot(cx - vp.w / 2, cy - vp.h / 2) / maxDist);
    let score = area + centered * 50000;
    if (box.closest('dialog[open], [aria-modal="true"], [role="dialog"]')) score += 1000000;
    if (box.closest('[aria-selected="true"], [data-current="true"], [data-active="true"]')) score += 20000;
    if (el.tagName === 'VIDEO' || box.tagName === 'VIDEO') score += 10000;
    return score;
  };

  const bestFocusedMedia = (roots, excluded) => {
    const candidates = [];
    for (const root of roots || []) {
      if (!root || isExcluded(root, excluded) || !isVisibleElement(root)) continue;
      for (const el of mediaElementsIn(root)) {
        const box = mediaBoxElement(el);
        if (!box || isExcluded(box, excluded) || !isVisibleElement(box)) continue;
        const rect = box.getBoundingClientRect();
        const intrinsicW = el.naturalWidth || el.videoWidth || el.width || rect.width || 0;
        const intrinsicH = el.naturalHeight || el.videoHeight || el.height || rect.height || 0;
        if (intrinsicW < 120 || intrinsicH < 120) continue;
        const urls = directMediaUrls(el);
        if (!urls.length) continue;
        candidates.push({ el, urls, score: mediaElementScore(el) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  };

  const queryVisibleRoots = selector => {
    const roots = [];
    if (!selector) return roots;
    try {
      document.querySelectorAll(selector).forEach(el => {
        if (isVisibleElement(el)) roots.push(el);
      });
    } catch { /* unsupported selector */ }
    return roots;
  };

  const collectFocusedMedia = (profile, excluded) => {
    const dialogRoots = queryVisibleRoots(
      'dialog[open], [aria-modal="true"], [role="dialog"], ' +
      '[data-pagelet*="MediaViewer" i], [data-testid*="lightbox" i]'
    );
    let best = bestFocusedMedia(dialogRoots, excluded);
    if (best) return best.urls;

    best = bestFocusedMedia(queryVisibleRoots(profile.focusSel), excluded);
    if (best) return best.urls;

    best = bestFocusedMedia([document.body || document.documentElement], excluded);
    return best ? best.urls : [];
  };

  // Extract candidate media URLs from a given root (default: document)
  const extractFromRoot = (root, excluded) => {
    const urls = new Set();
    const add = url => {
      url = absoluteUrl(url);
      if (isMediaUrl(url)) urls.add(url);
    };

    root.querySelectorAll("img").forEach(img => {
      if (excluded && isExcluded(img, excluded)) return;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 180 || h < 180) return;
      [img.currentSrc, img.src,
       img.getAttribute("src"), img.getAttribute("data-src"),
       img.getAttribute("data-original"), img.getAttribute("data-url")]
        .forEach(add);
      parseSrcset(img.getAttribute("srcset")).forEach(add);
    });

    root.querySelectorAll("picture source, source").forEach(source => {
      if (excluded && isExcluded(source, excluded)) return;
      [source.src, source.getAttribute("src"), source.getAttribute("srcset")]
        .forEach(v => { parseSrcset(v).forEach(add); add(v); });
    });

    root.querySelectorAll("video").forEach(video => {
      if (excluded && isExcluded(video, excluded)) return;
      [video.currentSrc, video.src, video.poster,
       video.getAttribute("src"), video.getAttribute("poster")].forEach(add);
      video.querySelectorAll("source").forEach(s => add(s.src));
    });

    // og:image / og:video / twitter:image — only meaningful when root is document
    if (root === document) {
      document.querySelectorAll(`
        meta[property="og:image"], meta[property="og:image:secure_url"],
        meta[property="og:video"], meta[property="og:video:url"],
        meta[property="og:video:secure_url"],
        meta[name="twitter:image"], meta[name="twitter:player:stream"]
      `).forEach(m => add(m.getAttribute("content")));
    }

    // Inline JSON blobs in page HTML often contain the full-quality URL
    if (root === document) {
      const html = document.documentElement.innerHTML;
      const regexes = [
        /https?:\\?\/\\?\/[^"'<>\\\s]+?\.(?:jpg|jpeg|png|webp|gif|mp4|webm|m3u8|mpd)[^"'<>\\\s]*/gi,
        /https?:\\?\/\\?\/[^"'<>\\\s]+?(?:fbcdn|cdninstagram|twimg|licdnmedia|licdn|redd\.it|redditmedia|pinimg)[^"'<>\\\s]*/gi
      ];
      regexes.forEach(re => (html.match(re) || []).forEach(add));
    }

    return [...urls];
  };

  // ---------- URL upgrades (per site) ----------
  const preferHighQuality = urls => [...new Set(urls.map(url => {
    let u = clean(url);
    // X/Twitter: name=orig
    if (u.includes("pbs.twimg.com/media/")) {
      try { const p = new URL(u); p.searchParams.set("name", "orig"); u = p.href; }
      catch {}
    }
    // Pinterest: /<size>/ → /originals/. Size folder may carry a
    // letter suffix (Pinterest added "_RS" / "_AC" etc. for "responsive
    // sizes" / aspect-cropped variants), so allow an optional _[A-Za-z]+.
    if (u.includes("pinimg.com/")) {
      u = u.replace(/pinimg\.com\/(?:\d+x(?:\d+)?(?:_[A-Za-z]+)?|originals)\//i,
                    "pinimg.com/originals/");
    }
    // Reddit preview: strip sizing params, keep signature
    if (/preview\.redd\.it|external-preview\.redd\.it/.test(u)) {
      try {
        const p = new URL(u);
        ["width", "height", "blur", "format"].forEach(k => p.searchParams.delete(k));
        u = p.href;
      } catch {}
    }
    return u;
  }))];

  // ---------- WebCrypto helpers (AES-128 HLS) ----------
  const _hexToBytes = hex => {
    hex = String(hex || '').replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
    if (hex.length % 2) hex = '0' + hex;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substr(i, 2), 16);
    return out;
  };

  // Per RFC 8216 §5.2, when an EXT-X-KEY tag does not carry an explicit IV
  // the IV is the media-sequence number of the segment, expressed as a
  // 128-bit big-endian unsigned integer (left-zero-padded).
  const _ivFromSequence = seq => {
    const iv = new Uint8Array(16);
    // A bitwise `| 0` here would coerce to a signed 32-bit int, returning an
    // all-zero IV for any media sequence ≥ 2^31 (which long-running live HLS
    // streams routinely exceed) and breaking AES-128 segment decryption.
    // Coerce defensively to a non-negative integer, then go straight to BigInt.
    let n = BigInt(Math.max(0, Math.trunc(Number(seq)) || 0));
    for (let i = 15; i >= 0 && n > 0n; i--) {
      iv[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return iv;
  };

  const _decryptAes128Cbc = async (ciphertext, keyBytes, iv) => {
    if (!(crypto && crypto.subtle)) throw new Error('WebCrypto unavailable');
    const ct = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
    const key = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']
    );
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct);
    return new Uint8Array(plain);
  };

  // ---------- MSE / SourceBuffer recorder ----------
  // State is parked on window so it survives SMD re-injection (the chrome
  // extension calls executeScript with our file once per turn; the second
  // call re-defines window.SocialMediaDownloader and we'd otherwise lose
  // every byte captured so far). _mseStateRef() lazily creates the record.
  const _mseStateRef = () => {
    if (!window.__smd_mse) {
      window.__smd_mse = {
        armed: false,
        buffers: new Map(),       // SourceBuffer -> { mime, chunks, bytes, mediaSource }
        mediaSources: new Map(),  // MediaSource  -> { url, buffers: SourceBuffer[] }
      };
    }
    return window.__smd_mse;
  };

  const armMseRecorder = () => {
    if (typeof MediaSource === 'undefined' || typeof SourceBuffer === 'undefined') {
      return { armed: false, error: 'MSE not available in this browser' };
    }
    const state = _mseStateRef();
    if (state.armed) return { armed: true, alreadyArmed: true };
    state.armed = true;

    // Track new MediaSources (so we can label captured buffers with their
    // parent MS URL — handy for debugging multi-stream pages).
    const origAddSb = MediaSource.prototype.addSourceBuffer;
    if (!origAddSb.__smd_patched) {
      MediaSource.prototype.addSourceBuffer = function (mime) {
        const buf = origAddSb.call(this, mime);
        const s = _mseStateRef();
        s.buffers.set(buf, { mime: String(mime || ''), chunks: [], bytes: 0, mediaSource: this });
        let msEntry = s.mediaSources.get(this);
        if (!msEntry) { msEntry = { url: null, buffers: [] }; s.mediaSources.set(this, msEntry); }
        msEntry.buffers.push(buf);
        return buf;
      };
      MediaSource.prototype.addSourceBuffer.__smd_patched = true;
    }

    // Tee bytes into our own copy before handing them to the player.
    // Cover all three input types appendBuffer accepts (ArrayBuffer,
    // TypedArrayView, DataView).
    const origAppend = SourceBuffer.prototype.appendBuffer;
    if (!origAppend.__smd_patched) {
      SourceBuffer.prototype.appendBuffer = function (data) {
        try {
          const s = _mseStateRef();
          let entry = s.buffers.get(this);
          if (!entry) {
            entry = { mime: 'application/octet-stream', chunks: [], bytes: 0, mediaSource: null };
            s.buffers.set(this, entry);
          }
          let view = null;
          if (data instanceof ArrayBuffer) view = new Uint8Array(data);
          else if (ArrayBuffer.isView(data)) {
            view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          }
          if (view) {
            // Player may reuse / mutate the underlying buffer — copy now.
            const copy = new Uint8Array(view.byteLength);
            copy.set(view);
            entry.chunks.push(copy);
            entry.bytes += copy.byteLength;
          }
        } catch (_) { /* never let our hook break the player */ }
        return origAppend.call(this, data);
      };
      SourceBuffer.prototype.appendBuffer.__smd_patched = true;
    }

    // URL.createObjectURL hook — attach the blob: URL to the MediaSource
    // record so getMseRecording()'s output names each capture sensibly.
    const origCreateUrl = URL.createObjectURL;
    if (!origCreateUrl.__smd_patched) {
      URL.createObjectURL = function (obj) {
        const url = origCreateUrl.call(this, obj);
        try {
          if (obj instanceof MediaSource) {
            const s = _mseStateRef();
            let msEntry = s.mediaSources.get(obj);
            if (!msEntry) { msEntry = { url, buffers: [] }; s.mediaSources.set(obj, msEntry); }
            else msEntry.url = url;
          }
        } catch (_) {}
        return url;
      };
      URL.createObjectURL.__smd_patched = true;
    }

    return { armed: true };
  };

  const getMseRecording = () => {
    const state = _mseStateRef();
    const summary = [];
    for (const [, ms] of state.mediaSources) {
      summary.push({
        url: ms.url,
        buffers: ms.buffers.map(b => {
          const e = state.buffers.get(b);
          return { mime: e ? e.mime : null, chunks: e ? e.chunks.length : 0, bytes: e ? e.bytes : 0 };
        }),
      });
    }
    // Also surface buffers that have no associated MediaSource (appendBuffer
    // observed before addSourceBuffer — happens when arming after the player
    // already created its buffers).
    const orphans = [];
    for (const [, entry] of state.buffers) {
      if (!entry.mediaSource) {
        orphans.push({ mime: entry.mime, chunks: entry.chunks.length, bytes: entry.bytes });
      }
    }
    return { armed: state.armed, mediaSources: summary, orphanBuffers: orphans };
  };

  const _mseExtForMime = mime => {
    if (/video\/mp4/i.test(mime)) return '.mp4';
    if (/audio\/mp4/i.test(mime)) return '.m4a';
    if (/video\/webm/i.test(mime)) return '.webm';
    if (/audio\/webm/i.test(mime)) return '.weba';
    if (/video\/mp2t/i.test(mime)) return '.ts';
    return '.bin';
  };

  const _mseEntryHasMuxedAudioVideo = entry => {
    const mime = String(entry && entry.mime || '');
    if (!/^video\//i.test(mime)) return false;
    const hasVideoCodec = /\b(?:avc1|avc3|hvc1|hev1|vp0?[89]|av01|theora)\b/i.test(mime);
    const hasAudioCodec = /(?:mp4a|aac|ac-3|ec-3|opus|vorbis)/i.test(mime);
    return hasVideoCodec && hasAudioCodec;
  };

  // Group captured SourceBuffers by their parent MediaSource. Each
  // MediaSource ≈ one stream on the page — typically one reel on
  // infinite-feed viewers like Instagram /reels/, where the player
  // preloads neighbours as the user scrolls. Without grouping,
  // "download this reel" once produced 29 files (15 video + 14 audio,
  // one per preloaded neighbour). Orphan buffers (appendBuffer fired
  // before our addSourceBuffer hook) become their own group since we
  // can't attribute them to a specific stream.
  const _groupMseBuffers = (minBytes) => {
    const state = _mseStateRef();
    const groups = []; // { url, entries: [bufferEntry], totalBytes }
    const seen = new Set();
    for (const [, msEntry] of state.mediaSources) {
      const entries = [];
      let totalBytes = 0;
      for (const sb of msEntry.buffers) {
        const e = state.buffers.get(sb);
        if (!e || e.bytes < minBytes) continue;
        entries.push(e);
        totalBytes += e.bytes;
        seen.add(e);
      }
      if (entries.length > 0) groups.push({ url: msEntry.url, entries, totalBytes });
    }
    const orphanEntries = [];
    let orphanBytes = 0;
    for (const [, entry] of state.buffers) {
      if (seen.has(entry)) continue;
      if (entry.bytes < minBytes) continue;
      orphanEntries.push(entry);
      orphanBytes += entry.bytes;
    }
    if (orphanEntries.length > 0) {
      groups.push({ url: null, entries: orphanEntries, totalBytes: orphanBytes });
    }
    return groups;
  };

  // Pick the "primary" stream when the page captured multiple. Instagram
  // (and similar infinite-feed viewers) keeps adjacent preloaded reels
  // mounted as their own <video> elements with their own MediaSources,
  // so "is the MediaSource attached to any <video>" doesn't narrow at
  // all — every captured group is. We need a tighter signal for "the
  // one the user is watching". Probe in priority order:
  //   1. video is actively playing AND its bounding rect intersects
  //      the viewport (Instagram autoplays the focused reel; preloaded
  //      neighbours are paused);
  //   2. video bounding rect intersects the viewport (user paused, but
  //      it's still the one on screen);
  //   3. any <video> in the DOM (last resort).
  // Within the narrowest non-empty tier we tie-break by total bytes —
  // longer playback ≈ the one the user actually watched. Bytes alone
  // are NOT used as the primary signal: an off-screen neighbour that
  // happened to preload more frames than the focused reel would
  // otherwise win.
  const _pickPrimaryMseGroup = (groups) => {
    if (groups.length <= 1) return groups[0];
    const byUrl = new Map();
    for (const g of groups) {
      if (g.url) byUrl.set(g.url, g);
    }
    const playing = new Set();
    const visible = new Set();
    const anyDom = new Set();
    try {
      if (typeof document !== 'undefined') {
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
        const vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
        for (const v of document.querySelectorAll('video')) {
          const g = byUrl.get(v.currentSrc) || byUrl.get(v.src);
          if (!g) continue;
          anyDom.add(g);
          let inView = false;
          try {
            const r = v.getBoundingClientRect();
            inView = r.width > 0 && r.height > 0 &&
                     r.bottom > 0 && r.top < vh &&
                     r.right > 0 && r.left < vw;
          } catch (_) { /* detached <video> — leave inView=false */ }
          if (inView) {
            visible.add(g);
            if (v.paused === false) playing.add(g);
          }
        }
      }
    } catch (_) { /* detached doc — fall through to size heuristic */ }
    const candidates =
      playing.size > 0 ? [...playing] :
      visible.size > 0 ? [...visible] :
      anyDom.size > 0 ? [...anyDom] :
      groups;
    candidates.sort((a, b) => b.totalBytes - a.totalBytes);
    return candidates[0];
  };

  // mode resolution intentionally diverges from collect()'s here. For
  // URL extraction, `auto` on a feed page means "every item the page
  // shows" — that's correct, because the captured URLs ARE distinct
  // gallery items. For MSE captures, the captured groups are temporal
  // player state (preload side-effects), not page content: an Instagram
  // /home feed will MSE-capture ≈5 reels because the player preloads
  // vertically-adjacent reels in the background, but the user only
  // ever sees one. Resolving `auto` via profile.isSingle() here would
  // dump every preloaded neighbour on every feed page, which is the
  // bug this PR fixes in the first place. So saveMse() treats auto
  // and main identically — primary group only — and reserves explicit
  // `mode: 'all'` for callers who genuinely want every captured stream
  // (e.g. they scrolled through 10 reels and want them all).
  //   'main'  → primary group only
  //   'auto'  → primary group only (same as main; see above)
  //   'all'   → every captured group
  // Default 'all' preserves the pre-v4 contract for direct console
  // callers of saveMse() — only download_social_media plumbs the mode.
  const saveMse = async ({ prefix = 'mse', minBytes = 1, mode = 'all', requireMuxedAudioVideo = false } = {}) => {
    const groups = _groupMseBuffers(minBytes);
    const primaryOnly = mode === 'main' || mode === 'auto';
    const toSave = (primaryOnly && groups.length > 1)
      ? [_pickPrimaryMseGroup(groups)]
      : groups;
    if (requireMuxedAudioVideo && toSave.some((group) => (
      group.entries.length !== 1 || !_mseEntryHasMuxedAudioVideo(group.entries[0])
    ))) {
      const error = new Error(
        'The browser MSE capture contains split or unverifiably muxed media. No files were saved because a video request must produce one file with audio included.',
      );
      error.code = 'split_mse_requires_server_merge';
      throw error;
    }
    let i = 1;
    const saved = [];
    for (const group of toSave) {
      for (const entry of group.entries) {
        const merged = new Uint8Array(entry.bytes);
        let off = 0;
        for (const c of entry.chunks) { merged.set(c, off); off += c.length; }
        const kind = /audio/i.test(entry.mime) ? 'audio' : 'video';
        const ext = _mseExtForMime(entry.mime);
        const fname = `${filenameSafe(prefix)}_${kind}_${String(i).padStart(2, '0')}${ext}`;
        triggerBlobDownload(
          new Blob([merged], { type: entry.mime || 'application/octet-stream' }),
          fname
        );
        saved.push({ filename: fname, bytes: entry.bytes, mime: entry.mime });
        i++;
      }
    }
    if (saved.length >= 2) {
      console.log(
        '[MSE] saved %d buffers — if video+audio are split, remux with:\n' +
        '      ffmpeg -i %s -i %s -c copy out.mp4',
        saved.length, saved[0].filename, saved[1].filename
      );
    }
    return saved;
  };

  // ---------- YouTube progressive formats ----------
  // YouTube's main player uses MSE+DASH and (often) Widevine — yt-dlp's
  // job, not ours. BUT the page HTML still embeds `ytInitialPlayerResponse`
  // with a `streamingData.formats[]` list, and a handful of those have
  // pre-signed `url` fields (typically the 360p combined-audio/video MP4,
  // itag 18). Those are downloadable in one call, no cipher work needed.
  // Higher-resolution streams come in DASH `adaptiveFormats[]` with a
  // `signatureCipher` blob that requires decoding base.js — out of scope.
  const _findJsonObject = (text, marker) => {
    const startIdx = text.indexOf(marker);
    if (startIdx < 0) return null;
    const open = text.indexOf('{', startIdx);
    if (open < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return text.slice(open, i + 1); }
    }
    return null;
  };

  const _extractYoutubeProgressive = () => {
    const out = [];
    try {
      // Prefer the live player object if ytcfg has already deserialized it.
      let resp = null;
      if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
        resp = window.ytInitialPlayerResponse;
      } else {
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        const raw = _findJsonObject(html, 'ytInitialPlayerResponse');
        if (raw) {
          try { resp = JSON.parse(raw); } catch { /* malformed */ }
        }
      }
      if (!resp || !resp.streamingData) return out;
      const sd = resp.streamingData;
      const list = [].concat(sd.formats || [], sd.adaptiveFormats || []);
      for (const f of list) {
        if (f && typeof f.url === 'string' && /^https?:/i.test(f.url)) {
          out.push(f.url);
        }
        // f.signatureCipher / f.cipher entries need base.js decoding — skip.
      }
    } catch (_) { /* never fatal */ }
    return [...new Set(out)];
  };

  // ---------- "Use a real tool" recommendation builder ----------
  // SMD knowingly cannot do certain things — YouTube's signed/Widevine
  // video stream, DRM-encrypted HLS, MSE blobs where the player never
  // got a chance to load the bytes. When the result is poor for one of
  // those reasons, we return a `recommendation` object so the caller
  // (the agent, the human at the console) sees an honest "use yt-dlp"
  // or "use gallery-dl" message instead of pretending the download
  // worked. Pure-functional on the inputs so the tests can drive it
  // without a real YouTube / Facebook page in the loop.
  const _buildRecommendation = ({
    urls = [],
    profile = 'generic',
    mseBytes = 0,
    // v4.x: download_social_media now calls saveMse() inline when
    // mseBytes > 0 and passes the results in. If the save succeeded
    // there's nothing to recommend — the bytes already landed. If it
    // failed, recommend yt-dlp instead of the old "call execute_js
    // → saveMse()" dance, which was broken by extension-CSP `unsafe-
    // eval`. Old callers that don't pass these fields still work: they
    // get the legacy `mse_capture_available` recommendation.
    mseSavedFiles = null,
    mseSaveError = null,
    mseSaveCode = null,
    completedCount = 0,
    completedVideoCount = null,
    requestedTarget = 'auto',
    pageUrl = (typeof location !== 'undefined' ? location.href : ''),
  } = {}) => {
    let parsed = null;
    try { parsed = new URL(pageUrl); } catch (_) { /* malformed */ }
    const href = parsed ? parsed.href : String(pageUrl || '');
    const path = parsed ? (parsed.pathname + parsed.search) : '';

    const completedDownloads = Number(completedCount) || 0;
    // New callers report successful video downloads explicitly. Preserve
    // compatibility with older callers by treating a completed run that
    // discovered a video URL as a completed video when the field is absent.
    const completedVideos = completedVideoCount === null
      ? (completedDownloads > 0 && urls.some(isVideoDownloadUrl) ? completedDownloads : 0)
      : (Number(completedVideoCount) || 0);

    // YouTube watch / shorts pages — a saved thumbnail or OG image does not
    // satisfy a video request. Only suppress the fallback after an actual
    // video stream (including a verified muxed MSE file) completed.
    const youtubeVideoRequested = requestedTarget === 'auto'
      || requestedTarget === 'media'
      || requestedTarget === 'video';
    if (profile === 'youtube' && youtubeVideoRequested) {
      const isWatch = /\/(?:watch|shorts)/i.test(path);
      if (isWatch && completedVideos === 0) {
        return {
          kind: 'youtube_video',
          message:
            'YouTube serves its actual video through MediaSource + rotating ' +
            'signed URLs and (often) Widevine DRM that this in-browser ' +
            'script cannot touch. For real YouTube video downloads, use ' +
            'yt-dlp — it handles the cipher decoding and DASH muxing:\n' +
            '  pip install yt-dlp\n' +
            '  yt-dlp "' + href + '"',
        };
      }
    }

    const completedRequestedDownloads = requestedTarget === 'video'
      ? completedVideos
      : completedDownloads;
    if (completedRequestedDownloads > 0) return null;

    // MSE capture available. The new flow: download_social_media calls
    // saveMse() inline and passes mseSavedFiles / mseSaveError in.
    //
    //   - mseSavedFiles is a non-empty array → the bytes already landed.
    //     No recommendation needed; let the normal "N files downloaded"
    //     result speak for itself.
    //   - mseSavedFiles is an empty array → save attempted but produced
    //     nothing (rare — buffers below minBytes). Surface a useful
    //     note pointing at yt-dlp as the bulletproof fallback.
    //   - mseSaveError is set → save threw. Same fallback as above plus
    //     the error string so the agent can echo it to the user.
    //   - Both null (legacy caller that doesn't pass the new fields) →
    //     return the old `mse_capture_available` recommendation, preserved
    //     for backwards compat with any external callers of
    //     _buildRecommendation. NOT consumed by download_social_media
    //     anymore.
    if (mseBytes > 0 && requestedTarget !== 'image') {
      if (mseSaveCode === 'split_mse_requires_server_merge') {
        return {
          kind: 'split_mse_unmerged',
          message:
            'The browser fallback detected split or unverifiably muxed media. ' +
            'It intentionally saved nothing because the requested video must be one file with audio included. ' +
            'Use the dedicated public-media downloader for server-side finalization; if that service already failed, report its failure honestly.',
        };
      }
      if (Array.isArray(mseSavedFiles) && mseSavedFiles.length > 0) {
        return null; // bytes saved — nothing to recommend
      }
      if (mseSavedFiles !== null || mseSaveError) {
        // New caller invoked saveMse, but it returned nothing or threw.
        const errBit = mseSaveError ? ' (' + mseSaveError + ')' : '';
        return {
          kind: 'mse_save_failed',
          message:
            'The MSE recorder captured ' + mseBytes + ' bytes from the ' +
            'player but saveMse() did not produce a downloadable file' +
            errBit + '. This usually means the captured chunks are below ' +
            'the minBytes threshold or the page revoked the blob URL ' +
            'before the <a download> click landed. The most reliable ' +
            'fallback for this URL is yt-dlp:\n' +
            '  pip install yt-dlp\n' +
            '  yt-dlp "' + href + '"',
        };
      }
      // Legacy caller (didn't pass mseSavedFiles / mseSaveError). Keep
      // the old recommendation. download_social_media no longer hits this.
      return {
        kind: 'mse_capture_available',
        message:
          'The MSE recorder captured ' + mseBytes + ' bytes from the ' +
          'player while the page was open. Run `await ' +
          'SocialMediaDownloader.saveMse()` to download those bytes as ' +
          'separate video / audio files. If the result is two files, ' +
          'remux with: ffmpeg -i video.mp4 -i audio.mp4 -c copy out.mp4',
      };
    }

    // Saw a blob: URL but no captured bytes — the player IS using MSE,
    // but it hasn't pushed anything into the buffer yet (or hasn't been
    // played at all). Tell the user how to make it work, and offer
    // yt-dlp as the DRM-encrypted fallback.
    const hasBlob = urls.some(u => /^blob:/i.test(u));
    if (hasBlob) {
      return {
        kind: 'mse_capture_empty',
        message:
          'This video plays through MediaSource Extensions; the <video> ' +
          'src is a blob: URL backed by chunks the player streams into ' +
          'memory. The extension auto-arms a capture hook on supported ' +
          'social hosts, but it can only record bytes the player has ' +
          'ALREADY loaded. Reload the page, play the video through (or ' +
          'scrub to the end to force a full buffer), then re-invoke this ' +
          'tool. If the stream is DRM-encrypted (Widevine / FairPlay / ' +
          'PlayReady), browser capture is impossible — use yt-dlp:\n' +
          '  pip install yt-dlp\n' +
          '  yt-dlp "' + href + '"',
      };
    }

    // Site profile is 'generic' — we have no per-site logic at all.
    if (profile === 'generic') {
      return {
        kind: 'unsupported_site',
        message:
          'This site is not in the in-browser script\'s supported list ' +
          '(Facebook · Instagram · X · LinkedIn · Reddit · Pinterest · ' +
          'YouTube). For broader coverage, use the canonical CLI tools:\n' +
          '  Videos (1,800+ sites): pip install yt-dlp; yt-dlp "' + href + '"\n' +
          '  Images (300+ sites):   pip install gallery-dl; gallery-dl "' + href + '"',
      };
    }

    // Supported site but the run came back empty. Could be a logged-out
    // session, a feed that hasn\'t scrolled, or the post the user wants
    // hasn\'t been clicked into.
    if (urls.length === 0) {
      return {
        kind: 'empty_result',
        message:
          'No media found on this page. Common causes: (a) you are not ' +
          'logged in, (b) you are looking at a feed and have not clicked ' +
          'into a specific post, (c) the media is inside a carousel and ' +
          'you have not scrolled to it. Try one of those first. If the ' +
          'site does not actually serve the media this way, fall back to ' +
          'yt-dlp (videos) or gallery-dl (images).',
      };
    }

    return null;
  };

  // ---------- Reddit DASH grouping ----------
  const groupRedditDash = urls => {
    const groups = new Map();
    const passthrough = [];
    for (const url of urls) {
      const m = url.match(/^(https?:\/\/v\.redd\.it\/[^\/]+)\/(DASH_[^\/?#]+)/i);
      if (!m) { passthrough.push(url); continue; }
      const base = m[1], part = m[2];
      if (!groups.has(base)) groups.set(base, { video: null, audio: null });
      const g = groups.get(base);
      if (/audio/i.test(part)) g.audio = url;
      else {
        const h = parseInt((part.match(/DASH_(\d+)/i) || [])[1] || "0", 10);
        if (!g.video || h > (g._h || 0)) { g.video = url; g._h = h; }
      }
    }
    const dashUrls = [];
    for (const [, g] of groups) {
      if (g.video) dashUrls.push(g.video);
      if (g.audio) dashUrls.push(g.audio);
    }
    return { dashUrls, passthrough, groups };
  };

  // ---------- Scoring & ranking ----------
  const isHttpVideoUrl = url =>
    /^https?:\/\//i.test(url || '') &&
    (/\.(mp4|mov|m4v|webm|m3u8|mpd|ts)(\?|#|$)/i.test(url) ||
     /googlevideo\.com\/videoplayback\b/i.test(url) ||
     /[?&](?:mime|type)=video(?:%2f|\/)/i.test(url));

  const scoreUrl = url => {
    let s = 0;
    if (isHttpVideoUrl(url)) s += 100;
    if (/\.(jpg|jpeg|png|webp)(\?|#|$)/i.test(url)) s += 50;
    if (url.includes("name=orig")) s += 20;
    if (url.includes("originals/")) s += 25;
    if (url.includes("video")) s += 10;
    if (url.startsWith("blob:")) s -= 50;
    if (/preview\.redd\.it/.test(url)) s -= 5;
    return s;
  };

  const videoFirstUrls = urls => {
    const httpVideos = urls.filter(isHttpVideoUrl);
    const blobUrls = urls.filter(u => u.startsWith("blob:"));
    const rest = urls.filter(u => !isHttpVideoUrl(u) && !u.startsWith("blob:"));
    return [...httpVideos, ...blobUrls, ...rest];
  };

  const isVideoDownloadUrl = url =>
    isHttpVideoUrl(url) ||
    String(url || '').startsWith('blob:') ||
    /v\.redd\.it/i.test(url || '');

  const filterUrlsForTarget = (urls, target = 'auto') => {
    if (target === 'video') return urls.filter(isVideoDownloadUrl);
    if (target === 'image') return urls.filter(url => !isVideoDownloadUrl(url));
    return urls;
  };

  const focusedDownloadUrls = urls => {
    urls = videoFirstUrls(urls);
    const httpVideoUrl = urls.find(isHttpVideoUrl);
    if (httpVideoUrl) return [httpVideoUrl];
    const blobUrl = urls.find(u => u.startsWith("blob:"));
    return blobUrl ? [blobUrl] : urls.slice(0, 1);
  };

  // ---------- HLS m3u8 stitching ----------
  const fetchText = async u =>
    (await fetch(u, { credentials: "include" })).text();
  const fetchBinary = async u =>
    new Uint8Array(await (await fetch(u, { credentials: "include" })).arrayBuffer());
  const resolveSegmentUrl = (seg, playlistUrl) => {
    try { return new URL(seg, playlistUrl).href; } catch { return seg; }
  };

  // Parse an HLS media playlist into a list of { url, key, iv } segment
  // entries. `key` is null for plaintext; `iv` is a Uint8Array(16) when
  // encrypted. Tracks EXT-X-MEDIA-SEQUENCE so the implicit IV is correct
  // for live/rotating-key playlists. Caches fetched key bytes by URI to
  // avoid re-fetching for every segment in a long playlist.
  const _parseHlsMediaPlaylist = async (text, playlistUrl) => {
    const lines = text.split(/\r?\n/);
    const seqStart = parseInt((text.match(/#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/i) || [])[1] || '0', 10);
    let mediaSeq = seqStart;
    let currentKey = null; // { method, keyBytes, ivBytes|null }
    const keyCache = new Map(); // URI -> Uint8Array
    const segments = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-KEY')) {
        const methodMatch = line.match(/METHOD=([A-Z0-9-]+)/i);
        const uriMatch = line.match(/URI="([^"]+)"/i);
        const ivMatch = line.match(/IV=(0x[0-9a-fA-F]+)/i);
        const method = methodMatch ? methodMatch[1].toUpperCase() : 'NONE';
        if (method === 'NONE') { currentKey = null; continue; }
        if (method !== 'AES-128') {
          throw new Error(`HLS: unsupported encryption method ${method} (only AES-128 supported)`);
        }
        if (!uriMatch) throw new Error('HLS: AES-128 key missing URI');
        const keyUrl = resolveSegmentUrl(uriMatch[1], playlistUrl);
        let keyBytes = keyCache.get(keyUrl);
        if (!keyBytes) {
          keyBytes = await fetchBinary(keyUrl);
          if (keyBytes.length !== 16) {
            throw new Error(`HLS: AES-128 key file is ${keyBytes.length} bytes, expected 16`);
          }
          keyCache.set(keyUrl, keyBytes);
        }
        const ivBytes = ivMatch ? _hexToBytes(ivMatch[1]) : null;
        currentKey = { method, keyBytes, ivBytes };
        continue;
      }
      if (line.startsWith('#')) continue;
      const segUrl = resolveSegmentUrl(line, playlistUrl);
      const iv = currentKey
        ? (currentKey.ivBytes || _ivFromSequence(mediaSeq))
        : null;
      segments.push({
        url: segUrl,
        key: currentKey ? currentKey.keyBytes : null,
        iv,
      });
      mediaSeq++;
    }
    return segments;
  };

  const stitchHls = async playlistUrl => {
    console.log('[HLS] fetching playlist', playlistUrl);
    let text = await fetchText(playlistUrl);
    if (/#EXT-X-STREAM-INF/i.test(text)) {
      const lines = text.split(/\r?\n/);
      let best = { bw: 0, uri: null };
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
          const uri = lines[i + 1] && !lines[i + 1].startsWith('#')
            ? lines[i + 1].trim() : null;
          if (uri && bw > best.bw) best = { bw, uri };
        }
      }
      if (!best.uri) throw new Error('HLS: no variant found');
      playlistUrl = resolveSegmentUrl(best.uri, playlistUrl);
      text = await fetchText(playlistUrl);
    }
    const segments = await _parseHlsMediaPlaylist(text, playlistUrl);
    if (!segments.length) throw new Error('HLS: media playlist has no segments');
    const encryptedCount = segments.filter(s => s.key).length;
    console.log(
      `[HLS] fetching ${segments.length} segments` +
      (encryptedCount ? ` (${encryptedCount} AES-128 encrypted)` : '')
    );
    const chunks = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      let bytes = await fetchBinary(seg.url);
      if (seg.key) {
        bytes = await _decryptAes128Cbc(bytes, seg.key, seg.iv);
      }
      chunks.push(bytes);
      if (i % 10 === 0) {
        console.log(`[HLS] ${i + 1}/${segments.length}${seg.key ? ' (decrypted)' : ''}`);
      }
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return new Blob([out], { type: 'video/mp2t' });
  };

  // ---------- Main extraction entry point ----------
  // mode: 'auto' | 'main' | 'all'
  const collect = (mode = 'auto') => {
    const profile = activeProfile();
    const excluded = buildExclusionSet(profile);

    const focusedUrls = mode === 'auto'
      ? collectFocusedMedia(profile, excluded)
      : [];
    let useMain;
    if (mode === 'main') useMain = true;
    else if (mode === 'all') useMain = false;
    else useMain = profile.isSingle();   // auto

    // Gallery / album list page: scoped extraction beats a whole-document
    // sweep. Without this, an album with N photos returns N + nav avatars
    // + page logo + suggested-content thumbnails — the trace that found
    // 713 "photos" on a Twonks album was 90%+ chrome.
    const useGallery =
      !useMain &&
      typeof profile.gallerySel === 'string' &&
      typeof profile.isGallery === 'function' &&
      profile.isGallery();

    let urls;
    let sourceMode = useGallery ? 'gallery' : (useMain ? 'main' : 'all');
    if (focusedUrls.length) {
      urls = focusedUrls;
      sourceMode = 'focused';
    } else if (useGallery) {
      const galleryUrls = [];
      const galleryEls = document.querySelectorAll(profile.gallerySel);
      galleryEls.forEach(el => {
        if (isExcluded(el, excluded)) return;
        // Pull the img directly so we don't accidentally bring in
        // sibling overlay icons that share the link's <a> ancestor.
        extractFromRoot(el, excluded).forEach(u => galleryUrls.push(u));
        if (el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'SOURCE') {
          [el.currentSrc, el.src, el.poster,
           el.getAttribute('src'), el.getAttribute('poster')]
            .forEach(u => {
              u = absoluteUrl(u);
              if (isMediaUrl(u)) galleryUrls.push(u);
            });
          parseSrcset(el.getAttribute('srcset')).forEach(u => {
            u = absoluteUrl(u);
            if (isMediaUrl(u)) galleryUrls.push(u);
          });
        }
      });
      urls = [...new Set(galleryUrls)];
    } else if (useMain) {
      // 1) og:image / og:video — what the site declares as THE media
      const ogUrls = [];
      document.querySelectorAll(`
        meta[property="og:image"], meta[property="og:image:secure_url"],
        meta[property="og:video"], meta[property="og:video:url"],
        meta[property="og:video:secure_url"]
      `).forEach(m => {
        const c = absoluteUrl(m.getAttribute("content"));
        if (isMediaUrl(c)) ogUrls.push(c);
      });

      // 2) Anything inside the main-content container
      const mainEls = profile.mainSel
        ? document.querySelectorAll(profile.mainSel) : [];
      const mainUrls = [];
      mainEls.forEach(el => {
        const root = el.closest('img, video, picture, source')
          ? el.parentElement || el
          : el;
        extractFromRoot(root, excluded).forEach(u => mainUrls.push(u));
        // Also extract from el itself (covers img/video matched directly)
        if (el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'SOURCE') {
          [el.currentSrc, el.src, el.poster,
           el.getAttribute('src'), el.getAttribute('poster')]
            .forEach(u => {
              u = absoluteUrl(u);
              if (isMediaUrl(u)) mainUrls.push(u);
            });
          parseSrcset(el.getAttribute('srcset')).forEach(u => {
            u = absoluteUrl(u);
            if (isMediaUrl(u)) mainUrls.push(u);
          });
        }
      });

      urls = [...new Set([...ogUrls, ...mainUrls])];
    } else {
      urls = extractFromRoot(document, excluded);
    }

    // YouTube: on /watch pages the player's actual bytes hide behind MSE
    // and signed googlevideo URLs, but ytInitialPlayerResponse usually
    // surfaces at least one pre-signed progressive MP4 (typically 360p).
    // Include it whenever we're on YouTube so list/run can offer a real
    // video file alongside the poster thumbnail.
    if (profile.name === 'youtube') {
      for (const u of _extractYoutubeProgressive()) {
        if (isMediaUrl(u)) urls.push(u);
      }
    }

    const upgraded = preferHighQuality(urls);
    const { dashUrls, passthrough, groups } = groupRedditDash(upgraded);
    let finalUrls = [...dashUrls, ...passthrough]
      .sort((a, b) => scoreUrl(b) - scoreUrl(a));
    // Per-profile URL filter — keeps the avatars / icons / sprite assets
    // out of the final list even when they slipped past DOM exclusion.
    // Facebook puts a size slug in `stp=…` (e.g. `_s80x80` for an avatar
    // vs `_s552x414` for a real album thumbnail); the FB profile uses
    // that to drop anything under ~300×300. Other profiles can opt in.
    if (typeof profile.urlFilter === 'function') {
      finalUrls = finalUrls.filter(u => {
        try { return profile.urlFilter(u); } catch { return true; }
      });
    }
    if (sourceMode === 'focused') finalUrls = focusedDownloadUrls(finalUrls);
    else if (sourceMode === 'main') finalUrls = videoFirstUrls(finalUrls);
    return { urls: finalUrls, profile,
             mode: sourceMode,
             dashGroups: groups };
  };

  const list = (mode = 'auto') => {
    const { urls, profile, mode: m, dashGroups } = collect(mode);
    console.log(
      `%c[SMD] site=${profile.name} mode=${m} found=${urls.length}`,
      'color:#06c;font-weight:bold'
    );
    console.table(urls.map((url, i) => ({
      index: i + 1,
      type: url.startsWith("blob:") ? "blob"
        : /\.m3u8(\?|#|$)/i.test(url) ? "hls"
        : /v\.redd\.it.*DASH_audio/i.test(url) ? "dash-audio"
        : /v\.redd\.it.*DASH_/i.test(url) ? "dash-video"
        : /\.(mp4|mov|m4v|webm)(\?|#|$)/i.test(url) ? "video"
        : "image",
      url
    })));
    if (dashGroups && dashGroups.size) {
      console.log(`[reddit] ${dashGroups.size} DASH group(s) — merge with:`);
      console.log(`  ffmpeg -i video.mp4 -i audio.mp4 -c copy out.mp4`);
    }
    return urls;
  };

  // ---------- Scrolling for feed pages ----------
  const scrollAndCollect = async ({
    maxScrolls = 40, scrollDelay = 1000, settleDelay = 1500, mode = 'all'
  } = {}) => {
    const found = new Set();
    const add = () => collect(mode).urls.forEach(u => found.add(u));
    add();
    let lastH = 0, stagnant = 0;
    for (let i = 0; i < maxScrolls; i++) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await sleep(scrollDelay);
      add();
      const h = document.body.scrollHeight;
      if (h === lastH) stagnant++; else stagnant = 0;
      lastH = h;
      if (stagnant >= 4) break;
    }
    await sleep(settleDelay);
    add();
    return [...found].sort((a, b) => scoreUrl(b) - scoreUrl(a));
  };

  // ---------- Download primitives ----------
  const triggerBlobDownload = (blob, filename) => {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 7000);
  };

  // Status taxonomy returned by download():
  //   'completed'    — bytes were fetched and an <a download> click fired,
  //                    so the browser is committed to writing the file.
  //   'opened-in-tab'— we could not fetch the bytes (blob: URL or CORS
  //                    blocked) and opened the source in a new tab as a
  //                    last resort. The browser may or may not save anything,
  //                    and popup-blocking kills the SECOND such call onwards.
  //   'failed'       — HLS stitch or some other hard error; nothing was
  //                    triggered. Includes a `reason` string for the caller.
  const download = async (url, filename) => {
    url = clean(url);
    if (/\.m3u8(\?|#|$)/i.test(url)) {
      try {
        const blob = await stitchHls(url);
        triggerBlobDownload(blob, filename.replace(/\.[^.]+$/, '') + '.ts');
        return { status: 'completed', filename };
      } catch (e) {
        console.warn('HLS stitch failed:', e);
        return { status: 'failed', filename, reason: `HLS stitch: ${e && e.message || e}` };
      }
    }
    if (url.startsWith('blob:')) {
      console.warn('Blob URL — opening in new tab:', url);
      window.open(url, '_blank');
      return { status: 'opened-in-tab', filename, reason: 'blob URL — cannot be fetched programmatically' };
    }
    // Try in order: credentialed, anonymous, open-in-tab.
    // Credentialed is needed for signed CDN URLs (fbcdn, cdninstagram);
    // anonymous works for permissive CDNs (pinimg) where credentials would
    // require Access-Control-Allow-Credentials: true; tab is the last resort
    // for CDNs that send no CORS headers at all (e.g. media.licdn.com).
    const fetchAttempts = [
      { credentials: 'include', mode: 'cors' },
      { credentials: 'omit',    mode: 'cors' }
    ];
    let lastErr = null;
    for (const init of fetchAttempts) {
      try {
        const res = await fetch(url, init);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        triggerBlobDownload(await res.blob(), filename);
        return { status: 'completed', filename };
      } catch (e) { lastErr = e; }
    }
    console.warn('All fetches failed (CDN sends no CORS headers). Opening in new tab — right-click → Save image as:', url);
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    return {
      status: 'opened-in-tab', filename,
      reason: `fetch blocked (${lastErr && lastErr.message || 'CORS'}) — opened in new tab`,
    };
  };

  // ---------- Public API ----------
  const run = async ({
    mode = 'auto',
    target = 'auto',
    all = false,
    maxScrolls = 40, scrollDelay = 1000, settleDelay = 1500,
    limit = Infinity,
    prefix = location.hostname.replace(/^www\./, ''),
    delayBetweenDownloads = 500
  } = {}) => {
    const urls = all
      ? await scrollAndCollect({ maxScrolls, scrollDelay, settleDelay,
                                  mode: mode === 'auto' ? 'all' : mode })
      : list(mode);
    const eligibleUrls = filterUrlsForTarget(urls, target);
    const selected = eligibleUrls.slice(0, limit);
    console.log(`[SMD] downloading ${selected.length} of ${eligibleUrls.length} target-matching URLs`);
    // Track per-status counts so the calling tool can report honestly to
    // the agent. Before this we returned only the URL list, which made it
    // look like a 713-URL run completed 713 downloads when in practice
    // popup-blocking kills the new-tab fallback after the first hit.
    const stats = {
      triggered: selected.length,
      completed: 0,
      completedVideo: 0,
      openedInTab: 0,
      failed: 0,
      failures: [], // first ~5 failures only — keeps payload small
    };
    let i = 1;
    for (const url of selected) {
      const isVideo = isVideoDownloadUrl(url);
      const ext = getExt(url) || (isVideo ? '.mp4' : '.jpg');
      const filename = `${filenameSafe(prefix)}_${isVideo ? 'video' : 'photo'}_${String(i).padStart(3, '0')}${ext}`;
      let r;
      try {
        r = await download(url, filename);
      } catch (e) {
        r = { status: 'failed', filename, reason: (e && e.message) || String(e) };
      }
      if (r.status === 'completed') {
        stats.completed++;
        if (isVideo) stats.completedVideo++;
      } else if (r.status === 'opened-in-tab') {
        stats.openedInTab++;
        if (stats.failures.length < 5) stats.failures.push({ filename, url, reason: r.reason });
      } else {
        stats.failed++;
        if (stats.failures.length < 5) stats.failures.push({ filename, url, reason: r.reason });
      }
      await sleep(delayBetweenDownloads);
      i++;
    }
    console.log(`[SMD] done. completed=${stats.completed} opened-in-tab=${stats.openedInTab} failed=${stats.failed}`);
    return { urls: selected, stats };
  };

  // single() now uses main-content mode and returns the top item.
  // Returns just the URL array (not {urls, stats}) to keep the DevTools-
  // console contract documented at the top of this file.
  const single = async opts => {
    const r = await run(Object.assign({ mode: 'main', limit: 1 }, opts || {}));
    return r && r.urls ? r.urls : r;
  };

  return {
    run, single, list, scrollAndCollect,
    // MSE recorder (v4). Arm BEFORE the player loads:
    //   SocialMediaDownloader.armMseRecorder()
    //   <reload the page>
    //   <play the video>
    //   await SocialMediaDownloader.saveMse()
    armMseRecorder, getMseRecording, saveMse,
    // Exposed for debugging/inspection:
    _collect: collect,
    _activeProfile: activeProfile,
    _profiles: SITE_PROFILES,
    _stitchHls: stitchHls,
    _parseHlsMediaPlaylist,
    _decryptAes128Cbc,
    _ivFromSequence,
    _hexToBytes,
    _extractYoutubeProgressive,
    _buildRecommendation,
    _filterUrlsForTarget: filterUrlsForTarget,
    _groupRedditDash: groupRedditDash,
    _preferHighQuality: preferHighQuality
  };
})();

// Auto-arm the MSE recorder on hosts where social-media playback uses
// MediaSource Extensions. Fires once per realm — re-injection on the
// same page is a no-op because armMseRecorder() checks for __smd_patched
// flags on the prototype methods before re-wrapping. The big win comes
// when SMD is registered as a content_script at document_start: patches
// are installed before the page's player ever calls addSourceBuffer,
// so the init segment is captured and saveMse() produces playable bytes.
const _SMD_MSE_AUTOARM_HOSTS =
  /(?:^|\.)(?:facebook|fb|instagram|x|twitter|linkedin|reddit|youtube)\.com$|(?:^|\.)youtu\.be$/i;
try {
  if (_SMD_MSE_AUTOARM_HOSTS.test(location.hostname)) {
    SocialMediaDownloader.armMseRecorder();
  }
} catch (_) { /* never block on auto-arm */ }

// Log once per realm. Re-injection on the same page (which happens every
// time the chrome extension calls the download_social_media tool) used
// to spew the multi-line banner repeatedly — annoying noise on heavily
// used hosts where the prelude content_script ALSO loads us at document
// start. Now you see it once.
if (!window.__smd_logged) {
  window.__smd_logged = true;
  console.log(
    '%cSocialMediaDownloader v4 loaded.',
    'color:#0a0;font-weight:bold;font-size:14px'
  );
  console.log(`Site profile: ${SocialMediaDownloader._activeProfile().name}
  await SocialMediaDownloader.run()           // smart default
  await SocialMediaDownloader.single()        // just the main item
  await SocialMediaDownloader.run({ all:true }) // scroll & grab everything
  SocialMediaDownloader.list()                // list only, no download

For MSE/blob: videos (FB, IG reels, X amplify, LinkedIn) — on supported
hosts the extension auto-arms us at document_start, so just play the
video then call saveMse(). On other hosts:
  SocialMediaDownloader.armMseRecorder()
  <reload, then play the video>
  SocialMediaDownloader.getMseRecording()     // inspect captured buffers
  await SocialMediaDownloader.saveMse()       // download captured bytes

Reddit videos download video + audio separately. Merge with:
  ffmpeg -i video.mp4 -i audio.mp4 -c copy out.mp4`);
}
