// What a clicked control's caption means is read by a model in any language
// (the control_effect question), never matched against an English word list:
// whether a rapid second click could duplicate it, whether a form could reject
// it, and whether a workflow click submits its form.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureControlEffectReading, fixturePageTextReading, stubPageTextReadings } from './semantic-decision-stub.mjs';

const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area }, runtime: { getURL: value => `extension://test/${value}` },
};

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { guardRecentSubmitClick } = await import(`../src/${build}/src/agent/submit-click-guard.js`);

  test(`${build}: a saved-workflow replay reads page texts with the decision model alone`, async () => {
    const agent = new Agent({ getActive: () => ({}) });
    const mainModel = [];
    agent._semanticDecisions = async (_tab, _kind, { items = [] } = {}, options = {}) => {
      mainModel.push(options.mainModel);
      return items.map(() => ({ choice: 'view', evidence: '', source: 'decision_model' }));
    };
    await agent._readPageTexts(7, 'control_effect', ['Kapat'], {}, { maxChars: 200 });
    // The tab a deterministic replay runs in asks no active model.
    agent._workflowReplayTabs = new Set([8]);
    await agent._readPageTexts(8, 'control_effect', ['Pencereyi kapat'], {}, { maxChars: 200 });
    assert.deepEqual(mainModel, [true, false]);
  });

  test(`${build}: a rapid repeat is blocked only for a caption a model read as a commit, in any language`, async () => {
    const page = 'https://shop.example.test/sepet';
    for (const [caption, blocked] of [['Kaydet', true], ['Onayla', true], ['Gönder', true], ['送信', true],
      ['Devam', false], ['Ekle', false], ['Filtrele', false]]) {
      const store = new Map();
      let now = 1_000_000, urlReads = 0;
      const url = async () => { urlReads += 1; return page; };
      const read = async text => fixtureControlEffectReading(text);
      assert.equal(await guardRecentSubmitClick(store, 1, { text: caption }, url, () => now, null, read), null, caption);
      now += 5_000;
      const second = await guardRecentSubmitClick(store, 1, { text: caption }, url, () => now, null, read);
      assert.equal(second?.blockedDuplicateSubmit === true, blocked, caption);
      // A caption read as committing nothing never needs the tab's address.
      assert.equal(urlReads, fixtureControlEffectReading(caption) === 'commit' ? 2 : 0, caption);
    }
  });

  test(`${build}: an unread caption is recorded and read only when a rapid repeat needs it`, async () => {
    let now = 1_000_000;
    const url = async () => 'https://shop.example.test/form';
    const asked = [];
    const later = reading => async (text, { read }) => { asked.push([text, read]); return read ? reading : null; };
    const store = new Map();
    assert.equal(await guardRecentSubmitClick(store, 1, { text: 'Bestätigen' }, url, () => now, null, later('commit')), null);
    assert.deepEqual(asked, [['Bestätigen', false]], 'The first click does not wait for a reading');
    now += 3_000;
    assert.equal((await guardRecentSubmitClick(store, 1, { text: 'Bestätigen' }, url, () => now, null, later('commit')))
      ?.blockedDuplicateSubmit, true);
    assert.deepEqual(asked.slice(1), [['Bestätigen', false], ['Bestätigen', true]]);
    // A caption no model could read, or a reader that fails, lets the repeat through.
    for (const reader of [later(null), async () => { throw new Error('offline'); }]) {
      const fresh = new Map();
      assert.equal(await guardRecentSubmitClick(fresh, 1, { text: 'Bestätigen' }, url, () => now, null, reader), null);
      assert.equal(await guardRecentSubmitClick(fresh, 1, { text: 'Bestätigen' }, url, () => now + 1_000, null, reader), null);
    }
    // A repeat the user approved on WebBrain's card passes and re-arms the
    // window. No model argument does, and a peek records nothing.
    const acknowledged = new Map();
    const commit = async () => 'commit';
    await guardRecentSubmitClick(acknowledged, 1, { text: 'Pagar' }, url, () => now, null, commit);
    assert.equal((await guardRecentSubmitClick(acknowledged, 1, { text: 'Pagar', _allowResubmit: true }, url, () => now + 500, null, commit))
      ?.blockedDuplicateSubmit, true);
    const peeked = await guardRecentSubmitClick(acknowledged, 1, { text: 'Pagar' }, url, () => now + 600, null, commit, { peek: true });
    assert.equal(peeked?.blockedDuplicateSubmit, true);
    assert.equal(peeked.previousClickAt, now);
    assert.equal(await guardRecentSubmitClick(new Map(), 1, { text: 'Pagar' }, url, () => now, null, commit, { peek: true }), null);
    assert.equal(acknowledged.get(1)[0].ts, now, 'a peek and a refusal leave the record as it was');
    assert.equal(await guardRecentSubmitClick(acknowledged, 1, { text: 'Pagar' }, url, () => now + 1_000, null, commit, { approved: true }), null);
    assert.equal(acknowledged.get(1)[0].ts, now + 1_000);
    assert.equal((await guardRecentSubmitClick(acknowledged, 1, { text: 'Pagar' }, url, () => now + 2_000, null, commit))?.blockedDuplicateSubmit, true);
  });

  test(`${build}: form validation inspects a click by what its caption means, in any language`, () => {
    const agent = new Agent({});
    agent._pageTextReading = fixturePageTextReading;
    const looks = (caption, detected = null, result = { success: true, tag: 'DIV', name: caption }) =>
      agent._formValidationActionLooksSubmit('click_ax', { ref_id: 'ref_9' }, result, detected);
    for (const [caption, expected] of [['Kaydet', true], ['Devam', true], ['Gönder', true], ['保存', true],
      ['Ekle', false], ['Filtrele', false], ['Save', true], ['Add address', false]]) {
      assert.equal(looks(caption), expected, caption);
      assert.equal(looks(caption, { isSubmit: true, validationSubmitEvidence: 'heuristic' }), expected, `${caption} in a form`);
    }
    // An unread caption is no evidence; structure still decides.
    agent._pageTextReading = () => null;
    assert.equal(looks('Save'), false);
    assert.equal(looks('Save', null, { success: true, tag: 'BUTTON', type: 'submit', isSubmitControl: true }), true);
    assert.equal(agent._formValidationActionLooksSubmit('click', { selector: 'button[type=submit]' }, { success: true }), true);
    assert.equal(agent._formValidationActionLooksSubmit('click', { selector: '#submit-order' }, { success: true }), false,
      'Words in a selector are not read');
  });

  test(`${build}: a workflow click submits its form only by structure or a caption read as a commit`, () => {
    const agent = new Agent({});
    agent._pageTextReading = fixturePageTextReading;
    assert.equal(agent._isWorkflowFormSubmitAction('click', { text: 'Gönder' }, { success: true }), true);
    assert.equal(agent._isWorkflowFormSubmitAction('click', { text: 'Devam' }, { success: true }), false);
    assert.equal(agent._isWorkflowFormSubmitAction('click', { selector: 'input[type=submit]' }, { success: true }), true);
    agent._pageTextReading = () => null;
    assert.equal(agent._isWorkflowFormSubmitAction('click', { text: 'Submit' }, { success: true }), false);
  });

  test(`${build}: a search form whose buttons a model read as searching stops counting at completion`, async () => {
    const form = (labels, extra = {}) => ({ label: '', relevant: true, utility: false, utilityReason: null, editableCount: 1,
      submitCount: labels.length, searchCandidate: true, searchUtilityReason: 'semantic_search', submitLabels: labels, ...extra });
    const agent = new Agent({});
    const asked = stubPageTextReadings(agent);
    const state = { relevantFormCount: 5, formDescriptors: [form(['Ara']), form(['Suchen', 'Kaydet']), form(['']),
      form(['Ara'], { submitCount: 2 }), { label: 'Profil', relevant: true, utility: false, submitCount: 1 }] };
    // The fixtures' oracle reads "Ara" and "Suchen" as only changing the view, "Kaydet" as a commit.
    agent._pageTextReading = (kind, text) => (kind === 'control_effect' && ['Ara', 'Suchen'].includes(text) ? 'view'
      : kind === 'control_effect' && text === 'Kaydet' ? 'commit' : null);
    await agent._readCompletionFormSubmits(1, state);
    assert.deepEqual(state.formDescriptors.map(item => item.relevant), [false, true, true, true, true]);
    assert.equal(state.formDescriptors[0].utilityReason, 'semantic_search');
    assert.equal(state.relevantFormCount, 4);
    assert.deepEqual([...new Set(asked.map(item => item.text))].sort(), ['Ara', 'Kaydet', 'Suchen'],
      'Only complete, non-empty captions of search candidates are read');
  });

  test(`${build}: a caption is read once, never when structure decides, and a failed read is no answer`, async () => {
    const agent = new Agent({});
    const asked = stubPageTextReadings(agent);
    assert.equal(await agent._readControlEffect(1, 'Kaydet'), 'commit');
    assert.equal(await agent._readControlEffect(1, 'Kaydet'), 'commit');
    assert.deepEqual(asked.map(item => [item.kind, item.text]), [['control_effect', 'Kaydet']]);
    assert.equal(agent._controlEffectReading('Kaydet'), 'commit');
    assert.equal(await agent._readControlEffect(1, ''), null);
    for (const detected of [{ isSubmit: false, resolvedNavigationTarget: true }, { isSubmit: false, resolvedEditableTarget: true },
      { isSubmit: false, resolvedNonSubmitTarget: true }, { isSubmit: false, resolvedDraftControl: true },
      { isSubmit: false, resolvedOrdinaryActivationTarget: true }, { isSubmit: true, validationSubmitEvidence: 'strong' }]) {
      assert.equal(agent._controlCaptionDecidedByStructure('click_ax', { ref_id: 'ref_1' }, { success: true, name: 'Kaydet' }, detected), true,
        JSON.stringify(detected));
    }
    assert.equal(agent._controlCaptionDecidedByStructure('click_ax', { ref_id: 'ref_1' },
      { success: true, tag: 'BUTTON', type: 'button', isSubmitControl: false, name: 'Kaydet' }, null), true, 'A plain type=button');
    for (const detected of [null, { isSubmit: true, validationSubmitEvidence: 'heuristic' }]) {
      assert.equal(agent._controlCaptionDecidedByStructure('click_ax', { ref_id: 'ref_1' }, { success: true, tag: 'DIV', name: 'Kaydet' }, detected), false);
    }
    // A cost-limit or transport failure while reading leaves the caption
    // unread and never undoes the click; stopping the run still stops it.
    const failing = new Agent({});
    failing._semanticDecisions = async () => { throw Object.assign(new Error('budget'), { code: 'WB_COST_ALLOWANCE' }); };
    failing._checkAbort = () => false;
    assert.equal(await failing._readControlEffect(1, 'Kaydet'), null);
    failing._checkAbort = () => true;
    await assert.rejects(failing._readControlEffect(1, 'Gönder'), /budget/);
  });
}
