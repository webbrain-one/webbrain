/**
 * Site Adapters — per-site notes the agent receives when operating on a
 * known high-traffic site. The goal is NOT to encode every selector (those
 * rot fast), but to capture the non-obvious quirks that cost an LLM several
 * dead-end tool calls to discover on its own.
 *
 * Each adapter:
 *   - match(url): boolean — does this adapter apply to the current URL?
 *   - name: short identifier
 *   - category: 'general' | 'finance' — finance gets an extra safety warning
 *   - notes: short bulleted guidance, injected into the first user message
 *
 * Keep notes SHORT (4–8 bullets max). They cost tokens on every first turn.
 * Only encode things the model can't trivially figure out from reading the page.
 *
 * Stale adapters are worse than missing ones. If a note says "click X" and X
 * has been renamed, the model will trust the note and fail. When in doubt,
 * describe the SHAPE of the page rather than literal selectors.
 */

/**
 * Universal guidance injected into the first user message on every
 * conversation when site adapters are enabled. Covers two patterns that
 * appear on a huge fraction of the public web and are NOT intuitive for
 * LLMs: consent banners (which block interaction and get summarized as
 * page content) and paywalls (which invite the agent to bypass them).
 *
 * Kept deliberately short — this costs tokens on every new conversation.
 * If you add more universal guidance, audit the total size first.
 */
export const UNIVERSAL_PREAMBLE = `[Universal guidance — cookie banners & paywalls]
COOKIE / CONSENT BANNERS (OneTrust, Didomi, Cookiebot, Quantcast, Google Funding Choices, TrustArc, etc.) often open on top of page content and must be dismissed before anything else works.
- Priority: click({text: "Reject all"}) > "Reject non-essential" / "Only necessary". Use click({text}) — selectors churn; labels are stable.
- If only "Accept all" / "I agree" is exposed at the top level, click it to unblock the task. Do NOT dig into "Manage preferences" / "Customize" / "Show details" — it's a token sink and usually a dark-pattern dead-end.
- After dismissing, re-screenshot or call read_page before reasoning about the page. Do NOT describe the banner text as if it were page content.

PAYWALLS / SIGN-IN WALLS. Signals: "Subscribe to continue", "X free articles remaining", a gray/blurred overlay on the body, a fade-out on the text, a sign-in wall mid-article, very short article body followed by a signup form.
- STOP and surface the paywall to the user. Report what's actually visible (headline, dek, first paragraphs).
- DO NOT attempt to bypass: no archive.today / archive.org / 12ft.io, no cookie/localStorage clearing, no disabling JS, no reader-mode tricks, no copy-from-print-view. These are circumvention and not supported.
- Offer alternatives: (a) search freely available sources for the same story, (b) ask whether the user has a subscription account to sign in with.
- Never claim to have read the full article when only the preview was available.

PDF TABS. If the active tab URL ends in .pdf (or is opened in the browser's built-in PDF viewer), DO NOT use read_page / click / get_accessibility_tree / get_interactive_elements / scroll / screenshot — the PDF viewer is a privileged page our content scripts cannot reach, so those tools either silently no-op or hit the viewer chrome (sidebar, page-number input) and you'll loop. Use \`read_pdf\` instead, which fetches the PDF binary and extracts text directly. By default it returns up to 50 pages / 50,000 chars; pass \`fromPage\`/\`toPage\` to read further.`;

