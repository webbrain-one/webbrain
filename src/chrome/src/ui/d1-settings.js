import { D1_MODEL_ID, D1_CONSENT_KEY, D1_CONSENT_VERSION } from '../providers/d1-config.js';
import { t } from './i18n.js';

export function initD1Settings(send) {
  const provider = document.getElementById('decision-provider'), controls = document.getElementById('d1-controls'), line = document.getElementById('d1-status'), consent = document.getElementById('d1-consent');
  // Nothing to wire on a page without the Decision section.
  if (!provider || !controls) return async () => {};
  let timer = null, busy = false;
  const show = async () => {
    const selected = provider.value === 'webgpu_d1'; controls.hidden = !selected;
    const model = document.getElementById('decision-model'); model.readOnly = selected;
    document.getElementById('system-one-api-key').disabled = selected;
    if (selected) model.value = D1_MODEL_ID;
    if (!selected) { clearInterval(timer); timer = null; return; }
    await refresh(); if (!timer) timer = setInterval(refresh, 2000);
  };
  // One button downloads what is missing and loads; once the model is in the
  // cache it only loads, which skips the download pass's second verification.
  const loadButton = document.getElementById('d1-load');
  const showLoadButton = snapshot => {
    const cached = snapshot?.loaded === true || snapshot?.cached === true || ['cached', 'ready'].includes(snapshot?.status);
    loadButton.dataset.d1Command = cached ? 'load' : 'download';
    loadButton.dataset.i18n = cached ? 'st.d1.load' : 'st.d1.download';
    loadButton.textContent = t(loadButton.dataset.i18n);
  };
  async function refresh() {
    if (provider.value !== 'webgpu_d1') return;
    try {
      const result = await send('d1_control', { command: 'status' });
      if (!result.success) throw new Error(result.error);
      const snapshot = result.result;
      showLoadButton(snapshot);
      line.textContent = `${snapshot.status || 'idle'}${snapshot.progress ? ` (${Math.round(snapshot.progress)}%)` : ''}${snapshot.error ? ': ' + snapshot.error : ''}${snapshot.adapter ? ' | ' + [snapshot.adapter.vendor, snapshot.adapter.device, snapshot.adapter.description].filter(Boolean).join(' / ') : ''}`;
    } catch (error) { line.textContent = error.message; }
  }
  provider.addEventListener('change', () => { if (provider.value === 'webgpu_d1') document.getElementById('toggle-decision-done').checked = false; void show(); });
  for (const button of controls.querySelectorAll('button[data-d1-command]')) button.addEventListener('click', async () => {
    if (busy) return;
    if (['download', 'load'].includes(button.dataset.d1Command) && !consent.checked) { line.textContent = t('st.d1.need_consent'); return; }
    busy = true; button.disabled = true;
    try {
      const result = await send('d1_control', { command: button.dataset.d1Command, consent: consent.checked, consentVersion: D1_CONSENT_VERSION });
      if (!result.success) throw new Error(result.error);
      await refresh();
    } catch (error) { line.textContent = error.message; }
    finally { busy = false; button.disabled = false; }
  });
  (globalThis.browser || globalThis.chrome).storage.local.get(D1_CONSENT_KEY).then(stored => { consent.checked = stored[D1_CONSENT_KEY] === D1_CONSENT_VERSION; });
  return show;
}
