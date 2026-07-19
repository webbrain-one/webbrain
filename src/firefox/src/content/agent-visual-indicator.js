/**
 * WebBrain Agent Visual Indicator (content script)
 *
 * Renders an animated purple inset glow around the page viewport while
 * the agent is operating on this tab, a "Stop WebBrain" floating button,
 * and a large WebBrain-purple cursor/outline on the element currently
 * being acted on. The base indicator follows Anthropic's Claude-for-Chrome
 * extension pattern, recolored for WebBrain's accent (#6c63ff).
 *
 * Lifecycle messages from the service worker:
 *
 *   WB_SHOW_AGENT_INDICATORS  — agent run started → fade in border + button
 *   WB_HIDE_AGENT_INDICATORS  — agent run ended → fade out + remove
 *   WB_HIDE_FOR_TOOL_USE      — temporarily hide so screenshots don't
 *                                capture our own UI
 *   WB_SHOW_AFTER_TOOL_USE    — restore visibility after the screenshot
 *                                has been captured
 *
 * Stop button click → service worker via WB_STOP_AGENT, which calls
 * agent.abort(tabId) the same way the sidepanel's Stop button does.
 *
 * Self-contained — no imports, runs in the page's content-script world.
 * z-index uses the max signed 32-bit value so the indicator sits above
 * site overlays/modals but never accidentally swallows page input
 * (border has pointer-events: none; button uses pointer-events: auto).
 */

