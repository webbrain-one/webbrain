/*
 * Main-world bridge for suppressing input.showPicker() during agent clicks.
 *
 * Extension content scripts run in an isolated JavaScript world, so replacing
 * HTMLInputElement.prototype.showPicker there does not affect page handlers.
 * This script runs in the page's MAIN world and uses short-lived DOM events
 * and attributes to coordinate with content.js.
 */
(() => {
  const PROBE_EVENT = 'webbrain:file-picker-guard-probe';
  const PROBE_ATTR = 'data-webbrain-file-picker-probe';
  const PROBE_ACK_ATTR = 'data-webbrain-file-picker-probe-ack';
  const ARM_EVENT = 'webbrain:file-picker-guard-arm';
  const DISARM_EVENT = 'webbrain:file-picker-guard-disarm';
  const RESET_EVENT = 'webbrain:file-picker-guard-reset';
  const BLOCKED_EVENT = 'webbrain:file-picker-guard-blocked';
  const GUARD_ATTR = 'data-webbrain-file-picker-guard';
  const BLOCKED_ATTR = 'data-webbrain-file-picker-blocked';
  const MAX_GUARD_MS = 5000;

  const probeRoot = document.documentElement;
  if (probeRoot) {
    const probeToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    probeRoot.setAttribute(PROBE_ATTR, probeToken);
    document.dispatchEvent(new Event(PROBE_EVENT));
    const alreadyInstalled = probeRoot.getAttribute(PROBE_ACK_ATTR) === probeToken;
    probeRoot.removeAttribute(PROBE_ATTR);
    probeRoot.removeAttribute(PROBE_ACK_ATTR);
    if (alreadyInstalled) return;
  }

  let activeGuardId = null;
  let restorePickerMethods = null;
  let expiryTimer = null;

  function allPiercedMatches(selector) {
    const matches = [];
    const visit = (root) => {
      try { matches.push(...root.querySelectorAll(selector)); } catch { return; }
      let elements = [];
      try { elements = root.querySelectorAll('*'); } catch {}
      for (const element of elements) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    return matches;
  }

  function uniqueFileInputSelector(input) {
    const unique = (selector) => {
      if (!selector) return null;
      const matches = allPiercedMatches(selector);
      return matches.length === 1 && matches[0] === input ? selector : null;
    };
    try {
      if (input.id && window.CSS?.escape) {
        const byId = unique('#' + CSS.escape(input.id));
        if (byId) return byId;
      }
      if (input.name && window.CSS?.escape) {
        const byName = unique('input[type="file"][name=' + CSS.escape(String(input.name)) + ']');
        if (byName) return byName;
      }
      const parts = [];
      let node = input;
      while (node?.nodeType === Node.ELEMENT_NODE) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        const byPath = unique(parts.join(' > '));
        if (byPath) return byPath;
        node = parent;
      }
    } catch {}
    return null;
  }

  function isFileInput(input) {
    return input?.tagName === 'INPUT'
      && String(input.getAttribute?.('type') || input.type || '').toLowerCase() === 'file';
  }

  function clearGuard() {
    activeGuardId = null;
    if (expiryTimer) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    restorePickerMethods?.();
    restorePickerMethods = null;
  }

  function reportBlocked(input) {
    const root = document.documentElement;
    if (!root || !activeGuardId) return;
    root.setAttribute(BLOCKED_ATTR, JSON.stringify({
      guardId: activeGuardId,
      selector: uniqueFileInputSelector(input),
    }));
    document.dispatchEvent(new Event(BLOCKED_EVENT));
    root.removeAttribute(BLOCKED_ATTR);
  }

  function armGuard() {
    const root = document.documentElement;
    const guardId = root?.getAttribute(GUARD_ATTR);
    if (!guardId) return;
    clearGuard();

    const proto = window.HTMLInputElement?.prototype;
    if (!proto) return;
    const showPickerDescriptor = Object.getOwnPropertyDescriptor(proto, 'showPicker');
    const originalShowPicker = showPickerDescriptor?.value;
    const ownClickDescriptor = Object.getOwnPropertyDescriptor(proto, 'click');
    const originalClick = proto.click;
    if (typeof originalShowPicker !== 'function' && typeof originalClick !== 'function') return;

    const guardedShowPicker = function(...args) {
      if (activeGuardId && isFileInput(this)) {
        reportBlocked(this);
        return undefined;
      }
      return Reflect.apply(originalShowPicker, this, args);
    };
    const guardedClick = function(...args) {
      if (activeGuardId && isFileInput(this)) {
        reportBlocked(this);
        return undefined;
      }
      return Reflect.apply(originalClick, this, args);
    };
    let showPickerInstalled = false;
    let clickInstalled = false;
    if (typeof originalShowPicker === 'function') {
      try {
        Object.defineProperty(proto, 'showPicker', {
          ...showPickerDescriptor,
          value: guardedShowPicker,
        });
        showPickerInstalled = true;
      } catch {}
    }
    if (typeof originalClick === 'function') {
      try {
        Object.defineProperty(proto, 'click', {
          configurable: true,
          enumerable: ownClickDescriptor?.enumerable ?? false,
          writable: true,
          value: guardedClick,
        });
        clickInstalled = true;
      } catch {}
    }
    if (!showPickerInstalled && !clickInstalled) return;

    activeGuardId = guardId;
    restorePickerMethods = () => {
      try {
        if (showPickerInstalled && proto.showPicker === guardedShowPicker) {
          Object.defineProperty(proto, 'showPicker', showPickerDescriptor);
        }
      } catch {}
      try {
        if (clickInstalled && proto.click === guardedClick) {
          if (ownClickDescriptor) Object.defineProperty(proto, 'click', ownClickDescriptor);
          else delete proto.click;
        }
      } catch {}
    };
    expiryTimer = setTimeout(clearGuard, MAX_GUARD_MS);
  }

  function disarmGuard() {
    const guardId = document.documentElement?.getAttribute(GUARD_ATTR);
    if (guardId && guardId === activeGuardId) clearGuard();
  }

  function acknowledgeProbe() {
    const root = document.documentElement;
    const probeToken = root?.getAttribute(PROBE_ATTR);
    if (probeToken) root.setAttribute(PROBE_ACK_ATTR, probeToken);
  }

  document.addEventListener(PROBE_EVENT, acknowledgeProbe, true);
  document.addEventListener(ARM_EVENT, armGuard, true);
  document.addEventListener(DISARM_EVENT, disarmGuard, true);
  document.addEventListener(RESET_EVENT, clearGuard, true);
  armGuard();
})();
