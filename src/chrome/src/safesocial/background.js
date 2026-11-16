import { SETTINGS_KEY, CACHE_NAME, normalizeSettings, isInstagramUrl, isMediaUrl, matchingLabels } from './config.js';

export function installSafeSocialBackground(api, runHost) {
  let generation = 0;
  let transition = Promise.resolve();
  // SafeSocial is managed from its section of the Settings page.
  const settingsUrl = api.runtime.getURL('src/ui/settings.html');
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    generation++;
    // Serialize stop against a rapid off/on toggle and pending host creation.
    if (changes[SETTINGS_KEY].newValue?.enabled !== true) {
      transition = transition.then(() => runHost('stop')).catch(() => {});
    }
  });
  async function handle(message, sender) {
    if (sender.id !== api.runtime.id) throw new Error('Invalid classifier caller.');
    const trustedSettings = String(sender.url || '').split(/[?#]/)[0] === settingsUrl;
    if (message.command === 'classify') {
      if (!sender.tab || sender.frameId !== 0 || !isInstagramUrl(sender.url) || !isMediaUrl(message.url)) {
        throw new Error('Classifier is limited to Instagram images.');
      }
    } else if (!trustedSettings || !['prepare', 'status', 'remove'].includes(message.command)) {
      throw new Error('Open SafeSocial settings to manage the classifier.');
    }
    await transition;
    const epoch = generation;
    const settings = normalizeSettings((await api.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
    if (message.command === 'remove') {
      if (settings.enabled) throw new Error('Disable SafeSocial before removing its model.');
      if (epoch !== generation) return { ok: false, disabled: true, status: 'disabled' };
      // A new enable/prepare must wait until deletion has completed.
      const removal = transition.then(async () => {
        await runHost('stop');
        await caches.delete(CACHE_NAME);
      });
      transition = removal.catch(() => {});
      await removal;
      return { ok: true, status: 'idle' };
    }
    if (!settings.enabled || epoch !== generation) return { ok: false, disabled: true, status: 'disabled' };
    const result = await runHost(message.command, { url: message.url });
    // A settings change or disabling the feature invalidates every queued result.
    if (epoch !== generation) return { ok: false, disabled: true, status: 'disabled' };
    return { ok: true, ...result, ...(message.command === 'classify'
      ? { labels: matchingLabels(result.scores, settings), action: settings.action } : {}) };
  }
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== 'safesocial') return false;
    handle(message, sender).then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  });
  return { handle };
}
