import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { chromium, firefox } from 'playwright';
import { defaultDecide, fixtureControlEffectReading, semanticQuestionOf } from './semantic-decision-stub.mjs';

// Real-DOM fixtures: the production submit probe (injected the way each build
// injects it) classifies controls in Chromium and Firefox pages, then the real
// guard chain runs in production order. Every request is fulfilled locally.
const noneContract = { version: 1, status: 'none', actions: [], requirements: null, prohibited: [], reason: 'No publication requested.' };
// The receipt shape _completionSubmitStates keeps for an ordinary form
// submission made before the user's correction.
const priorReceipt = () => ({ dispatched: true, observedAfterSubmit: false, mutationKind: 'submit', actionSequence: 3,
  submittedActionUrl: 'https://other.example/newsletter', submittedFields: [{ label: 'Email', type: 'email', value: 'me@example.com' }],
  originatingUrl: 'https://other.example/', currentUrl: 'https://other.example/', originatingDocument: 'doc-a' });

for (const build of ['chrome', 'firefox']) {
  for (const engine of ['chromium', 'firefox']) {
    test(`${build} build on ${engine}: ordinary controls are not consequential commits; commits keep their checks`, async t => {
      const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
      const { guardRecentSubmitClick } = await import(`../src/${build}/src/agent/submit-click-guard.js`);
      const browser = await (engine === 'chromium' ? chromium : firefox).launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>fixture</title>' }));
      const page = await context.newPage();
      const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
      if (build === 'chrome') {
        globalThis.chrome = { scripting: { executeScript: async ({ func, args }) => [{ frameId: 0,
          result: await page.evaluate(({ source, args }) => Function('return (' + source + ')')()(...args), { source: func.toString(), args }) }] } };
      } else {
        globalThis.chrome = undefined;
        globalThis.browser = { tabs: { executeScript: async (_tab, { code }) => [await page.evaluate(code => Function('return (' + code + ')')(), code)] } };
      }
      const call = (action, params) => page.evaluate(({ action, params }) => new Promise(resolve => {
        for (const listener of window.contentListeners) listener({ target: 'content', action, params }, {}, resolve);
      }), { action, params });
      let host = '';
      const load = async url => {
        if (host === url) return;
        host = url;
        await page.goto(url);
        await page.evaluate(() => {
          window.contentListeners = [];
          window.chrome = { runtime: { sendMessage: () => {}, onMessage: { addListener: fn => window.contentListeners.push(fn) } } };
          window.browser = window.chrome;
        });
        for (const name of ['accessibility-tree.js', 'content.js']) {
          await page.addScriptTag({ content: readFileSync(`src/${build}/src/content/${name}`, 'utf8') });
        }
      };
      const setup = async (url, html, { request = 'Inspect this page and use its ordinary controls.', steering = false, gate = {} } = {}) => {
        await load(url);
        await page.setContent('<style>button,[role=button],a,[role=menuitem],[role=tab],[role=option],summary{display:inline-block;min-width:60px;min-height:28px}</style>' + html);
        const provider = { model: 'owned-fixture-provider', chat: async () => ({ content: '{}' }) };
        const agent = new Agent({ getActive: () => provider });
        agent._currentUrl = async () => page.url();
        agent._persist = () => {};
        agent.conversations.set(1, [{ role: 'system', content: 'system' }, { role: 'user', content: request }]);
        const guard = agent._startPlanExecutionGuard(1, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: false, ...gate });
        const modelCalls = [];
        agent._chatWithCostAllowance = async (_p, messages, _o, _c, meta) => {
          modelCalls.push(meta?.generationName);
          // Fixed-choice decisions about the request get a model's reading;
          // the publication contract finds no publication.
          const kind = String(meta?.generationName || '').match(/^semantic_(.+)$/)?.[1];
          return { content: JSON.stringify(kind ? defaultDecide(kind, semanticQuestionOf(agent, messages)) : noneContract) };
        };
        if (steering) guard.steeringPriorSubmission = priorReceipt();
        return { agent, guard, provider, modelCalls };
      };
      const ref = async id => {
        const tree = await call('get_accessibility_tree', { filter: 'all', maxChars: 16000 });
        assert.equal(typeof tree?.pageContent, 'string');
        return page.evaluate(id => window.__wb_ax_ref(document.getElementById(id)), id);
      };
      // Production order: resource/steering/workflow (social) pre-submit gates.
      const gate = async (f, tool, args) => {
        const detected = await f.agent._detectLikelySubmitAction(1, tool, args);
        const block = await f.agent._resourceMutationPreSubmitBlock(1, tool, args, detected, f.provider)
          || f.agent._steeringPriorSubmissionBlock(1, tool, args, detected)
          || await f.agent._workflowPreSubmitDispatchBlock(1, tool, args, detected, f.provider);
        return { detected, block };
      };
      try {
        await t.test('remove-filter chip, Trash folder link and draft attachment are not deletions', async () => {
          for (const steering of [false, true]) {
            let f = await setup('https://shop.example/socks', '<div class="chips"><span>Size: L</span><button id="t" type="button" aria-label="Remove filter: Size L">Size L ×</button></div><ul><li>Wool socks</li></ul>', { steering });
            let { detected, block } = await gate(f, 'click_ax', { ref_id: await ref('t') });
            assert.equal(detected?.resolvedOrdinaryActivationTarget, true, 'filter chip');
            assert.equal(detected.mutationKind, undefined);
            assert.equal(block, null);
            f = await setup('https://mail.example/inbox', '<nav><a role="menuitem" href="/inbox">Inbox</a> <a id="t" role="menuitem" href="/trash">Trash</a></nav>', { steering, gate: { requiresStateChange: false } });
            ({ detected, block } = await gate(f, 'click_ax', { ref_id: await ref('t') }));
            assert.equal(detected?.resolvedNavigationTarget, true, 'Trash folder link');
            assert.equal(block, null);
            f = await setup('https://mail.example/inbox', '<nav><a role="menuitem" href="/mail?folder=inbox">Inbox</a> <a id="t" role="menuitem" href="/mail?folder=trash">Trash</a></nav>', { steering, gate: { requiresStateChange: false } });
            ({ detected, block } = await gate(f, 'click_ax', { ref_id: await ref('t') }));
            assert.equal(detected?.resolvedNavigationTarget, true, 'Trash folder selected by query');
            assert.equal(block, null);
            f = await setup('https://mail.example/compose', '<section><textarea aria-label="Body">Hi Bob</textarea><div class="attachment"><span>report.pdf</span><button id="t" type="button" aria-label="Remove attachment">×</button></div><button type="button">Send</button></section>', { steering });
            ({ detected, block } = await gate(f, 'click_ax', { ref_id: await ref('t') }));
            assert.equal(detected?.resolvedDraftControl, true, 'draft attachment');
            assert.equal(block, null);
          }
        });

        await t.test('requested resource deletions and scripted commands keep the deletion guard', async () => {
          // A row without a permalink is now bound by its text; a request that
          // names no row cannot select it. Toolbar, unlinked menu and dialog
          // deletions have no record at all.
          for (const [url, html, reason] of [
            ['https://shop.example/cart', '<ul class="cart"><li>Wool socks — $12 <button id="t" type="button">Remove</button></li><li>Hat <button type="button">Remove</button></li></ul>', 'record_not_named_in_request'],
            ['https://admin.example/users', '<table><tr><td>bob@example.com</td><td><button id="t" type="button">Delete</button></td></tr></table>', 'record_not_named_in_request'],
            ['https://mail.example/msg/42', '<div role="toolbar"><div id="t" role="button" tabindex="0" aria-label="Delete">🗑</div></div><h2>Subject</h2>', 'resource_unresolved'],
            ['https://app.example/items', '<ul><li>Item <a id="t" role="button" href="#">Delete</a></li></ul>', 'record_not_named_in_request'],
            // A GET link whose query performs the deletion keeps its caption.
            ['https://blog.example/wp-admin/edit.php', '<ul><li>Post 1 <span role="menu"><a id="t" role="menuitem" href="/wp-admin/post.php?post=1&amp;action=trash&amp;_wpnonce=abc">Trash</a></span></li></ul>', 'resource_unresolved'],
            ['https://admin.example/list', '<ul><li>Row 5 <span role="menu"><a id="t" role="menuitem" href="/admin.php?do=delete_row&amp;id=5">Delete</a></span></li></ul>', 'resource_unresolved'],
            ['https://notes.example/', '<section><textarea aria-label="New note"></textarea><div class="note"><p>Buy milk</p><button id="t" type="button">Remove</button></div></section>', 'record_not_named_in_request'],
            ['https://app.example/settings', '<dialog open><form method="dialog"><p>Delete this item?</p><button value="cancel">Cancel</button><button id="t" value="confirm">Delete</button></form></dialog>', 'resource_unresolved'],
          ]) {
            const f = await setup(url, html, { request: 'Delete the selected item.' });
            const { detected, block } = await gate(f, 'click_ax', { ref_id: await ref('t') });
            assert.equal(detected?.mutationKind, 'delete', url);
            assert.equal(block?.noDispatch, true, url);
            assert.equal(block.actionGuard.reason, reason, url);
            assert.equal(f.modelCalls.includes('resource_mutation_authorization'), false, url);
            // A row the request does not identify goes to the user on WebBrain's
            // card; a control with no record is never put to the model.
            assert.equal(f.modelCalls.includes('semantic_deletion_request'), reason === 'record_not_named_in_request', url);
            assert.equal(block.mutationConfirmation?.reason, reason === 'record_not_named_in_request' ? 'not_named' : undefined, url);
          }
        });

        await t.test('after a correction, searches, dialog Cancel and in-form toggles pass; commits and unknown targets stay blocked', async () => {
          const passing = [
            ['G7', 'https://bank.example/login', '<form method="post" action="/session"><input name="user"><input type="password" name="password"><button id="t" type="button" aria-label="Show password">👁</button><button type="submit">Sign in</button></form>'],
            ['G8', 'https://shop.example/checkout', '<form method="post" action="/cart/update"><input name="qty" value="1"><button id="t" type="button" aria-label="Increase quantity">+</button><button type="submit">Update cart</button></form>'],
            ['G9', 'https://travel.example/search', '<form method="get" action="/flights"><input name="from"><input name="to"><button id="t" type="button" aria-haspopup="dialog">Pick dates</button><button type="submit">Search</button></form>'],
            ['G10', 'https://docs.example/page', '<form method="post" action="/settings"><div id="t" role="button" tabindex="0" aria-expanded="false">Shipping details</div><input name="addr"></form>'],
            ['G16', 'https://app.example/settings', '<dialog open><form method="dialog"><p>Discard changes?</p><button id="t">Cancel</button><button value="ok">OK</button></form></dialog>'],
            ['G17', 'https://docs.example/', '<form role="search" method="get" action="/search"><input type="search" name="q" value="webhooks"><button id="t" type="submit">Search</button></form>'],
            ['G11', 'https://news.example/', '<header><button id="t" aria-haspopup="menu">Menu</button></header>'],
          ];
          for (const [id, url, html] of passing) {
            const f = await setup(url, html, { steering: true });
            const { detected, block } = await gate(f, 'click_ax', { ref_id: await ref('t') });
            assert.equal(block, null, id);
            if (id === 'G11') assert.equal(detected?.resolvedPreparatoryTarget, true, id);
            else {
              // The submit confirmation is unchanged; only the correction guards relax.
              assert.equal(detected?.isSubmit, true, id);
              assert.equal(f.agent._nonCommittingSubmission(detected), true, id);
            }
          }
          const blockedCases = [
            ['in-form Save', 'https://app.example/profile', '<form method="post" action="/profile"><input name="name" value="Bob"><button id="t" type="button">Save</button></form>', 'prior_effect_unreconciled'],
            ['typeless Cancel in a POST form', 'https://app.example/profile', '<form method="post" action="/profile"><input name="name" value="Bob"><button id="t">Cancel</button></form>', 'prior_effect_unreconciled'],
            ['icon-only unnamed button', 'https://mail.example/inbox', '<div role="toolbar"><button id="t" type="button"><svg width="20" height="20"><path d="M0 0h20v20z"/></svg></button></div>', 'target_unresolved'],
            ['framework DELETE link', 'https://blog.example/posts', '<ul><li>Post 1 <a id="t" href="/posts/1" data-method="delete">Remove post</a></li></ul>', 'target_unresolved'],
          ];
          for (const [name, url, html, reason] of blockedCases) {
            const f = await setup(url, html, { steering: true });
            const { detected, block } = await gate(f, 'click_ax', { ref_id: await ref('t') });
            assert.equal(block?.noDispatch, true, name);
            assert.equal(block.actionGuard.reason, reason, name);
            assert.notEqual(detected?.nonCommittingControl, true, name);
            if (reason === 'target_unresolved') assert.match(block.error, /could not be identified/);
          }
        });

        await t.test('X and Bluesky ordinary controls resolve without publication authority', async () => {
          const nav = '<nav><a data-testid="AppTabBar_Profile_Link" href="/alice">Profile</a></nav>';
          const cases = [
            ['reply opener', 'https://x.com/home', '<main><article data-testid="tweet"><a href="/bob/status/1">1h</a><div data-testid="tweetText">Hello</div><div role="group"><button id="t" type="button" data-testid="reply" aria-label="3 Replies. Reply"><svg width="20" height="20"></svg></button></div></article></main>', 'resolvedOrdinaryActivationTarget'],
            ['share menu item', 'https://x.com/home', '<div role="menu"><div id="t" role="menuitem" tabindex="0">Copy link</div><div role="menuitem" tabindex="0">Bookmark</div></div>', 'resolvedOrdinaryActivationTarget'],
            ['tab', 'https://x.com/home', '<div role="tablist"><div role="tab" aria-selected="true" tabindex="0">For you</div><div id="t" role="tab" aria-selected="false" tabindex="0">Following</div></div>', 'resolvedOrdinaryActivationTarget'],
            ['schedule tool', 'https://x.com/compose/post', '<div role="dialog"><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">Draft</div><button id="t" type="button" data-testid="scheduleOption" aria-label="Schedule post"><svg width="20" height="20"></svg></button><button type="button" data-testid="tweetButton">Post</button></div>', 'resolvedOrdinaryActivationTarget'],
            ['settings checkbox', 'https://x.com/settings/audience', '<main><label><input id="t" type="checkbox" aria-label="Protect your posts"> Protect your posts</label></main>', 'resolvedOrdinaryActivationTarget'],
            ['typeless pill', 'https://x.com/home', '<main><button id="t">Show 105 posts</button></main>', 'resolvedOrdinaryActivationTarget'],
            ['disclosure', 'https://x.com/settings/account', '<details><summary id="t">Advanced</summary><p>More</p></details>', 'resolvedOrdinaryActivationTarget'],
            ['listbox option', 'https://x.com/home', '<div role="listbox"><div id="t" role="option" tabindex="0" aria-selected="false">Following</div><div role="option" tabindex="0">Everyone</div></div>', 'resolvedOrdinaryActivationTarget'],
            ['media picker with nested file input', 'https://x.com/home', `${nav}<div id="t" role="button" tabindex="0" aria-label="Add photos or video">Media<input type="file" style="display:none"></div>`, 'resolvedOrdinaryActivationTarget'],
            ['Bluesky reply opener', 'https://bsky.app/', '<main><div data-testid="feedItem-by-bob.bsky.social"><a href="/profile/bob.bsky.social/post/3abc">2h</a><div data-testid="postText">Hi</div><button id="t" type="button" data-testid="replyBtn" aria-label="Reply (2 replies)"><svg width="20" height="20"></svg></button></div></main>', 'resolvedOrdinaryActivationTarget'],
            ['remove media in the unsent post', 'https://x.com/home', `${nav}<div id="composer"><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">Hello</div><div><div><img alt="" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><div id="t" role="button" tabindex="0" aria-label="Remove media"></div></div></div><nav aria-label="Composer tools"><button id="emoji" type="button" aria-label="Add emoji">Emoji</button></nav><button type="button" data-testid="tweetButtonInline">Post</button></div>`, 'resolvedDraftControl'],
          ];
          for (const [name, url, html, flag] of cases) {
            for (const steering of [false, true]) {
              const f = await setup(url, html, { steering, request: 'Look around this page. Do not post anything.' });
              const { detected, block } = await gate(f, 'click_ax', { ref_id: await ref('t') });
              assert.equal(detected?.[flag], true, `${name} (${steering ? 'after correction' : 'initial'})`);
              assert.equal(detected.isSubmit, false, name);
              assert.equal(detected.mutationKind, undefined, name);
              assert.equal(block, null, `${name} (${steering ? 'after correction' : 'initial'})`);
              assert.equal(f.modelCalls.includes('social_publication_authorization'), false, name);
            }
          }
          // A coordinate click lands on the link text, not on the anchor.
          let f = await setup('https://x.com/home', '<main><a id="link" href="/bob/status/1"><span id="inner">Open the post</span></a></main>');
          const box = await page.locator('#inner').boundingBox();
          let result = await gate(f, 'click', { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
          assert.equal(result.detected?.resolvedNavigationTarget, true, 'link ancestry');
          assert.equal(result.block, null);
          // Unmodified Enter in the app-marked post editor edits the draft.
          f = await setup('https://x.com/home', `${nav}<div><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" id="editor">Hello</div><button type="button" data-testid="tweetButtonInline">Post</button></div>`);
          await page.locator('#editor').focus();
          result = await gate(f, 'press_keys', { key: 'Enter' });
          assert.equal(result.detected?.resolvedEditableTarget, true, 'Enter in the post editor');
          assert.equal(result.block, null);
        });

        await t.test('X publish, send, deletion, keyboard and unidentified targets stay blocked with distinct messages', async () => {
          const nav = '<nav><a data-testid="AppTabBar_Profile_Link" href="/alice">Profile</a></nav>';
          let f = await setup('https://x.com/home', `${nav}<div><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">Hello</div><button id="t" type="button" data-testid="tweetButtonInline">Post</button></div>`, { request: 'Look around. Do not post anything.' });
          let result = await gate(f, 'click_ax', { ref_id: await ref('t') });
          assert.equal(result.detected?.publicationControl, true);
          assert.equal(result.block?.noDispatch, true, 'a real publish control still needs a ready contract');
          assert.doesNotMatch(result.block.error, /could not be identified/);
          for (const [name, html] of [
            ['unnamed', '<button id="t" type="button"></button>'],
            ['unlabelled commit word', '<main><button id="t" type="button">Reply</button></main>'],
            ['DM send', '<button id="t" type="button" data-testid="dmComposerSendButton"></button>'],
            ['unrecognized app id without a type', '<button id="t" data-testid="unknown">Cancel</button>'],
          ]) {
            f = await setup('https://x.com/home', html);
            result = await gate(f, 'click_ax', { ref_id: await ref('t') });
            assert.equal(result.block?.noDispatch, true, name);
            assert.equal(result.block.targetUnresolved, true, name);
            assert.match(result.block.error, /could not be identified as a link, field, menu item or ordinary button/, name);
            // No workflow job is bound to this run: the refusal names none.
            assert.equal(result.block.socialPublicationGuard, true, name);
            assert.equal(result.block.workflowJob, undefined, name);
          }
          f = await setup('https://x.com/home', '<div role="menu"><div id="t" role="menuitem" tabindex="0">Delete</div></div>', { request: 'Delete my last post.' });
          result = await gate(f, 'click_ax', { ref_id: await ref('t') });
          assert.equal(result.detected?.mutationKind, 'delete');
          assert.equal(result.block.actionGuard.reason, 'resource_unresolved');
          for (const html of ['<main><p>Timeline</p></main>', '<div data-testid="dmComposerTextInput" contenteditable="true" role="textbox" id="editor">Hi</div>']) {
            f = await setup('https://x.com/messages', html);
            if (html.includes('editor')) await page.locator('#editor').focus();
            result = await gate(f, 'press_keys', { key: 'Enter' });
            assert.notEqual(result.detected?.resolvedEditableTarget, true);
            assert.equal(result.block?.noDispatch, true);
            assert.match(result.block.error, /Enter was not pressed/);
          }
        });

        // QA P1 (vision, x.com): "Open the third post in this timeline and
        // bookmark it." Every click on the post's Bookmark button was refused
        // as an unidentified control that could publish. A model reads a
        // Bookmark caption as saving the post (a commit), and an app control
        // whose caption reads as a commit is not ordinary, so the probe
        // resolved nothing. The app's own name for a Like or Bookmark toggle
        // says it publishes nothing; publishing controls stay guarded.
        await t.test('X and Bluesky Like and Bookmark toggles are not refused as controls that could publish', async () => {
          // What a model may read every caption of the clicked control as.
          const readEveryCaptionAs = (f, choice) => {
            const chat = f.agent._chatWithCostAllowance;
            f.agent._chatWithCostAllowance = async (provider, messages, options, cost, meta) => meta?.generationName === 'semantic_control_effect'
              ? { content: JSON.stringify({ answers: semanticQuestionOf(f.agent, messages).items
                .map((item, index) => ({ item: index, choice, evidence: String(item.text) })) }) }
              : chat(provider, messages, options, cost, meta);
          };
          const xPost = button => '<main><article data-testid="tweet"><a href="/example/status/1">1h</a><div data-testid="tweetText">Hello</div>'
            + `<div role="group"><button type="button" data-testid="reply" aria-label="3 Replies. Reply"><svg width="20" height="20"></svg></button>${button}</div></article></main>`;
          const bskyPost = button => '<main><div data-testid="feedItem-by-example.bsky.social"><a href="/profile/example.bsky.social/post/3abc">2h</a>'
            + `<div data-testid="postText">Hi</div>${button}</div></main>`;
          const toggles = [
            ['X Bookmark', 'https://x.com/home', xPost('<button id="t" type="button" data-testid="bookmark" aria-label="25 Bookmarks. Bookmark"><div><svg id="icon" width="20" height="20"></svg></div><span>25</span></button>')],
            ['X Bookmarked', 'https://x.com/home', xPost('<button id="t" type="button" data-testid="removeBookmark" aria-label="26 Bookmarks. Bookmarked"><svg width="20" height="20"></svg><span>26</span></button>')],
            ['X Like', 'https://x.com/home', xPost('<button id="t" type="button" data-testid="like" aria-label="88 Likes. Like"><svg width="20" height="20"></svg><span>88</span></button>')],
            ['X Liked', 'https://twitter.com/home', xPost('<button id="t" type="button" data-testid="unlike" aria-label="89 Likes. Liked"><svg width="20" height="20"></svg><span>89</span></button>')],
            ['X Bookmark without a type', 'https://x.com/home', xPost('<button id="t" data-testid="bookmark" aria-label="Bookmark"><svg width="20" height="20"></svg></button>')],
            ['Bluesky Like', 'https://bsky.app/', bskyPost('<div id="t" role="button" tabindex="0" data-testid="likeBtn" aria-label="Like (5 likes)"><svg width="20" height="20"></svg></div>')],
            ['Bluesky Save', 'https://bsky.app/', bskyPost('<button id="t" type="button" data-testid="postBookmarkBtn" aria-label="Add to saved posts"><svg width="20" height="20"></svg></button>')],
          ];
          for (const [name, url, html] of toggles) {
            for (const reading of ['fixture', 'commit']) {
              const f = await setup(url, html, { request: 'Open the third post in this timeline and bookmark it.' });
              if (reading === 'commit') readEveryCaptionAs(f, 'commit');
              const args = { ref_id: await ref('t') };
              const { detected, block } = await gate(f, 'click_ax', args);
              assert.equal(block, null, `${name} (${reading})`);
              assert.equal(detected?.isSubmit, false, name);
              if (reading === 'commit') {
                assert.equal(detected.resolvedNonPublishingControl, true, name);
                assert.notEqual(detected.resolvedOrdinaryActivationTarget, true, `${name}: a commit is not ordinary`);
              } else {
                assert.ok(detected.resolvedNonPublishingControl === true || detected.resolvedOrdinaryActivationTarget === true, name);
              }
              // Nothing was or could be posted: no publication check, and
              // the click is not recorded as a possible post.
              assert.equal(f.agent._cannotPost(detected), true, name);
              assert.equal(f.agent._socialActivationMayPost('click_ax', args, detected, url), false, name);
              assert.equal(f.modelCalls.includes('social_publication_authorization'), false, name);
            }
          }
          // A model reads "Bookmark" as saving the post.
          assert.equal(fixtureControlEffectReading('25 Bookmarks. Bookmark'), 'commit');
          // The vision click: a point on the Bookmark icon.
          let f = await setup('https://x.com/home', toggles[0][2], { request: 'Open the third post in this timeline and bookmark it.' });
          const box = await page.locator('#icon').boundingBox();
          let result = await gate(f, 'click', { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), coordinate_space: 'css' });
          assert.equal(result.detected?.resolvedNonPublishingControl, true, 'vision click on the Bookmark icon');
          assert.equal(result.block, null, 'vision click on the Bookmark icon');
          // Not ordinary: after a correction that followed a submission, it
          // keeps the checks any other commit gets.
          f = await setup('https://x.com/home', toggles[0][2], { steering: true, request: 'Open the third post in this timeline and bookmark it.' });
          result = await gate(f, 'click_ax', { ref_id: await ref('t') });
          assert.equal(result.detected?.resolvedNonPublishingControl, true);
          assert.equal(result.block?.steeringPriorSubmission, true, 'a correction still holds a bookmark back');
          // Publishing controls and controls the app does not name as Like or
          // Bookmark stay refused when their caption reads as a commit or a
          // publication, as before.
          for (const [name, url, html] of [
            ['X Reply', 'https://x.com/home', xPost('').replace('<button type="button" data-testid="reply"', '<button id="t" type="button" data-testid="reply"')],
            ['X Repost', 'https://x.com/home', xPost('<button id="t" type="button" data-testid="retweet" aria-haspopup="menu" aria-label="5 reposts. Repost"><svg width="20" height="20"></svg></button>')],
            ['X Repost menu item', 'https://x.com/home', '<div role="menu"><div id="t" role="menuitem" tabindex="0" data-testid="retweetConfirm">Repost</div><a href="/compose/post" role="menuitem">Quote</a></div>'],
            ['X Like without the app name', 'https://x.com/home', xPost('<button id="t" type="button" aria-label="88 Likes. Like"><svg width="20" height="20"></svg></button>')],
            ['X unknown app control', 'https://x.com/home', xPost('<button id="t" type="button" data-testid="bookmarkFolder" aria-label="Bookmark to folder"><svg width="20" height="20"></svg></button>')],
            ['Bluesky Repost', 'https://bsky.app/', bskyPost('<button id="t" type="button" data-testid="repostBtn" aria-label="Repost (1 repost)"><svg width="20" height="20"></svg></button>')],
          ]) {
            for (const choice of ['commit', 'publish']) {
              // An app control id that is not a publish one disproves a
              // caption read as a publication; only an unnamed one keeps it.
              if (choice === 'publish' && name !== 'X Like without the app name') continue;
              f = await setup(url, html, { request: 'Open the third post in this timeline and bookmark it.' });
              readEveryCaptionAs(f, choice);
              result = await gate(f, 'click_ax', { ref_id: await ref('t') });
              assert.notEqual(result.detected?.resolvedNonPublishingControl, true, `${name} (${choice})`);
              assert.equal(result.block?.noDispatch, true, `${name} (${choice})`);
              assert.equal(result.block.targetUnresolved, true, `${name} (${choice})`);
              assert.match(result.block.error, /could not be identified/, `${name} (${choice})`);
            }
          }
          // The composer's Post button is still a publication control.
          f = await setup('https://x.com/home', '<nav><a data-testid="AppTabBar_Profile_Link" href="/example">Profile</a></nav><div><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">Hello</div><button id="t" type="button" data-testid="tweetButtonInline">Post</button></div>',
            { request: 'Open the third post in this timeline and bookmark it.' });
          readEveryCaptionAs(f, 'commit');
          result = await gate(f, 'click_ax', { ref_id: await ref('t') });
          assert.equal(result.detected?.publicationControl, true);
          assert.equal(result.block?.noDispatch, true);
        });

        // X Pro (pro.x.com) has none of the app markers the X adapter reads.
        // A plain Post button whose caption no model read in time looks
        // ordinary to the probe, which says so; Enter in the app-marked post
        // editor edits the draft there as on x.com.
        await t.test('on X Pro an unread caption proves nothing, and Enter in the post editor edits the draft', async () => {
          const html = '<main><div><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox" id="editor">Draft</div><button id="t" type="button">Post</button></div></main>';
          for (const reading of ['unread', 'read']) {
            const f = await setup('https://pro.x.com/i/decks/1', html, { steering: true });
            if (reading === 'unread') {
              const chat = f.agent._chatWithCostAllowance;
              f.agent._chatWithCostAllowance = async (provider, messages, options, cost, meta) => meta?.generationName === 'semantic_control_effect'
                ? { content: '' } : chat(provider, messages, options, cost, meta);
            }
            const { detected, block } = await gate(f, 'click_ax', { ref_id: await ref('t') });
            if (reading === 'unread') {
              assert.equal(detected?.resolvedOrdinaryActivationTarget, true, reading);
              assert.equal(detected.captionUnread, true, reading);
              assert.equal(f.agent._cannotPost(detected), false, reading);
            } else {
              assert.notEqual(detected?.resolvedOrdinaryActivationTarget, true, 'read as a post, it is no ordinary button');
            }
            // Under a correction it is not clicked either way.
            assert.equal(block?.actionGuard?.reason, 'target_unresolved', reading);
          }
          // A Post button that also opens a popup is not clicked either.
          const popup = await setup('https://pro.x.com/i/decks/1', html.replace('<button id="t" type="button">', '<button id="t" type="button" aria-haspopup="dialog">'), { steering: true });
          const popupChat = popup.agent._chatWithCostAllowance;
          popup.agent._chatWithCostAllowance = async (provider, messages, options, cost, meta) => meta?.generationName === 'semantic_control_effect'
            ? { content: '' } : popupChat(provider, messages, options, cost, meta);
          const launcher = await gate(popup, 'click_ax', { ref_id: await ref('t') });
          assert.equal(launcher.detected?.resolvedPreparatoryTarget, true);
          assert.equal(launcher.detected.captionUnread, true);
          assert.equal(launcher.block?.actionGuard?.reason, 'target_unresolved');
          const f = await setup('https://pro.x.com/i/decks/1', html, { steering: true });
          await page.locator('#editor').focus();
          const result = await gate(f, 'press_keys', { key: 'Enter' });
          assert.equal(result.detected?.resolvedEditableTarget, true, 'Enter in the X Pro post editor');
          assert.equal(f.agent._cannotPost(result.detected), true);
          assert.equal(result.block, null);
          // On a site that is not X or Bluesky nothing changes.
          const other = await setup('https://deck.example/', html);
          const chat = other.agent._chatWithCostAllowance;
          other.agent._chatWithCostAllowance = async (provider, messages, options, cost, meta) => meta?.generationName === 'semantic_control_effect'
            ? { content: '' } : chat(provider, messages, options, cost, meta);
          const plain = await gate(other, 'click_ax', { ref_id: await ref('t') });
          assert.equal(plain.detected?.resolvedOrdinaryActivationTarget, true);
          assert.equal(plain.detected.captionUnread, undefined);
        });

        await t.test('the duplicate-click window exempts draft tools and popups, not ordinary commits by caption', async () => {
          const f = await setup('https://x.com/home', '<nav><a data-testid="AppTabBar_Profile_Link" href="/alice">Profile</a></nav><div><div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">Hello</div><nav aria-label="Composer tools"><button id="emoji" type="button" aria-label="Add emoji">Add emoji</button></nav><button type="button" data-testid="tweetButtonInline">Post</button></div>');
          const emoji = await f.agent._detectLikelySubmitAction(1, 'click', { text: 'Add emoji' });
          assert.equal(emoji?.resolvedDraftControl, true);
          const store = new Map();
          let now = 1_000_000;
          const repeat = async (text, detected) => {
            // What a model read each caption as.
            const read = async caption => fixtureControlEffectReading(caption);
            const first = await guardRecentSubmitClick(store, 1, { text }, async () => 'https://x.com/home', () => now, detected, read);
            now += 5_000;
            return [first, await guardRecentSubmitClick(store, 1, { text }, async () => 'https://x.com/home', () => now, detected, read)];
          };
          assert.deepEqual(await repeat('Add emoji', emoji), [null, null]);
          for (const detected of [{ isSubmit: false, resolvedOrdinaryActivationTarget: true, resolvedPreparatoryTarget: true },
            { isSubmit: false, resolvedNavigationTarget: true }, { isSubmit: false, resolvedEditableTarget: true }]) {
            assert.deepEqual(await repeat('Update', detected), [null, null]);
            store.clear();
          }
          for (const [text, detected] of [['Add to cart', { isSubmit: false, resolvedOrdinaryActivationTarget: true }], ['Place order', { isSubmit: true }], ['Create', null]]) {
            const [first, second] = await repeat(text, detected);
            assert.equal(first, null, text);
            assert.equal(second?.blockedDuplicateSubmit, true, text);
            store.clear();
          }
        });
      } finally {
        globalThis.chrome = originalChrome;
        globalThis.browser = originalBrowser;
        await browser.close();
      }
    });
  }
}
