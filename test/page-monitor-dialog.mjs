import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createNativeActionMarker } from '../firefox-companion/session.mjs';
import { sharedBrowsers } from './lib/shared-browsers.mjs';
import { scaled, suiteTimeout } from './lib/time-budget.mjs';

const browsers = sharedBrowsers([chromium, firefox]);

const html = `<!doctype html><style>
body { margin:0;width:1000px;height:700px; }
#composer { position:absolute;left:30px;top:30px;width:450px;height:300px; }
#editor { width:300px;height:90px; }
#timeline { position:absolute;left:600px;top:30px;width:300px; }
#anonymous { position:absolute;left:600px;top:350px;width:300px; }
#anonymous-editor { width:280px;height:60px; }
</style><main id="timeline"><h2 id="timeline-heading">Following</h2><span id="counter">14</span></main>
<div id="composer" role="dialog"><button aria-label="Close">X</button><button>Drafts</button>
<button id="audience">Everyone</button>
<div id="editor" role="textbox" aria-label="Post text" contenteditable="true" data-testid="tweetTextarea_0"></div>
<button>Everyone can reply</button><nav><button>Add photos or video</button><button>Add a GIF</button></nav>
<button id="post" type="button">Post</button></div>
<div id="anonymous" role="toolbar"><div id="anonymous-editor" role="textbox" aria-label="Message" contenteditable="true"></div>
<button id="anonymous-send">Send</button></div>`;

async function fixture(browser, build, role = 'dialog') {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://monitor.test/**', route => route.fulfill({
    contentType: 'text/html', body: html.replace('role="dialog"', `role="${role}"`),
  }));
  await context.addInitScript(() => {
    window.messageListeners = [];
    const runtime = {
      onMessage: { addListener: listener => messageListeners.push(listener), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return {
          active: true, runToken: 'dialog-test', documentToken: message.documentToken,
        };
        if (message.action === 'page_feedback') return { accepted: true };
        return {};
      },
    };
    window.chrome = { runtime }; window.browser = window.chrome;
    window.deliver = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      for (const listener of messageListeners) {
        const asynchronous = listener({ target: 'content', action,
          params: { runToken: 'dialog-test', ...params } }, {}, value => { answered = true; resolve(value); });
        if (answered || asynchronous === true) break;
      }
    });
  });
  for (const file of ['accessibility-tree.js', 'page-monitor.js']) {
    await context.addInitScript({
      content: fs.readFileSync(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8'),
    });
  }
  const page = await context.newPage();
  await page.goto('https://monitor.test/compose');
  await page.waitForFunction(() => window.__wbPageMonitor?.active && window.__wb_ax_installed);
  await page.waitForTimeout(180);
  return { context, page };
}

async function capture(page) {
  return page.evaluate(async () => {
    const snapshot = await deliver('page_monitor_capture_model', { includeTree: true });
    return { ...snapshot, editorRef: __wb_ax_ref(document.getElementById('editor')),
      postRef: __wb_ax_ref(document.getElementById('post')),
      anonymousRef: __wb_ax_ref(document.getElementById('anonymous-send')) };
  });
}

async function validate(page, snapshot, target = { tool: 'type_ax', ref_id: snapshot.editorRef }) {
  return page.evaluate(({ snapshotToken, target }) => deliver('page_monitor_validate_model', {
    snapshotToken, ...target,
  }), { snapshotToken: snapshot.snapshotToken, target });
}

