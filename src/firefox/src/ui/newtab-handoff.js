/**
 * Receives a task typed into the WebBrain new tab (newtab/src/features/agent).
 *
 * The new tab stores { id, tabId, text, mode, createdAt, target } under a per-tab key
 * (`wbNewtabHandoff:<tabId>`, so two submissions can never overwrite each other)
 * and opens this panel from its own click handler (Act), or turns its own tab into the
 * full-page chat, which runs this same receiver with `receiver: 'tab-chat'` (Ask). A receiver
 * claims the record only if it is fresh, addressed to the tab it is showing, and meant for it
 * (`target`; none means the panel):
 *   - Ask and Act: the task is filled in and sent straight away, pinned to the mode the
 *     user chose in the new tab (`__mode`), so automatic mode selection cannot change it.
 *     Act therefore starts acting without a further Enter (the new tab warns about this).
 *     Act is first checked for eligibility (`ensureActMode`: selected-text scope, Ask-only
 *     in-browser providers); if it is blocked the text is left in the composer, unsent, and
 *     the mode is untouched. Plan before Act still applies when it is enabled.
 *     If a run is already active in that tab the task is queued behind it, with its pinned
 *     mode, exactly like pressing Send then. If the panel declines to send (plan review
 *     pending, state refresh, ...) the text stays in the composer for the user to send.
 *     If the composer already holds a different draft (the user's own, or an unsent task)
 *     nothing is overwritten, the mode is left as it is, and nothing is sent: the task is
 *     added below the draft for the user to review and send.
 *
 * A second hand-off is held back while an earlier task is still being sent (its text
 * is still sitting in the composer): filling the composer again would make that
 * send see a changed draft and drop it.
 *
 * Nothing is claimed until start() is called, after the panel has finished
 * restoring its chat: sending earlier would be overwritten by the restore. The
 * freshness window is extended by however long that startup took.
 *
 * The Chrome and Firefox copies of this file are identical — edit both together.
 */

export const NEWTAB_HANDOFF_PREFIX = 'wbNewtabHandoff:';
export const newtabHandoffKey = (tabId) => `${NEWTAB_HANDOFF_PREFIX}${tabId}`;
// Which page may claim a record. Act (and anything from an older new tab, which wrote no
// target) goes to the side panel; Ask goes to the full-page chat the new tab turns into. Both can
// be listening for the same tab at once (a panel already open beside the new tab), so each only
// takes its own and leaves the other's where it is.
export const NEWTAB_HANDOFF_TARGET_PANEL = 'panel';
export const NEWTAB_HANDOFF_TARGET_TAB_CHAT = 'tab-chat';
export const newtabHandoffTarget = (raw) => (raw?.target === NEWTAB_HANDOFF_TARGET_TAB_CHAT
  ? NEWTAB_HANDOFF_TARGET_TAB_CHAT
  : NEWTAB_HANDOFF_TARGET_PANEL);
// A task the panel has to hand back (its tab lost focus mid-send, ...) goes to a key only the
// panel writes. Reusing the new tab's key could overwrite a newer task stored there meanwhile,
// and chrome.storage has no compare-and-set to guard that.
export const newtabHandoffRetryKey = (tabId) => `${NEWTAB_HANDOFF_PREFIX}retry:${tabId}`;
export const NEWTAB_HANDOFF_MAX_AGE_MS = 30_000;
export const NEWTAB_HANDOFF_MAX_STARTUP_ALLOWANCE_MS = 120_000;
export const NEWTAB_HANDOFF_MAX_TEXT = 4000;
export const NEWTAB_HANDOFF_SEND_RETRY_MS = 150;
// Give up holding a later hand-off back after this many retries (~15 s). It has to stay well
// under NEWTAB_HANDOFF_MAX_AGE_MS: a record held longer than it is accepted would come out
// stale, unclaimed, after the new tab had already reported success.
export const NEWTAB_HANDOFF_SEND_HOLD_MAX_RETRIES = 100;

/** Returns a clean record, or null when it is malformed, stale or from the future. */
export function normalizeNewtabHandoff(raw, now = Date.now(), maxAgeMs = NEWTAB_HANDOFF_MAX_AGE_MS) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text || text.length > NEWTAB_HANDOFF_MAX_TEXT) return null;
  const mode = raw.mode === 'act' ? 'act' : raw.mode === 'ask' ? 'ask' : null;
  if (!mode) return null;
  const tabId = Number(raw.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  const createdAt = Number(raw.createdAt);
  if (!Number.isFinite(createdAt)) return null;
  if (now - createdAt > maxAgeMs || createdAt - now > 5_000) return null;
  const id = String(raw.id ?? '');
  if (!id) return null;
  return { id, tabId, text, mode, createdAt, target: newtabHandoffTarget(raw) };
}

