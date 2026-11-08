import { frameHostMatches, urlFilterHostHint } from './permission-gate.js';
import { richTextToolbarUsesFocusedTarget } from './rich-text-toolbar-guard.js';
import { secureRandomBase36Token } from './random-token.js';

function withDispatchBinding(probe, frameId = probe?.frameId) {
  if (!probe || typeof probe !== 'object') return probe;
  const token = String(probe.dispatchBinding?.token || '');
  const backendNodeId = Number(probe.dispatchBinding?.backendNodeId) || null;
  const dispatchBinding = token || backendNodeId
    ? {
        ...(token ? { token } : {}),
        ...(backendNodeId ? { backendNodeId } : {}),
        ...(Number.isInteger(frameId) ? { frameId } : {}),
      }
    : null;
  return {
    ...probe,
    ...(dispatchBinding ? { dispatchBinding } : {}),
  };
}

function messageOrigin(url) {
  try {
    const origin = new URL(String(url || '')).origin;
    return origin && origin !== 'null' ? origin : '';
  } catch {
    return '';
  }
}

export class RichTextToolbarProbe {
  constructor(agent) {
    this.agent = agent;
  }

  async frameGeometryToTop(tabId, navigationFrames, frameId, rect) {
    if (!rect || !Number.isInteger(frameId)) return null;
    if (frameId === 0) return { annotationRect: rect, frameOwnerRect: null, frameOwnerMeta: null };
    const frames = Array.isArray(navigationFrames) ? navigationFrames : [];
    if (!frames.some(frame => frame?.frameId === 0) || !frames.some(frame => frame?.frameId === frameId)) return null;
    const snapshots = (await Promise.all(frames.map(async frame => {
      const collect = () => browser.tabs.sendMessage(tabId, {
        target: 'redaction-content',
        action: 'get_redaction_regions',
        params: { coordinateSpace: 'viewport' },
      }, { frameId: frame.frameId });
      let payload;
      try {
        payload = await collect();
      } catch {
        try {
          await browser.tabs.executeScript(tabId, {
            frameId: frame.frameId,
            file: '/src/content/redaction-regions.js',
          });
          payload = await collect();
        } catch {
          return null;
        }
      }
      return {
        ...payload,
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url || '',
      };
    }))).filter(Boolean);
    const navigationById = new Map(frames.map(frame => [frame.frameId, frame]));
    const snapshotById = new Map(snapshots.map(frame => [frame.frameId, frame]));
    const edges = [];
    const seen = new Set();
    let child = navigationById.get(frameId);
    while (child && child.frameId !== 0 && !seen.has(child.frameId)) {
      seen.add(child.frameId);
      const parent = navigationById.get(child.parentFrameId);
      if (!parent) return null;
      edges.unshift({ parent, child });
      child = parent;
    }
    if (!child || child.frameId !== 0) return null;
    const opaqueFrameIds = new Set();
    const exactChildRect = async edge => {
      const token = `wb-frame-${Date.now()}-${secureRandomBase36Token(12)}`;
      const parentOriginOpaque = opaqueFrameIds.has(edge.parent.frameId);
      const parentOrigin = parentOriginOpaque ? '' : messageOrigin(edge.parent.url);
      const expectedChildOrigin = messageOrigin(edge.child.url);
      const parentResponse = browser.tabs.sendMessage(tabId, {
        target: 'redaction-content',
        action: 'wait_for_exact_child_frame_rect',
        params: { token, expectedChildOrigin, allowOpaqueChildOrigin: parentOriginOpaque, scrollIntoView: true },
      }, { frameId: edge.parent.frameId }).catch(() => null);
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        await browser.tabs.sendMessage(tabId, {
          target: 'redaction-content',
          action: 'announce_exact_child_frame',
          params: { token, parentOrigin },
        }, { frameId: edge.child.frameId });
      } catch {}
      return parentResponse;
    };
    const transforms = new Map([[0, { x: 0, y: 0, scaleX: 1, scaleY: 1 }]]);
    let frameOwnerRect = null;
    let frameOwnerMeta = null;
    for (const edge of edges) {
      const exact = await exactChildRect(edge);
      if (exact?.childOriginOpaque === true) opaqueFrameIds.add(edge.child.frameId);
      const parentTransform = transforms.get(edge.parent.frameId);
      const childSnapshot = snapshotById.get(edge.child.frameId);
      const childWidth = Number(childSnapshot?.viewport?.width);
      const childHeight = Number(childSnapshot?.viewport?.height);
      const content = exact?.contentRect;
      const outer = exact?.outerRect;
      if (
        !exact?.found || !parentTransform || !content || !outer
        || !(content.w > 0 && content.h > 0) || !(childWidth > 0 && childHeight > 0)
      ) return null;
      if (exact.scrolled) await new Promise(resolve => setTimeout(resolve, 50));
      const mappedContent = {
        x: parentTransform.x + content.x * parentTransform.scaleX,
        y: parentTransform.y + content.y * parentTransform.scaleY,
        w: content.w * parentTransform.scaleX,
        h: content.h * parentTransform.scaleY,
      };
      transforms.set(edge.child.frameId, {
        x: mappedContent.x,
        y: mappedContent.y,
        scaleX: mappedContent.w / childWidth,
        scaleY: mappedContent.h / childHeight,
      });
      if (edge.child.frameId === frameId) {
        const parentViewport = snapshotById.get(edge.parent.frameId)?.viewport || {};
        const ownerPageX = Number.isFinite(Number(outer.pageX))
          ? Number(outer.pageX)
          : Number(outer.x) + (Number(parentViewport.scrollX) || 0);
        const ownerPageY = Number.isFinite(Number(outer.pageY))
          ? Number(outer.pageY)
          : Number(outer.y) + (Number(parentViewport.scrollY) || 0);
        frameOwnerRect = { ...outer, pageX: ownerPageX, pageY: ownerPageY };
        frameOwnerMeta = exact.ownerMeta || null;
      }
    }
    const transform = transforms.get(frameId);
    if (!transform) return null;
    const mapped = {
      x: transform.x + Number(rect.x) * transform.scaleX,
      y: transform.y + Number(rect.y) * transform.scaleY,
      w: Number(rect.w) * transform.scaleX,
      h: Number(rect.h) * transform.scaleY,
    };
    if (![mapped.x, mapped.y, mapped.w, mapped.h].every(Number.isFinite)) return null;
    const rounded = value => {
      const result = {
        x: Math.round(value.x),
        y: Math.round(value.y),
        w: Math.round(value.w),
        h: Math.round(value.h),
      };
      if (Number.isFinite(Number(value.pageX))) result.pageX = Math.round(Number(value.pageX));
      if (Number.isFinite(Number(value.pageY))) result.pageY = Math.round(Number(value.pageY));
      return result;
    };
    return {
      annotationRect: rounded(mapped),
      frameOwnerRect: frameOwnerRect ? rounded(frameOwnerRect) : null,
      frameOwnerMeta,
    };
  }

  async frameRectToTop(tabId, navigationFrames, frameId, rect) {
    const geometry = await this.frameGeometryToTop(tabId, navigationFrames, frameId, rect);
    return geometry?.annotationRect || null;
  }

  async legacyIframeTypeAllFrames(
    tabId,
    { selector, text, clear, urlFilter, matchIndex: requestedMatchIndex },
    { abortSignal = null, deadlineAt = 0, deadlineError = null, beforeDispatch = null } = {},
  ) {
    const actionDeadlineAt = Number(deadlineAt) || 0;
    const actionExpired = () => abortSignal?.aborted
      || (actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt);
    const throwIfAborted = () => {
      if (!actionExpired()) return;
      throw abortSignal?.reason instanceof Error
        ? abortSignal.reason
        : deadlineError instanceof Error
          ? deadlineError
        : new Error('Iframe typing was cancelled.');
    };
    throwIfAborted();
    const matchIndex = Number.isInteger(requestedMatchIndex) && requestedMatchIndex >= 0
      ? requestedMatchIndex
      : null;
    let navigationFrames = [];
    try { navigationFrames = await browser.webNavigation.getAllFrames({ tabId }); } catch {}
    throwIfAborted();
    const matchingFrames = (navigationFrames || []).filter(frame => (
      frame?.frameId !== 0
      && (!urlFilter || (frameHostMatches(frame.url || '', urlFilter) && String(frame.url || '').includes(urlFilter)))
    ));
    const countCode = `
      (() => {
        try {
          return { ok: true, url: location.href, matchCount: document.querySelectorAll(${JSON.stringify(selector)}).length };
        } catch (error) {
          return { ok: false, url: location.href, error: error.message };
        }
      })()
    `;
    const frames = await Promise.all(matchingFrames.map(async frame => {
      try {
        const values = await browser.tabs.executeScript(tabId, { frameId: frame.frameId, code: countCode });
        return { frameId: frame.frameId, url: frame.url || '', ...(values?.[0] || {}) };
      } catch (error) {
        return { frameId: frame.frameId, url: frame.url || '', ok: false, error: error.message };
      }
    }));
    throwIfAborted();
    const candidates = frames.filter(frame => matchIndex == null ? frame.matchCount > 0 : frame.matchCount > matchIndex);
    const targetCount = matchIndex == null
      ? candidates.reduce((sum, frame) => sum + Number(frame.matchCount || 0), 0)
      : candidates.length;
    if (targetCount !== 1) {
      return {
        success: false,
        dispatched: false,
        noDispatch: true,
        ...(targetCount > 1 ? { ambiguous: true } : {}),
        matchCount: targetCount,
        searchedFrames: frames.length,
        frameUrls: candidates.map(frame => frame.url).slice(0, 10),
        candidates: candidates.map(frame => ({ frameId: frame.frameId, url: frame.url, elementCount: frame.matchCount })).slice(0, 10),
        error: targetCount > 1
          ? `The iframe selector matched ${targetCount} elements, so nothing was typed. Call iframe_read with this selector and retry with the intended matchIndex.`
          : urlFilterHostHint(urlFilter, (navigationFrames || []).filter(frame => frame?.frameId !== 0).map(frame => frame?.url))
            || 'Input not found in any matching iframe',
      };
    }
    const selected = candidates[0];
    const selectedIndex = matchIndex == null ? 0 : matchIndex;
    const markerToken = `wbit_${Date.now().toString(36)}_${secureRandomBase36Token(12)}`;
    const markerAttribute = `data-webbrain-legacy-iframe-type-${markerToken}`;
    const markerValue = markerToken;
    const deadlineResult = result => {
      const dispatched = result?.dispatched === true;
      return {
        success: false,
        dispatched,
        ...(dispatched
          ? { outcomeUnknown: true, retryable: false }
          : { noDispatch: true, outcomeUnknown: false, retryable: true }),
        deadlineExpired: true,
        error: dispatched
          ? 'The iframe action deadline expired during field mutation; text entry may be incomplete.'
          : 'The iframe action deadline expired before field mutation.',
      };
    };
    const preparationCode = `
      (() => {
        const markerAttribute = ${JSON.stringify(markerAttribute)};
        const markerValue = ${JSON.stringify(markerValue)};
        const actionDeadlineAt = ${actionDeadlineAt};
        const deadlineExpired = () => actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt;
        const deadlineFailure = () => ({ ok: false, deadlineExpired: true, dispatched: false });
        try {
          if (deadlineExpired()) return deadlineFailure();
          const el = document.querySelectorAll(${JSON.stringify(selector)})[${selectedIndex}];
          if (!el) return { ok: false, url: location.href, reason: 'target-changed', dispatched: false };
          if (deadlineExpired()) return deadlineFailure();
          el.setAttribute(markerAttribute, markerValue);
          if (deadlineExpired()) {
            el.removeAttribute(markerAttribute);
            return deadlineFailure();
          }
          // The text a clearing write would replace, for the preview check.
          const currentValue = !${!!clear} ? undefined
            : el.isContentEditable ? String(typeof el.innerText === 'string' ? el.innerText : el.textContent || '')
              : el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? String(el.value ?? '') : undefined;
          return { ok: true, prepared: true, url: location.href, dispatched: false,
            ...(currentValue !== undefined ? { currentValue } : {}) };
        } catch (error) {
          return { ok: false, url: location.href, dispatched: false, error: error.message };
        }
      })()
    `;
    let markerPrepared = false;
    try {
      throwIfAborted();
      const prepared = (await browser.tabs.executeScript(tabId, {
        frameId: selected.frameId,
        code: preparationCode,
      }))?.[0] || null;
      if (prepared?.deadlineExpired) return deadlineResult(prepared);
      if (!prepared?.ok || prepared.prepared !== true) {
        return {
          success: false,
          dispatched: false,
          noDispatch: true,
          retryable: true,
          error: prepared?.error || 'The iframe target changed before typing. Re-read the iframe and retry.',
        };
      }
      markerPrepared = true;
      throwIfAborted();
      // A cleared field must not be refilled with only a truncated preview
      // of its own value. The frame has no content script on this path, so
      // the check every other clearing write runs is asked of the top
      // frame's content script, which owns it, with the value just read. No
      // answer leaves typing as it was.
      if (clear && typeof prepared.currentValue === 'string' && prepared.currentValue) {
        const previewCheck = await Promise.resolve().then(() => browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'check_truncated_replacement',
          params: { text: String(text ?? ''), currentValue: prepared.currentValue },
        }, { frameId: 0 })).catch(() => null);
        throwIfAborted();
        if (previewCheck?.errorCode === 'truncated_value_replacement') return { ...previewCheck, frameId: selected.frameId };
      }
      if (typeof beforeDispatch === 'function') await beforeDispatch(selected.frameId);
      throwIfAborted();
      const mutationCode = `
      (() => {
        let targetDispatched = false;
        let el = null;
        const markerAttribute = ${JSON.stringify(markerAttribute)};
        const markerValue = ${JSON.stringify(markerValue)};
        const actionDeadlineAt = ${actionDeadlineAt};
        const deadlineExpired = () => actionDeadlineAt > 0 && Date.now() >= actionDeadlineAt;
        const deadlineFailure = () => ({ ok: false, deadlineExpired: true, dispatched: targetDispatched });
        try {
          if (deadlineExpired()) return deadlineFailure();
          const marked = Array.from(document.querySelectorAll('[' + markerAttribute + ']'))
            .filter(candidate => candidate.getAttribute(markerAttribute) === markerValue);
          if (marked.length !== 1) {
            return { ok: false, url: location.href, reason: 'target-changed', dispatched: false };
          }
          el = marked[0];
          if (deadlineExpired()) return deadlineFailure();
          if (el.isContentEditable && (el.classList.contains('public-DraftEditor-content')
              || ['ProseMirror', 'ql-editor', 'cke_editable', 'mce-content-body', 'cm-content'].some(name => el.classList.contains(name))
              || el.getAttribute('data-slate-editor') === 'true' || el.getAttribute('data-lexical-editor') === 'true'
              || Array.from(el.children).some(child => child.getAttribute('data-contents') === 'true'))) {
            return { ok: false, dispatched: false, trustedTypeRequired: true,
              error: 'This rich-text editor requires Firefox trusted automation. Enable it in Settings → Advanced and retry.' };
          }
          // Preparation only binds a marker. Focus belongs after this frame's
          // dispatch fence and must retain the exact marked target.
          window.__wbPageMonitor?.beforeLocalDispatch({ preparation: true, kind: 'focus', target: el });
          el.focus({ preventScroll: true });
          if (deadlineExpired()) return deadlineFailure();
          if (!el.isConnected || el.getAttribute(markerAttribute) !== markerValue) {
            return { ok: false, url: location.href, reason: 'target-changed', dispatched: false };
          }
          if (el.isContentEditable) {
            if (${!!clear}) {
              if (deadlineExpired()) return deadlineFailure();
              targetDispatched = true;
              el.textContent = '';
              if (deadlineExpired()) return deadlineFailure();
            }
            if (deadlineExpired()) return deadlineFailure();
            targetDispatched = true;
            el.textContent += ${JSON.stringify(text)};
            if (deadlineExpired()) return deadlineFailure();
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} }));
            if (deadlineExpired()) return deadlineFailure();
            return { ok: true, url: location.href, method: 'contenteditable', value: el.textContent.slice(0, 100), dispatched: true };
          }
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          const newValue = (${!!clear} ? '' : (el.value || '')) + ${JSON.stringify(text)};
          if (deadlineExpired()) return deadlineFailure();
          targetDispatched = true;
          if (setter) setter.call(el, newValue); else el.value = newValue;
          if (deadlineExpired()) return deadlineFailure();
          el.dispatchEvent(new Event('input', { bubbles: true }));
          if (deadlineExpired()) return deadlineFailure();
          el.dispatchEvent(new Event('change', { bubbles: true }));
          if (deadlineExpired()) return deadlineFailure();
          return { ok: true, url: location.href, method: 'native-setter', value: (el.value || '').slice(0, 100), dispatched: true };
        } catch (error) {
          return { ok: false, url: location.href, dispatched: targetDispatched, error: error.message };
        } finally {
          try {
            if (el && el.getAttribute(markerAttribute) === markerValue) el.removeAttribute(markerAttribute);
          } catch {}
        }
      })()
    `;
      let result = null;
      try {
        result = (await browser.tabs.executeScript(tabId, { frameId: selected.frameId, code: mutationCode }))?.[0] || null;
      } catch (error) {
        throwIfAborted();
        return { success: false, dispatched: false, noDispatch: true, retryable: true, error: `The iframe target changed before typing: ${error.message}` };
      }
      if (result?.deadlineExpired) return deadlineResult(result);
      throwIfAborted();
      if (result?.ok) {
        return { success: true, dispatched: true, frameId: selected.frameId, matchIndex: selectedIndex, frame: result, resolution: 'unique-target' };
      }
      return {
        success: false,
        ...(result?.dispatched ? { dispatched: true } : { dispatched: false, noDispatch: true }),
        retryable: result?.trustedTypeRequired !== true,
        ...(result?.trustedTypeRequired ? { trustedTypeRequired: true } : {}),
        error: result?.error || 'The iframe target changed before typing. Re-read the iframe and retry.',
      };
    } finally {
      if (markerPrepared) {
        const cleanupCode = `
          (() => {
            const markerAttribute = ${JSON.stringify(markerAttribute)};
            const markerValue = ${JSON.stringify(markerValue)};
            for (const candidate of document.querySelectorAll('[' + markerAttribute + ']')) {
              if (candidate.getAttribute(markerAttribute) === markerValue) candidate.removeAttribute(markerAttribute);
            }
          })()
        `;
        try {
          void browser.tabs.executeScript(tabId, { frameId: selected.frameId, code: cleanupCode }).catch(() => {});
        } catch {}
      }
    }
  }

  async _requestFrameProbe(tabId, frame, params) {
    const request = () => browser.tabs.sendMessage(tabId, {
      target: 'content',
      action: 'probe_rich_text_toolbar_retry_target',
      params,
    }, { frameId: frame.frameId });
    let probe;
    try {
      probe = await request();
    } catch {
      try {
        await browser.tabs.executeScript(tabId, {
          frameId: frame.frameId,
          file: '/src/content/rich-text-toolbar-heuristic.js',
        });
        await browser.tabs.executeScript(tabId, {
          frameId: frame.frameId,
          file: '/src/content/accessibility-tree.js',
        });
        await browser.tabs.executeScript(tabId, {
          frameId: frame.frameId,
          file: '/src/content/content.js',
        });
        probe = await request();
      } catch {
        return null;
      }
    }
    return probe?.resolved ? withDispatchBinding({
      ...probe,
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      frameUrl: frame.url || '',
    }, frame.frameId) : null;
  }

  async probeIframeTarget(tabId, args = {}, { mapAnnotation = true } = {}) {
    const selector = typeof args?.selector === 'string' ? args.selector.trim() : '';
    if (!selector) return null;
    let navigationFrames;
    try { navigationFrames = await browser.webNavigation.getAllFrames({ tabId }); } catch { return null; }
    if (!Array.isArray(navigationFrames) || !navigationFrames.length) return null;
    const urlFilter = String(args?.urlFilter || '');
    const matchingFrames = navigationFrames.filter(frame => {
      const url = String(frame?.url || '');
      return frame?.frameId !== 0
        && (!urlFilter || (frameHostMatches(url, urlFilter) && url.includes(urlFilter)));
    });
    const probes = (await Promise.all(matchingFrames.map(frame => this._requestFrameProbe(tabId, frame, {
      toolName: 'type_text',
      args: { selector, text: args?.text || '', matchIndex: args?.matchIndex },
    })))).filter(Boolean);
    if (!probes.length) return null;
    const explicitMatchIndex = Number.isInteger(args?.matchIndex) && args.matchIndex >= 0;
    const matchedElementCount = probes.reduce((sum, probe) => (
      sum + (explicitMatchIndex ? 1 : Math.max(1, Number(probe.selectorMatchCount) || 1))
    ), 0);
    if (probes.length !== 1 || matchedElementCount !== 1) {
      await Promise.all(probes.map(probe => this.release(tabId, probe)));
      return {
        resolved: false,
        ambiguous: true,
        matchCount: matchedElementCount,
        matchedFrameIds: probes.map(probe => probe.frameId),
        matchedFrameUrls: probes.map(probe => probe.frameUrl || '').filter(Boolean).slice(0, 5),
        candidateFrames: probes.map(probe => ({
          frameId: probe.frameId,
          url: probe.frameUrl || '',
          elementCount: Math.max(1, Number(probe.selectorMatchCount) || 1),
        })).slice(0, 10),
      };
    }
    const selected = probes[0];
    const recoveryNeedsGeometry = this.agent._richTextToolbarGuard.needsFrameOwnerGeometry(tabId);
    const candidateNeedsAnnotation = Number(selected.fieldMeta?.toolbarCandidate?.score) >= 4;
    const geometry = mapAnnotation && (candidateNeedsAnnotation || recoveryNeedsGeometry)
      ? await this.frameGeometryToTop(tabId, navigationFrames, selected.frameId, selected.rect)
      : null;
    return withDispatchBinding({
      ...selected,
      annotationRect: mapAnnotation ? geometry?.annotationRect || null : null,
      frameOwnerRect: geometry?.frameOwnerRect || null,
      frameOwnerMeta: geometry?.frameOwnerMeta || null,
      frameOwnerScopeUrl: navigationFrames.find(frame => frame?.frameId === selected.parentFrameId)?.url || '',
      topFrameUrl: navigationFrames.find(frame => frame?.frameId === 0)?.url || '',
    }, selected.frameId);
  }

  async probeFocusedTarget(tabId, args = {}, { mapAnnotation = false } = {}) {
    let navigationFrames;
    try { navigationFrames = await browser.webNavigation.getAllFrames({ tabId }); } catch { return null; }
    if (!Array.isArray(navigationFrames) || !navigationFrames.length) return null;
    const focusedChildFrame = async (parentFrameId, children) => {
      for (const child of children) {
        const token = `wb-focused-frame-${Date.now()}-${secureRandomBase36Token(12)}`;
        const parentResponse = browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'wait_for_rich_text_toolbar_focused_child_frame',
          params: { token },
        }, { frameId: parentFrameId }).catch(() => null);
        await new Promise(resolve => setTimeout(resolve, 0));
        const announce = () => browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'announce_rich_text_toolbar_focused_child_frame',
          params: { token },
        }, { frameId: child.frameId });
        try {
          await announce();
        } catch {
          try {
            await browser.tabs.executeScript(tabId, {
              frameId: child.frameId,
              file: '/src/content/rich-text-toolbar-heuristic.js',
            });
            await browser.tabs.executeScript(tabId, {
              frameId: child.frameId,
              file: '/src/content/accessibility-tree.js',
            });
            await browser.tabs.executeScript(tabId, {
              frameId: child.frameId,
              file: '/src/content/content.js',
            });
            await announce();
          } catch {}
        }
        const match = await parentResponse;
        if (match?.matched === true) return child;
      }
      return null;
    };
    const topFrame = navigationFrames.find(frame => frame?.frameId === 0);
    if (!topFrame) return null;
    let selected = await this._requestFrameProbe(tabId, topFrame, {
      toolName: 'type_text',
      args: { text: args?.text || '' },
    });
    if (!selected) return null;
    const seen = new Set();
    while (['iframe', 'frame'].includes(String(selected.fieldMeta?.tag || '').toLowerCase())) {
      if (seen.has(selected.frameId)) break;
      seen.add(selected.frameId);
      const children = navigationFrames.filter(frame => frame?.parentFrameId === selected.frameId);
      if (!children.length) break;
      const child = await focusedChildFrame(selected.frameId, children);
      if (!child) break;
      const nextSelected = await this._requestFrameProbe(tabId, child, {
        toolName: 'type_text',
        args: { text: args?.text || '' },
      });
      if (!nextSelected) break;
      selected = nextSelected;
    }
    const annotationRect = mapAnnotation
      ? await this.frameRectToTop(tabId, navigationFrames, selected.frameId, selected.rect)
      : null;
    return withDispatchBinding({ ...selected, annotationRect }, selected.frameId);
  }

  async release(tabId, probeOrBinding) {
    const binding = probeOrBinding?.dispatchBinding || probeOrBinding;
    const token = String(binding?.token || '');
    if (!token) return;
    const options = Number.isInteger(binding?.frameId) ? { frameId: binding.frameId } : undefined;
    try {
      await browser.tabs.sendMessage(tabId, {
        target: 'content',
        action: 'release_dispatch_binding',
        params: { dispatchBinding: { token } },
      }, options);
    } catch {}
  }

  async probe(tabId, toolName, args = {}, { mapAnnotation = false } = {}) {
    if (toolName === 'iframe_type' || toolName === 'iframe_click') {
      return this.probeIframeTarget(tabId, args, { mapAnnotation: false });
    }
    if (richTextToolbarUsesFocusedTarget(toolName, args)) {
      return this.probeFocusedTarget(tabId, args, { mapAnnotation });
    }
    // The answer is bound to the top frame, so only the top frame is asked:
    // sent to every frame, the first answer won, which could be a subframe's
    // (one an iframe tool injected the content script into), labelled as the
    // top frame's or reporting the top frame's ref as missing.
    try {
      const probe = await browser.tabs.sendMessage(tabId, {
        target: 'content',
        action: 'probe_rich_text_toolbar_retry_target',
        params: { toolName, args },
      }, { frameId: 0 });
      return withDispatchBinding(probe, 0);
    } catch {
      try {
        await this.agent._injectCoreContentScripts(tabId);
        const probe = await browser.tabs.sendMessage(tabId, {
          target: 'content',
          action: 'probe_rich_text_toolbar_retry_target',
          params: { toolName, args },
        }, { frameId: 0 });
        return withDispatchBinding(probe, 0);
      } catch {
        return null;
      }
    }
  }
}
