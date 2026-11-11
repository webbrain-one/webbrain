// Settings → General: the combined switches (../settings-presets.js).
//
// A switch stores nothing of its own. Picking a position writes the settings
// it stands for, and the position shown is read back from those settings, so
// it follows every change made to them: by the Advanced controls on this
// page, by another extension page, or by a config import.
//
// This module also greys out rows whose parent switch is off (rows carrying
// data-depends-on="<checkbox id> [<checkbox id>…]").
//
// Shared verbatim by the Chrome and Firefox builds (test/settings-presets.mjs).

import { t } from './i18n.js';
import {
  PRESET_CUSTOM,
  PRESET_GROUP_IDS,
  detectPreset,
  presetPatch,
  presetSettingValue,
  presetStorageKeys,
} from '../settings-presets.js';

const api = (typeof browser !== 'undefined' && browser?.storage) ? browser : (typeof chrome !== 'undefined' ? chrome : null);

// Fired on a control this module changed, so settings.js can refresh what
// hangs off that control without saving the value again.
const SYNC_EVENT = 'wb-setting-sync';
// Fired by settings.js after it has filled the controls from storage.
const LOADED_EVENT = 'wb-settings-loaded';

// The Advanced control that edits each setting a preset writes.
const CONTROLS = Object.freeze({
  enforceActionGuards: 'toggle-enforce-action-guards',
  strictGuards: 'toggle-strict-guards',
  leanMode: 'select-lean-mode',
  planBeforeActMode: 'select-plan-before-act-mode',
  planReviewMode: 'select-plan-review-mode',
  visionQuality: 'select-vision-quality',
  imageDetail: 'select-image-detail',
  maxImageDimension: 'select-max-image-dimension',
  maxScreenshotsPerTurn: 'select-max-screenshots',
  autoScreenshot: 'select-auto-screenshot',
  notifySound: 'toggle-notify-sound',
  completionConfetti: 'toggle-completion-confetti',
  completionFlashTab: 'toggle-completion-flash-tab',
});
// A legacy storage key and the setting whose control shows it.
const LEGACY_SETTING = Object.freeze({ planBeforeAct: 'planBeforeActMode' });

const WATCHED_KEYS = new Set(presetStorageKeys());
const selects = new Map(PRESET_GROUP_IDS
  .map((groupId) => [groupId, document.getElementById(`select-preset-${groupId}`)])
  .filter(([, select]) => select));

// What storage holds for the watched keys, kept current by onChanged.
let stored = {};

function renderGroup(groupId) {
  const select = selects.get(groupId);
  if (!select) return;
  const option = detectPreset(groupId, stored);
  const custom = select.querySelector(`option[value="${PRESET_CUSTOM}"]`);
  if (custom) custom.hidden = option !== PRESET_CUSTOM;
  select.value = option;

  const note = document.getElementById(`preset-${groupId}-note`);
  if (!note) return;
  const guardsOff = groupId === 'supervision' && presetSettingValue('enforceActionGuards', stored) === false;
  const text = guardsOff ? t('st.presets.guards_off') : option === PRESET_CUSTOM ? t('st.presets.custom_note') : '';
  note.textContent = text;
  note.hidden = !text;
  note.dataset.tone = guardsOff ? 'warning' : 'info';
}

function render() {
  for (const groupId of selects.keys()) renderGroup(groupId);
}

// Show a setting's value on its Advanced control.
function showSetting(key) {
  const control = document.getElementById(CONTROLS[key] || '');
  if (!control) return;
  const value = presetSettingValue(key, stored);
  if (control.type === 'checkbox') {
    if (control.checked === (value === true)) return;
    control.checked = value === true;
  } else {
    if (control.value === String(value)) return;
    control.value = String(value);
  }
  control.dispatchEvent(new Event(SYNC_EVENT));
}

async function load() {
  if (!api?.storage?.local) return;
  stored = await api.storage.local.get(presetStorageKeys()) || {};
  render();
}

for (const [groupId, select] of selects) {
  select.addEventListener('change', async () => {
    const patch = presetPatch(groupId, select.value);
    if (!patch) {
      renderGroup(groupId);
      return;
    }
    Object.assign(stored, patch);
    for (const key of Object.keys(patch)) showSetting(key);
    renderGroup(groupId);
    try {
      await api.storage.local.set(patch);
    } catch {
      // Nothing was saved: show what storage really holds again.
      await load().catch(() => {});
      for (const key of Object.keys(CONTROLS)) showSetting(key);
    }
  });
}

api?.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes).filter((key) => WATCHED_KEYS.has(key));
  if (!keys.length) return;
  for (const key of keys) {
    if (changes[key].newValue === undefined) delete stored[key];
    else stored[key] = changes[key].newValue;
  }
  for (const key of new Set(keys.map((key) => LEGACY_SETTING[key] || key))) showSetting(key);
  render();
});

// The notes are written here, not by data-i18n.
document.addEventListener('wb-locale-changed', render);

// "Fine-tune in Advanced": open the tab that holds the group and go to it.
for (const button of document.querySelectorAll('[data-preset-jump]')) {
  button.addEventListener('click', () => {
    const heading = document.getElementById(button.dataset.presetJump);
    const panel = heading?.closest('.tab-panel');
    if (!heading || !panel) return;
    document.querySelector(`.tab-btn[data-tab="${panel.dataset.panel}"]`)?.click();
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
  });
}

// Rows that only matter while a parent switch is on.
const dependents = [];
for (const row of document.querySelectorAll('[data-depends-on]')) {
  const parents = row.dataset.dependsOn.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean);
  if (!parents.length) continue;
  const apply = () => {
    const on = parents.every((parent) => parent.checked);
    row.classList.toggle('setting-dependent-off', !on);
    for (const control of row.querySelectorAll('input, select, textarea, button')) control.disabled = !on;
  };
  for (const parent of parents) {
    parent.addEventListener('change', apply);
    parent.addEventListener(SYNC_EVENT, apply);
  }
  dependents.push(apply);
}

function applyDependents() {
  for (const apply of dependents) apply();
}

// settings.js fills the parent switches from storage without firing change.
document.addEventListener(LOADED_EVENT, applyDependents);
if (document.documentElement.dataset.settingsReady === 'true') applyDependents();

load().catch(() => {});