(function () {
  if (window.__webbrainAgentIndicatorInjected) return;
  window.__webbrainAgentIndicatorInjected = true;

  const TARGET_CURSOR_TTL_MS = 3000;
  let borderEl = null;
  let stopContainerEl = null;
  let targetCursorEl = null;
  let targetOutlineEl = null;
  let targetElement = null;
  let targetRectOverride = null;
  let targetTimer = null;
  let targetRaf = 0;
  let indicatorsActive = false;
  // Saved visibility state during HIDE_FOR_TOOL_USE so SHOW_AFTER_TOOL_USE
  // can restore the right thing (don't want to show indicators that
  // weren't on before the screenshot).
  let savedBorderVisible = false;
  let savedStopVisible = false;
  let savedTargetCursorVisible = false;
  let savedTargetOutlineVisible = false;

  function injectStyles() {
    if (document.getElementById('webbrain-agent-styles')) return;
    const style = document.createElement('style');
    style.id = 'webbrain-agent-styles';
    style.textContent = `
      @keyframes webbrain-pulse {
        0% {
          box-shadow:
            inset 0 0 10px rgba(108, 99, 255, 0.5),
            inset 0 0 20px rgba(108, 99, 255, 0.3),
            inset 0 0 30px rgba(108, 99, 255, 0.1);
        }
        50% {
          box-shadow:
            inset 0 0 15px rgba(108, 99, 255, 0.7),
            inset 0 0 25px rgba(108, 99, 255, 0.5),
            inset 0 0 35px rgba(108, 99, 255, 0.2);
        }
        100% {
          box-shadow:
            inset 0 0 10px rgba(108, 99, 255, 0.5),
            inset 0 0 20px rgba(108, 99, 255, 0.3),
            inset 0 0 30px rgba(108, 99, 255, 0.1);
        }
      }

      @keyframes webbrain-target-pop {
        0% { opacity: 0; }
        100% { opacity: 1; }
      }

      @keyframes webbrain-target-ring {
        0%, 100% {
          box-shadow:
            0 0 0 3px rgba(108, 99, 255, 0.18),
            0 0 24px rgba(108, 99, 255, 0.28);
        }
        50% {
          box-shadow:
            0 0 0 6px rgba(108, 99, 255, 0.10),
            0 0 32px rgba(108, 99, 255, 0.38);
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createBorder() {
    const el = document.createElement('div');
    el.id = 'webbrain-agent-glow-border';
    el.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      z-index: 2147483646;
      opacity: 0;
      transition: opacity 0.3s ease-in-out;
      animation: webbrain-pulse 2s ease-in-out infinite;
      box-shadow:
        inset 0 0 10px rgba(108, 99, 255, 0.5),
        inset 0 0 20px rgba(108, 99, 255, 0.3),
        inset 0 0 30px rgba(108, 99, 255, 0.1);
    `;
    return el;
  }

  function createStopButton() {
    const container = document.createElement('div');
    container.id = 'webbrain-agent-stop-container';
    container.style.cssText = `
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      justify-content: center;
      align-items: center;
      pointer-events: none;
      z-index: 2147483647;
    `;
    const button = document.createElement('button');
    button.id = 'webbrain-agent-stop-button';
    button.type = 'button';
    button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor"
           style="margin-right: 10px; vertical-align: middle;">
        <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"/>
      </svg>
      <span style="vertical-align: middle;">Stop WebBrain</span>
    `;
    button.style.cssText = `
      position: relative;
      transform: translateY(80px);
      padding: 11px 18px;
      background: #ffffff;
      color: #1a1a2e;
      border: 1px solid rgba(108, 99, 255, 0.30);
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow:
        0 24px 48px rgba(108, 99, 255, 0.24),
        0 4px 14px rgba(108, 99, 255, 0.20);
      transition:
        transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
        opacity 0.3s ease,
        background 0.15s ease;
      opacity: 0;
      user-select: none;
      pointer-events: auto;
      white-space: nowrap;
      margin: 0 auto;
    `;
    button.addEventListener('mouseenter', () => {
      if (indicatorsActive) button.style.background = '#f3f0ff';
    });
    button.addEventListener('mouseleave', () => {
      if (indicatorsActive) button.style.background = '#ffffff';
    });
    button.addEventListener('click', async () => {
      // Clear the page-owned UI immediately. The background may have
      // restarted (or the run may already be gone), leaving this indicator
      // with no live background state to clean it up.
      hide();
      try {
        await browser.runtime.sendMessage({ type: 'WB_STOP_AGENT' });
      } catch { /* extension context invalidated, ignore */ }
    });
    container.appendChild(button);
    return container;
  }

  function createTargetOutline() {
    const el = document.createElement('div');
    el.id = 'webbrain-agent-target-outline';
    el.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 2147483645;
      opacity: 0;
      border: 2px solid rgba(108, 99, 255, 0.96);
      border-radius: 10px;
      background: rgba(108, 99, 255, 0.035);
      transition:
        opacity 0.16s ease,
        top 0.18s ease,
        left 0.18s ease,
        width 0.18s ease,
        height 0.18s ease;
      animation: webbrain-target-ring 1.3s ease-in-out infinite;
    `;
    return el;
  }

  function createTargetCursor() {
    const el = document.createElement('div');
    el.id = 'webbrain-agent-target-cursor';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <svg width="48" height="56" viewBox="0 0 48 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 4L39 31L24 34L31 50L20 54L14 38L5 48V4Z"
          fill="#6c63ff" stroke="white" stroke-width="3" stroke-linejoin="round"/>
        <path d="M24 34L31 50" stroke="rgba(20, 18, 48, 0.34)" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
    el.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 48px;
      height: 56px;
      pointer-events: none;
      z-index: 2147483646;
      opacity: 0;
      filter:
        drop-shadow(0 14px 26px rgba(108, 99, 255, 0.38))
        drop-shadow(0 2px 4px rgba(20, 18, 48, 0.22));
      transition:
        opacity 0.16s ease,
        transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
      animation: webbrain-target-pop 0.18s ease-out;
      will-change: transform, opacity;
    `;
    return el;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function getTargetRect() {
    if (targetRectOverride) return targetRectOverride;
    if (!targetElement || typeof targetElement.getBoundingClientRect !== 'function') return null;
    const rect = targetElement.getBoundingClientRect();
    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      rect.width < 1 ||
      rect.height < 1
    ) {
      return null;
    }

    const left = clamp(rect.left - 4, 4, Math.max(4, window.innerWidth - 12));
    const top = clamp(rect.top - 4, 4, Math.max(4, window.innerHeight - 12));
    const right = clamp(rect.right + 4, 4, window.innerWidth - 4);
    const bottom = clamp(rect.bottom + 4, 4, window.innerHeight - 4);
    if (right <= left || bottom <= top) return null;
    return {
      left,
      top,
      width: right - left,
      height: bottom - top,
      rawWidth: rect.width,
      rawHeight: rect.height,
    };
  }

  function placeTargetOverlay() {
    if (!targetCursorEl || !targetOutlineEl) return;
    const rect = getTargetRect();
    if (!rect) {
      targetCursorEl.style.opacity = '0';
      targetOutlineEl.style.opacity = '0';
      return;
    }

    targetOutlineEl.style.left = `${Math.round(rect.left)}px`;
    targetOutlineEl.style.top = `${Math.round(rect.top)}px`;
    targetOutlineEl.style.width = `${Math.round(rect.width)}px`;
    targetOutlineEl.style.height = `${Math.round(rect.height)}px`;
    targetOutlineEl.style.borderRadius = `${rect.height < 28 ? 7 : 10}px`;
    targetOutlineEl.style.opacity = '1';

    const innerX = Math.min(Math.max(rect.rawWidth * 0.62, 14), Math.max(14, rect.rawWidth - 8));
    const innerY = Math.min(Math.max(rect.rawHeight * 0.58, 14), Math.max(14, rect.rawHeight - 8));
    const tipX = clamp(rect.left + innerX, 8, window.innerWidth - 40);
    const tipY = clamp(rect.top + innerY, 8, window.innerHeight - 48);
    targetCursorEl.style.transform = `translate(${Math.round(tipX - 5)}px, ${Math.round(tipY - 4)}px)`;
    targetCursorEl.style.opacity = '1';
  }

  function scheduleTargetUpdate() {
    if (!targetElement || targetRaf) return;
    targetRaf = requestAnimationFrame(() => {
      targetRaf = 0;
      placeTargetOverlay();
    });
  }

  function hideTargetCursor() {
    targetElement = null;
    targetRectOverride = null;
    if (targetTimer) {
      clearTimeout(targetTimer);
      targetTimer = null;
    }
    if (targetRaf) {
      cancelAnimationFrame(targetRaf);
      targetRaf = 0;
    }
    if (targetCursorEl) targetCursorEl.style.opacity = '0';
    if (targetOutlineEl) targetOutlineEl.style.opacity = '0';
    setTimeout(() => {
      if (targetElement || targetRectOverride) return;
      targetCursorEl?.parentNode?.removeChild(targetCursorEl);
      targetOutlineEl?.parentNode?.removeChild(targetOutlineEl);
      targetCursorEl = null;
      targetOutlineEl = null;
    }, 180);
  }

  function scheduleTargetExpiry() {
    if (targetTimer) clearTimeout(targetTimer);
    targetTimer = setTimeout(hideTargetCursor, TARGET_CURSOR_TTL_MS);
  }

  function showTarget(el, source = 'interaction') {
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    injectStyles();
    const root = document.body || document.documentElement;
    if (!root) return;

    targetElement = el;
    targetRectOverride = null;
    if (targetOutlineEl) {
      targetOutlineEl.style.display = '';
    } else {
      targetOutlineEl = createTargetOutline();
      root.appendChild(targetOutlineEl);
    }
    if (targetCursorEl) {
      targetCursorEl.style.display = '';
    } else {
      targetCursorEl = createTargetCursor();
      root.appendChild(targetCursorEl);
    }
    targetCursorEl.dataset.source = String(source || 'interaction');

    placeTargetOverlay();
    scheduleTargetExpiry();
  }

  function showTargetRect(rect, source = 'interaction') {
    if (!rect) return;
    const x = Number(rect.x);
    const y = Number(rect.y);
    const w = Math.max(1, Number(rect.w ?? rect.width ?? 1));
    const h = Math.max(1, Number(rect.h ?? rect.height ?? 1));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return;

    injectStyles();
    const root = document.body || document.documentElement;
    if (!root) return;

    const width = Math.max(w, 28);
    const height = Math.max(h, 28);
    targetElement = null;
    targetRectOverride = {
      left: clamp(x - Math.max(0, width - w) / 2 - 4, 4, Math.max(4, window.innerWidth - 12)),
      top: clamp(y - Math.max(0, height - h) / 2 - 4, 4, Math.max(4, window.innerHeight - 12)),
      width: Math.min(width + 8, Math.max(1, window.innerWidth - 8)),
      height: Math.min(height + 8, Math.max(1, window.innerHeight - 8)),
      rawWidth: width,
      rawHeight: height,
    };

    if (targetOutlineEl) {
      targetOutlineEl.style.display = '';
    } else {
      targetOutlineEl = createTargetOutline();
      root.appendChild(targetOutlineEl);
    }
    if (targetCursorEl) {
      targetCursorEl.style.display = '';
    } else {
      targetCursorEl = createTargetCursor();
      root.appendChild(targetCursorEl);
    }
    targetCursorEl.dataset.source = String(source || 'interaction');

    placeTargetOverlay();
    scheduleTargetExpiry();
  }

  function show() {
    indicatorsActive = true;
    injectStyles();

    const root = document.body || document.documentElement;
    if (!root) return; // page hasn't parsed yet — extremely unlikely on document_idle

    if (borderEl) {
      borderEl.style.display = '';
    } else {
      borderEl = createBorder();
      root.appendChild(borderEl);
    }

    if (stopContainerEl) {
      stopContainerEl.style.display = '';
    } else {
      stopContainerEl = createStopButton();
      root.appendChild(stopContainerEl);
    }

    // Two RAFs: first to land the elements in the DOM (so the browser
    // computes their initial transforms with opacity 0 / translateY 80px),
    // second to apply the in-flight values for a clean transition.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (borderEl) borderEl.style.opacity = '1';
        const btn = stopContainerEl?.querySelector('#webbrain-agent-stop-button');
        if (btn) {
          btn.style.transform = 'translateY(0)';
          btn.style.opacity = '1';
        }
      });
    });
  }

  function hide() {
    if (!indicatorsActive) return;
    indicatorsActive = false;
    if (borderEl) borderEl.style.opacity = '0';
    hideTargetCursor();
    const btn = stopContainerEl?.querySelector('#webbrain-agent-stop-button');
    if (btn) {
      btn.style.transform = 'translateY(80px)';
      btn.style.opacity = '0';
    }
    setTimeout(() => {
      // Bail if the user re-triggered show() during the fade-out.
      if (indicatorsActive) return;
      borderEl?.parentNode?.removeChild(borderEl);
      stopContainerEl?.parentNode?.removeChild(stopContainerEl);
      borderEl = null;
      stopContainerEl = null;
    }, 320);
  }

  /**
   * Hide both elements without tearing them down — for the brief window
   * around a screenshot capture, so the agent doesn't see its own border
   * pulsing in the screenshots it sends back to the model.
   */
  function hideForToolUse() {
    savedBorderVisible = !!(borderEl && borderEl.style.display !== 'none');
    savedStopVisible = !!(stopContainerEl && stopContainerEl.style.display !== 'none');
    savedTargetCursorVisible = !!(targetCursorEl && targetCursorEl.style.display !== 'none');
    savedTargetOutlineVisible = !!(targetOutlineEl && targetOutlineEl.style.display !== 'none');
    if (borderEl) borderEl.style.display = 'none';
    if (stopContainerEl) stopContainerEl.style.display = 'none';
    if (targetCursorEl) targetCursorEl.style.display = 'none';
    if (targetOutlineEl) targetOutlineEl.style.display = 'none';
  }

  function showAfterToolUse() {
    if (savedBorderVisible && borderEl) borderEl.style.display = '';
    if (savedStopVisible && stopContainerEl) stopContainerEl.style.display = '';
    if (savedTargetCursorVisible && targetCursorEl) targetCursorEl.style.display = '';
    if (savedTargetOutlineVisible && targetOutlineEl) targetOutlineEl.style.display = '';
    savedBorderVisible = false;
    savedStopVisible = false;
    savedTargetCursorVisible = false;
    savedTargetOutlineVisible = false;
  }

  window.addEventListener('scroll', scheduleTargetUpdate, true);
  window.addEventListener('resize', scheduleTargetUpdate, true);
  window.__webbrainAgentIndicator = { showTarget, showTargetRect, hideTarget: hideTargetCursor };

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'WB_SHOW_AGENT_INDICATORS':
        show();
        sendResponse({ ok: true });
        break;
      case 'WB_HIDE_AGENT_INDICATORS':
        hide();
        sendResponse({ ok: true });
        break;
      case 'WB_HIDE_FOR_TOOL_USE':
        hideForToolUse();
        sendResponse({ ok: true });
        break;
      case 'WB_SHOW_AFTER_TOOL_USE':
        showAfterToolUse();
        sendResponse({ ok: true });
        break;
      case 'WB_SHOW_AGENT_TARGET':
        if (msg.rect) showTargetRect(msg.rect, msg.source || 'message');
        sendResponse({ ok: true });
        break;
      // Unknown messages are silently ignored — other content scripts in
      // the same world might be using browser.runtime.onMessage too.
    }
    // Synchronous response — return falsy so the channel closes.
  });
})();
