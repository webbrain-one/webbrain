import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const ORIGINAL_CALC_CORRECTION = readFileSync(new URL('./fixtures/literal-calculation-correction.txt', import.meta.url), 'utf8').trim();

const passive = [{ kind: 'dom', source: 'page', frameId: 0, target: 'span#views' }];
const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
const page = {
  success: true,
  pageContent: 'region "Photo editor" [ref_1]\n heading "Current photo" [ref_2]\n form "Details" [ref_3]\n'
    + '  textbox "Caption" [ref_4] value="Original"\n  checkbox "Visible" [ref_5] checked=false\n'
    + '  button "Preview" [ref_6] type="button"\n  button "Save" [ref_7] type="submit"\n'
    + 'region "Timeline" [ref_8]\n text "12 views"',
};

for (const build of ['chrome', 'firefox']) {
  const { acceptCalculationAnswerForm, canRetainPageFeedbackCalls, isLiteralCalculationTask, literalCalculationCandidate,
    literalCalculationOutputRequirements, literalCalculationTaskExpression } = await import(`../src/${build}/src/agent/page-feedback-policy.js`);
  test(`${build}: a request's arithmetic is found by structure in any language, never inside a word or code`, () => {
    const expression = '12345678901234567890 * 7 + 0.125';
    for (const task of [
      ORIGINAL_CALC_CORRECTION,
      'Sadece ' + expression + ' hesapla. Tam sonucu bildir ve marker "HESAP_2026_01" ile bitir.',
      'Berechne nur ' + expression + '. Gib das exakte Ergebnis zurück und beende mit marker "RECHNUNG_2026_01".',
      'Calcule seulement ' + expression + '. Retourne le résultat exact et termine avec marker "CALCUL_2026_01".',
      'Only calculate ' + expression + '. Report the exact result and finish with marker "CALC_2026-10-08".',
      '只计算 ' + expression + '，并给出准确结果。',
    ]) assert.equal(literalCalculationCandidate(task), expression, task.slice(0, 40));
    // Two expressions, a second number or a lone number are not one literal
    // arithmetic request.
    for (const task of [`Calculate ${expression} and ${expression}`, `Only calculate ${expression}. Report result and calculate 42.`,
      'Calculate 2 + 2 for my 3 kids.', 'Only calculate 42.', 'Only calculate the current page price.'])
      assert.equal(literalCalculationCandidate(task), null, task);
  });
  test(`${build}: a calculation is literal only with a sure reading of this exact request and expression`, () => {
    const expression = '12345678901234567890 * 7 + 0.125';
    const task = `Only calculate ${expression}; do not interact with the page.`;
    const reading = choice => ({ task, expression, choice });
    for (const choice of ['only_result', 'only_result_with_form']) {
      assert.equal(isLiteralCalculationTask(task, expression, { readScope: 'none', calculationReading: reading(choice) }), true);
      assert.equal(isLiteralCalculationTask(task, expression, { calculationReading: reading(choice) }), true,
        'Without a planner read scope, the reading decides.');
      // The planner's own page reads veto it.
      assert.equal(isLiteralCalculationTask(task, expression, { readScope: 'visible', calculationReading: reading(choice) }), false);
    }
    // No reading, an unsure one, or a reading of other work or of another
    // request or expression never makes it literal.
    for (const scope of [{}, { readScope: 'none' }, { calculationReading: reading(null) },
      { calculationReading: reading('other_work') }, { calculationReading: reading('not_requested') },
      { calculationReading: { ...reading('only_result'), task: task + ' Then post it.' } },
      { calculationReading: { ...reading('only_result'), expression: '2 + 2' } }])
      assert.equal(isLiteralCalculationTask(task, expression, scope), false, JSON.stringify(scope));
    assert.equal(isLiteralCalculationTask(`${task} Then post it.`, expression, { calculationReading: reading('only_result') }), false);
    // The calculator's own spelling of the same arithmetic is the same
    // expression; a different one is not.
    assert.equal(isLiteralCalculationTask(task, '12345678901234567890*7+0.125', { calculationReading: reading('only_result') }), true);
    assert.equal(isLiteralCalculationTask(task, '12345678901234567890 * 7', { calculationReading: reading('only_result') }), false);
    assert.equal(literalCalculationTaskExpression(task, { calculationReading: reading('only_result') }), expression);
    assert.equal(literalCalculationTaskExpression(task, { calculationReading: reading('other_work') }), null);
  });
  test(`${build}: a calculation request in any language is literal when a model reads it so`, () => {
    const expression = '12345678901234567890 * 7 + 0.125';
    for (const task of [
      `只计算 ${expression}，然后给出准确结果，不要与页面交互。`,
      `${expression} を計算して、正確な結果だけを答えてください。`,
      `Sadece ${expression} hesapla ve tam sonucu bildir; sayfaya dokunma.`,
    ]) {
      const scope = { readScope: 'none', deliverables: ['Exact arithmetic result'],
        calculationReading: { task, expression: literalCalculationCandidate(task), choice: 'only_result' } };
      assert.equal(isLiteralCalculationTask(task, expression, scope), true, task);
      assert.deepEqual(literalCalculationOutputRequirements(task, expression, scope),
        { markers: [], suffix: null, onlyScalar: false, scalarAtEnd: false });
      // The same request read as other work keeps the ordinary path.
      assert.equal(isLiteralCalculationTask(task, expression,
        { ...scope, calculationReading: { ...scope.calculationReading, choice: 'other_work' } }), false);
    }
  });
  test(`${build}: the answer form keeps only texts copied from the request`, () => {
    const expression = '2 + 2';
    const task = 'Only calculate 2 + 2. Finish with marker FIRST_END. Include marker SECOND_END.';
    const scope = form => ({ calculationReading: { task, expression, choice: 'only_result_with_form', ...(form ? { form } : {}) } });
    assert.deepEqual(literalCalculationOutputRequirements(task, expression, { calculationReading: { task, expression, choice: 'only_result' } }),
      { markers: [], suffix: null, onlyScalar: false, scalarAtEnd: false });
    const form = acceptCalculationAnswerForm({ only_result: false, result_last: false, ending: 'FIRST_END', include: ['SECOND_END'] }, task);
    assert.deepEqual(form, { markers: ['SECOND_END', 'FIRST_END'], suffix: 'FIRST_END', onlyScalar: false, scalarAtEnd: false });
    assert.deepEqual(literalCalculationOutputRequirements(task, expression, scope(form)), form);
    // A form that cannot be written down leaves the answer to the judge.
    assert.equal(literalCalculationOutputRequirements(task, expression, scope(null)), null);
    for (const answer of [
      { ending: 'THIRD_END' }, // not in the request
      { ending: ' FIRST_END' }, { ending: 'FIRST_END\n' }, { include: ['FIRST_END', 'X'.repeat(81)] },
      { only_result: true, ending: 'FIRST_END' }, // the number alone cannot end with a marker
      { only_result: false, result_last: false, ending: '', include: [] }, // no form at all
      { ending: 7 }, { include: 'FIRST_END' }, null, [], 'FIRST_END',
    ]) assert.equal(acceptCalculationAnswerForm(answer, task), null, JSON.stringify(answer));
    assert.deepEqual(acceptCalculationAnswerForm({ result_last: true }, task),
      { markers: [], suffix: null, onlyScalar: false, scalarAtEnd: true });
    assert.deepEqual(acceptCalculationAnswerForm({ only_result: true }, task),
      { markers: [], suffix: null, onlyScalar: true, scalarAtEnd: false });
  });
  const keep = (name, args, current = page, events = passive) =>
    canRetainPageFeedbackCalls([call(name, args)], { url: 'https://example.com/photo/1', page }, current, events);

  for (const name of ['fetch_url', 'research_url']) {
    for (const method of [undefined, 'GET', 'HEAD', 'get', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const expected = method == null || ['GET', 'HEAD'].includes(method.toUpperCase())
        || (name === 'fetch_url' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()));
      test(`${build}: passive churn ${expected ? 'retains' : 'supersedes'} explicit ${name} ${method || 'default GET'}`, () => {
        assert.equal(keep(name, { url: 'https://example.com/resource', ...(method ? { method } : {}) }), expected);
      });
    }
    for (const extra of [{ replayRequestId: 'captured-post' }, { apiReplayRequestId: 'captured-post' },
      { method: 'POST', body: '{}', replayRequestId: 'captured-post' },
      { method: 'POST', body: '{}', apiReplayRequestId: 'captured-post' }, { method: 'GET', replayRequestId: 'captured-post' },
      { body: 'changed-server-data' }, { method: 'GET', body: '{}' }]) {
      test(`${build}: passive churn supersedes ${name} ${Object.keys(extra).join('+')} payload`, () => {
        assert.equal(keep(name, { url: 'https://example.com/resource', ...extra }), false,
          'A concrete URL does not make mutation/replay arguments independent of page state');
      });
    }
  }

  test(`${build}: explicit API writes survive counters and ad frames but retain intervention fences`, () => {
    const args = { url: 'https://api.mail.test/accounts', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{"address":"fresh@example.test","password":"fixture"}' };
    assert.equal(keep('fetch_url', args), true);
    assert.equal(keep('fetch_url', args, page, [
      { kind: 'navigation', source: 'unknown', frameId: 23 },
      { kind: 'dom', source: 'page', frameId: 0, target: 'span#counter' },
    ]), true);
    for (const event of [
      { kind: 'input', source: 'user', frameId: 0 },
      { kind: 'click', source: 'user', frameId: 23 },
      { kind: 'navigation', source: 'unknown', frameId: 0 },
      { kind: 'dom', source: 'page', frameId: 0, target: 'base' },
    ]) assert.equal(keep('fetch_url', args, page, [event]), false, JSON.stringify(event));
    for (const extra of [{ url: '/accounts' }, { url: 'https://user:pass@example.test/accounts' },
      { body: { address: 'not-a-serialized-payload' } }, { replayRequestId: 'old-request' },
      { apiReplayRequestId: 'old-request' }]) assert.equal(keep('fetch_url', { ...args, ...extra }), false);
  });

  for (const [name, args] of [
    ['click_ax', { ref_id: 'ref_6' }],
    ['type_ax', { ref_id: 'ref_4', text: 'Updated caption' }],
    ['set_field', { ref_id: 'ref_4', text: 'Updated caption' }],
    ['set_checked', { ref_id: 'ref_5', checked: true }],
  ]) {
    test(`${build}: passive counter updates retain unchanged ${name} action context`, () => {
      assert.equal(keep(name, args, { ...page, pageContent: page.pageContent.replace('12 views', '13 views') }), true);
    });
    test(`${build}: passive changes to form values supersede ${name}`, () => {
      assert.equal(keep(name, args, { ...page, pageContent: page.pageContent.replace('value="Original"', 'value="Someone else edited this"') }), false);
    });
    test(`${build}: passive changes to the enclosing entity supersede ${name}`, () => {
      assert.equal(keep(name, args, { ...page, pageContent: page.pageContent.replace('Current photo', 'Different photo') }), false,
        'A heading outside the nearest form still identifies which entity the form acts on');
    });
  }

  test(`${build}: a changed recipient heading outside the nearest form invalidates the send button`, () => {
    const composer = { success: true, pageContent: 'region "Message composer" [ref_1]\n heading "Gamze" [ref_2]\n'
      + ' form "Message" [ref_3]\n  textbox "Message" [ref_4] value="hello"\n  button "Send" [ref_5] type="button"' };
    const changed = { ...composer, pageContent: composer.pageContent.replace('Gamze', 'Someone else') };
    assert.equal(canRetainPageFeedbackCalls([call('click_ax', { ref_id: 'ref_5' })], { page: composer }, changed,
      [{ kind: 'dom', source: 'page', frameId: 0, target: 'h2' }]), false);
  });

  test(`${build}: a native submit remains conservative even with an unchanged snapshot`, () => {
    assert.equal(keep('click_ax', { ref_id: 'ref_7' }), false);
  });
}

for (const build of ['chrome', 'firefox']) {
  const { canRetainPageFeedbackCalls, pageFeedbackCallPolicy } = await import(`../src/${build}/src/agent/page-feedback-policy.js`);
  for (const args of [{ target: 'image' }, { mode: 'main', target: 'image' }, { target: 'video' }, { target: 'auto' }]) {
    test(`${build}: missing ${args.target} prebinding retains only a readonly resolution under counter churn`, () => {
      const state = { url: 'https://x.com/account/status/123/photo/1', mediaBindings: {} };
      assert.equal(pageFeedbackCallPolicy('download_social_media', args, state, page).kind, 'media_resolve');
      assert.equal(canRetainPageFeedbackCalls([call('download_social_media', args)], state, page, passive), true);
      assert.equal(canRetainPageFeedbackCalls([call('download_social_media', args)], state, page,
        [{ kind: 'pointer', source: 'user', frameId: 0 }]), false);
    });
  }
  for (const extra of [{ scroll: true }, { all: true }, { mode: 'all' }, { strategy: 'vision' }, { limit: 2 }]) {
    test(`${build}: media resolution does not authorize ${JSON.stringify(extra)}`, () => {
      assert.equal(pageFeedbackCallPolicy('download_social_media', { target: 'image', ...extra }, {}, page).kind, 'unsafe');
      assert.equal(canRetainPageFeedbackCalls([call('download_social_media', { target: 'image', ...extra })], {}, page, passive), false);
    });
  }
}

for (const build of ['chrome', 'firefox']) {
  const { canRetainPageFeedbackCalls, pageFeedbackCallPolicy } = await import(`../src/${build}/src/agent/page-feedback-policy.js`);
  const state = { url: 'https://ordinary.test/editor', page,
    actionBinding: { snapshotToken: 'private-snapshot', runToken: 'private-run', documentToken: 'private-document' } };
  for (const name of ['download_files', 'download_file']) {
    for (const args of [{ url: 'https://images.test/photo.jpg' },
      { url: 'https://images.test/photo.jpg', filename: 'photo.jpg', urls: [] },
      { url: 'https://images.test/photo.jpg', urls: 'legacy malformed alias' },
      { url: 'javascript:wrong-alias', urls: ['https://images.test/intended.jpg'] }]) {
      test(`${build}: passive download ${name} uses handler URL normalization ${JSON.stringify(args)}`, () => {
        assert.equal(pageFeedbackCallPolicy(name, args, state, page).kind, 'independent');
        assert.equal(canRetainPageFeedbackCalls([call(name, args)], state, page, passive, { pending: true }), true);
      });
    }
    for (const args of [{}, { url: 'javascript:alert(1)' }, { url: 'file:///tmp/private' },
      { url: 'https://images.test/photo.jpg', urls: ['javascript:alert(1)'] },
      { urls: ['https://images.test/photo.jpg', 'file:///tmp/private'] }, { urls: [{ url: 'https://images.test/photo.jpg' }] }]) {
      test(`${build}: passive download ${name} rejects unbound/invalid requests ${JSON.stringify(args)}`, () => {
        assert.equal(canRetainPageFeedbackCalls([call(name, args)], state, page, passive), false);
      });
    }
  }
  test(`${build}: a private snapshot makes a submit/selector only a local validation candidate`, () => {
    const changed = { ...page, truncated: true, pageContent: page.pageContent.replace('Current photo', 'Other photo') };
    assert.equal(pageFeedbackCallPolicy('click_ax', { ref_id: 'ref_7' }, state, changed).kind, 'bound_target');
    assert.equal(pageFeedbackCallPolicy('click', { selector: '#save' }, state, changed).kind, 'bound_target');
    assert.equal(canRetainPageFeedbackCalls([call('click', { selector: '#save' })], state, changed,
      [{ kind: 'pointer', source: 'user', frameId: 0 }]), false);
  });
  for (const [name, args] of [['click', {}], ['click', { selector: '#save', x: 1, y: 1 }],
    ['click', { selector: '#save', allFrames: true }], ['click', { selector: '#save', frameId: 1 }],
    ['click', { selector: '#save', urlFilter: 'other.test' }], ['execute_js', { code: 'save()' }],
    ['iframe_click', { selector: '#save' }]]) {
    test(`${build}: private action snapshots do not certify ${name} ${JSON.stringify(args)}`, () => {
      assert.notEqual(pageFeedbackCallPolicy(name, args, state, page).kind, 'bound_target');
    });
  }
  test(`${build}: model-supplied snapshot fields cannot enable local binding`, () => {
    assert.equal(pageFeedbackCallPolicy('click', { selector: '#save', expectedModelSnapshot: 'invented',
      actionBinding: state.actionBinding }, { page }, page).kind, 'unsafe');
  });
}

for (const build of ['chrome', 'firefox']) {
  const { canRetainPageFeedbackCalls, pageFeedbackCallPolicy } = await import(`../src/${build}/src/agent/page-feedback-policy.js`);
  const state = { url: 'https://ordinary.test/editor', page };
  for (const [name, args] of [['calculate', { expression: '12345678901234567890 * 7 + 0.125' }],
    ['read_pdf', {}], ['get_captcha_capabilities', {}], ['find_text', { text: 'literal match' }],
    ['generate_image', { prompt: 'An authorized illustration' }], ['schedule_task', { title: 'Authorized reminder', prompt: 'Inspect the draft' }],
    ['schedule_resume', { after_seconds: 60 }], ['resize_window', { width: 1280, height: 720 }]]) {
    test(`${build}: self-validating ${name} does not starve under unrelated DOM feedback`, () => {
      assert.notEqual(pageFeedbackCallPolicy(name, args, state, page).kind, 'unsafe');
      assert.equal(canRetainPageFeedbackCalls([call(name, args)], state, page, passive, { pending: true }), true);
      for (const event of [{ kind: 'pointer', source: 'user', frameId: 0 }, { kind: 'navigation', source: 'page', frameId: 0 }]) {
        assert.equal(canRetainPageFeedbackCalls([call(name, args)], state, page, [event]), false);
      }
      // Unknown-attribution DOM is automatic churn (no human gesture), so a
      // self-validating tool proceeds; the supersession budget no longer resets.
      assert.equal(canRetainPageFeedbackCalls([call(name, args)], state, page, [{ kind: 'dom', source: 'unknown', frameId: 0 }]), true);
    });
  }
  for (const outcome of ['partial', 'failed']) {
    test(`${build}: explicit ${outcome} completion survives counters without becoming success`, () => {
      const candidate = call('done', { summary: 'The task remains incomplete.', outcome });
      assert.equal(canRetainPageFeedbackCalls([candidate], state, { success: false }, passive, { pending: true }), true);
      assert.equal(canRetainPageFeedbackCalls([candidate, call('click', { selector: '#save' })], state, page, passive), false);
      assert.equal(canRetainPageFeedbackCalls([candidate], state, page, [{ kind: 'pointer', source: 'user', frameId: 0 }]), false);
    });
  }
  test(`${build}: summary-only Ask completion survives counters and unavailable AX reads`, () => {
    const candidate = call('done', { summary: 'Answer from completed detached research.' });
    const ask = { ...state, runMode: 'ask' };
    for (const currentPage of [page, { success: false }, null]) {
      assert.equal(canRetainPageFeedbackCalls([candidate], ask, currentPage, passive, { pending: true }), true);
    }
    assert.equal(canRetainPageFeedbackCalls([candidate, call('research_url', { url: 'https://example.com' })], ask, page, passive), false);
    for (const feedback of [
      { kind: 'input', source: 'user', frameId: 0 },
      { kind: 'navigation', source: 'page', frameId: 0 },
      { kind: 'dom', source: 'unknown', frameId: 0 },
      { kind: 'dom', source: 'page', frameId: 1 },
      { kind: 'dom', source: 'page', frameId: 0, target: 'style' },
    ]) assert.equal(canRetainPageFeedbackCalls([candidate], ask, page, [feedback]), false);
  });
  test(`${build}: action and unknown modes cannot borrow Ask's summary-only completion`, () => {
    const args = { summary: 'Claimed answer', runMode: 'ask', mode: 'ask' };
    for (const runMode of ['act', 'dev', null, undefined]) {
      assert.equal(pageFeedbackCallPolicy('done', args, { ...state, runMode }, page).kind, 'unsafe');
    }
    for (const outcome of ['failure', '', null, 'invented']) {
      assert.equal(pageFeedbackCallPolicy('done', { summary: 'Incomplete', outcome }, { ...state, runMode: 'ask' }, page).kind, 'unsafe');
    }
    assert.equal(pageFeedbackCallPolicy('done_json', { data: { answer: 'Structured' } }, { ...state, runMode: 'ask' }, page).kind, 'unsafe');
    assert.equal(pageFeedbackCallPolicy('done', { summary: 'Claimed success', outcome: 'success' }, { ...state, runMode: 'ask' }, { success: false }).kind, 'unsafe');
  });
  test(`${build}: selectorless input needs a captured focus before becoming a binding candidate`, () => {
    for (const name of ['type_text', 'press_keys']) {
      assert.equal(pageFeedbackCallPolicy(name, {}, state, page).kind, 'unsafe');
      assert.equal(pageFeedbackCallPolicy(name, {}, { ...state, actionBinding: { snapshotToken: 'private', focusedTargetAvailable: true } }, page).kind, 'bound_target');
    }
  });
}