const ADAPTERS = [
  // ─── Code & Dev Tools ─────────────────────────────────────────────────
  {
    name: 'github',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?github\.com\//.test(url),
    notes: `
- Creating a release: navigate to /<owner>/<repo>/releases/new (not /releases). The tag selector is a combobox labeled "Choose a tag" — click({text: "Choose a tag"}) to open it, then type the tag name into the focused popup, then click({text: "Create new tag"}) to confirm.
- DO NOT use index-based clicks on the release page. GitHub's global header pollutes the index space and the release form is deep in the DOM. Always use click({text:"..."}) for buttons. Specifically: never click element #38 from memory — that's a learned anti-pattern from training data, and on the live site #38 is the "Pull requests" header link that navigates away from the release form.
- Release body is a CodeMirror editor, not a textarea. Click the editor surface (click({text:"Describe this release"}) on the placeholder works) then type with no selector.
- The green "Publish release" button is at the bottom of the form. Click it with click({text: "Publish release"}). The gray "Save draft" is right next to it — don't confuse them.
- EDITING an existing release (URL pattern /<owner>/<repo>/releases/edit/<tag>): binaries attach via the "Attach binaries" area below the body editor. This Firefox build has NO file-upload tool — you cannot attach the file yourself, so ask the user to drag the binaries onto that area (or click it and pick them) manually; you can still help with everything else on the page. The commit button is green and says "Update release"; the uploads are discarded if the user navigates away without clicking it.
- Files in a /tree/.../<folder> view (e.g. /tree/main/dist) can be downloaded via raw URLs of the form https://github.com/<owner>/<repo>/raw/<branch>/<path>. Once downloaded, the file is on local disk; do not re-download to "verify".
- Issue/PR comments use the same CodeMirror editor; markdown preview is on a separate tab.
- File browser: pressing "t" opens the fuzzy file finder (faster than navigating folders).
- Settings/admin actions often require re-entering the repo name as a confirmation — read the modal carefully.`,
  },
  {
    name: 'gitlab',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?gitlab\.com\//.test(url),
    notes: `
- Releases live at /<group>/<project>/-/releases/new. Tag must exist or be created via "Create tag" inline.
- Merge requests have a "Merge" button that may be disabled until pipelines pass; check the pipeline status before clicking.
- The sidebar collapses on narrow viewports — scroll horizontally or expand it before clicking sidebar items.`,
  },
  {
    name: 'stackoverflow',
    category: 'general',
    match: (url) => /^https?:\/\/(.*\.)?stackoverflow\.com\//.test(url) || /^https?:\/\/(.*\.)?stackexchange\.com\//.test(url),
    notes: `
- Answers are sorted by votes by default; the accepted answer has a green check and may not be the highest-voted.
- The question body and each answer have separate edit histories — link to "edited" timestamps for provenance.
- Code blocks use 4-space indentation OR triple-backtick fences. When extracting code, preserve indentation exactly.`,
  },
  {
    name: 'hackernews',
    category: 'general',
    match: (url) => /^https?:\/\/news\.ycombinator\.com\//.test(url),
    notes: `
- Comments are nested via indentation (the "indent" image's width tells you the depth). To find the top-level reply chain for a comment, walk back to the matching depth.
- "More" link at the bottom of comment pages loads the next page — the URL has a "next" token, not a numeric page.`,
  },

  // ─── Communication & Productivity ─────────────────────────────────────
  {
    name: 'gmail',
    category: 'general',
    match: (url) => /^https?:\/\/mail\.google\.com\//.test(url),
    notes: `
- Composing: the "Compose" button opens a floating window. The "To" field is a contact picker — type the name and pick from the dropdown, don't just type the raw email.
- The body is a contenteditable div (rich text), not a textarea. Click into it before typing.
- Sending: the "Send" button is bottom-left of the compose window; "Send + Schedule" arrow is next to it for scheduled send.
- Search uses operators: from:, to:, subject:, has:attachment, before:YYYY/MM/DD.
- Threads collapse old messages — click "Show trimmed content" or the message header to expand.`,
  },
  {
    name: 'google-docs',
    category: 'general',
    match: (url) => /^https?:\/\/docs\.google\.com\/document\//.test(url),
    notes: `
- The document body is a canvas-rendered editor (NOT a normal contenteditable). Direct DOM typing usually fails. Use the floating textbox that appears when you click into the doc, or use keyboard shortcuts.
- Comments are in the right margin; click the comment icon to open the comment panel.
- Real-time collaboration means the cursor and text shift while you read. Re-read after a delay if a write seems lost.`,
  },
  {
    name: 'google-calendar',
    category: 'general',
    match: (url) => /^https?:\/\/calendar\.google\.com\//.test(url),
    notes: `
- Creating an event: click an empty time slot OR press "c". A popover appears with title, time, guests.
- Guests field is a contact picker; type the name and pick from the dropdown.
- "More options" expands to the full event editor. The "Save" button asks about notifying guests — read the modal.
- View switching: 1=day, 2=week, 3=month, 4=year, 5=schedule, 6=4-day.`,
  },
  {
    name: 'slack',
    category: 'general',
    match: (url) => /^https?:\/\/app\.slack\.com\//.test(url) || /\.slack\.com\//.test(url),
    notes: `
- Slack is a heavily virtualized scroll list — messages off-screen aren't in the DOM. Scroll to load more.
- The message composer is a contenteditable; @mentions and #channels open a picker that requires keyboard selection.
- Threads open in a side panel; replying in a thread is different from replying in the channel.
- "Send" is implicit on Enter (Shift+Enter for newline). To pre-select "Send to channel and reply", check the box first.`,
  },
  {
    name: 'notion',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?notion\.so\//.test(url),
    notes: `
- Every block is a separate contenteditable. Pressing Enter creates a new block; "/" opens the slash menu for block types.
- Drag handles appear on hover at the left edge. Selection across blocks works with shift-click.
- Database views (tables, boards, calendars) are virtualized — rows off-screen aren't in the DOM. Use the search inside the database to filter, don't try to scroll through everything.
- Page properties (title, status, etc.) are at the top above the body and use their own widgets.`,
  },
  {
    name: 'jira',
    category: 'general',
    match: (url) => /\.atlassian\.net\//.test(url),
    notes: `
- Issue keys (PROJ-123) are everywhere — clicking them opens the issue in a side panel or new view.
- Status changes go through a workflow dropdown that may have intermediate states. Read the available transitions before clicking.
- The description editor is a rich-text editor with its own toolbar. Markdown shortcuts work but don't render until you blur.
- JQL search is at /issues/?jql=... — much more powerful than the basic search bar.`,
  },

  // ─── Social & Content ─────────────────────────────────────────────────
  {
    name: 'twitter',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//.test(url),
    notes: `
- The composer is a contenteditable, not a textarea. Character count is enforced client-side at 280 (or higher for Premium).
- The timeline is virtualized — tweets scroll out of the DOM. To find a specific tweet, use search, don't scroll.
- "Reply", "Retweet", "Like" icons are below each tweet; the share menu has "Copy link" for permalinks.
- Quote tweets vs reposts: the retweet icon opens a menu with both options.`,
  },
  {
    name: 'linkedin',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?linkedin\.com\//.test(url),
    notes: `
- LinkedIn aggressively lazy-loads everything; scroll to populate the feed/profile, but most content lives in modal-style detail panes.
- "Connect" button on profiles often has a "Send without a note" prompt — read it before clicking.
- Messages are at /messaging — the message composer is a contenteditable with image/file upload icons.
- In Messaging, after filling the composer, the reliable send path is usually Enter. If the composer footer says "Press Enter to Send" or the send-options popover shows "Press Enter to Send", call press_keys({key:"Enter"}) from the composer. Do NOT keep scrolling to find a Send button that is already visible/implicit.
- The three-dot / send-options control near the composer opens send preferences ("Press Enter to Send" vs "Click Send"); it is not the Send action. If you opened that popover by mistake, choose/keep "Press Enter to Send", close it if needed, then press Enter to send the focused composer.
- Search has filters (People, Posts, Jobs, Companies) as tabs at the top.`,
  },
  {
    name: 'reddit',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.|old\.|new\.)?reddit\.com\//.test(url),
    notes: `
- Prefer old.reddit.com — its DOM is simpler and easier to automate. If you land on www.reddit.com or new.reddit.com, navigate to the old.reddit.com equivalent first (swap the subdomain, keep the path).
- old.reddit.com and new.reddit.com have completely different DOMs. Check the URL before assuming selectors.
- Comments are nested deeply; "load more comments" links require clicking to expand.
- Voting requires being logged in; the up/down arrows are siblings of each post/comment.
- Post composer: title, body (markdown editor), flair selector. "Submit" button is at the bottom.`,
  },
  {
    name: 'youtube',
    category: 'general',
    match: (url) => /^https?:\/\/((www|m)\.)?youtube\.com\//.test(url) || /^https?:\/\/youtu\.be\//.test(url),
    notes: `
- The video player is a custom element. Keyboard shortcuts: space=play/pause, k=play/pause, j/l=±10s, ←/→=±5s, m=mute.
- For questions about the current video's content, use any available transcript skill tool first (for example \`read_youtube_transcript\` from FreeSkillz) and ground the answer in it. Transcript skill tools do not require \`/allow-api\`. If no transcript skill tool is available, or it fails or returns no text, say the transcript tool was unavailable and fall back to visible title/description/comments.
- Fallback transcript UI path: get_accessibility_tree({filter:"visible"}) → expand description ("..." / "more") with click_ax/click → click "Show transcript" → read the transcript panel with get_accessibility_tree or read_page; scroll the panel/page for more segments.
- Do NOT invent transcript URLs, and do NOT use fetch_url for YouTube captions. Use an available transcript skill tool or the visible transcript UI.
- If a transcript skill response has has_more_text=true, continue with text_offset=next_text_offset until you have enough transcript evidence for the task.
- Transcript text is timestamped/segmented and may be auto-generated or auto-translated; collect enough segments before summarizing or answering, and do not infer from the title alone when transcript is reachable.
- Comments load lazily AFTER you scroll past the video — they're not in the initial DOM.
- The subscribe button has a bell icon next to it for notification preferences; they're separate clicks.`,
  },
  {
    name: 'medium',
    category: 'general',
    match: (url) => /^https?:\/\/(.*\.)?medium\.com\//.test(url),
    notes: `
- Member-only articles show a paywall partway through — the agent sees "Read more" or a sign-up gate, not the full text.
- The clap button increments per click up to 50; long-press equivalent is multiple clicks.
- Highlights are inline annotations; hovering text shows the highlight popover.`,
  },
  {
    name: 'substack',
    category: 'general',
    match: (url) => /\.substack\.com\//.test(url),
    notes: `
- Most posts are public; some are paywalled mid-article. If the content suddenly stops with a "Subscribe" CTA, that's a paywall, not the end.
- Comments live below the article in a separate thread component.
- Subscribe button is a popup form — needs an email and may require email confirmation.`,
  },
  {
    // WordPress matcher is host-agnostic — self-hosted WP runs on millions
    // of domains. We trigger on the admin/login paths, which are
    // standardized across virtually every WP install.
    name: 'wordpress',
    category: 'general',
    match: (url) => /^https?:\/\/[^/]+\/(wp-admin|wp-login\.php)(\/|$|\?)/.test(url),
    notes: `
- "My API key" on WordPress is AMBIGUOUS. The two common meanings:
    (a) a WP REST API *application password* — per-user, lives at Users → Profile → "Application Passwords" panel (URL contains \`profile.php\`). This is the most common interpretation of "my WordPress API key".
    (b) a *plugin-specific* key (Rank Math Content AI, Jetpack, Akismet, WP Mail SMTP, etc.) — lives in that plugin's own settings page.
  If the user said "my API key" without naming a plugin, prefer (a) and read Users → Profile first. Don't pattern-match on plugin names just because they have "AI" or "API" in them. If both (a) and Application Passwords exist AND the site has multiple plugin keys, call \`clarify\` once to ask the user which they mean.
- Don't blindly click \`index: 0\` in /wp-admin/. The first interactive element on every admin page is a skip-to-content link, localized per-user — "Skip to content", "Ana içeriğe git", "Saltar al contenido", "Перейти к содержимому", "コンテンツへスキップ", etc. Clicking it never changes meaningful state. If a \`click({text:...})\` returns "Ambiguous text match", read \`candidates\` and pick the one whose \`tag\`/\`ancestor\` matches your intent.
- Two navigation surfaces: top admin bar (horizontal, near the very top) is shortcuts; left sidebar (vertical) is the primary menu. Sidebar items have hover-expanded sub-items. If you need a sub-item that isn't visible, hover the parent via \`click_ax\` first, then re-fetch the a11y tree.
- Plugin settings pages put the relevant value on the page directly — once you've navigated there, call \`read_page\` or \`get_accessibility_tree\` BEFORE clicking any sub-link or sub-tab. Don't keep navigating "to find the right page" — you're usually already there.
- For a simpler/old post editor, prefer URL shortcuts before hunting through Gutenberg: \`/wp-admin/post-new.php?classic-editor\` for new posts, or \`/wp-admin/post.php?post=<id>&action=edit&classic-editor\` for existing posts. This only opens Classic Editor when the plugin/site supports it; if WordPress still opens the block editor, continue in the current UI. Never treat GET URLs as a way to create/publish content — saving/publishing still requires the page's form or REST flow with nonce/capability checks.
- Localized labels (Turkish examples): Yazılar=Posts, Sayfalar=Pages, Eklentiler=Plugins, Ayarlar=Settings, Kullanıcılar=Users, Profil=Profile, Genel Ayarlar=General Settings, Başlangıç/Pano=Dashboard. Match on URL paths (\`profile.php\`, \`users.php\`, \`options-general.php\`, \`plugins.php\`, \`admin.php?page=...\`) rather than visible text when the site is in a non-English language.
- Login pages (\`wp-login.php\`) have a stable shape: \`#user_login\` (username/email), \`#user_pass\` (password), \`#wp-submit\` (submit). The password field is type=password — when the user provides credentials, do not echo them in any summary.`,
  },

  // ─── Commerce ─────────────────────────────────────────────────────────
  {
    name: 'amazon',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.|smile\.)?amazon\.(com|co\.uk|de|fr|ca|com\.au|co\.jp|in|com\.br|com\.mx|es|it|nl|pl|se|sg|ae|sa|com\.tr)\//.test(url),
    notes: `
- "Add to Cart" and "Buy Now" are different — "Buy Now" skips the cart and goes straight to checkout. Be very careful which one you click.
- Product variants (size, color) are buttons above the price; selecting them changes the URL and price.
- Reviews are paginated and may be filtered by stars; the "Top reviews" tab is the default.
- Subscribe & Save dropdown defaults to a recurring delivery — uncheck it if the user wants a one-time purchase.`,
  },

  // ─── Cloud Consoles & Infra ───────────────────────────────────────────
  {
    name: 'aws',
    category: 'general',
    match: (url) => /^https?:\/\/.*\.console\.aws\.amazon\.com\//.test(url) || /^https?:\/\/console\.aws\.amazon\.com\//.test(url),
    notes: `
- The region selector is in the top-right and persists in the URL — many resources are region-scoped, so check before searching.
- Service search: press "/" or click the top-left "Services" menu.
- Most "Create" actions span multi-page wizards. Don't click "Next" without reading; defaults often cost money (e.g. NAT gateways, larger instance sizes).
- Tags are usually on the last wizard page and easy to skip — they matter for billing.
- Deletion typically requires typing the resource name as confirmation.`,
  },
  {
    name: 'gcp',
    category: 'general',
    match: (url) => /^https?:\/\/console\.cloud\.google\.com\//.test(url),
    notes: `
- The project selector is in the top bar — every action is project-scoped. Confirm the project before doing anything destructive.
- The hamburger menu (top-left) hides most services; pinning frequently-used ones helps.
- Cloud Shell (top-right terminal icon) gives a real shell with gcloud preinstalled — often faster than the GUI for batch ops.
- Many services prompt to enable an API on first use; that's a one-time click but takes 30+ seconds to propagate.`,
  },
  {
    name: 'cloudflare',
    category: 'general',
    match: (url) => /^https?:\/\/dash\.cloudflare\.com\//.test(url),
    notes: `
- Account-level vs zone-level: the left sidebar changes depending on whether you're inside a specific domain or at the account root.
- DNS records: the "Proxy status" toggle (orange cloud / gray cloud) controls whether traffic routes through Cloudflare. Toggling it can break SSL or routing.
- Page rules and Rulesets are different systems; new sites should use Rulesets.`,
  },
  {
    name: 'vercel',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?vercel\.com\//.test(url),
    notes: `
- Deployments live under each project. The "Production" tab vs "Preview" tab matters — promoting a preview to prod is a separate action.
- Environment variables are scoped to environments (Production, Preview, Development); changing one doesn't auto-redeploy.
- The team selector is in the top-left, separate from the project selector.`,
  },

  // ─── News Paywalls ────────────────────────────────────────────────────
  // For each of these, full article bodies are subscription-gated. The
  // universal paywall note already says "don't bypass" — these adapters
  // are here to (1) set expectations early so the agent doesn't chase
  // "Continue reading" buttons that lead to signup walls, and (2) name
  // the specific framework so users see a sensible "this is paywalled"
  // message instead of a confused summary of a signup CTA.
  {
    name: 'nytimes',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?nytimes\.com\//.test(url),
    notes: `
- NYT is a subscription publication. Most articles are paywalled after the first 2-3 paragraphs. A sign-in wall may appear as a full-page takeover.
- Cookie banner: "Continue" / "Manage Privacy Preferences" — click Continue to dismiss.
- DO NOT attempt paywall bypass. Report what's visible and offer alternatives (AP/Reuters wire coverage of the same story is usually free).
- Games (Wordle, Connections, Mini Crossword) have their own subsections; progress requires a free NYT account.`,
  },
  {
    name: 'wsj',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?wsj\.com\//.test(url),
    notes: `
- WSJ is a subscription publication. Most articles show a short preview then a subscriber wall.
- The article URL sometimes contains "?mod=…" tracking params — strip them if sharing a link.
- DO NOT attempt paywall bypass. Report what's visible and offer: (a) search freely available coverage of the same story, (b) ask the user to sign in if they have a subscription.`,
  },
  {
    name: 'ft',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?ft\.com\//.test(url),
    notes: `
- Financial Times is a metered subscription publication — a handful of free articles per month, then a hard paywall.
- Some articles are marked "Free to read" (look for a small label near the headline); those are fully available.
- DO NOT attempt paywall bypass. If the article is gated, surface the paywall to the user and offer alternatives.`,
  },
  {
    name: 'bloomberg',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?bloomberg\.com\//.test(url),
    notes: `
- Bloomberg articles are paywalled; free users see a short preview and a gray fade-out before the signup wall.
- Bloomberg's bot check occasionally interposes a CAPTCHA before the article — if you hit it, STOP and tell the user rather than trying to solve it.
- DO NOT attempt paywall bypass. Offer alternatives (Reuters, AP usually cover the same market stories freely).`,
  },
  {
    name: 'economist',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?economist\.com\//.test(url),
    notes: `
- The Economist is a subscription publication. Most articles show the first paragraph then a subscriber wall.
- "1843 Magazine" and some opinion pieces are free — others aren't.
- DO NOT attempt paywall bypass. Surface the paywall and offer to summarize from freely available coverage.`,
  },
  {
    name: 'washingtonpost',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?washingtonpost\.com\//.test(url),
    notes: `
- Washington Post is a metered subscription publication. After the free article limit, a hard paywall replaces the article body.
- Cookie banner is a full-screen consent dialog with clear Accept/Reject options — dismiss first.
- DO NOT attempt paywall bypass. Report what's visible and offer alternatives.`,
  },

  // ─── Finance / High-Stakes ────────────────────────────────────────────
  {
    name: 'stripe',
    category: 'finance',
    match: (url) => /^https?:\/\/(dashboard\.)?stripe\.com\//.test(url),
    notes: `
- LIVE vs TEST mode toggle is in the top-right. Always confirm which mode you're in before creating, refunding, or canceling anything. Live actions move real money.
- Refunds are partial-by-default in the input — check the amount carefully.
- Customer deletion is irreversible and detaches all their payment methods. The confirmation modal is easy to click through.
- API keys: the secret key is shown once on creation. Don't reveal it in screenshots or chat output.
- Subscription edits often have proration prompts ("Charge prorated amount immediately" vs "On next invoice") — read which is selected.
- PRODUCT CATALOG — CRITICAL: The product catalog page has CONFUSABLE buttons near each other. "Export prices" and "Export products" are NOT for creating products — NEVER click them when the task is to create a product. To create a product: (1) click the green "+ Create product" button, (2) the "Add a product" overlay form appears, (3) use get_interactive_elements to find the Name input field INSIDE THE FORM — it will be an input element near the top, (4) click that input, then type_text with no selector to enter the name, (5) scroll down to the "Pricing" section for price/interval, (6) click "Add product" to submit. IMPORTANT: after the form overlay opens, ONLY interact with elements inside the form. Do NOT click anything on the page behind the form.`,
  },
  // Site-specific finance adapters come BEFORE finance-generic.
  // getActiveAdapter returns the first match; finance-generic's regex
  // includes "coinbase" and "robinhood" as substrings, so if it sat
  // earlier it would shadow these site-specific adapters and the
  // high-stakes per-site guidance would never reach the model.
  {
    name: 'coinbase',
    category: 'finance',
    match: (url) => /^https?:\/\/(www\.|pro\.|exchange\.|accounts\.)?coinbase\.com\//.test(url),
    notes: `
- ⚠️ HIGH-STAKES — real crypto, real money. Trades and withdrawals are typically irreversible.
- Buy / Sell flows are 2-step: an entry screen (amount + asset + funding source) → a Review/Preview screen → an explicit Confirm. Never click Confirm without reading back the exact amount, asset, fees, and total to the user.
- The funding-source picker (USD wallet vs USDC vs linked bank vs card) changes fees materially — confirm which is selected before previewing.
- Recurring buy schedules can be toggled inside the buy flow; don't enable one unless the user explicitly asked for recurring.
- Sends to external wallets show the address and asked network — both must match what the user told you. If the network is wrong, the funds are lost. Read both fields back verbatim.
- Vault withdrawals carry a 48h delay window; signal this if relevant to the user's task.
- 2FA prompts (SMS, authenticator, hardware key) should be surfaced — never auto-approve.`,
  },
  {
    name: 'robinhood',
    category: 'finance',
    match: (url) => /^https?:\/\/(www\.)?robinhood\.com\//.test(url),
    notes: `
- ⚠️ HIGH-STAKES — real brokerage. Orders fill at market and are typically irreversible.
- Place Order is 2-step: Review → Submit. The Review screen is the last gate — read it back to the user (symbol, action, quantity, dollar amount, order type, time-in-force) before pressing Submit.
- Account switcher (top-left header) toggles between Brokerage / Cash / Margin / Crypto / Retirement — available symbols and orders differ per account. Confirm which is active before placing.
- Order entry has a $ vs # shares toggle. Fractional dollar amounts only work on supported symbols; the form silently rounds otherwise.
- Options trading is gated by approval level (Level 1–3). If the action is unavailable for the user's level, surface that, don't try to bypass.
- "Robinhood Gold" upsell modals interpose mid-flow on margin / advanced features — dismiss with the close X, don't sign up.
- Crypto orders on Robinhood Crypto are separate from stock orders; symbols are not transferable to external wallets without a withdrawal flow.`,
  },
  {
    name: 'tradingview',
    category: 'finance',
    match: (url) => /^https?:\/\/(www\.)?tradingview\.com\//.test(url),
    notes: `
- Charts render to <canvas>. get_accessibility_tree returns almost nothing useful for the chart surface itself — don't try to read prices off the chart by querying the tree.
- The Symbol info / "Details" panel on the right sidebar (and the watchlist in the top bar) DO surface readable data in the tree. Use those for price, ratio, fundamentals reads.
- "/" opens symbol search from anywhere. Type ticker, pick from the dropdown.
- Buy / Sell buttons trigger broker integration (Interactive Brokers, OANDA, etc.) via a side panel — they do NOT execute orders on TradingView itself. If the user said "buy", confirm which broker is connected and treat it as a high-stakes finance action (read order back).
- Alerts and indicators added to a chart persist per-layout; saving requires sign-in.
- Heavy keyboard culture: Alt+S save layout, Ctrl+, settings. If the model can't find a button, hint at the shortcut rather than searching forever.`,
  },
  {
    name: 'finance-generic',
    category: 'finance',
    // Catch-all for finance/banking/crypto domains we don't have a
    // site-specific adapter for. MUST be ordered AFTER the specific
    // finance adapters (stripe, coinbase, robinhood, tradingview) so
    // those win when both this regex and a specific match() return true.
    match: (url) => /^https?:\/\/[^\/]*(bank|banking|chase|wellsfargo|bankofamerica|citibank|hsbc|barclays|santander|bnp|deutsche|ubs|coinbase|binance|kraken|gemini\.com|bitstamp|bitfinex|crypto\.com|metamask|paypal|venmo|wise\.com|revolut|n26|monzo|robinhood|fidelity|schwab|vanguard|etrade|interactivebrokers|nordnet|degiro)\b/i.test(url),
    notes: `
- ⚠️ HIGH-STAKES SITE (financial / banking / crypto). Real money is at stake and many actions are irreversible.
- DO NOT initiate transfers, trades, payments, withdrawals, or balance changes without an EXPLICIT, SPECIFIC instruction from the user that names the destination and amount in this conversation. Vague instructions like "send some" or "buy a bit" are NOT sufficient.
- Always read confirmation modals carefully and read them back to the user before clicking the final confirm.
- If the user asks you to "check balance" or "show transactions", do that and stop. Don't proactively click action buttons.
- Wallet connect prompts, signature requests, and 2FA codes should be surfaced to the user — never auto-approve.`,
  },

  // ─── Travel ───────────────────────────────────────────────────────────
  {
    name: 'airbnb',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?airbnb\.[a-z.]+\//.test(url),
    notes: `
- Search "Where" field is a combobox — typing alone won't commit. Type a destination, then PICK the suggestion from the dropdown (set_field with submit:true + a re-read of the tree to confirm the chip appeared).
- Date pickers are custom calendar listboxes. Keyboard nav (arrow keys + Enter) is more reliable than clicking date cells.
- "Instant Book" auto-confirms; "Request to Book" needs host approval. Different finality — read the badge on the listing before clicking the primary CTA.
- Login wall appears the moment the user tries to view wishlists, hosting, or messages. Booking flow itself requires sign-in at the final step.
- The initially-shown nightly price excludes cleaning fee / Airbnb service fee / taxes — the breakdown only appears in the reservation review. Always confirm the TOTAL with the user before the final Confirm.
- "Specific dates" vs "Flexible" tabs — flexible search returns a different result shape; flag if the user said specific dates.`,
  },
  {
    name: 'booking',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?booking\.com\//.test(url),
    notes: `
- Urgency overlays ("X people are looking", "Only N rooms left at this price", "Booked 3 times in the last hour") are marketing, not constraints. Ignore them when summarizing for the user.
- Currency / language widget in the header changes displayed prices. Clicking it mid-flow can shuffle a comparison; check before changing.
- "Genius" loyalty discount applies only when signed in; the non-logged-in price shown is the ceiling. Mention if relevant.
- "Free cancellation" vs "Non-refundable" badges on each room option are critical. Read the badge before clicking Reserve — non-refundable saves money but locks the booking.
- Multi-room reservations require a separate guest-details form per room. Don't assume one form covers all.
- Search results have a sort dropdown ("Our top picks" by default — sponsored-influenced). For price-sensitive searches, switch to "Price (lowest first)".`,
  },
  {
    name: 'expedia',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?expedia\.[a-z.]+\//.test(url),
    notes: `
- Bundle flow (Flight + Hotel, Flight + Car, etc.) — the primary CTA label changes per step ("Continue" → "Choose flights" → "Select hotel" → "Reserve"). Read the current button text; don't memorize a single label.
- Filters live in a left rail that may be collapsed on narrow viewports — expand before reading.
- Loyalty program (One Key) discounts auto-apply at checkout if signed in. Verify the pre/post-loyalty total against what the user expected.
- Date picker is a custom calendar; type-then-tab usually doesn't commit. Click into the field, pick from the calendar grid (arrow keys + Enter work).
- "Book a trip" vs "Save for later" — the latter is a wishlist action, not a hold.
- Trip dashboard at /trips after a booking shows itinerary, change/cancel options. Cancellation rules vary per supplier.`,
  },
  {
    name: 'google-maps',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?google\.[a-z.]+\/maps/.test(url) || /^https?:\/\/maps\.google\.[a-z.]+\//.test(url),
    notes: `
- Search bar at top-left. Results panel slides out from the left when a search returns multiple places.
- Clicking a marker (or a result in the list) opens a place card. The "Directions" button is at the top of that card.
- Layer / traffic / satellite toggles live in a bottom-left rail and do not always surface in the AX tree — describe what should be on screen rather than insisting on tree-driven clicks. Coord clicks via screenshot may be necessary.
- Place details panel has multiple tabs (Overview, Reviews, Photos, About) — switch by clicking the tab label. Reviews lazy-load.
- "Send directions to your phone" requires Google sign-in.
- Sharing a place produces a /maps/place/... URL with a CID — that's the stable link. The current viewport URL with @lat,lng,zoom is not a place link.`,
  },
  {
    name: 'google-flights',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?google\.[a-z.]+\/(travel\/)?flights/.test(url),
    notes: `
- Date matrix and price calendar are partially canvas-rendered; the AX tree may show very little for that section. Use the visible row/column labels you CAN read, and quote dollar amounts only when they appear as DOM text.
- Origin / Destination / Dates are all comboboxes — type, then pick the matching dropdown entry. Without picking, the search doesn't commit.
- Filter chips (stops, airlines, times, bags) toggle inline; the URL may not reflect changes. To share a filtered search, copy the URL AFTER changing filters.
- "Track prices" toggle requires Google sign-in; surface this if the user asks to track.
- "Book on Expedia / Kayak / airline" buttons redirect to an OTA or airline site — that's a different adapter's territory. Flag the handoff to the user before clicking.`,
  },
  {
    name: 'kayak',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?kayak\.[a-z.]+\//.test(url),
    notes: `
- Aggregator, not a direct booker. The "View Deal" / "Book Now" button redirects to an OTA (Expedia, Priceline, etc.) or the airline directly. The actual booking happens off-Kayak.
- "Hacker Fares" combine two one-way tickets, often on different carriers. Confirm before the user purchases — the two legs are SEPARATE bookings with separate cancellation rules.
- Search Engine Results Page (SERP) clusters multiple booking options per itinerary — expand the cluster card to see all providers and prices.
- Anti-bot challenges fire on rapid filter changes or fast pagination — slow the pace (wait_for_stable between filter toggles) rather than power through.
- Price alerts require sign-in; "Hopper" predictions on price trends are advisory, not guarantees.`,
  },
  {
    name: 'opentable',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?opentable\.[a-z.]+\//.test(url),
    notes: `
- Search flow: party size + date + time → results show time-slot chips per restaurant. Click a time chip to enter the reservation flow.
- A reservation HOLD is created when the user clicks the time chip; final confirmation happens on the next screen. The hold expires (usually 5 min) — don't dawdle on the review page.
- Phone number is required for booking; some restaurants ask for credit-card hold (no-show charge).
- Cancellation policy varies per restaurant and per time — read the small print before confirming.
- "DiningPoints" earnings show in the confirmation screen; not all reservations earn points.
- Map view and List view toggle in the toolbar — list is easier for read-back.`,
  },

  // ─── E-commerce (beyond Amazon) ───────────────────────────────────────
  {
    name: 'ebay',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?ebay\.[a-z.]+\//.test(url),
    notes: `
- Listing format matters: Auction vs Buy-It-Now vs Best Offer — the primary buy button changes. "Place bid" is NOT the same as "Buy It Now".
- Bidding: enter your maximum bid (eBay auto-bids up to it). The confirm modal shows the actual current bid that will be placed, which may be lower than the max. Read both back to the user.
- "Watchlist" requires sign-in; "Add to cart" works without.
- Seller page URL pattern is /usr/<seller>; listing URL is /itm/<id>. Don't confuse them when navigating.
- Shipping cost may show as "Calculated" until a ZIP code is entered — set the ZIP before promising a total.
- Returns policies vary per seller (30 day, 60 day, no returns) — read the listing's Returns section before suggesting purchase.`,
  },
  {
    name: 'walmart',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?walmart\.com\//.test(url),
    notes: `
- Fulfillment selector (Pickup / Delivery / Shipping) sits at the top of search and product pages — switching it filters items and changes prices/availability. Confirm the user's intent before assuming.
- "Add to cart" appears in TWO mounts: search results card AND product detail page. They behave identically; either is fine.
- "Walmart+" subscription upsell fires mid-checkout with a "Free shipping with Walmart+" modal. Decline unless asked.
- Pickup / delivery slots require a ZIP code or saved address; "Find in store" inventory requires it too.
- Reviews and Q&A tabs lazy-load. Scroll into the section before reading.`,
  },
  {
    name: 'target',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?target\.com\//.test(url),
    notes: `
- Fulfillment toggle (Drive Up / Order Pickup / Shipping) — Drive Up is store curbside, Order Pickup is in-store, Shipping is delivery. The cart fields change per choice.
- "RedCard" prompts (5% discount on the Target credit/debit card) interpose mid-checkout. Decline unless explicitly asked.
- "Find in store" requires ZIP; results show per-store inventory and stock levels.
- "Target Circle" rewards offers may auto-apply at checkout if signed in. Verify the cart total reflects the rewards the user expected.
- Cart drawer slides in from the right after Add; main cart is at /cart.`,
  },
  {
    name: 'etsy',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?etsy\.[a-z.]+\//.test(url),
    notes: `
- Variations (size, color, style) live in a separate selector ABOVE Add to cart. If the listing has variations and they aren't picked, Add to cart is disabled. Click each variation dropdown, pick a value, before adding.
- Personalization text field appears for some listings (engraving, monogram, custom note). When marked required, you can't add to cart without filling it.
- "Add to cart" can appear on the listing page AND inside the cart drawer (when the drawer re-renders) — both work; treat them as the same action.
- Save for later (heart icon) requires sign-in.
- Sellers are independent shops; shipping/return policies vary per shop and are listed on the listing under "Shipping and return policies".
- Pre-orders / "Made to order" listings have a longer ship date — surface that to the user before buying.`,
  },

  // ─── Regional — Türkiye (TR) ──────────────────────────────────────────
  // Regional adapters are the project's #1 wanted contribution (CONTRIBUTIONS.md);
  // Türkiye is top of the priority list. Add more TR sites (trendyol,
  // hepsiburada, n11, getir, yemeksepeti) below as separate, focused entries.
  {
    name: 'sahibinden',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?sahibinden\.com\//.test(url),
    notes: `
- sahibinden is Türkiye's largest CLASSIFIEDS site (vehicles/"Vasıta", real estate/"Emlak", and general goods), NOT a checkout store. Most listings are "contact the seller", so do NOT hunt for a "Sepete Ekle"/Add-to-cart button on a typical car or property listing — the task is to read the listing and surface the seller's contact. "Mesaj Gönder" sends a message; the phone/"Cep" number is often revealed only after login.
- ANTI-BOT TRAP: sahibinden runs aggressive bot protection (DataDome). You may hit a security/verification wall — a page saying "Güvenlik kontrolü", "İşleminize devam edebilmek için...", a slider/CAPTCHA, or "Erişiminiz engellendi". If you see one, STOP and tell the user a security check is blocking automated access. Do NOT loop retrying navigations/fetches — repeated automated requests escalate the block.
- Do NOT re-fetch the same search/results URL repeatedly. The results list is already on the page; extract items from it (extract_data / get_accessibility_tree) before paginating. Re-running research_url/fetch_url on the same sorted URL (e.g. a "?...&sorting=..." or "?sd=..." variant) returns the same page and wastes steps.
- Filtering: filters live in the LEFT rail (price range, "İl"/"İlçe" = province/district location, date, and category-specific facets). Set the location filter for local results. Sort via the "Sıralama" dropdown (e.g. price ascending) rather than guessing URL params.
- Labels are Turkish: "Giriş Yap" = log in, "Üye Ol" = sign up, "İlan Ver"/"Ücretsiz İlan Ver" = post a listing, "Filtrele" = apply filters, "Sıralama" = sort.
- Posting an "İlan" requires login and a multi-step form; after submitting it appears under "İlanlarım" with a status such as "Onay Bekliyor" (pending approval) — it is NOT live immediately. Do not report it as published until the status shows it is active ("Yayında").`,
  },

  {
    name: 'apple',
    category: 'general',
    match: (url) => /^https?:\/\/((www\.)?apple\.com|secure\.store\.apple\.com)(\/|$)/.test(url),
    notes: `
- Product buying flow splits across marketing pages (/iphone, /mac, etc.) and store pages (/shop/buy-*). Use the visible "Buy" CTA to get to the configurable purchase page, then re-read the selected size/chip/storage/color before quoting a price.
- If the user is price-sensitive, check whether the current country/storefront offers Certified Refurbished (usually a footer/nav link or /shop/refurbished, localized under the country path). If available, compare the same product family and configuration for a lower price before recommending new; if the country does not expose refurbished inventory, say so and continue.
- Refurbished inventory is limited and not always the exact current model/configuration. Do not treat older generations, different chip tiers, storage, cellular, display size, or keyboard layout as equivalent without telling the user.
- Trade-in, carrier deals, financing, AppleCare+, and accessories can change the final total. Treat them as optional choices and confirm before adding them.
- Pickup/delivery availability depends on ZIP/postcode and selected configuration. Set location only when needed, and verify the bag total before checkout.`,
  },

  // ─── Productivity (gaps) ──────────────────────────────────────────────
  {
    name: 'outlook',
    category: 'general',
    match: (url) => /^https?:\/\/outlook\.(live|office)\.com\//.test(url) || /^https?:\/\/outlook\.office365\.com\//.test(url),
    notes: `
- Compose opens in either a side pane (default layout) or a popped-out window (if the user clicked "Pop out"). UI differs slightly — Send button location is top-right in the side pane, bottom in popped-out.
- To / Cc / Bcc are contact-picker fields. Type a name, pick from the dropdown — typing a raw email and pressing Enter usually works, but the picker is more reliable for contacts.
- "Focused" vs "Other" inbox tabs split incoming mail. The user's expected message may be in "Other" if it's from a new sender.
- Folder tree on the left collapses; expand the relevant folder before clicking conversations inside.
- Calendar integration: New > Calendar event (not Email) opens the event composer.
- Reply / Reply all / Forward buttons live at the top of the reading pane AND inline at the bottom of the most recent message; either works.`,
  },
  {
    name: 'google-sheets',
    category: 'general',
    match: (url) => /^https?:\/\/docs\.google\.com\/spreadsheets\//.test(url),
    notes: `
- The cell grid is canvas-rendered. get_accessibility_tree returns essentially nothing for cell content — the tree shows menus, toolbar, and the formula bar, but not the cells themselves. Do NOT try to "read the data" by querying the tree; that returns empty.
- The formula bar (visible in the tree, labeled by current cell) DOES expose the active cell's value. To READ a cell: click the cell first (keyboard arrows or a coordinate click on the visible grid), then read the formula bar.
- To WRITE a cell: click into the cell, type — input goes into the cell. Or click into the formula bar (in the tree) directly. Enter commits and moves down; Tab commits and moves right.
- For bulk reads / writes / formulas across many cells, the AX-tree path is too slow and brittle. Surface this to the user honestly: "Sheets cells are canvas-rendered; for bulk operations I can navigate cell-by-cell but you may want to do it yourself or paste a CSV." Don't pretend you can read a 100-row range fast.
- Menus (File, Edit, View, Insert, Format, Data, Tools, Extensions, Help) ARE in the tree — they're standard HTML menus. The toolbar (bold, color, sum, etc.) also surfaces.
- Ranges and named ranges: Data > Named ranges. The name box (left of the formula bar) jumps to a range.`,
  },
  {
    name: 'trello',
    category: 'general',
    match: (url) => /^https?:\/\/trello\.com\//.test(url),
    notes: `
- Board structure: lists (vertical columns) contain cards. drag_drop is the right tool to reorder cards inside a list OR move them between lists — there's no "Move to" button on the card by default (it's hidden in the card-detail menu).
- "Add a card" is an inline input at the bottom of each list. Click the "+ Add a card" placeholder, type the title, press Enter. Enter again to immediately start adding another card.
- Card detail opens in a modal overlay over the board. Edit description, add checklists/labels/dates from there. Close with Escape or the X — navigating away (e.g. clicking the board background) does NOT save unsaved description edits.
- Quick-edit (small pencil that appears on hover) lets you rename + label without opening the modal.
- Power-Ups (Butler, Calendar, custom-fields) are gated by workspace settings; if a feature is missing, it's not enabled.
- Search (top bar) returns boards, cards, and members across visible workspaces.`,
  },

  // ─── Social (gaps) ────────────────────────────────────────────────────
  {
    name: 'instagram',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?instagram\.com\//.test(url),
    notes: `
- Login wall pops mid-scroll on the home feed (/), Explore (/explore), and Reels (/reels). Without sign-in, beyond a handful of posts the user can't view anything — surface that, don't loop trying to scroll past.
- Story bar at top of profile / feed is keyboard-driven: left/right arrows advance, Esc closes. Clicking is unreliable.
- Profile grid (/<user>) lazy-loads via IntersectionObserver — scroll the page (not a sub-container) to load more posts.
- DMs at /direct/inbox — sign-in required.
- Hashtag pages: /explore/tags/<tag>. Location pages: /explore/locations/<id>.
- "Add to story / Add to post" actions require the mobile app for most content types — surface the limitation.
- Saving images / videos directly is blocked by the UI. If the user asks to download, use an enabled media download skill tool such as \`download_public_media\` first; otherwise use \`download_social_media\`.`,
  },
  {
    name: 'tiktok',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?tiktok\.com\//.test(url),
    notes: `
- "For You" feed swallows clicks that aren't on explicit buttons (Like, Comment, Share). Avoid coord-clicking inside the video area.
- Login required for comments, likes, follows, saves. Without sign-in, the user can watch but not interact.
- Video URL pattern: /@<user>/video/<id>. Profile pattern: /@<user>.
- Sidebar nav (For You / Following / Explore / Live) only visible at desktop widths; on narrow viewports it collapses behind a menu icon.
- "Watch History" requires sign-in and lives at /following.
- Downloading videos: use an enabled media download skill tool such as \`download_public_media\` first; otherwise use \`download_social_media\`.`,
  },
  {
    name: 'facebook',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.|m\.)?facebook\.com\//.test(url),
    notes: `
- PRIMARY use cases on Facebook web are Marketplace (/marketplace/) and Groups (/groups/<id>). The main news feed is heavily algorithmically personalized noise — don't try to "summarize the feed" usefully.
- Marketplace listings (/marketplace/item/<id>): contact seller is via Messenger ("Message" button); price + location + condition + description fields. Some sellers gate inquiries behind "Send" templates.
- Group pages: many groups are member-only — content is gated behind a "Join Group" request that requires admin approval (could take hours/days). If the user asks to read a group they aren't in, surface this rather than looping.
- Login wall fires aggressively across most non-public surfaces. Persistent cross-page nav loss — refresh resets the URL to the wall.
- "Sign in to continue" interstitials show even on PUBLIC pages once a few are viewed; rate-limit-ish.
- Messenger lives at messenger.com (separate domain) — different adapter territory.
- Notification bell and message inbox in the top bar; both require sign-in.`,
  },

  // ─── Coding Practice ──────────────────────────────────────────────────
  {
    name: 'leetcode',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?leetcode\.com\//.test(url),
    notes: `
- Problem layout: statement (markdown panel) on the LEFT, code editor (Monaco) on the RIGHT. The split is draggable but defaults to ~50/50.
- The code editor IS a Monaco instance, NOT a textarea. Click into the editor area, then type — input goes to the focused editor. set_field is overkill; click_ax to focus, then type_text with NO selector.
- Language selector dropdown at the top-left of the editor. Switching language WIPES the current code (no warning). Confirm with the user before switching if they wrote anything.
- "Run" button tests against the sample input shown below the editor; "Submit" runs against hidden test cases and counts toward stats.
- Premium problems show a lock icon. Without a Premium subscription, they cannot be opened — surface that, don't loop trying.
- "Solutions" tab below the editor reveals community solutions AFTER you submit (or for unsolved problems via a Premium tier).
- Daily Challenge at /problems/<slug> with the calendar widget at the top.`,
  },
  {
    name: 'hackerrank',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?hackerrank\.com\//.test(url),
    notes: `
- Practice/test environment layout: problem statement above (or left), Monaco code editor below (or right). Some tests have a timer at the top — DON'T navigate away mid-test (work is lost on some test configs).
- Language selector is on the right side of the editor toolbar. Switching language may or may not preserve code — confirm with the user.
- "Compile & Test" runs against custom input (a separate textarea below the editor); "Submit Code" finalizes against hidden cases.
- Multi-part problems (common in tests) have tabs at the top of the problem panel for each subproblem. Submissions are per-part.
- Test invitations land at /test/<id>. The Take Test button starts a timer that can't be paused.
- Login required for submissions and progress tracking. Anonymous users can read problems but not submit.`,
  },

  // ─── Job Portals ──────────────────────────────────────────────────────
  {
    name: 'greenhouse',
    category: 'general',
    // Greenhouse hosts ATS for many employers under boards.greenhouse.io
    // (or job-boards.greenhouse.io for the newer build).
    match: (url) => /^https?:\/\/(boards|job-boards)\.greenhouse\.io\//.test(url),
    notes: `
- Application URLs look like /<employer>/jobs/<id> with the apply form at /<employer>/jobs/<id>/applications/new.
- Form fields vary per employer but typically include: First name, Last name, Email, Phone, Resume (file upload), Cover letter (textarea), and a set of demographic / EEO questions (usually optional).
- Resume upload: input[type=file]. This Firefox build cannot attach files programmatically — ask the user to select the resume themselves. PDF is universally accepted; some employers also accept .docx.
- Cover letter is a plain textarea (not a rich editor). Click into it, type with no selector.
- "Apply" / "Submit Application" button at the bottom. Some employers add custom questions below the standard set — scroll the entire form before submitting.
- Each employer's customization can add required custom questions; an unanswered required field will block submit with an inline error.
- Application status / withdrawals are NOT visible on greenhouse — the candidate dashboard is hosted per-employer (often a separate URL provided in the confirmation email).`,
  },
  {
    name: 'workday',
    category: 'general',
    // Workday's tenant URLs are like myworkdayjobs.com or <company>.wd1.myworkdayjobs.com.
    match: (url) => /^https?:\/\/[^\/]*\.myworkdayjobs\.com\//.test(url) || /^https?:\/\/[^\/]*\.wd[0-9]+\.myworkdayjobs\.com\//.test(url),
    notes: `
- Workday is the most hostile of common ATS systems. Expect: heavy use of accordion panels, shadow DOM for some form fields, autosave between steps, and lots of "Continue" buttons that look the same.
- Multi-step application: each step is a separate route. Workday AUTOSAVES between steps, so "Save and Continue Later" works — but mid-step changes can be lost if you navigate via browser back. Always click the page's Continue / Save button explicitly.
- Many fields are nested in collapsed accordions (Education, Experience, References). EXPAND each accordion before reading or filling — collapsed required fields will fail validation but you can't see what's missing.
- Date pickers are custom widgets. Click the field, type MM/DD/YYYY (or DD/MM/YYYY depending on tenant locale), then Tab. Don't try to click calendar cells — the popup is portal-rendered outside the field's subtree.
- "Add Another" buttons for experiences / education clone the entire panel — fill the FIRST one fully before clicking Add Another, or the new clone may copy partial state.
- Some employers wrap Workday in an iframe — if get_accessibility_tree shows almost no form fields, check for an iframe and switch to iframe_read / iframe_type.
- File upload (resume, CV) lives in the "My Information" or "Resume/CV" step. The drop zone has a "Select Files" button — this Firefox build cannot attach files programmatically, so ask the user to pick the file themselves.
- "Review" step at the end shows everything filled — read it back to the user before clicking Submit; mistakes at this stage usually require restarting the whole application.`,
  },

  // ─── Messaging ────────────────────────────────────────────────────────
  {
    name: 'discord',
    category: 'general',
    match: (url) => /^https?:\/\/(www\.)?discord\.com\/(channels|app)/.test(url) || /^https?:\/\/(www\.)?discord\.com\/$/.test(url),
    notes: `
- Three-pane layout: Server list (icons, left-most rail) → Channel list (per-server, second rail) → Channel chat (main pane). Selecting a server reveals its channels; selecting a channel loads its message history.
- Channel URL pattern: /channels/<server_id>/<channel_id>. Direct messages live under /channels/@me/<dm_id>.
- Text channels are #-prefixed; voice channels have a speaker icon and join on click (don't click them unless the user asked to join voice).
- @mentions trigger an autocomplete dropdown — type @ + a few letters, pick from the list. Pinging the wrong person is a real social cost; verify the suggestion before submit.
- Slash commands (/, then command name); per-server bots add their own. The command list popup appears as you type /.
- Message input is a contenteditable div (rich text). Use set_field or click + type_text. Enter sends by default; Shift+Enter inserts a newline.
- Threads (replies branching from a message) live inside channels; opening one reveals a side pane.
- Reactions appear on hover for each message; the smiley + button on hover opens the emoji picker. Reveal-on-hover affordances — use \`hover\` if the model can't see the buttons.
- 2FA, security tokens, payment / Nitro flows should be surfaced to the user — high-stakes.`,
  },
  {
    name: 'whatsapp-web',
    category: 'general',
    match: (url) => /^https?:\/\/web\.whatsapp\.com\//.test(url),
    notes: `
- First-time setup REQUIRES the user to scan a QR code with their phone's WhatsApp app. The agent CANNOT scan a QR code — if the QR is on screen, surface it to the user and stop. Don't loop waiting for it to disappear.
- Once linked, layout is: conversation list on the LEFT (chats sorted by recency), active conversation on the RIGHT.
- Message input is a contenteditable div at the bottom of the conversation. set_field works; Enter sends by default.
- Emoji picker, attachment button (paperclip), voice-note (mic) sit to the left/right of the input.
- Search at the top of the conversation list searches across all chats (people, group names, message content).
- "Status" tab (eye icon) is a separate stream of ephemeral updates; "Calls" tab shows call history and starts voice/video calls.
- DO NOT send a message unless the user has named the recipient AND given an explicit message body in this conversation. Auto-confirming a draft is irreversible.
- New chat (pencil icon) opens the contact picker.`,
  },
  {
    name: 'telegram',
    category: 'general',
    // Both web.telegram.org and the k/a/z variants for different builds.
    match: (url) => /^https?:\/\/((web|webk|weba|webz|k)\.)?telegram\.org\//.test(url) && !/^https?:\/\/(www\.)?telegram\.org\/\?/.test(url),
    notes: `
- Login: phone number → SMS code → optionally 2FA password. If the phone has no SMS access, an in-app Telegram code is sent instead — surface either flow to the user.
- Layout: chat list on the LEFT (Saved Messages, channels, groups, individual chats), active chat on the RIGHT.
- "Saved Messages" is a self-DM — common pattern for personal notes / file storage.
- Channels (broadcast, read-only for most members) have a megaphone icon; groups (interactive) have a people icon.
- Public channels / groups can be joined via /joinchat/<token> or @<username> links.
- @mentions trigger autocomplete for users; #hashtags work in channels with the hashtag feature enabled.
- Stickers, GIFs, and bot commands (/) all live in popups above the message input.
- DO NOT send a message unless the user named the recipient AND the exact message body in this conversation.
- "Edit message" works for a window after sending (~48h); "Delete for everyone" within a shorter window — both have explicit confirms.`,
  },
];

/**
 * Find the first adapter matching the given URL.
 */
export function getActiveAdapter(url) {
  if (!url) return null;
  for (const a of ADAPTERS) {
    try {
      if (a.match(url)) return a;
    } catch (e) { /* malformed URL or broken matcher — skip */ }
  }
  return null;
}

/**
 * Get a printable list of all registered adapters (for settings UI / docs).
 */
export function listAdapters() {
  return ADAPTERS.map(a => ({ name: a.name, category: a.category }));
}
