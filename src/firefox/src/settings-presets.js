// Settings presets: the combined switches in Settings → General ("Agent
// supervision", "Image quality", "Completion alerts").
//
// A preset is not stored. Choosing one writes the existing settings it stands
// for, and a switch's position is read back from those settings. The agent,
// config export/import and provisioning therefore keep seeing ordinary
// settings, and an upgrade needs no migration: untouched settings read as
// "balanced" / "all", and a combination fine-tuned in Advanced that matches no
// preset reads as PRESET_CUSTOM.
//
// Rules every preset follows:
//   - only the supervision group's "unsupervised" position turns action
//     guards off (it is the one place that setting is offered as a preset);
//     every other preset leaves enforceActionGuards on, and
//   - none touches the permission gate (askBeforeConsequentialActions).
// The permission gate stays an explicit, one-at-a-time choice in Permissions.
//
// This file is shared verbatim by the Chrome and Firefox builds; keep both
// copies byte-identical (test/settings-presets.mjs checks).

export const PRESET_CUSTOM = 'custom';

function oneOf(allowed, fallback) {
  return (value) => (allowed.includes(value) ? value : fallback);
}

const leanMode = oneOf(['auto', 'on', 'off'], 'auto');
const planReviewMode = oneOf(['confidence', 'always', 'never'], 'confidence');
const visionQuality = oneOf(['economy', 'balanced', 'sharp'], 'balanced');
const imageDetail = oneOf(['high', 'low', 'auto'], 'auto');
const autoScreenshot = oneOf(['off', 'navigation', 'state_change', 'every_step'], 'navigation');

// How each setting reads from storage, unset and legacy values included. These
// mirror the readers in background.js, agent.js and ui/settings.js so a switch
// shows the position the runtime is actually using.
const READERS = Object.freeze({
  enforceActionGuards: (stored) => stored.enforceActionGuards !== false,
  strictGuards: (stored) => stored.strictGuards === true,
  leanMode: (stored) => leanMode(String(stored.leanMode ?? '').trim().toLowerCase()),
  // planBeforeAct is the boolean this setting replaced; it only counts while
  // planBeforeActMode is unset.
  planBeforeActMode: (stored) => {
    if (['try', 'strict', 'off'].includes(stored.planBeforeActMode)) return stored.planBeforeActMode;
    if (stored.planBeforeAct === true) return 'strict';
    if (stored.planBeforeAct === false) return 'off';
    return 'try';
  },
  planReviewMode: (stored) => planReviewMode(stored.planReviewMode),
  visionQuality: (stored) => visionQuality(String(stored.visionQuality ?? '').trim().toLowerCase()),
  imageDetail: (stored) => imageDetail(stored.imageDetail),
  maxImageDimension: (stored) => {
    const n = Number(stored.maxImageDimension);
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(2048, Math.round(n))) : 1568;
  },
  maxScreenshotsPerTurn: (stored) => {
    const n = Number(stored.maxScreenshotsPerTurn);
    return stored.maxScreenshotsPerTurn != null && Number.isFinite(n) && n >= 0 ? Math.min(5, Math.floor(n)) : 0;
  },
  autoScreenshot: (stored) => autoScreenshot(stored.autoScreenshot),
  notifySound: (stored) => stored.notifySound !== false,
  completionConfetti: (stored) => stored.completionConfetti !== false,
  completionFlashTab: (stored) => stored.completionFlashTab !== false,
});

// Storage keys a reader consults besides its own.
const LEGACY_KEYS = Object.freeze({ planBeforeActMode: ['planBeforeAct'] });

function group(defaultOption, options) {
  const frozen = {};
  for (const [id, values] of Object.entries(options)) frozen[id] = Object.freeze({ ...values });
  return Object.freeze({
    keys: Object.freeze(Object.keys(options[defaultOption])),
    defaultOption,
    options: Object.freeze(frozen),
  });
}