export function createNewtabHandoff({
  storage,
  onChanged,
  getCurrentTabId,
  getIsProcessing,
  getIsBlocked = () => false,
  getIsDocumentVisible = () => true,
  doc = globalThis.document,
  setMode,
  // Optional: resolves false when Act cannot run here (in-browser model, selected-text scope). The
  // panel explains why itself; the task then waits in the composer, unsent.
  ensureActMode = null,
  getInputEl,
  autoResizeInput,
  sendMessage,
  now = Date.now,
  // NEWTAB_HANDOFF_TARGET_TAB_CHAT for the full-page chat; the side panel keeps the default.
  receiver = NEWTAB_HANDOFF_TARGET_PANEL,
}) {
  const ownRecord = (raw) => newtabHandoffTarget(raw) === receiver;
  const handled = new Set();
  const startedAt = now();
  let ready = false;
  let startupAllowanceMs = 0;
  let startedUpAt = -Infinity; // when start() ran; tasks created before it were delayed by the startup
  let consuming = false;
  let rerun = false;
  let retryTimer = null;
  const retries = new Map(); // tabId -> polls spent waiting for that tab's send
  // The Ask most recently handed to sendMessage, while its text may still be in
  // the composer waiting for the send's own checks to finish.
  // One per tab: a send in preflight on one tab must stay known while another tab is shown.
  const pendingSends = new Map();
  // When a look at storage was first put off because a send still held the composer. A task that
  // sat waiting behind that send is not stale for the time the panel itself kept it waiting.
  const heldSince = new Map(); // tabId -> when
  // The waiting time of tasks put off by that hold, kept until every task it delayed has been
  // looked at (a fresher one may be considered first).
  const heldAllowanceMs = new Map(); // tabId -> ms
  // Writes to the retry slot (a list, written only by this panel) run one after another, so
  // two hand-backs or a hand-back and a claim never overwrite each other.
  let retrySlotWrites = Promise.resolve();
  const serialRetryWrite = (fn) => {
    retrySlotWrites = retrySlotWrites.then(fn, fn);
    return retrySlotWrites;
  };
  const asList = (raw) => (Array.isArray(raw) ? raw : raw == null ? [] : [raw]);
  // Tasks that could not be written back to storage (it was refusing writes). They exist only in
  // memory, so every look at storage first tries to save them again; the retry slot stays the
  // one place they are picked up from.
  const unsaved = [];
  const stashRecord = (record) => serialRetryWrite(async () => {
    const retryKey = newtabHandoffRetryKey(Number(record.tabId));
    try {
      const queue = asList((await storage.get(retryKey))?.[retryKey]);
      if (!queue.some((entry) => entry?.id === record.id)) {
        await storage.set?.({ [retryKey]: [...queue, record] });
      }
      const at = unsaved.findIndex((entry) => entry.id === record.id);
      if (at >= 0) unsaved.splice(at, 1);
      return true;
    } catch {
      if (!unsaved.some((entry) => entry.id === record.id)) unsaved.push(record);
      return false;
    }
  });

  const sendStillHoldsComposer = (tabId) => {
    const pendingSend = pendingSends.get(Number(tabId));
    if (!pendingSend || pendingSend.settled) return false;
    const value = String(getInputEl()?.value ?? '');
    if (value === pendingSend.text) return true;
    // A slash command empties the composer before its (asynchronous) preflight finishes, so an
    // empty box does not yet mean the send has committed. It has once the run is under way, and a
    // send that was queued behind a run settles by itself.
    return pendingSend.text.startsWith('/') && value === '' && (pendingSend.queued || !getIsProcessing());
  };

  function retrySoon(tabId) {
    // Stop polling after the budget instead of forcing the send aside: a send that is still
    // running owns the composer, and putting the next task in beside it would be sent along
    // with it or duplicated when it settles. The waiting task stays in storage and is picked
    // up when that send settles (below) or when the panel is next triggered. The budget belongs
    // to the tab whose send is being waited for, so another tab's polling does not use it up.
    const polls = (retries.get(Number(tabId)) ?? 0) + 1;
    if (polls > NEWTAB_HANDOFF_SEND_HOLD_MAX_RETRIES) {
      retries.delete(Number(tabId));
      return;
    }
    retries.set(Number(tabId), polls);
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      consume();
    }, NEWTAB_HANDOFF_SEND_RETRY_MS);
  }

  async function consume() {
    if (!ready || !getIsDocumentVisible()) return false;
    // A record can arrive while another is being claimed (the new tab unlocks as
    // soon as the first is removed). Remember it and look again when this ends.
    if (consuming) {
      rerun = true;
      return false;
    }
    const tabId = getCurrentTabId();
    if (tabId == null) return false;
    if (sendStillHoldsComposer(tabId)) {
      if (!heldSince.has(Number(tabId))) heldSince.set(Number(tabId), now());
      retrySoon(tabId);
      return false;
    }
    retries.delete(Number(tabId));
    if (heldSince.has(Number(tabId))) {
      heldAllowanceMs.set(
        Number(tabId),
        Math.max(
          heldAllowanceMs.get(Number(tabId)) ?? 0,
          Math.min(now() - heldSince.get(Number(tabId)), NEWTAB_HANDOFF_MAX_STARTUP_ALLOWANCE_MS),
        ),
      );
      heldSince.delete(Number(tabId));
    }
    const primaryKey = newtabHandoffKey(Number(tabId));
    const retryKey = newtabHandoffRetryKey(Number(tabId));
    let key = primaryKey;
    let claimedOne = false;
    consuming = true;
    // Anything that could not be saved earlier gets another try before storage is read.
    for (const record of unsaved.slice()) await stashRecord(record);
    const heldAllowance = heldAllowanceMs.get(Number(tabId)) ?? 0;
    // The shared composer belongs to whichever tab is active now. If the user switches
    // tabs while storage is being read or written, this tab's task must not be applied
    // to the other tab's composer; the switch's own consume() picks up the right one.
    const sameTab = () => Number(getCurrentTabId()) === Number(tabId);
    // Hand a task back for when this tab is shown again, without touching the key the new tab
    // writes to (it unlocks as soon as a record is removed and may already hold the next task).
    const stashForLater = stashRecord;
    const retryWaiting = async () => {
      try {
        return asList((await storage.get(retryKey))?.[retryKey]).some(ownRecord);
      } catch {
        return false;
      }
    };
    // Takes the record just read out of storage: the primary key is simply removed, the retry
    // slot drops that one entry and keeps the others.
    const removeClaimed = (record) => {
      if (key !== retryKey) return storage.remove(key);
      return serialRetryWrite(async () => {
        const rest = asList((await storage.get(retryKey))?.[retryKey]).filter((entry) => entry?.id !== record?.id);
        if (rest.length) await storage.set?.({ [retryKey]: rest });
        else await storage.remove(retryKey);
      });
    };
    try {
      // Every task typed before the panel finished starting was delayed by that startup, whichever
      // tab it belongs to and whichever tab is looked at first.
      const accept = (record) => {
        const delayedByStartup = Number(record?.createdAt) <= startedUpAt ? startupAllowanceMs : 0;
        return normalizeNewtabHandoff(record, now(), NEWTAB_HANDOFF_MAX_AGE_MS + delayedByStartup + heldAllowance);
      };
      let stored = (await storage.get(primaryKey))?.[primaryKey];
      // A record meant for the other receiver of this tab (Ask's full-page chat, while a side panel
      // is open beside the new tab, or the reverse) is not ours: leave it exactly as it is.
      if (stored != null && !ownRecord(stored)) stored = null;
      let handoff = stored == null ? null : accept(stored);
      // A stale or malformed primary record is left where it is: the new tab replaces it once
      // its own lock has run out, and deleting the key from an earlier read could take a task
      // written in between (storage has no compare-and-delete). Look in the retry slot instead.
      if (!handoff && sameTab()) {
        stored = asList((await storage.get(retryKey))?.[retryKey]).find(ownRecord);
        key = retryKey;
        handoff = stored == null ? null : accept(stored);
      }
      if (stored == null) {
        heldAllowanceMs.delete(Number(tabId)); // nothing left that the hold could have delayed
        return false;
      }
      if (!sameTab()) return false;
      if (!handoff) {
        // Only the panel writes the retry slot, so dropping an expired entry is safe.
        if (key === retryKey) {
          await removeClaimed(stored);
          claimedOne = true; // others may be waiting behind it
        }
        return false;
      }
      if (handoff.tabId !== Number(tabId) || handled.has(handoff.id)) return false;

      handled.add(handoff.id);
      try {
        await removeClaimed(stored);
      } catch (error) {
        // Not claimed after all (storage refused): the record is still there, so it must stay claimable.
        handled.delete(handoff.id);
        throw error;
      }
      if (!sameTab()) {
        // Switched during the removal: put the record back for when this tab is shown again.
        handled.delete(handoff.id);
        // The new tab already showed this task as handed over, so it must outlive the freshness
        // window that has been running since it was typed.
        await stashForLater({ ...stored, createdAt: now() });
        return false;
      }

      let actBlocked = false;
      // Checking Act eligibility may switch the panel to Act, which an existing draft must not
      // be subjected to (the task is only added below it), so skip it in that case.
      const draftBefore = String(getInputEl()?.value || '').trim();
      if (handoff.mode === 'act' && ensureActMode && !(draftBefore && draftBefore !== handoff.text)) {
        try {
          // Eligibility only: the mode is switched below, after the composer has been looked at again.
          actBlocked = (await ensureActMode({ switchMode: false })) === false;
        } catch {
          actBlocked = false; // a failed lookup must not block; sending is still checked by the panel
        }
        if (!sameTab()) {
          handled.delete(handoff.id);
          await stashForLater({ ...stored, createdAt: now() });
          return false;
        }
      }

      const input = getInputEl();
      // Never overwrite what is already in the composer. The task goes below it,
      // and the panel keeps the mode that draft was written in: switching it would
      // change what confirming the combined draft does (an Ask draft would become
      // an Act, or the reverse).
      // `existing` is only for the emptiness / equality checks; the draft itself is kept as typed.
      const draft = String(input.value || '');
      const existing = draft.trim();
      const keepsDraft = Boolean(existing) && existing !== handoff.text;
      if (!keepsDraft && !actBlocked) setMode(handoff.mode);
      const composerText = keepsDraft ? `${draft}\n\n${handoff.text}` : handoff.text;
      const fill = () => {
        input.value = composerText;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        autoResizeInput();
      };
      fill();
      input.focus?.();
      if (!getIsBlocked() && !keepsDraft && !actBlocked) {
        // sendMessage reads the composer synchronously when called, so starting it
        // here captures this task. It is not awaited: a send can last a whole run,
        // and that must not hold up later hand-offs or the panel's own startup.
        const send = { text: handoff.text, settled: false, queued: Boolean(getIsProcessing()) };
        pendingSends.set(Number(tabId), send);
        let sending;
        try {
          // __mode pins the mode the user chose in the box: with automatic mode selection the
          // panel would otherwise pick one itself, and Ask must stay read-only while Act acts.
          sending = Promise.resolve(sendMessage({
            ...(getIsProcessing() ? { __deliveryMode: 'queue' } : {}),
            __mode: handoff.mode,
          }));
        } catch (error) {
          sending = Promise.reject(error);
        }
        sending
          .then((result) => result !== false, () => false)
          .then((sent) => {
            send.settled = true;
            if (pendingSends.get(Number(tabId)) === send) pendingSends.delete(Number(tabId));
            // A task that arrived while this send held the composer is waiting; look for it once
            // the recovery below (which runs synchronously) is done.
            queueMicrotask(() => { consume(); });
            // Declined or failed: the new tab already showed success and cleared its
            // box, so make sure the text is still sitting in the composer.
            if (sent) return;
            if (sameTab()) {
              const current = String(input.value || '');
              if (!current.trim()) {
                fill();
              } else if (current.trim() !== handoff.text && !current.endsWith(`\n\n${handoff.text}`)) {
                // The user typed something else while the send was pending: keep their draft and
                // put the task below it (the record is gone, so this is the only copy left).
                input.value = `${current}\n\n${handoff.text}`;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                autoResizeInput();
              }
            } else {
              // The user moved to another tab while the send was being declined, and the
              // composer now belongs to that tab. Hand the task back for its own tab instead.
              stashForLater({ ...stored, id: `${handoff.id}-retry`, createdAt: now() });
            }
          });
      }
      // A task handed back earlier may be waiting behind the one just claimed (removing a
      // primary record raises no change event this panel acts on), so look again if so.
      if (key === primaryKey) {
        claimedOne = await retryWaiting();
        // Nothing else was delayed by the hold: whatever arrives next is judged on its own age.
        if (!claimedOne) heldAllowanceMs.delete(Number(tabId));
      } else {
        // A hand-back was claimed; look again, which finds the next one or clears the allowance.
        claimedOne = true;
      }
      return true;
    } catch {
      return false;
    } finally {
      consuming = false;
      if (rerun || claimedOne) {
        rerun = false;
        queueMicrotask(() => { consume(); });
      }
    }
  }

  /** Call once the panel has finished restoring its chat. */
  function start() {
    startupAllowanceMs = Math.min(
      Math.max(0, now() - startedAt),
      NEWTAB_HANDOFF_MAX_STARTUP_ALLOWANCE_MS,
    );
    startedUpAt = now();
    ready = true;
    return consume();
  }

  function watch() {
    onChanged?.addListener((changes, area) => {
      if (area && area !== 'local') return;
      const tabId = getCurrentTabId();
      if (tabId == null) return;
      if (
        changes?.[newtabHandoffKey(Number(tabId))]?.newValue ||
        changes?.[newtabHandoffRetryKey(Number(tabId))]?.newValue
      ) consume();
    });
    // The record can arrive just before an already-loaded panel becomes visible
    // (the new tab writes it, then opens the panel). consume() skips hidden
    // panels, so try again the moment this one is shown.
    doc?.addEventListener?.('visibilitychange', () => {
      if (getIsDocumentVisible()) consume();
    });
  }

  return { consume, start, watch };
}
