/**
 * Persistent-background audio for /watch alerts. Generated tones keep the
 * alert distinct from Firefox's ordinary side-panel completion chime.
 */

let audioContext = null;
let playback = Promise.resolve();

export function watchAlertPattern(style = 'default') {
  if (style === 'short') {
    return [{ at: 0, duration: 0.12, frequency: 740 }];
  }
  if (style === 'long') {
    return [
      { at: 0, duration: 0.24, frequency: 620 },
      { at: 0.28, duration: 0.24, frequency: 820 },
      { at: 0.56, duration: 0.24, frequency: 1040 },
      { at: 0.88, duration: 0.38, frequency: 820 },
    ];
  }
  return [
    { at: 0, duration: 0.16, frequency: 660 },
    { at: 0.2, duration: 0.2, frequency: 990 },
  ];
}

async function play(style) {
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor) throw new Error('Web Audio is unavailable in the background page.');
  if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextCtor();
  if (audioContext.state === 'suspended') await audioContext.resume();

  const pattern = watchAlertPattern(style);
  const start = audioContext.currentTime + 0.02;
  for (const tone of pattern) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const toneStart = start + tone.at;
    const toneEnd = toneStart + tone.duration;
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
    gain.gain.setValueAtTime(0.0001, toneStart);
    gain.gain.exponentialRampToValueAtTime(0.11, toneStart + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(toneStart);
    oscillator.stop(toneEnd + 0.01);
  }
  const end = Math.max(...pattern.map((tone) => tone.at + tone.duration));
  await new Promise((resolve) => setTimeout(resolve, Math.ceil((end + 0.05) * 1000)));
}

export async function playWatchAlert(api, { style = 'default' } = {}) {
  const stored = await api.storage.local.get('notifySound');
  if (stored?.notifySound === false) return { ok: true, muted: true };
  playback = playback.catch(() => {}).then(() => play(style));
  await playback;
  return { ok: true };
}
