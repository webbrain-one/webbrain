/**
 * Audio host for /watch alerts. The scheduler persists the event key before
 * asking this offscreen document to play, so restarts cannot double-play the
 * same event. These generated tones are intentionally distinct from the
 * ordinary task-completion mp3 used by the side panel.
 */

(() => {
  let audioContext = null;
  let playback = Promise.resolve();

  function patternFor(style) {
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
    if (!AudioContextCtor) throw new Error('Web Audio is unavailable in the offscreen document.');
    if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextCtor();
    if (audioContext.state === 'suspended') await audioContext.resume();

    const pattern = patternFor(style);
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'offscreen-watch-audio' || message?.action !== 'play_watch_alert') return;
    playback = playback.catch(() => {}).then(() => play(message.style));
    playback.then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String(error?.message || error) }),
    );
    return true;
  });
})();
