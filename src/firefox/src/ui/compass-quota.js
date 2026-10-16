// Quota recovery never starts a browser task. Only the explicit Continue/Retry button does.
export function formatQuotaUsd(value, locale) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2,
    maximumFractionDigits: 6 }).format(Number(value) || 0);
}

export function socialComposer(platform, text, shareUrl) {
  const encoded = encodeURIComponent(text);
  return platform === 'x' ? `https://x.com/intent/tweet?text=${encoded}`
    : platform === 'bluesky' ? `https://bsky.app/intent/compose?text=${encoded}`
      : `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl || 'https://webbrain.one/')}`;
}

export function createQuotaController({ t, locale, request, openUrl, continueTask, persist }) {
  const cards = new Map();
  const event = name => { void request('/promotions/events', { event: name }).catch(() => {}); };
  function mount(host, quota, context = {}) {
    if (quota?.code !== 'webbrain_cloud_free_tier_exceeded') return false;
    const operations = cards.get(host)?.operations || { version: 0, submitting: false };
    host.classList.add('compass-quota', 'subscribe-error');
    host.dataset.quota = JSON.stringify(quota);
    host.dataset.quotaContext = JSON.stringify(context);
    host.replaceChildren();
    const el = (tag, text, cls = '') => {
      const node = document.createElement(tag);
      if (text) node.textContent = text;
      if (cls) node.className = cls;
      return node;
    };
    const button = (text, fn, cls = '') => {
      const node = el('button', text, cls);
      node.type = 'button'; node.dataset.bound = 'true'; node.addEventListener('click', fn); return node;
    };
    const state = quota.usage || {};
    let social = state.social_claim;
    const info = el('div', t('quota.used'), 'subscribe-error-text');
    const balance = el('div', '', 'quota-balance');
    const reset = el('div', '', 'quota-reset');
    const actions = el('div', '', 'quota-choices');
    const claimArea = el('div', '', 'quota-claim');
    const status = el('div', '', 'quota-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const share = button(t('quota.get'), async () => {
      host.dataset.claimOpen = 'true';
      try {
        if (social?.status === 'pending') { await inflight; await refresh(); return; }
        operations.version++;
        if (!social?.share_url) social = await request('/promotions/social');
        if (cards.get(host)?.refresh !== refresh) return;
        renderState(); showClaim();
      } catch (error) { status.textContent = error.message; }
    }, 'quota-share');
    const subscribe = button(t('quota.subscribe'), () => { event('checkout_open'); openUrl(quota.subscribe_url); }, 'subscribe-btn');
    actions.append(share, subscribe);
    const resume = button(t(context.retry ? 'sp.retry' : 'sp.continue_btn'), () => {
      if (social && !social.eligible) event('continuation_after_reward');
      continueTask(resume, context);
    }, 'subscribe-resume-btn');
    resume.dataset.resumeMode = context.mode || 'act';
    resume.dataset.resumeForeground = context.foreground ? 'true' : 'false';
    const refreshButton = button(t('quota.refresh'), () => refresh(), 'quota-refresh');
    host.append(info, balance, reset, actions, claimArea, status, refreshButton, resume);

    function renderState() {
      if (cards.get(host)?.refresh !== refresh) return;
      const base = state.base_weekly_allowance_usd ?? state.weekly_limit_usd ?? state.daily_limit_usd;
      balance.textContent = base == null ? '' : t('quota.balance', { base: formatQuotaUsd(base, locale()),
        credit: formatQuotaUsd(social?.remaining_credit_usd ?? state.promotional_balance_usd, locale()) });
      const date = new Date(state.next_reset_at || social?.next_reset_at || '');
      reset.textContent = Number.isNaN(date.getTime()) ? '' : t('quota.reset', { time: date.toLocaleString(locale(), { timeZoneName: 'short' }) });
      share.hidden = social?.eligible === false;
      share.textContent = t(social?.status === 'pending' ? 'quota.check' : 'quota.get');
      if (social?.status === 'pending') status.textContent = t('quota.pending');
      if (social?.status === 'rejected') status.textContent = t('quota.rejected', { reason: social.reason });
      if (social?.status === 'approved') status.textContent = t('quota.approved');
      if (social?.status === 'redeemed') status.textContent = t('quota.redeemed');
      if (host.dataset.claimOpen === 'true') showClaim(false);
      host.dataset.quota = JSON.stringify({ ...quota, usage: { ...state, social_claim: social } });
      persist();
    }

    function showClaim(focus = true) {
      if (!social?.share_url) { return; }
      if (!social.eligible || social.status === 'pending') { claimArea.replaceChildren(); return; }
      // A balance/status refresh must not replace the user's focused editor or draft.
      const existingForm = claimArea.querySelector('form');
      if (existingForm) {
        existingForm.querySelector('button[type="submit"]').disabled = operations.submitting;
        if (focus) claimArea.querySelector('textarea').focus();
        return;
      }
      const rules = el('p', t('quota.rules'));
      const copyLabel = el('label', t('quota.copy'));
      const copy = el('textarea'); copy.rows = 4;
      copy.value = host.dataset.shareCopy ?? t('quota.suggestion', { url: social.share_url });
      copy.addEventListener('input', () => { host.dataset.shareCopy = copy.value; persist(); });
      copyLabel.append(copy);
      const composers = el('div', '', 'quota-composers');
      for (const platform of ['x', 'linkedin', 'bluesky']) composers.append(button(platform === 'x' ? 'X' : platform === 'linkedin' ? 'LinkedIn' : 'Bluesky', () => openUrl(socialComposer(platform, copy.value, social.share_url))));
      const copyButton = button(t('quota.clipboard'), async () => {
        try { await navigator.clipboard.writeText(copy.value); status.textContent = t('quota.copied'); }
        catch { copy.focus(); copy.select(); }
      });
      const form = el('form');
      const platformLabel = el('label', t('quota.platform'));
      const platform = el('select');
      for (const [id, name] of [['x', 'X'], ['linkedin', 'LinkedIn'], ['bluesky', 'Bluesky']]) platform.append(new Option(name, id));
      platform.value = host.dataset.claimPlatform || social.platform || 'x';
      platform.addEventListener('change', () => { host.dataset.claimPlatform = platform.value; persist(); });
      platformLabel.append(platform);
      const urlLabel = el('label', t('quota.url'));
      const url = el('input'); url.type = 'url'; url.required = true; url.placeholder = 'https://';
      url.value = host.dataset.claimUrl || social.post_url || '';
      url.addEventListener('input', () => { host.dataset.claimUrl = url.value; persist(); });
      urlLabel.append(url);
      const submit = el('button', t('quota.submit')); submit.type = 'submit';
      submit.disabled = operations.submitting;
      form.append(platformLabel, urlLabel, submit);
      form.addEventListener('submit', async e => {
        e.preventDefault();
        if (operations.submitting) return;
        operations.submitting = true; operations.version++; submit.disabled = true;
        try {
          social = await request('/promotions/social/claims', { platform: platform.value, post_url: url.value });
          if (cards.get(host)?.refresh !== refresh) return;
          renderState();
        } catch (error) { if (cards.get(host)?.refresh === refresh) status.textContent = error.message; }
        finally {
          operations.submitting = false; submit.disabled = false;
          // A locale remount during submission needs a fresh authoritative snapshot.
          if (cards.get(host)?.refresh !== refresh) void cards.get(host)?.refresh();
        }
      });
      claimArea.append(rules, copyLabel, composers, copyButton, form);
      if (focus) copy.focus();
    }

    let inflight;
    async function refresh() {
      if (operations.submitting) return;
      if (inflight) return inflight;
      const version = operations.version;
      inflight = (async () => {
        try {
          const nextUsage = await request('/usage');
          if (cards.get(host)?.refresh !== refresh || operations.version !== version || operations.submitting) return;
          social = nextUsage.social_claim;
          Object.assign(state, nextUsage);
          status.textContent = nextUsage.tier !== 'free' ? t('quota.ready') : '';
          renderState();
        } catch { if (cards.get(host)?.refresh === refresh && operations.version === version && !operations.submitting) status.textContent = t('quota.unavailable'); }
        finally { inflight = null; }
      })();
      return inflight;
    }
    cards.set(host, { refresh, operations });
    renderState();
    if (!host.dataset.quotaViewed) { host.dataset.quotaViewed = 'true'; event('quota_card_view'); }
    void refresh();
    return true;
  }
  function restore(root, force = false) {
    root.querySelectorAll('.compass-quota[data-quota]').forEach(host => {
      if (cards.has(host) && !force) return;
      try { mount(host, JSON.parse(host.dataset.quota), JSON.parse(host.dataset.quotaContext || '{}')); } catch { /* corrupt history */ }
    });
  }
  async function refreshAll() {
    await Promise.all([...cards].map(([host, card]) => {
      if (!host.isConnected) { cards.delete(host); return; }
      return card.refresh();
    }));
  }
  function forget(host) {
    cards.delete(host);
    delete host.dataset.quota;
    delete host.dataset.quotaContext;
    host.classList.remove('compass-quota');
  }
  return { mount, restore, refreshAll, forget };
}