for (const build of ['chrome', 'firefox']) {
  // Sixty isolated scenarios run sequentially; coverage plus other browser files
  // can exhaust a one-minute collection even when every scenario completes.
  // Keep individual hangs bounded while budgeting the full collection by its
  // sixty cases.
  test(`${build}: heading-free dialogs bind their exact action context`, { timeout: suiteTimeout(60) }, async t => {
    const scenario = (name, body) => t.test(name, { timeout: scaled(10000) }, body);
    const browser = await browsers.lease(build === 'chrome' ? chromium : firefox);
    try {
      for (const role of ['dialog', 'alertdialog']) await scenario(`${role}: visible owner and editor are certified without a heading`, async () => {
        const { context, page } = await fixture(browser, build, role);
        try {
          await page.locator('#editor').focus();
          const snapshot = await capture(page);
          assert.equal(snapshot.ready, true);
          assert.ok(snapshot.targetCount >= 6, JSON.stringify(snapshot));
          assert.equal(snapshot.focusedTargetAvailable, true);
          assert.match(snapshot.page.pageContent, new RegExp(`\\b${role} \\[ref_`));
          assert.match(snapshot.page.pageContent, /textbox "Post text"/);
          assert.match(snapshot.page.pageContent, /button "Post"/);
          assert.equal((await validate(page, snapshot)).ready, true);
          assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, true);
          const anonymous = await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.anonymousRef });
          assert.equal(anonymous.ready, false);
          assert.equal(anonymous.reason, 'target_uncovered', 'The background toolbar was not observed in the dialog capture');
        } finally { await context.close(); }
      });

      await scenario('unrelated timeline counts and headings do not invalidate the dialog', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          await page.evaluate(() => {
            document.getElementById('counter').textContent = '15';
            document.getElementById('timeline-heading').textContent = 'Latest activity';
          });
          await page.waitForTimeout(180);
          assert.equal((await validate(page, snapshot)).ready, true);
          assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, true);
        } finally { await context.close(); }
      });

      await scenario('real X structure: deep editor, dangling dialog label and account avatar are certified together', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => {
            const composer = document.getElementById('composer');
            composer.setAttribute('aria-labelledby', 'modal-header');
            const avatar = document.createElement('div');
            avatar.id = 'account-avatar'; avatar.setAttribute('aria-label', 'Emre Sokullu');
            avatar.style.cssText = 'width:40px;height:40px';
            avatar.innerHTML = '<div><img alt="Emre Sokullu" style="width:40px;height:40px"></div>';
            composer.prepend(avatar);
            let child = document.getElementById('editor');
            for (let depth = 0; depth < 40; depth++) {
              const wrapper = document.createElement('div');
              child.before(wrapper); wrapper.append(child); child = wrapper;
            }
            const placeholder = document.createElement('div');
            placeholder.id = 'draft-placeholder'; placeholder.textContent = 'What’s happening?';
            composer.append(placeholder);
            document.getElementById('editor').setAttribute('aria-describedby', placeholder.id);
          });
          await page.locator('#editor').focus();
          const snapshot = await capture(page);
          assert.equal(snapshot.focusedTargetAvailable, true);
          assert.match(snapshot.page.pageContent, /visible identity "Emre Sokullu"/);
          assert.equal((await validate(page, snapshot)).ready, true);
          assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, true);
          await page.evaluate(() => document.getElementById('counter').textContent = '16');
          await page.waitForTimeout(180);
          assert.equal((await validate(page, snapshot)).ready, true);
          await page.evaluate(() => document.getElementById('account-avatar').setAttribute('aria-label', 'Another account'));
          await page.waitForTimeout(180);
          assert.equal((await validate(page, snapshot)).ready, false);
          assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, false);
        } finally { await context.close(); }
      });

      for (const change of ['reference-appears', 'duplicate-reference', 'ancestor-limit']) await scenario(`${change}: deep dialog context remains bounded and exact`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => document.getElementById('composer').setAttribute('aria-labelledby', 'missing-header'));
          const snapshot = await capture(page);
          assert.equal((await validate(page, snapshot)).ready, true);
          await page.evaluate(change => {
            if (change === 'ancestor-limit') {
              let child = document.getElementById('editor');
              for (let index = 0; index < 70; index++) {
                const wrapper = document.createElement('div'); child.before(wrapper); wrapper.append(child); child = wrapper;
              }
            } else {
              for (let index = 0; index < (change === 'duplicate-reference' ? 2 : 1); index++) {
                const label = document.createElement('div'); label.id = 'missing-header'; label.textContent = 'Another destination';
                document.getElementById('composer').append(label);
              }
            }
          }, change);
          await page.waitForTimeout(180);
          assert.equal((await validate(page, snapshot)).ready, false);
          if (change !== 'reference-appears') {
            const current = await capture(page);
            assert.equal((await validate(page, current)).ready, false);
          }
        } finally { await context.close(); }
      });

      for (const labelLength of [160, 2200]) await scenario(`generic account label of ${labelLength} characters is fully observed or stays uncertified`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const label = 'Account ' + 'A'.repeat(labelLength);
          await page.evaluate(label => {
            const avatar = document.createElement('div'); avatar.setAttribute('aria-label', label);
            avatar.style.cssText = 'width:40px;height:40px'; document.getElementById('composer').prepend(avatar);
          }, label);
          const snapshot = await capture(page);
          const result = await validate(page, snapshot);
          if (labelLength === 160) {
            assert.ok(snapshot.page.pageContent.includes(`visible identity ${JSON.stringify(label)}`));
            assert.equal(result.ready, true);
          } else assert.equal(result.ready, false);
        } finally { await context.close(); }
      });

      for (const variant of ['image', 'aria-label', 'title', 'labelledby', 'describedby', 'reference-chain', 'reference-cycle', 'reference-order',
        'oversized-label', 'evidence-budget', 'duplicate-reference', 'dangling-reference', 'separate-form', 'sidebar',
        'editable', 'hidden-visible-child']) await scenario(`${variant}: nested account identities omitted by AX are fully exposed or stay uncertified`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const expected = await page.evaluate(variant => {
            const wrapper = document.createElement('div'); wrapper.id = 'account-wrapper';
            wrapper.setAttribute('aria-label', 'Account avatar'); wrapper.style.cssText = 'width:200px;height:44px';
            const label = document.createElement(variant === 'image' ? 'img' : 'span'); label.id = 'nested-account';
            label.style.cssText = 'display:inline-block;width:28px;height:28px';
            const expected = variant === 'oversized-label' ? 'Alice ' + 'A'.repeat(600)
              : variant === 'aria-label' ? 'Alice ' + 'A'.repeat(160) : 'Alice';
            label.setAttribute(variant === 'image' ? 'alt' : variant === 'title' ? 'title' : 'aria-label', expected);
            wrapper.append(label); document.getElementById('composer').prepend(wrapper);
            const addReference = (id, text) => {
              const reference = document.createElement('div'); reference.id = id; reference.textContent = text;
              reference.style.cssText = 'position:absolute;left:600px;top:520px;width:180px;height:24px';
              document.body.append(reference); return reference;
            };
            if (['labelledby', 'describedby', 'reference-chain', 'reference-cycle', 'reference-order', 'duplicate-reference', 'dangling-reference'].includes(variant)) {
              const reference = addReference('account-label', 'Alice');
              if (variant === 'labelledby') {
                label.removeAttribute('aria-label'); label.setAttribute('aria-labelledby', reference.id);
              } else label.setAttribute('aria-describedby', reference.id);
              if (variant === 'reference-chain' || variant === 'reference-cycle' || variant === 'reference-order') {
                const destination = addReference('account-destination', variant === 'reference-order' ? 'Alice' : 'Workspace one');
                reference.setAttribute('aria-describedby', destination.id);
                if (variant === 'reference-cycle') destination.setAttribute('aria-describedby', reference.id);
                if (variant === 'reference-order') {
                  reference.textContent = 'Profile'; label.setAttribute('aria-label', 'Avatar');
                  document.getElementById('editor').setAttribute('aria-describedby', reference.id);
                }
              } else if (variant === 'duplicate-reference') {
                addReference('account-label', 'Bob');
              } else if (variant === 'dangling-reference') {
                label.removeAttribute('aria-label'); label.setAttribute('aria-labelledby', 'missing-account');
                label.removeAttribute('aria-describedby'); reference.remove();
              }
            } else if (variant === 'evidence-budget') {
              label.setAttribute('aria-label', 'Alice ' + 'A'.repeat(400));
              for (let index = 0; index < 9; index++) {
                const extra = label.cloneNode(); extra.id = `additional-account-${index}`; wrapper.append(extra);
              }
            } else if (variant === 'separate-form' || variant === 'sidebar') {
              const excluded = document.createElement(variant === 'separate-form' ? 'form' : 'aside');
              wrapper.append(excluded); excluded.append(label);
            } else if (variant === 'editable') {
              label.setAttribute('contenteditable', 'true'); label.textContent = 'Private draft';
            } else if (variant === 'hidden-visible-child') {
              label.style.visibility = 'hidden';
              label.innerHTML = '<span style="visibility:visible">Alice</span>';
            }
            // Exercise complete public evidence independently of whether the
            // regular AX formatter happens to include an image/generic label.
            const omitted = [...wrapper.querySelectorAll('*'), wrapper,
              ...document.querySelectorAll('#account-label,#account-destination')];
            const omittedRefs = new Set(omitted.map(node => __wb_ax_ref(node)));
            const originalTree = window.__generateAccessibilityTree;
            window.__generateAccessibilityTree = (...args) => {
              const tree = originalTree(...args);
              return { ...tree, pageContent: tree.pageContent.split('\n')
                .filter(line => ![...omittedRefs].some(ref => line.includes(`[${ref}]`))).join('\n') };
            };
            return expected;
          }, variant);
          const snapshot = await capture(page);
          const editor = await validate(page, snapshot);
          const post = await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef });
          if (['image', 'aria-label', 'title', 'labelledby', 'describedby', 'reference-chain', 'reference-cycle', 'reference-order'].includes(variant)) {
            assert.equal(editor.ready, true, JSON.stringify(editor));
            assert.equal(post.ready, true, JSON.stringify(post));
            const evidence = snapshot.page.pageContent.split('[CURRENT VISIBLE ACTION IDENTITY]')[1];
            assert.ok(evidence.includes(`visible identity ${JSON.stringify(expected)}`), evidence);
            assert.ok(evidence.includes('visible identity "Account avatar"'), evidence);
            if (variant === 'reference-chain' || variant === 'reference-cycle')
              assert.ok(evidence.includes('visible identity "Workspace one"'), evidence);
            await page.evaluate(variant => {
              const node = document.getElementById(variant === 'reference-chain' || variant === 'reference-cycle' || variant === 'reference-order'
                ? 'account-destination' : variant === 'labelledby' || variant === 'describedby' ? 'account-label' : 'nested-account');
              if (node.id !== 'nested-account') node.textContent = 'Bob';
              else node.setAttribute(variant === 'image' ? 'alt' : variant === 'title' ? 'title' : 'aria-label', 'Bob');
            }, variant);
            await page.waitForTimeout(180);
            assert.equal((await validate(page, snapshot)).ready, false);
            assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, false);
          } else {
            assert.equal(editor.ready, false, JSON.stringify(editor));
            assert.equal(post.ready, false, JSON.stringify(post));
          }
        } finally { await context.close(); }
      });

      for (const placement of ['direct-owner', 'owned-form', 'direct-form']) await scenario(`${placement}: plain destination text is fully observed without publishing editable values as identity`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(placement => {
            const owner = document.getElementById('composer');
            const editor = document.getElementById('editor'); editor.textContent = 'Private draft';
            if (placement === 'direct-owner') owner.prepend(document.createTextNode('Replying to Alice'));
            else {
              const form = document.createElement('form');
              if (placement === 'direct-form') {
                form.append(document.createTextNode('Replying to Alice'), document.getElementById('post'));
                owner.append(form);
              } else {
                const label = document.createElement('span'); label.textContent = 'Replying to Alice';
                editor.before(form); form.append(label, editor, document.getElementById('post'));
              }
            }
          }, placement);
          const snapshot = await capture(page);
          // A separate form belongs to its own Post action, so an editor
          // outside it remains conservative while the Post proof binds its text.
          if (placement !== 'direct-form') assert.equal((await validate(page, snapshot)).ready, true);
          assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, true);
          const identities = snapshot.page.pageContent.split('[CURRENT VISIBLE ACTION IDENTITY]')[1];
          assert.match(identities, /Replying to Alice/);
          assert.ok(!identities.includes('Private draft'), 'Additional identity evidence must exclude the editable payload');
          await page.evaluate(placement => {
            const owner = document.getElementById('composer');
            if (placement === 'direct-owner') owner.firstChild.data = 'Replying to Bob';
            else if (placement === 'direct-form') owner.querySelector('form').firstChild.data = 'Replying to Bob';
            else owner.querySelector('form > span').textContent = 'Replying to Bob';
          }, placement);
          await page.waitForTimeout(180);
          assert.equal((await validate(page, snapshot)).ready, false);
          assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, false);
        } finally { await context.close(); }
      });

      for (const variant of ['control-display', 'control-visibility', 'reference-display', 'reference-visibility',
        'readonly-inside-display', 'readonly-inside-visibility', 'readonly-reference-display', 'readonly-reference-visibility']) {
        await scenario(`${variant}: rendered audience changes invalidate an earlier Post certificate despite identical textContent`, async () => {
          const { context, page } = await fixture(browser, build);
          try {
            const original = await page.evaluate(variant => {
              const audience = document.getElementById('audience');
              const property = variant.endsWith('visibility') ? 'visibility' : 'display';
              const labels = `<span id="alice">Alice</span><span id="bob" style="${property}:${property === 'display' ? 'none' : 'hidden'}">Bob</span>`;
              let root = audience;
              if (variant.includes('reference') || variant.startsWith('readonly')) {
                root = document.createElement('div'); root.id = 'audience-label';
                if (variant.startsWith('readonly')) {
                  root.setAttribute('role', 'textbox'); root.setAttribute('aria-readonly', 'true');
                }
                if (variant.includes('reference')) {
                  root.style.cssText = 'position:absolute;left:600px;top:500px'; document.body.append(root);
                } else {
                  root.style.cssText = 'width:180px;height:22px'; audience.before(root);
                }
                audience.setAttribute('aria-labelledby', root.id);
              }
              root.innerHTML = labels;
              return { name: __wb_ax_name(audience), text: root.textContent, editable: root.isContentEditable,
                role: root.getAttribute('role'), readonly: root.getAttribute('aria-readonly') };
            }, variant);
            await page.waitForTimeout(180);
            const snapshot = await capture(page);
            assert.equal(original.name, 'Alice');
            if (variant.startsWith('readonly')) {
              assert.equal(original.editable, false); assert.equal(original.role, 'textbox'); assert.equal(original.readonly, 'true');
            }
            assert.match(snapshot.page.pageContent, /button "Alice"/);
            assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, true);
            const changed = await page.evaluate(variant => {
              const property = variant.endsWith('visibility') ? 'visibility' : 'display';
              const alice = document.getElementById('alice'), bob = document.getElementById('bob');
              alice.style[property] = property === 'display' ? 'none' : 'hidden';
              bob.style[property] = property === 'display' ? 'inline' : 'visible';
              return { name: __wb_ax_name(document.getElementById('audience')), text: alice.parentElement.textContent };
            }, variant);
            assert.equal(changed.name, 'Bob');
            assert.equal(changed.text, original.text, 'The raw label text stays constant; only its rendered identity changed');
            await page.waitForTimeout(180);
            assert.equal((await validate(page, snapshot)).ready, false);
            assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, false);
          } finally { await context.close(); }
        });
      }

      await scenario('native input continuation tolerates its own new editable text nodes', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.locator('#editor').focus();
          const snapshot = await capture(page);
          const operationId = 'dialog-native-input';
          const prepared = await page.evaluate(params => deliver('page_monitor_prepare', params), {
            operationId, expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true, tool: 'type_text', text: 'xy',
          });
          assert.equal(prepared.modelBindingValid, true);
          const dispatched = await page.evaluate(operationId => deliver('page_monitor_dispatch', {
            operationId, kind: 'input', fenceOnly: true,
          }), operationId);
          assert.equal(dispatched.ready, true);
          let guard = dispatched.guard;
          for (const [index, key] of [...'xy'].entries()) {
            const current = await page.evaluate(guard => deliver('page_monitor_validate', { ...guard, kind: 'input' }), guard);
            assert.equal(current.ready, true, JSON.stringify(current));
            guard = { ...guard, revision: current.revision };
            const marker = createNativeActionMarker(guard, 'input', index + 1);
            await page.evaluate(marker => document.getElementById('editor').setAttribute('data-webbrain-native-action', marker), marker);
            await page.keyboard.press(key);
          }
          assert.equal(await page.locator('#editor').innerText(), 'xy');
        } finally { await context.close(); }
      });

      for (const kind of ['nested-text', 'generic-label', 'display-contents', 'display-contents-label', 'hidden-label-visible-child', 'label-with-editor', 'label-with-shadow', 'label-with-excluded-control', 'open-shadow', 'separate-form', 'labelled-separate-form', 'labelled-sidebar-control', 'separate-article', 'sidebar-identity', 'nav-control-identity', 'nav-control-shadow']) await scenario(`${kind}: destination identity is completely observed or stays uncertified`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(kind => {
            const destination = document.createElement('p'); destination.id = 'destination';
            if (kind === 'display-contents-label' || kind === 'hidden-label-visible-child') {
              destination.setAttribute('aria-label', 'Replying to Alice');
              destination.style.cssText = kind === 'display-contents-label' ? 'display:contents' : 'visibility:hidden';
              destination.innerHTML = '<span style="visibility:visible">Replying to Alice</span>';
            } else if (kind === 'label-with-editor') {
              destination.setAttribute('aria-label', 'Replying to Alice');
              destination.innerHTML = '<div contenteditable="true">Existing message</div>';
            } else if (kind === 'label-with-shadow') {
              destination.setAttribute('aria-label', 'Replying to Alice');
              destination.attachShadow({ mode: 'open' }).innerHTML = '<span>Replying to Alice</span>';
            } else if (kind === 'label-with-excluded-control') {
              destination.setAttribute('aria-label', 'Replying to Alice');
              destination.innerHTML = '<aside><input type="checkbox"></aside>';
            } else if (kind === 'labelled-separate-form') {
              destination.innerHTML = '<form><button aria-label="Replying to Alice" type="button"></button></form>';
            } else if (kind === 'labelled-sidebar-control') {
              destination.innerHTML = '<aside><button aria-label="Replying to Alice" type="button"></button></aside>';
            } else if (kind === 'separate-article') {
              destination.innerHTML = '<article><span>Replying to Alice</span></article>';
            } else if (kind === 'nested-text' || kind === 'display-contents') {
              destination.innerHTML = '<span>Replying to Alice</span>';
              if (kind === 'display-contents') destination.style.display = 'contents';
            } else if (kind === 'open-shadow') {
              destination.style.display = 'contents';
              const host = document.createElement('div'); host.style.display = 'contents';
              host.attachShadow({ mode: 'open' }).innerHTML = '<span>Replying to Alice</span>';
              destination.append(host);
            } else if (kind === 'separate-form') {
              destination.innerHTML = '<form><button type="button">Replying to Alice</button></form>';
            } else if (kind === 'sidebar-identity') {
              destination.innerHTML = '<aside><span data-recipient="Alice"></span></aside>';
            } else if (kind === 'nav-control-identity') {
              destination.innerHTML = '<nav><button><span data-recipient="Alice">Send</span></button></nav>';
            } else if (kind === 'nav-control-shadow') {
              destination.innerHTML = '<nav><button>Send</button></nav>';
              const host = document.createElement('span');
              host.attachShadow({ mode: 'open' }).innerHTML = '<span>Replying to Alice</span>';
              destination.querySelector('button').append(host);
            }
            else { destination.setAttribute('aria-label', 'Replying to Alice'); destination.style.cssText = 'width:180px;height:20px'; }
            document.getElementById('composer').prepend(destination);
          }, kind);
          await page.waitForTimeout(180);
          const snapshot = await capture(page);
          const original = await validate(page, snapshot);
          if (['generic-label', 'nested-text', 'display-contents'].includes(kind)) {
            assert.equal(original.ready, true);
            assert.match(snapshot.page.pageContent, /visible identity "Replying to Alice"/);
          } else {
            assert.equal(original.ready, false);
            if (kind === 'display-contents-label' || kind === 'hidden-label-visible-child')
              assert.equal(original.reason, 'target_uncovered', 'A private footprint without complete public identity evidence cannot certify the target');
            else assert.equal(original.uncertified, true);
          }
          await page.evaluate(kind => {
            const destination = document.getElementById('destination');
            if (kind === 'nested-text' || kind === 'display-contents') destination.firstChild.textContent = 'Replying to Bob';
            else if (kind === 'open-shadow') destination.firstChild.shadowRoot.firstChild.textContent = 'Replying to Bob';
            else if (kind === 'separate-form') destination.querySelector('button').textContent = 'Replying to Bob';
            else if (kind === 'sidebar-identity') destination.querySelector('[data-recipient]').setAttribute('data-recipient', 'Bob');
            else if (kind === 'nav-control-identity') destination.querySelector('[data-recipient]').setAttribute('data-recipient', 'Bob');
            else if (kind === 'nav-control-shadow') destination.querySelector('button > span').shadowRoot.firstChild.textContent = 'Replying to Bob';
            else destination.setAttribute('aria-label', 'Replying to Bob');
          }, kind);
          await page.waitForTimeout(180);
          assert.equal((await validate(page, snapshot)).ready, false);
          assert.equal((await validate(page, snapshot, { tool: 'click_ax', ref_id: snapshot.postRef })).ready, false);
        } finally { await context.close(); }
      });

      await scenario('a weak referenced owner label cannot establish heading-free editor coverage', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => document.getElementById('post').setAttribute('aria-describedby', 'composer'));
          await page.waitForTimeout(180);
          const snapshot = await capture(page);
          const editor = await validate(page, snapshot);
          assert.equal(editor.ready, false);
          assert.equal(editor.uncertified, true, 'An owner recorded with direct text is not a full-text label root');
        } finally { await context.close(); }
      });

      await scenario('new uncovered destination text invalidates an earlier controls-only dialog certificate', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          assert.equal((await validate(page, snapshot)).ready, true);
          await page.evaluate(() => {
            const destination = document.createElement('p'); destination.textContent = 'Replying to Bob';
            document.getElementById('composer').prepend(destination);
          });
          await page.waitForTimeout(180);
          assert.equal((await validate(page, snapshot)).ready, false);
        } finally { await context.close(); }
      });

      for (const change of ['audience', 'control', 'dialog-label', 'dialog-replacement', 'editor-replacement']) {
        await scenario(`${change} invalidates the observed action context`, async () => {
          const { context, page } = await fixture(browser, build);
          try {
            const snapshot = await capture(page);
            await page.evaluate(change => {
              if (change === 'audience') document.getElementById('audience').textContent = 'Private circle';
              if (change === 'control') document.getElementById('post').disabled = true;
              if (change === 'dialog-label') document.getElementById('composer').setAttribute('aria-label', 'Reply to another post');
              if (change === 'dialog-replacement' || change === 'editor-replacement') {
                const node = document.getElementById(change === 'dialog-replacement' ? 'composer' : 'editor');
                node.replaceWith(node.cloneNode(true));
              }
            }, change);
            await page.waitForTimeout(180);
            assert.equal((await validate(page, snapshot)).ready, false);
            assert.equal((await validate(page, snapshot, { tool: 'type_text', selector: '#editor' })).ready, false,
              'Resolving the same selector must not transfer the original certificate to a replacement');
          } finally { await context.close(); }
        });
      }
    } finally { await browser.close(); }
  });
}

