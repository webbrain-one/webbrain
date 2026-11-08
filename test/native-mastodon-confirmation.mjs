import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { fixtureControlEffectReading, installModelStub, probeWithReadings } from './semantic-decision-stub.mjs';

// Mastodon 4.4 to 4.7 as a trace showed it, in a 1126 px wide tab beside
// WebBrain's panel. Mastodon renders its composer beside the timeline only from
// 1175 px, so there is none here; the signed-in account is in the navigation
// panel (since 4.4); a post's menu mounts at the end of the body, and its
// dangerous entries are Delete and Delete & re-draft; the delete confirmation
// opens a moment after the click, and while it is open ModalRoot marks every
// sibling of .modal-root inert. In the trace WebBrain opened the post's menu,
// chose Sil, and the confirmation that click opened was refused as "not inside
// one identifiable record".
const origin = 'https://mastoturk.org';
const own = id => `${origin}/@ownedqa/${id}`;
const status = (id, text, account = 'ownedqa') => `<article data-id="${id}"><div class="status__wrapper status__wrapper-public focusable" tabindex="0" aria-label="QA ${account}, ${text}, 15 Eki 21:01, ${account}">
<div class="status status-public" id="record-${id}"><div class="status__info"><a href="/@${account}/${id}" class="status__relative-time"><time>9m</time></a>
<a href="/@${account}" title="${account}" class="status__display-name"><span class="display-name"><bdi><strong class="display-name__html">QA ${account}</strong></bdi> <span class="display-name__account">@${account}</span></span></a></div>
<div class="status__content"><div class="status__content__text status__content__text--visible translate" lang="tr"><p>${text}</p></div></div>
<div class="status__action-bar"><div class="status__action-bar__button-wrapper"><button type="button" aria-label="Yanıtla" title="Yanıtla" class="status__action-bar__button icon-button"><svg class="icon icon-reply"></svg></button></div>
<div class="status__action-bar__button-wrapper"><button type="button" aria-label="Daha fazla" aria-expanded="false" title="Daha fazla" id="more-${id}" class="status__action-bar__button icon-button"><svg class="icon icon-ellipsis-h"></svg></button></div></div>
</div></div></article>`;
const accountBar = '<div class="navigation-bar"><div class="account account--minimal"><div class="account__wrapper"><div class="account__info-wrapper"><a class="account__display-name" title="ownedqa" href="/@ownedqa"><span class="display-name"><bdi><strong class="display-name__html">QA</strong></bdi> <span class="display-name__account">@ownedqa</span></span></a></div></div></div></div>';
const navigation = withAccount => `<div class="columns-area__panels__pane columns-area__panels__pane--start columns-area__panels__pane--navigational"><div class="columns-area__panels__pane__inner"><div class="navigation-panel">
<div class="navigation-panel__logo"><a href="/" class="column-link column-link--logo">Mastodon</a></div><form class="search"><input type="text" class="search__input" placeholder="Ara veya bağlantıyı yapıştır"></form>
${withAccount ? accountBar : ''}<div class="navigation-panel__menu"><a class="button navigation-panel__compose-button column-link" href="/publish">Yeni Gönderi</a><a class="column-link" href="/home">Anasayfa</a></div></div></div></div>`;
const composer = '<div class="columns-area__panels__pane columns-area__panels__pane--compositional"><div class="compose-panel"><form class="compose-form"><textarea class="autosuggest-textarea__textarea" placeholder="Aklında ne var?"></textarea></form></div></div>';
const menu = `<div id="menu-X" style="position:absolute;left:600px;top:120px;z-index:5;background:#fff"><div class="dropdown-animation dropdown-menu bottom"><div class="dropdown-menu__arrow bottom"></div><div class="dropdown-menu__container"><ul class="dropdown-menu__container__list">
<li class="dropdown-menu__item"><button data-index="0">Bu gönderiyi genişlet</button></li><li class="dropdown-menu__item"><button data-index="1">Gönderi bağlantısını kopyala</button></li>
<li class="dropdown-menu__separator"></li><li class="dropdown-menu__item"><button data-index="3" id="menu-edit">Düzenle</button></li>
<li class="dropdown-menu__item dropdown-menu__item--dangerous"><button data-index="4" id="menu-delete">Sil</button></li>
<li class="dropdown-menu__item dropdown-menu__item--dangerous"><button data-index="5" id="menu-redraft">Sil, Düzenle ve yeniden-paylaş</button></li></ul></div></div></div>`;
// Mastodon 4.4 and 4.5 render the confirmation as a div; 4.6 and later as a
// form whose confirm button submits it.
const confirmation = shell => {
  const body = '<div class="safety-action-modal__top"><div class="safety-action-modal__confirmation"><h1>Gönderiyi sil?</h1><p>Bu gönderiyi silmek istediğinden emin misin?</p></div></div>';
  return '<div style="pointer-events:auto"><div role="presentation" class="modal-root__overlay"></div><div role="dialog" class="modal-root__container">'
    + (shell === 'form'
      ? `<form class="modal-root__modal safety-action-modal">${body}<div class="safety-action-modal__bottom"><div class="safety-action-modal__actions"><button type="button" class="link-button" id="cancel">İptal</button><button type="submit" class="button" id="confirm">Sil</button></div></div></form>`
      : `<div class="modal-root__modal safety-action-modal">${body}<div class="safety-action-modal__bottom"><div class="safety-action-modal__actions"><button class="link-button" id="cancel">İptal</button><button type="button" class="button" id="confirm">Sil</button></div></div></div>`)
    + '</div></div>';
};
// timerLatency runs every page timer that many milliseconds late, as a content
// process does while the machine is busy; the test's own clock keeps going.
const page = ({ layout = 'narrow', shell = 'classic', deleteModal = true, signedIn = 'ownedqa', entries = 'buttons', timerLatency = 0 } = {}) => `<!doctype html><meta charset="utf-8">
${timerLatency ? `<script>{ const later = window.setTimeout;
  window.setTimeout = (callback, delay = 0, ...rest) => later(callback, Number(delay) + ${Number(timerLatency)}, ...rest); }</script>` : ''}
<style>body{margin:0;font:15px sans-serif}button{padding:8px}.columns-area__panels{display:flex}.columns-area__panels__main{width:600px}.navigation-panel{width:300px}
.modal-root__overlay{position:fixed;inset:0;background:rgba(0,0,0,.4)}.modal-root__container{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
.safety-action-modal{position:relative;background:#fff;padding:20px}svg{width:12px;height:12px;display:inline-block}</style>
<script id="initial-state" type="application/json">${JSON.stringify({ meta: { me: '1', delete_modal: deleteModal },
  accounts: { 1: { id: '1', username: signedIn, acct: signedIn, url: `${origin}/@${signedIn}` } } })}</script>
<div class="app-holder" id="mastodon"><div class="ui"><div class="columns-area__panels">${layout === 'wide' ? composer : ''}
<div class="columns-area__panels__main"><div class="column" role="region" aria-label="Anasayfa"><div role="feed" class="item-list">
${status('200', 'Test gönderisi / Test post')}${status('201', 'WebBrain test gönderisi')}${status('300', 'Başka birinin gönderisi', 'otherqa')}
</div></div></div>${navigation(layout !== 'hidden-account')}</div><div class="modal-root"></div></div></div>
<script>
window.qaDeletes = []; window.qaModal = ${JSON.stringify(confirmation(shell))};
window.qaMenu = ${JSON.stringify(entries === 'links' ? menu.replace(/<button data-index="(\d+)"( id="[^"]+")?>([^<]*)<\/button>/g, '<a href="#" role="button" tabindex="0" data-index="$1"$2>$3</a>') : menu)};
const ui = document.querySelector('.ui'), modalRoot = document.querySelector('.modal-root');
// ModalRoot: every sibling of .modal-root is inert while a modal is open.
const background = inert => { for (const sibling of ui.children) if (sibling !== modalRoot) inert ? sibling.setAttribute('inert', '') : sibling.removeAttribute('inert'); };
window.qaCloseModal = () => { modalRoot.innerHTML = ''; background(false); };
window.qaOpenModal = onConfirm => {
  modalRoot.innerHTML = qaModal; background(true);
  document.querySelector('#confirm').onclick = event => { event.preventDefault(); onConfirm(); qaCloseModal(); };
  document.querySelector('#cancel').onclick = event => { event.preventDefault(); qaCloseModal(); };
};
for (const id of ['200', '201', '300']) {
  const more = document.querySelector('#more-' + id);
  more.onclick = () => {
    if (document.querySelector('[id^="menu-2"],[id^="menu-3"]')) return;
    more.setAttribute('aria-expanded', 'true'); more.setAttribute('aria-controls', 'menu-' + id);
    more.querySelector('svg').setAttribute('class', 'icon icon-close');
    document.body.insertAdjacentHTML('beforeend', qaMenu.replace('menu-X', 'menu-' + id));
    const close = () => { document.querySelector('#menu-' + id)?.remove(); more.setAttribute('aria-expanded', 'false');
      more.querySelector('svg').setAttribute('class', 'icon icon-ellipsis-h'); };
    for (const item of document.querySelectorAll('#menu-' + id + ' [data-index]')) item.onclick = event => {
      event.preventDefault(); close();
      if (!item.closest('.dropdown-menu__item--dangerous')) return;
      // The confirmation's code loads a moment after the click.
      if (${deleteModal}) setTimeout(() => qaOpenModal(() => qaDeletes.push(id)), 60);
      else qaDeletes.push(id);
    };
  };
}
</script>`;

