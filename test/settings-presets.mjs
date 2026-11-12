// The combined switches in Settings → General (src/*/src/settings-presets.js):
// what each preset writes, how a position is read back from stored settings,
// the rules no preset may break, and the markup and copy the switches need.
// The switches themselves are driven in a browser by settings-pages-ui.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

test('the preset modules and their copy are shared verbatim by both builds', () => {
  for (const file of ['settings-presets.js', 'ui/settings-presets-ui.js', 'ui/locales/settings-presets-copy.mjs']) {
    assert.equal(read(`src/chrome/src/${file}`), read(`src/firefox/src/${file}`), file);
  }
});

for (const build of ['chrome', 'firefox']) {
  const {
    PRESET_CUSTOM, PRESET_GROUPS, PRESET_GROUP_IDS, PRESET_SETTING_KEYS,
    detectPreset, presetPatch, presetStorageKeys, presetValues,
  } = await import(`../src/${build}/src/settings-presets.js`);
  const transfer = await import(`../src/${build}/src/config-transfer.js`);
  const options = PRESET_GROUP_IDS.flatMap(group => Object.keys(PRESET_GROUPS[group].options).map(option => [group, option]));

  test(`${build}: untouched settings read as the default presets`, () => {
    assert.deepEqual(PRESET_GROUP_IDS, ['supervision', 'image', 'alerts']);
    assert.equal(detectPreset('supervision', {}), 'balanced');
    assert.equal(detectPreset('image', {}), 'balanced');
    assert.equal(detectPreset('alerts', {}), 'all');
    // An upgrade must change nothing, so each default option is exactly what
    // a config export writes for a profile nobody touched.
    for (const group of PRESET_GROUP_IDS) {
      const { defaultOption, keys } = PRESET_GROUPS[group];
      assert.equal(detectPreset(group, transfer.DEFAULT_CONFIG_SETTINGS), defaultOption, group);
      for (const key of keys) {
        assert.equal(PRESET_GROUPS[group].options[defaultOption][key], transfer.DEFAULT_CONFIG_SETTINGS[key], `${group}.${key}`);
      }
    }
  });

  test(`${build}: every option round-trips through storage`, () => {
    for (const [group, option] of options) {
      const patch = presetPatch(group, option);
      assert.equal(detectPreset(group, patch), option, `${group}.${option}`);
      // Whatever was stored before, picking an option lands on that option.
      for (const other of Object.keys(PRESET_GROUPS[group].options)) {
        assert.equal(detectPreset(group, { ...presetPatch(group, other), ...patch }), option, `${group}: ${other} to ${option}`);
      }
      assert.deepEqual(Object.keys(PRESET_GROUPS[group].options[option]), PRESET_GROUPS[group].keys, `${group}.${option} sets every key of its group`);
    }
    for (const group of PRESET_GROUP_IDS) {
      const distinct = new Set(Object.values(PRESET_GROUPS[group].options).map(values => JSON.stringify(values)));
      assert.equal(distinct.size, Object.keys(PRESET_GROUPS[group].options).length, `${group}: no two options are the same`);
    }
    assert.equal(new Set(PRESET_SETTING_KEYS).size, PRESET_SETTING_KEYS.length, 'no setting belongs to two groups');
  });

  test(`${build}: no preset turns action guards off or touches a permission or privacy switch`, () => {
    for (const [group, option] of options) {
      const patch = presetPatch(group, option);
      assert.notEqual(patch.enforceActionGuards, false, `${group}.${option}`);
      for (const key of [
        'askBeforeConsequentialActions', 'wb_permissions', 'scheduledRequireConsequentialConfirmation',
        'alwaysAllowApiMutations', 'agentAllowLocalNetwork', 'strictSecretMode', 'screenshotRedaction',
      ]) {
        assert.ok(!Object.hasOwn(patch, key), `${group}.${option} leaves ${key} alone`);
      }
    }
    for (const values of Object.values(PRESET_GROUPS.supervision.options)) assert.equal(values.enforceActionGuards, true);
  });

  test(`${build}: fine-tuned settings read as Custom, and Custom is never applied`, () => {
    assert.equal(detectPreset('supervision', { enforceActionGuards: false }), PRESET_CUSTOM);
    assert.equal(detectPreset('supervision', { leanMode: 'off' }), PRESET_CUSTOM);
    assert.equal(detectPreset('image', { imageDetail: 'low' }), PRESET_CUSTOM);
    assert.equal(detectPreset('alerts', { completionFlashTab: false }), PRESET_CUSTOM);
    assert.equal(detectPreset('no-such-group', {}), PRESET_CUSTOM);
    assert.equal(presetPatch('supervision', PRESET_CUSTOM), null);
    assert.equal(presetPatch('no-such-group', 'balanced'), null);
  });

  test(`${build}: legacy and malformed values read the way the runtime reads them`, () => {
    assert.equal(presetValues('supervision', { planBeforeAct: false }).planBeforeActMode, 'off');
    assert.equal(presetValues('supervision', { planBeforeAct: true }).planBeforeActMode, 'strict');
    assert.equal(presetValues('supervision', { planBeforeActMode: 'try', planBeforeAct: false }).planBeforeActMode, 'try');
    assert.equal(presetValues('supervision', { leanMode: ' ON ' }).leanMode, 'on');
    assert.equal(presetValues('supervision', { leanMode: 'bogus', planReviewMode: 'sometimes' }).leanMode, 'auto');
    assert.equal(presetValues('supervision', { planReviewMode: 'sometimes' }).planReviewMode, 'confidence');
    assert.deepEqual(
      presetValues('image', { visionQuality: 'SHARP', imageDetail: 'bogus', maxImageDimension: '9999', maxScreenshotsPerTurn: 100, autoScreenshot: '' }),
      { visionQuality: 'sharp', imageDetail: 'auto', maxImageDimension: 2048, maxScreenshotsPerTurn: 5, autoScreenshot: 'navigation' },
    );
    assert.deepEqual(presetValues('image', { maxImageDimension: 0, maxScreenshotsPerTurn: null }), PRESET_GROUPS.image.options.balanced);
    assert.deepEqual(presetValues('alerts', { notifySound: false, completionConfetti: null }), { notifySound: false, completionConfetti: true, completionFlashTab: true });
    // The planner's old boolean is read with its replacement and written with it.
    assert.ok(presetStorageKeys('supervision').includes('planBeforeAct'));
    assert.ok(PRESET_SETTING_KEYS.every(key => presetStorageKeys().includes(key)));
    assert.equal(presetPatch('supervision', 'thorough').planBeforeAct, true);
  });

  test(`${build}: everything a preset writes is exported, imported and valid`, () => {
    for (const [group, option] of options) {
      const patch = presetPatch(group, option);
      for (const key of Object.keys(patch)) {
        assert.ok(transfer.CONFIG_STORAGE_KEYS.includes(key), `${group}.${option}: ${key} is part of a config export`);
      }
      const parsed = transfer.parseConfigPatchImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: patch }));
      assert.deepEqual(parsed.settings, patch, `${group}.${option} is a valid config patch`);
      assert.deepEqual(parsed.ignoredKeys, []);
      // Export, then a full import: the switch still reads the same.
      const exported = transfer.createConfigExport(patch);
      const imported = transfer.parseConfigImport(JSON.stringify(exported));
      assert.equal(detectPreset(group, imported.settings), option, `${group}.${option} survives export and import`);
    }
    assert.throws(
      () => transfer.parseConfigPatchImport(JSON.stringify({ schema: transfer.CONFIG_SCHEMA, settings: { imageDetail: 'medium' } })),
      /Invalid value for configuration setting "imageDetail"/,
    );
  });

  test(`${build}: an unset plan-review threshold is the 75% default everywhere`, () => {
    assert.match(read(`src/${build}/src/background.js`), /if \(!Number\.isFinite\(threshold\)\) threshold = 0\.75;/);
    assert.match(read(`src/${build}/src/agent/agent.js`), /const PLAN_REVIEW_CONFIDENCE_DEFAULT = 0\.75;/);
    assert.match(read(`src/${build}/src/ui/settings.js`), /const PLAN_REVIEW_CONFIDENCE_DEFAULT = 75;/);
    assert.equal(transfer.DEFAULT_CONFIG_SETTINGS.planReviewConfidenceThreshold, 75);
  });

  test(`${build}: settings.html has a switch, a heading and one control for everything the presets need`, async () => {
    const html = read(`src/${build}/src/ui/settings.html`);
    const ui = read(`src/${build}/src/ui/settings-presets-ui.js`);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));

    for (const group of PRESET_GROUP_IDS) {
      const select = html.match(new RegExp(`<select id="select-preset-${group}"[^>]*>([\\s\\S]*?)</select>`))?.[1] || '';
      const values = [...select.matchAll(/<option value="([a-z_]+)"/g)].map(match => match[1]);
      assert.deepEqual(values, [...Object.keys(PRESET_GROUPS[group].options), PRESET_CUSTOM], `${group}: one option per preset, then Custom`);
      assert.match(select, new RegExp(`<option value="${PRESET_GROUPS[group].defaultOption}" selected `), `${group}: the default shows before scripts run`);
      assert.match(select, /<option value="custom" data-i18n="st\.presets\.custom" hidden disabled>/, `${group}: Custom cannot be picked`);
      assert.ok(ids.has(`preset-${group}-note`), `${group}: note`);
    }
    // The switches jump to headings that exist.
    for (const [, target] of html.matchAll(/data-preset-jump="([^"]+)"/g)) assert.ok(ids.has(target), `jump target #${target}`);
    // Each setting a preset writes has its Advanced control, named in the UI module.
    const controls = Object.fromEntries([...ui.matchAll(/^ {2}(\w+): '((?:toggle|select)-[a-z-]+)',$/gm)].map(match => [match[1], match[2]]));
    assert.deepEqual(Object.keys(controls).sort(), [...PRESET_SETTING_KEYS].sort(), 'one control per preset setting');
    for (const [key, id] of Object.entries(controls)) assert.ok(ids.has(id), `${key}: #${id} exists`);
    // Rows that depend on a switch name switches that exist.
    const parents = [...html.matchAll(/data-depends-on="([^"]+)"/g)].flatMap(match => match[1].split(' '));
    assert.ok(parents.includes('toggle-scheduled-tasks') && parents.includes('toggle-user-memory-enabled'));
    for (const id of parents) assert.match(html, new RegExp(`<input type="checkbox" id="${id}"`), `parent switch #${id}`);
    assert.match(html, /<script src="settings\.js" type="module"><\/script>[\s\S]*?<script src="settings-presets-ui\.js" type="module"><\/script>/, 'settings-presets-ui.js loads after settings.js');
  });

  test(`${build}: every locale has the switches' copy`, async () => {
    const { settingsPresetsEnglish, settingsPresetsTranslations } = await import(`../src/${build}/src/ui/locales/settings-presets-copy.mjs`);
    const keys = Object.keys(settingsPresetsEnglish);
    const locales = fs.readdirSync(path.join(ROOT, `src/${build}/src/ui/locales`))
      .map(name => name.match(/^([a-z]{2})\.js$/)?.[1]).filter(code => code && code !== 'en');
    assert.ok(locales.length >= 22);
    assert.deepEqual(Object.keys(settingsPresetsTranslations).sort(), [...locales].sort(), 'one block per non-English locale');
    for (const code of locales) {
      assert.deepEqual(Object.keys(settingsPresetsTranslations[code]), keys, `${code}: same keys as English, in order`);
      for (const key of keys) assert.ok(String(settingsPresetsTranslations[code][key] || '').trim(), `${code}: ${key}`);
    }
    // Every key the page asks for exists, and i18n.js merges the copy in.
    const html = read(`src/${build}/src/ui/settings.html`);
    const asked = new Set([...html.matchAll(/data-i18n="(st\.(?:presets|advanced\.group)\.[a-z_.]+)"/g)].map(match => match[1]));
    for (const key of asked) assert.ok(Object.hasOwn(settingsPresetsEnglish, key), key);
    for (const key of ['st.presets.custom_note', 'st.presets.guards_off']) assert.ok(Object.hasOwn(settingsPresetsEnglish, key), key);
    const i18n = read(`src/${build}/src/ui/i18n.js`);
    assert.match(i18n, /\.\.\.settingsPresetsEnglish,/);
    assert.match(i18n, /\.\.\.\(settingsPresetsTranslations\[code\] \|\| \{\}\),/);
  });
}
