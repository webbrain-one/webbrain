# WebBrain Test Scenarios

A dozen end-to-end tasks for evaluating the WebBrain browser agent across a spread of difficulty and UI-pattern coverage. Each scenario lists the site, the prompt to paste into the side panel, and the observable pass criterion.

## Scenarios

### 1. Wikipedia summary — Easy
- **Site:** en.wikipedia.org
- **Task:** "Go to Wikipedia, find the article on Alan Turing, and tell me his date of death."
- **Expected:** Agent navigates, reads the infobox, answers "7 June 1954". One `get_accessibility_tree` → `done`.

### 2. Hacker News top story — Easy
- **Site:** news.ycombinator.com
- **Task:** "What's the #1 story on Hacker News right now, and how many points does it have?"
- **Expected:** Returns title + point count from the top row. No clicks needed.

### 3. Amazon price check — Easy
- **Site:** amazon.com
- **Task:** "Search Amazon for 'USB-C hub' and tell me the price of the top sponsored result."
- **Expected:** One type into the search box, one Enter, read first card. Tests search-box detection and SERP parsing.

### 4. GitHub issue filing — Medium
- **Site:** github.com (your own test repo)
- **Task:** "Open a new issue titled 'Test from WebBrain' with body 'ignore this' on github.com/&lt;you&gt;/&lt;repo&gt;."
- **Expected:** Agent navigates to `/issues/new`, fills title + body, clicks Submit. Tests contenteditable body editor and duplicate-label "Submit new issue" button.

### 5. Gmail compose draft — Medium
- **Site:** mail.google.com
- **Task:** "Compose a draft to test@example.com with subject 'hello' and body 'this is a test'. Do not send."
- **Expected:** Clicks Compose, fills three fields (with autocomplete on To), closes to save as draft. Tests React portals and autocomplete comboboxes.

### 6. Google Calendar event — Medium
- **Site:** calendar.google.com
- **Task:** "Create a calendar event titled 'Lunch' tomorrow at 12:30pm for 30 minutes."
- **Expected:** Opens create dialog, types title, adjusts date/time pickers, saves. Tests date/time spinners.

### 7. Stripe product with CNY recurring — Hard
- **Site:** dashboard.stripe.com
- **Task:** "Create a product called 'MyProduct' priced at 500 CNY, recurring every 2 months."
- **Expected:** One row in the product catalog with name=MyProduct, currency=CNY, interval=2 months. Tests virtualized combobox + custom-interval reveal.

### 8. LinkedIn connection request — Medium
- **Site:** linkedin.com
- **Task:** "Go to linkedin.com/in/&lt;profile&gt;, click Connect, add a note 'Met at Demo Day', and send."
- **Expected:** Handles the "More" overflow menu on profiles where Connect is hidden. Tests menu discovery.

### 9. Airbnb search filter — Hard
- **Site:** airbnb.com
- **Task:** "Find listings in Istanbul for June 10–15, 2 guests, max $150/night, with a pool."
- **Expected:** Fills destination autocomplete, date-range picker, guest stepper, price slider, amenities checkbox. Tests range inputs and multi-step filter drawer.

### 10. Google Flights search — Hard
- **Site:** google.com/travel/flights
- **Task:** "Search one-way flights SFO → IST, departing May 20 2026, economy, 1 adult. Return the cheapest option and its airline."
- **Expected:** Airport autocomplete (two comboboxes), date picker, cabin selector, reads first result card. Tests SPA route transitions.

### 11. Reddit subreddit subscription — Medium
- **Site:** reddit.com
- **Task:** "Subscribe me to r/chess and then tell me how many members it has."
- **Expected:** Clicks Join, reads member count from the sidebar. Requires a logged-in account; tests state-change detection (Join → Joined).

### 12. Multi-tab research synthesis — Hard
- **Site:** arxiv.org + scholar.google.com
- **Task:** "Open arxiv.org/abs/1706.03762, then search Google Scholar for its citation count, and tell me both the paper title and citations."
- **Expected:** Uses `tabs_create` / `switch_browser` across two tabs and returns both data points. Tests cross-tab state handling.

## Scoring

- **Pass:** correct answer or correct final page state.
- **Partial:** right data but wrong field, or submitted form with one field off.
- **Fail:** stuck in a loop, wrong entity modified, or hallucinated completion.

## Automation options

Ranked from easiest to most ambitious.

### 1. Tracing you already have (lowest-effort baseline)
Tracing is already built in. Turn it on in Settings → "Record traces", run each scenario by hand once per model you want to compare, then open the Traces page and diff side by side. This is what we've been doing in this session. Cheap to start, but scoring is manual.

### 2. Scenario runner from the side panel
Add a `tests.json` containing `{ url, prompt, check }` rows. Build a small Test Runner tab (mirror Traces) that loops through entries: for each one, open the URL, stuff the prompt into the side panel's input, wait for the agent to finish, then evaluate `check`. Three useful flavors of `check`:

- **URL match** — final `window.location.href` matches a regex. Catches "was a draft actually created?" for pages that redirect on save.
- **DOM assertion** — run a small JS snippet in the page (`document.querySelector('[data-testid=product-row-name]')?.textContent === 'namaz'`). Catches Scenarios 4, 7, 11.
- **LLM-as-judge** — feed the final `done` summary + a screenshot to a stronger model (Claude Sonnet) with the prompt + rubric and get pass/partial/fail. Catches Scenarios 1, 2, 3, 10, 12 where the answer is a string.

You already have everything you need: the agent loop, the message bus, screenshots, traces. It's ~1 day of work.

### 3. Headless run via Puppeteer / Playwright
Launch Chromium with the extension pre-installed (`--load-extension=path/to/webbrain`), drive the side panel via its DOM, and run the suite non-interactively — overnight, in CI, across N providers. You can parallelize across Chrome profiles for throughput. Downsides: signed-in scenarios (Gmail, Reddit, LinkedIn) need baked cookie jars per profile, and Stripe's dashboard is fussy about new browsers (captcha).

The sweet spot is a hybrid: headless for anonymous sites (Wikipedia, HN, Amazon, arxiv), side-panel runner for logged-in ones.

### 4. Scenario generation from real browsing
Record a human doing the task once with devtools on, save the clicked-element IDs + final DOM state, and auto-build the `check`. Turns every hand-demoed flow into a regression test. Higher upfront cost; pays off once you have 50+ scenarios.

### 5. Model-vs-model leaderboard
Once (2) and (3) are in, sweep across every configured provider (llama.cpp 4B/12B/31B, Anthropic, OpenAI, OpenRouter) running the same suite nightly. Persist scores in IndexedDB, render a leaderboard tab. This is where tracing pays off — you can click "why did Gemma-4-31B fail Stripe?" and get the exact step sequence without re-running.

### Recommendation
Build option 2 first. The trace infrastructure means you're roughly 60% of the way there — what's missing is the scripted loop and a tiny pass/fail judge. That gets you repeatable numbers to justify changes like `v3.6.8`. Bolt on option 3 once the suite grows past ~20 scenarios and per-run cost matters.