// Lets the page run the timers that a click (or the page itself) started, in
// the page's own time. The confirmation opens on a 60 ms page timer, and
// WebBrain's launcher binding takes the popup that opened on its next 50 ms
// poll. A page runs a timer only after every timer that started before it
// with an equal or shorter delay, so the first wait ends after the page's
// timer has opened the popup, and the second after the poll that follows it.
// A fixed sleep on the Node side could end before a busy content process had
// run either of them.
async function settle(tab) {
  for (const ms of [150, 100]) await tab.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), ms);
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  test(`${build}: a Mastodon delete confirmation opened by WebBrain's own click keeps its post`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      async function fixture(options = {}) {
        const tab = await browser.newPage({ viewport: { width: 1126, height: 745 } });
        await tab.route('**/*', route => route.fulfill({ contentType: 'text/html', body: page(options) }));
        await tab.goto(`${origin}/home`);
        let scope = null;
        const runProbe = (tool, args) => tab.evaluate(({ source, tool, args }) => (0, eval)(`(${source})`)(tool, args),
          { source: Agent._submitActionProbe.toString(), tool, args });
        // A caption reading of null is a caption no model has read yet.
        const probe = (selector, read = fixtureControlEffectReading, overrides = {}) => probeWithReadings(runProbe, 'click', { selector,
          __wbNativeResourceAdapter: 'mastodon', __wbResourceRunToken: 'owned-run', __wbResourceTaskKey: 'owned-task',
          ...(scope ? { __wbOwnedResourceScope: scope } : {}), ...overrides }, read);
        // As the agent carries a delivered, non-submitting click's resource
        // to its next probe.
        const adopt = result => {
          if (result?.actionResource?.complete && result.isSubmit !== true) scope = { ...result.actionResource,
            document: result.frameDocumentIdentity, taskKey: 'owned-task', popupLauncherToken: result.popupLauncherToken || '',
            launcherDispatched: true };
        };
        // Playwright's click is trusted input; the trace's menu click was a
        // synthetic one.
        const click = async (selector, synthetic = false) => {
          if (synthetic) await tab.evaluate(selector => document.querySelector(selector).click(), selector);
          else await tab.click(selector);
          await settle(tab);
        };
        const deletes = () => tab.evaluate(() => window.qaDeletes);
        return { tab, probe, adopt, click, deletes, get scope() { return scope; } };
      }
      const unread = () => null;

      await t.test('the trace: Sil in the menu not read yet, the confirmation it opens keeps the post', async () => {
        const f = await fixture();
        try {
          const more = await f.probe('#more-200');
          assert.equal(more.actionResource?.url, own('200')); assert.ok(more.popupLauncherToken);
          f.adopt(more); await f.click('#more-200');
          const item = await f.probe('#menu-delete', unread);
          assert.equal(item.isSubmit, false); assert.equal(item.resolvedPreparatoryTarget, true);
          assert.equal(item.mutationKind, 'delete', "Mastodon's dangerous entry of the user's own post deletes it");
          assert.equal(item.actionResource?.url, own('200')); assert.ok(item.popupLauncherToken);
          f.adopt(item); await f.click('#menu-delete', true);
          assert.deepEqual(await f.deletes(), [], 'The menu entry only opens the confirmation');
          const confirm = await f.probe('#confirm');
          assert.equal(confirm.mutationKind, 'delete'); assert.equal(confirm.semanticCommit, true);
          assert.equal(confirm.actionResource?.url, own('200'), 'The confirmation belongs to the post whose menu opened it');

          // The deletion guard then decides on that post, instead of refusing
          // the confirmation as unbound.
          const provider = { chat() {} }, agent = new Agent({ getActive: () => provider });
          agent.conversations.set(1, [{ role: 'system', content: 'system' }, { role: 'user', content: `Delete ${own('200')}.` }]);
          agent._startPlanExecutionGuard(1, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
          agent._detectLikelySubmitAction = async () => structuredClone(confirm);
          installModelStub(agent);
          assert.equal(await agent._resourceMutationPreSubmitBlock(1, 'click', { selector: '#confirm' }, confirm, provider), null);
          await f.click('#confirm');
          assert.deepEqual(await f.deletes(), ['200']);
        } finally { await f.tab.close(); }
      });

      for (const layout of ['narrow', 'wide']) await t.test(`${layout} window: the page made inert behind the confirmation still holds the post`, async () => {
        const f = await fixture({ layout });
        try {
          const more = await f.probe('#more-200'); f.adopt(more); await f.click('#more-200');
          const item = await f.probe('#menu-delete'); f.adopt(item); await f.click('#menu-delete');
          assert.equal(await f.tab.evaluate(() => document.querySelector('.columns-area__panels').inert), true);
          const confirm = await f.probe('#confirm');
          assert.equal(confirm.mutationKind, 'delete'); assert.equal(confirm.semanticCommit, true);
          assert.equal(confirm.actionResource?.url, own('200'));
          assert.equal(confirm.actionResource?.account, `${origin}/@ownedqa`);
        } finally { await f.tab.close(); }
      });

      // On a busy machine the page opens the confirmation, and WebBrain's
      // binding takes it, later than a fixed sleep allows for.
      await t.test('a busy page whose timers all run late: the confirmation still keeps its post', async () => {
        const f = await fixture({ timerLatency: 300 });
        try {
          const more = await f.probe('#more-200'); f.adopt(more); await f.click('#more-200');
          const item = await f.probe('#menu-delete'); f.adopt(item); await f.click('#menu-delete');
          const confirm = await f.probe('#confirm');
          assert.equal(confirm?.mutationKind, 'delete', JSON.stringify(confirm)); assert.equal(confirm.semanticCommit, true);
          assert.equal(confirm.actionResource?.url, own('200'));
          await f.click('#confirm');
          assert.deepEqual(await f.deletes(), ['200']);
        } finally { await f.tab.close(); }
      });

      // Where a browser lacks native inert, Mastodon's polyfill also stops
      // pointer events on the page behind the dialog.
      await t.test("an inert polyfill's pointer-events behind the confirmation hide nothing", async () => {
        const f = await fixture();
        try {
          await f.tab.addStyleTag({ content: '[inert]{pointer-events:none;cursor:default}' });
          const more = await f.probe('#more-200'); f.adopt(more); await f.click('#more-200');
          const item = await f.probe('#menu-delete'); f.adopt(item); await f.click('#menu-delete');
          assert.equal(await f.tab.evaluate(() => getComputedStyle(document.querySelector('#record-200')).pointerEvents), 'none');
          assert.equal((await f.probe('#confirm')).actionResource?.url, own('200'));
        } finally { await f.tab.close(); }
      });

      await t.test('no caption read at all: page structure alone binds and classifies the confirmation', async () => {
        const f = await fixture();
        try {
          const more = await f.probe('#more-200', unread); f.adopt(more); await f.click('#more-200');
          const item = await f.probe('#menu-delete', unread); f.adopt(item); await f.click('#menu-delete');
          const confirm = await f.probe('#confirm', unread);
          assert.equal(confirm.mutationKind, 'delete', "Mastodon's own confirm button is a deletion without any reading");
          assert.equal(confirm.semanticCommit, true); assert.equal(confirm.actionResource?.url, own('200'));
        } finally { await f.tab.close(); }
      });

      await t.test('Mastodon 4.6 and later: the confirmation form keeps the post', async () => {
        const f = await fixture({ shell: 'form' });
        try {
          const more = await f.probe('#more-201'); f.adopt(more); await f.click('#more-201');
          const item = await f.probe('#menu-delete'); f.adopt(item); await f.click('#menu-delete');
          const confirm = await f.probe('#confirm');
          assert.equal(confirm.mutationKind, 'delete'); assert.equal(confirm.actionResource?.url, own('201'));
          await f.click('#confirm');
          assert.deepEqual(await f.deletes(), ['201']);
        } finally { await f.tab.close(); }
      });

      // Mastodon 4.3 draws the menu's entries as links styled as buttons, and
      // below 1175 px shows no account bar at all.
      await t.test('Mastodon 4.3: link entries, no account bar, the confirmation still keeps the post', async () => {
        const f = await fixture({ entries: 'links', layout: 'hidden-account' });
        try {
          const more = await f.probe('#more-200'); f.adopt(more); await f.click('#more-200');
          assert.equal(await f.tab.evaluate(() => document.querySelector('#menu-delete').tagName), 'A');
          const item = await f.probe('#menu-delete', unread);
          assert.equal(item.mutationKind, 'delete'); assert.equal(item.actionResource?.url, own('200')); assert.ok(item.popupLauncherToken);
          f.adopt(item); await f.click('#menu-delete');
          const confirm = await f.probe('#confirm');
          assert.equal(confirm.mutationKind, 'delete'); assert.equal(confirm.actionResource?.url, own('200'));
        } finally { await f.tab.close(); }
      });

      // The probe identifies the page's posts once per run, however many of
      // its questions need them: a timeline of the user's own posts behind
      // the confirmation stays quick.
      await t.test('the posts behind the confirmation are identified once per probe run', async () => {
        const f = await fixture();
        try {
          const more = await f.probe('#more-200'); f.adopt(more); await f.click('#more-200');
          const item = await f.probe('#menu-delete'); f.adopt(item); await f.click('#menu-delete');
          await f.tab.evaluate(() => {
            window.qaRecordScans = 0;
            const scan = Document.prototype.querySelectorAll;
            Document.prototype.querySelectorAll = function (selector) {
              if (selector === '.status,.detailed-status') window.qaRecordScans++;
              return scan.call(this, selector);
            };
          });
          const readings = { Sil: 'delete_one', 'İptal': 'view' };
          const confirm = await f.probe('#confirm', fixtureControlEffectReading, { __wbCaptionPass: 'final', __wbCaptionReadings: readings });
          assert.equal(confirm.actionResource?.url, own('200'));
          assert.equal(await f.tab.evaluate(() => window.qaRecordScans), 1);
        } finally { await f.tab.close(); }
      });

      await t.test("the signed-in account comes from the app's own state where the navigation does not show it", async () => {
        const f = await fixture({ layout: 'hidden-account' });
        try {
          const more = await f.probe('#more-200'); f.adopt(more); await f.click('#more-200');
          assert.equal(more.actionResource?.url, own('200'));
          const item = await f.probe('#menu-delete'); f.adopt(item); await f.click('#menu-delete');
          assert.equal((await f.probe('#confirm')).actionResource?.url, own('200'));
        } finally { await f.tab.close(); }
        // Another signed-in account owns none of these posts, and an
        // initial state that disagrees with the navigation names no account.
        for (const options of [{ layout: 'hidden-account', signedIn: 'otherqa' }, { signedIn: 'otherqa' }]) {
          const other = await fixture(options);
          try { assert.equal((await other.probe('#more-200'))?.actionResource ?? null, null, JSON.stringify(options)); }
          finally { await other.tab.close(); }
        }
      });

      await t.test("another account's post binds nothing", async () => {
        const f = await fixture();
        try { assert.equal((await f.probe('#more-300'))?.actionResource ?? null, null); } finally { await f.tab.close(); }
      });

      await t.test('an inert page with no Mastodon dialog open still hides its posts', async () => {
        const f = await fixture();
        try {
          await f.tab.evaluate(() => document.querySelector('.columns-area__panels').setAttribute('inert', ''));
          assert.equal((await f.probe('#more-200'))?.actionResource ?? null, null);
          // A closed modal root does not excuse its inert siblings either.
          await f.tab.evaluate(() => { document.querySelector('.modal-root').innerHTML = '<div></div>'; });
          assert.equal((await f.probe('#more-200'))?.actionResource ?? null, null);
        } finally { await f.tab.close(); }
      });

      await t.test('a confirmation the click did not open borrows nothing', async () => {
        const f = await fixture();
        try {
          const more = await f.probe('#more-200'); f.adopt(more); await f.click('#more-200');
          const item = await f.probe('#menu-delete', unread); f.adopt(item);
          // Not clicked: the page opens the same confirmation by itself.
          await f.tab.evaluate(() => { document.querySelector('[id^="menu-"]').remove(); qaOpenModal(() => qaDeletes.push('script')); });
          await settle(f.tab);
          assert.equal((await f.probe('#confirm'))?.actionResource ?? null, null);
        } finally { await f.tab.close(); }
      });

      await t.test('an ordinary menu entry is no deletion and lends its post to no confirmation', async () => {
        const f = await fixture();
        try {
          const more = await f.probe('#more-200'); f.adopt(more); await f.click('#more-200');
          const edit = await f.probe('#menu-edit', unread);
          assert.notEqual(edit?.mutationKind, 'delete'); assert.ok(!edit?.popupLauncherToken);
          f.adopt(edit); await f.click('#menu-edit');
          await f.tab.evaluate(() => qaOpenModal(() => qaDeletes.push('script')));
          await settle(f.tab);
          assert.equal((await f.probe('#confirm'))?.actionResource ?? null, null);
        } finally { await f.tab.close(); }
      });

      // With Mastodon's confirmation preference off, its dangerous entry
      // deletes at once: it is checked as the deletion itself, read or not.
      await t.test('confirmation preference off: the dangerous entry is the deletion before any reading', async () => {
        const f = await fixture({ deleteModal: false });
        try {
          const more = await f.probe('#more-200'); f.adopt(more); await f.click('#more-200');
          const item = await f.probe('#menu-delete', unread);
          assert.equal(item.isSubmit, true); assert.equal(item.mutationKind, 'delete');
          assert.equal(item.actionResource?.url, own('200')); assert.equal(item.resolvedPreparatoryTarget, undefined);
        } finally { await f.tab.close(); }
      });
    } finally { await browser.close(); }
  });
}