export const PRESET_GROUPS = Object.freeze({
  // How closely WebBrain checks the agent: planning before acting, plan
  // review stops, and the checks around each action. Unsupervised is Fast
  // with action guards off.
  supervision: group('balanced', {
    thorough: {
      enforceActionGuards: true,
      strictGuards: true,
      leanMode: 'off',
      planBeforeActMode: 'strict',
      planReviewMode: 'always',
    },
    balanced: {
      enforceActionGuards: true,
      strictGuards: false,
      leanMode: 'auto',
      planBeforeActMode: 'try',
      planReviewMode: 'confidence',
    },
    fast: {
      enforceActionGuards: true,
      strictGuards: false,
      leanMode: 'on',
      planBeforeActMode: 'try',
      planReviewMode: 'never',
    },
    unsupervised: {
      enforceActionGuards: false,
      strictGuards: false,
      leanMode: 'on',
      planBeforeActMode: 'try',
      planReviewMode: 'never',
    },
  }),
  // How much image the model gets. Economy leaves imageDetail on 'auto':
  // 'low' makes OpenAI-style endpoints shrink the image on their side, which
  // the extension cannot map coordinates through.
  image: group('balanced', {
    economy: {
      visionQuality: 'economy',
      imageDetail: 'auto',
      maxImageDimension: 1024,
      maxScreenshotsPerTurn: 2,
      autoScreenshot: 'navigation',
    },
    balanced: {
      visionQuality: 'balanced',
      imageDetail: 'auto',
      maxImageDimension: 1568,
      maxScreenshotsPerTurn: 0,
      autoScreenshot: 'navigation',
    },
    sharp: {
      visionQuality: 'sharp',
      imageDetail: 'high',
      maxImageDimension: 2048,
      maxScreenshotsPerTurn: 0,
      autoScreenshot: 'state_change',
    },
  }),
  // What happens when a plan waits for review or a task finishes.
  alerts: group('all', {
    all: { notifySound: true, completionConfetti: true, completionFlashTab: true },
    quiet: { notifySound: false, completionConfetti: false, completionFlashTab: true },
    off: { notifySound: false, completionConfetti: false, completionFlashTab: false },
  }),
});

export const PRESET_GROUP_IDS = Object.freeze(Object.keys(PRESET_GROUPS));

// Every setting a preset writes, across all groups.
export const PRESET_SETTING_KEYS = Object.freeze(PRESET_GROUP_IDS.flatMap((id) => PRESET_GROUPS[id].keys));

// The storage keys to read before asking for a group's position (all groups
// when no group is named): its settings plus the legacy keys their readers use.
export function presetStorageKeys(groupId = null) {
  const keys = groupId ? PRESET_GROUPS[groupId]?.keys || [] : PRESET_SETTING_KEYS;
  return [...new Set(keys.flatMap((key) => [key, ...(LEGACY_KEYS[key] || [])]))];
}

// One setting's effective value given what storage holds.
export function presetSettingValue(key, stored = {}) {
  const read = READERS[key];
  return read ? read(stored || {}) : undefined;
}

// A group's effective settings given what storage holds.
export function presetValues(groupId, stored = {}) {
  const definition = PRESET_GROUPS[groupId];
  if (!definition) return {};
  return Object.fromEntries(definition.keys.map((key) => [key, presetSettingValue(key, stored)]));
}

// The option a group's settings currently add up to, or PRESET_CUSTOM.
export function detectPreset(groupId, stored = {}) {
  const definition = PRESET_GROUPS[groupId];
  if (!definition) return PRESET_CUSTOM;
  const current = presetValues(groupId, stored);
  for (const [id, values] of Object.entries(definition.options)) {
    if (definition.keys.every((key) => current[key] === values[key])) return id;
  }
  return PRESET_CUSTOM;
}

// The settings to write for an option, or null for an unknown one (Custom is
// a reading, never something to apply).
export function presetPatch(groupId, optionId) {
  const values = PRESET_GROUPS[groupId]?.options?.[optionId];
  if (!values) return null;
  const patch = { ...values };
  // Keep the boolean the planner setting replaced in step, as its own control does.
  if (Object.hasOwn(patch, 'planBeforeActMode')) patch.planBeforeAct = patch.planBeforeActMode !== 'off';
  return patch;
}
