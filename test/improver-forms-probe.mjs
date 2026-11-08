// The done verification probe's form facts, as each build's agent.js sends
// them from a real page: a complementary sidebar counts as outside the
// primary content even on a page without a main landmark, a control's type
// tells a caption-less type=button apart from one that sends the form, a
// field's own label or placeholder is reported for a model to read, and a form
// of empty text fields stops counting on a run that typed nothing and sent no
// form. Both builds' probe source runs in Chromium; the snippet is plain page
// script.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

const icon = '<svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle></svg>';
// Mastodon's layout marks no main landmark; its sidebar search has only a
// localized placeholder and an icon-only type=button that clears it.
const noMainPage = `<!doctype html><html><body>
<div class="columns-area__panels">
  <div class="compose-panel"><form id="mastodon-search"><input class="search__input" type="text"
    placeholder="Suchen oder URL einfügen" aria-label="Suchen oder URL einfügen" value=""><button type="button"
    class="search__icon">${icon}</button></form></div>
  <div class="columns-area__panels__main"><article><p>Mein Beitrag ist live.</p></article></div>
</div>
<aside><form id="aside-search"><input type="text" placeholder="Suchen"><button type="button">${icon}</button></form></aside>
<div role="complementary"><form id="complementary-search"><input type="text" aria-label="Ara"></form></div>
</body></html>`;
const mainPage = `<!doctype html><html><body>
<main>
  <form id="draft"><input type="text" placeholder="Suchen" value="Hallo zusammen"><button type="button">${icon}</button></form>
  <form id="send"><input type="text" placeholder="Nachricht"><button>Senden</button></form>
  <aside><form id="aside-in-main"><input type="text" placeholder="Suchen"><button type="reset">${icon}</button></form></aside>
</main>
<aside><form id="aside-submit"><input type="text" placeholder="Suchen"><button>${icon}</button></form></aside>
</body></html>`;
// Mastodon's always-present composer (a textarea, icon buttons, a visibility
// button and Publish, in Turkish), an empty contenteditable reply editor that
// holds only a zero-width space, and a composer that also has a select.
const composerPage = (draft = '') => `<!doctype html><html><body>
<div class="columns-area__panels">
  <div class="compose-panel"><form id="composer" class="compose-form"><textarea class="autosuggest-textarea__textarea"
    placeholder="Neler oluyor?">${draft}</textarea><button type="button">${icon}</button><button type="button">${icon}</button>
    <button type="button">Herkese açık</button><button type="submit">Gönder</button></form></div>
  <div class="columns-area__panels__main"><article><p>Henüz gönderi yok.</p></article></div>
</div>
<form id="editor"><div contenteditable="true" aria-label="Reply">&#8203;</div><button>Reply</button></form>
<form id="with-select"><textarea></textarea><select><option>Public</option></select><button>Post</button></form>
</body></html>`;

async function probeFor(build, { untouchedByRun = false } = {}) {
  const source = await readFile(new URL(`../src/${build}/src/agent/agent.js`, import.meta.url), 'utf8');
  const { classifyCompletionForm } = await import(`../src/${build}/src/agent/completion-invariant.js`);
  const anchor = source.indexOf('const classifyForm = ${classifyCompletionForm.toString()};');
  const visibleStart = source.lastIndexOf('function visible(el) {', anchor);
  const formsStart = source.indexOf("const forms = Array.from(document.querySelectorAll('form')).filter(visible);", anchor);
  const formsEnd = source.indexOf('// Live messages are returned as they are;', formsStart);
  assert.ok(anchor > 0 && visibleStart > 0 && formsStart > anchor && formsEnd > formsStart, `${build}: done probe markers moved`);
  const visibleSource = source.slice(visibleStart, anchor);
  const formsSource = source.slice(formsStart, formsEnd);
  // The template literal's raw text is the page script only while it holds
  // no escapes or interpolations.
  assert.doesNotMatch(visibleSource + formsSource, /\\|\$\{/, `${build}: probe snippet needs template evaluation`);
  // The agent's fact about the run is set between the two snippets and given
  // to every form's classification.
  assert.ok(source.slice(anchor, formsStart).includes(
    "const untouchedByRun = ${formsUntouchedByRun ? 'true' : 'false'};"), `${build}: run fact moved`);
  assert.ok(source.includes('const formsUntouchedByRun = this._completionFormsUntouchedByRun(tabId);'), `${build}: run fact not read`);
  assert.match(formsSource, /^\s*untouchedByRun,$/m, `${build}: the classifier is not given the run fact`);
  return `(() => { ${visibleSource} const classifyForm = ${classifyCompletionForm.toString()};
    const untouchedByRun = ${untouchedByRun}; ${formsSource} return formDescriptors; })()`;
}

const browser = await chromium.launch({ headless: true });
test.after(() => browser.close());

for (const build of ['chrome', 'firefox']) {
  const probe = await probeFor(build);
  const untouchedProbe = await probeFor(build, { untouchedByRun: true });
  const describe = async (html, source = probe) => {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      return Object.fromEntries((await page.evaluate(source)).map(form => [form.label, form]));
    } finally {
      await page.close();
    }
  };

  test(`${build}: a page without a main landmark reports its sidebar search for a reading and treats asides as sidebars`, async () => {
    const forms = await describe(noMainPage);
    assert.deepEqual(forms['mastodon-search'], {
      label: 'mastodon-search', relevant: true, utility: false, utilityReason: null, editableCount: 1, submitCount: 1,
      searchCandidate: true, searchUtilityReason: 'unmarked_search', submitLabels: [''], fieldLabel: 'Suchen oder URL einfügen',
    });
    for (const id of ['aside-search', 'complementary-search']) {
      assert.equal(forms[id].relevant, false, id);
      assert.equal(forms[id].utilityReason, 'passive_utility_shell', id);
    }
  });

  test(`${build}: a draft stays, a sending caption is read, and an icon that can submit waits for a reading`, async () => {
    const forms = await describe(mainPage);
    assert.equal(forms.draft.relevant, true);
    assert.equal(forms.draft.searchCandidate, undefined);
    assert.equal(forms.send.searchCandidate, true);
    assert.deepEqual(forms.send.submitLabels, ['Senden']);
    assert.equal(forms.send.fieldLabel, undefined);
    // An aside inside main is still a sidebar; a reset icon cannot send it.
    assert.equal(forms['aside-in-main'].utilityReason, 'passive_utility_shell');
    // A <button> without a type submits its form, so the shell is not passive.
    assert.equal(forms['aside-submit'].relevant, true);
    assert.equal(forms['aside-submit'].searchCandidate, true);
    assert.equal(forms['aside-submit'].fieldLabel, 'Suchen');
  });

  test(`${build}: an empty composer stops counting only on a run that typed nothing and sent no form`, async () => {
    const idle = await describe(composerPage(), untouchedProbe);
    assert.deepEqual(idle.composer, { label: 'composer', relevant: false, utility: true,
      utilityReason: 'untouched_empty', editableCount: 1, submitCount: 4 });
    // An editor that holds only a zero-width space is empty too.
    assert.equal(idle.editor.utilityReason, 'untouched_empty');
    // A select's state is not an empty value: that form keeps counting.
    assert.equal(idle['with-select'].relevant, true);
    // The same page on a run that typed or sent a form: every form counts.
    const typed = await describe(composerPage());
    for (const id of ['composer', 'editor', 'with-select']) assert.equal(typed[id].relevant, true, id);
    // A draft in the composer keeps it counted whatever the run did.
    assert.equal((await describe(composerPage('Merhaba'), untouchedProbe)).composer.relevant, true);
  });
}
