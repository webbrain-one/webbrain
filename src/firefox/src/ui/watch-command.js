/**
 * Pure parser for the /watch slash command. Keep this module free of browser
 * APIs so Chrome and Firefox can share the exact validation contract and the
 * Node test suite can exercise malformed commands without loading sidepanel.js.
 */

export const WATCH_COMMAND_USAGE =
  '/watch [--keep] [--secs <30-120>] [--long | --short] <condition and action> [/beep]';
export const WATCH_DEFAULT_INTERVAL_SECONDS = 60;
export const WATCH_MIN_INTERVAL_SECONDS = 30;
export const WATCH_MAX_INTERVAL_SECONDS = 120;

function invalid(error, details = {}) {
  return { ok: false, error, usage: WATCH_COMMAND_USAGE, ...details };
}

function nextToken(value) {
  return String(value || '').match(/^\S+/)?.[0] || '';
}

/**
 * Parse one complete /watch invocation.
 *
 * Options intentionally precede the free-form condition. `--` can be used
 * when the condition itself begins with dashes. `/beep` is a trailing
 * modifier so ordinary prose in the condition is preserved verbatim.
 */
export function parseWatchSlashCommand(value) {
  const text = String(value || '').trim();
  const commandMatch = /^\/watch(?:\s|$)/i.exec(text);
  if (!commandMatch) return invalid('not-watch-command');

  let rest = text.slice(commandMatch[0].length).trimStart();
  let keep = false;
  let intervalSeconds = WATCH_DEFAULT_INTERVAL_SECONDS;
  let beepStyle = 'default';
  let explicitBeepStyle = false;
  const seen = new Set();

  while (rest.startsWith('--')) {
    const option = nextToken(rest).toLowerCase();
    if (option === '--') {
      rest = rest.slice(2).trimStart();
      break;
    }
    if (!['--keep', '--secs', '--long', '--short'].includes(option)) {
      return invalid('unknown-option', { option });
    }
    if (seen.has(option)) return invalid('duplicate-option', { option });
    seen.add(option);
    rest = rest.slice(nextToken(rest).length).trimStart();

    if (option === '--keep') {
      keep = true;
      continue;
    }
    if (option === '--secs') {
      const rawSeconds = nextToken(rest);
      if (!/^\d+$/.test(rawSeconds)) return invalid('invalid-seconds');
      intervalSeconds = Number(rawSeconds);
      if (
        !Number.isInteger(intervalSeconds)
        || intervalSeconds < WATCH_MIN_INTERVAL_SECONDS
        || intervalSeconds > WATCH_MAX_INTERVAL_SECONDS
      ) {
        return invalid('invalid-seconds');
      }
      rest = rest.slice(rawSeconds.length).trimStart();
      continue;
    }

    if (explicitBeepStyle) return invalid('conflicting-beep-style');
    explicitBeepStyle = true;
    beepStyle = option.slice(2);
  }

  let prompt = rest.trim();
  let beep = false;
  const beepMatch = /(?:^|\s)\/beep\s*$/i.exec(prompt);
  if (beepMatch) {
    beep = true;
    prompt = prompt.slice(0, beepMatch.index).trimEnd();
    if (/(?:^|\s)\/beep\s*$/i.test(prompt)) {
      return invalid('duplicate-beep');
    }
  }

  if (!prompt) return invalid('missing-prompt');
  if (explicitBeepStyle && !beep) return invalid('beep-style-without-beep');

  return {
    ok: true,
    prompt,
    keep,
    intervalSeconds,
    beep,
    beepStyle: beep ? beepStyle : null,
  };
}