test('Chrome and Firefox dialog ownership logic stays byte-identical', () => {
  const source = build => fs.readFileSync(new URL(`../src/${build}/src/content/page-monitor.js`, import.meta.url), 'utf8');
  assert.equal(source('chrome'), source('firefox'));
});

for (const [build, launcher] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: large occluded background remains responsive without acquiring action authority`, async () => {
    const browser = await browsers.lease(launcher);
    const { context, page } = await fixture(browser, build);
    try {
      await page.evaluate(() => {
        const composer = document.getElementById('composer');
        Object.assign(composer.style, { zIndex: '10', background: 'white' });
        const background = document.createElement('div'); background.id = 'large-background';
        for (let group = 0; group < 100; group++) {
          const region = document.createElement('section'); region.setAttribute('role', 'region');
          region.style.cssText = 'position:absolute;left:40px;top:40px;width:100px;height:80px';
          const heading = document.createElement('h2'); heading.textContent = 'Owned background ' + group;
          region.append(heading);
          for (let index = 0; index < 20; index++) {
            const button = document.createElement('button'); button.id = `background-${group}-${index}`;
            button.style.cssText = 'position:absolute;left:0;top:0;width:100px;height:30px';
            const label = document.createElement('span'); label.textContent = 'Background action ' + index;
            button.append(label); region.append(button);
          }
          background.append(region);
        }
        document.body.append(background);
      });
      const measurement = await page.evaluate(async () => {
        const generate = window.__generateAccessibilityTree;
        let treeMs = 0;
        window.__generateAccessibilityTree = (...args) => {
          const start = performance.now();
          try { return generate(...args); }
          finally { treeMs += performance.now() - start; }
        };
        const start = performance.now();
        const snapshot = await deliver('page_monitor_capture_model', { includeTree: true });
        return { snapshot, elapsed: performance.now() - start, treeMs,
          editorRef: __wb_ax_ref(document.getElementById('editor')),
          backgroundRef: __wb_ax_ref(document.getElementById('background-0-0')) };
      });
      console.log(JSON.stringify({ build, captureMs: Math.round(measurement.elapsed), treeMs: Math.round(measurement.treeMs), backgroundControls: 2000 }));
      assert.equal(measurement.snapshot.ready, true);
      assert.ok(measurement.elapsed < 3000, `One model observation must remain responsive: ${measurement.elapsed}ms`);
      const validateTarget = ref_id => page.evaluate(({ snapshotToken, ref_id }) => deliver('page_monitor_validate_model', {
        snapshotToken, tool: 'click_ax', ref_id,
      }), { snapshotToken: measurement.snapshot.snapshotToken, ref_id });
      assert.equal((await validateTarget(measurement.editorRef)).ready, true);
      assert.equal((await validateTarget(measurement.backgroundRef)).ready, false, 'An unobserved background cannot borrow the composer certificate.');
      await page.locator('#audience').evaluate(node => { node.textContent = 'Different audience'; });
      assert.equal((await validateTarget(measurement.editorRef)).ready, false, 'Capture speed cannot weaken the complete local identity fence.');
    } finally { await context.close(); await browser.close(); }
  });
}
