// What is under a viewport point, for vision-mode dispatch checks: a double
// click that would repeat a button's action, a drag that is really a click,
// a wheel over a focused number field, a native <select>, an embedded frame
// whose content cannot be inspected, the background of an open dialog.
// Shared verbatim by both builds.
//
// visionDomProbe runs inside the page (Chrome: an isolated world through CDP;
// Firefox: tabs.executeScript in the content-script world, so page scripts
// cannot redefine the DOM methods it calls). It is serialized with
// toString(), so it must stay self-contained: no imports, no outer names.

/**
 * @param {{points: {x:number,y:number}[], pair?: boolean, focusSelect?: boolean, focus?: boolean}} request
 *   points are CSS pixels of the top-level viewport. `pair` asks what a
 *   press at points[0] and a release at points[1] would click. `focusSelect`
 *   focuses a native <select> under points[0] (a click on it is answered
 *   with type_text instead of an OS popup no screenshot can show). `focus`
 *   asks whether the focused element is a text field at points[0] (keyboard
 *   input right after a click there goes where the model clicked).
 */
export function visionDomProbe(request) {
  const CLICKABLE = [
    'a[href]', 'area[href]', 'button', 'summary', 'label', 'select', 'option', '[onclick]',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]', '[role="tab"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="option"]',
    'input[type="submit"]', 'input[type="button"]', 'input[type="reset"]', 'input[type="image"]',
    'input[type="checkbox"]', 'input[type="radio"]', 'input[type="file"]', 'input[type="color"]',
  ].join(',');
  // A click inside a text field only places the caret, even when a <label>
  // or link wraps the field, so the walk up stops there.
  const TEXT_ENTRY = [
    'textarea', '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    'input:not([type])', 'input[type="text"]', 'input[type="search"]', 'input[type="email"]',
    'input[type="url"]', 'input[type="tel"]', 'input[type="password"]', 'input[type="number"]',
    'input[type="date"]', 'input[type="datetime-local"]', 'input[type="time"]', 'input[type="month"]',
    'input[type="week"]', 'input[type="range"]',
  ].join(',');
  // Where a press-move-release is the control's own gesture, a pointer
  // cursor around it does not make the drag a click.
  const DRAG_AFFORDANCE = '[draggable="true"],[role="slider"],[role="scrollbar"],[role="separator"],input[type="range"]';
  const DRAG_CURSORS = ['grab', 'grabbing', 'move', 'all-scroll', 'col-resize', 'row-resize', 'ew-resize', 'ns-resize',
    'nesw-resize', 'nwse-resize', 'e-resize', 'w-resize', 'n-resize', 's-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize'];
  const req = request && typeof request === 'object' ? request : {};
  // Composed parent: through shadow roots to their host and out of
  // same-origin frames to the frame element.
  const up = node => {
    if (!node) return null;
    if (node.nodeType === 9) {
      try { return (node.defaultView && node.defaultView.frameElement) || null; } catch (e) { return null; }
    }
    const parent = node.parentNode;
    if (parent && parent.nodeType === 11) return parent.host || null;
    return parent || null;
  };
  // How a point of a document maps into a same-origin frame drawn in it
  // (content.js _visionFrameMap does the same for Firefox input): the
  // frame's position, borders and padding are taken off, and whatever scale
  // a CSS transform or zoom draws it at is undone, by comparing its drawn box
  // with the size of its own viewport. Null when the frame or an ancestor is
  // rotated, skewed, flipped, set on a motion path or drawn in 3D, which no
  // scale maps.
  const frameMap = (frame, innerView) => {
    const view = frame.ownerDocument && frame.ownerDocument.defaultView;
    if (!view) return null;
    const length = value => Number.parseFloat(value) || 0;
    for (let node = frame, depth = 0; node && node.nodeType === 1 && depth < 256; depth++) {
      const style = view.getComputedStyle(node);
      const transform = String(style.transform || 'none');
      if (transform !== 'none') {
        const matrix = /^matrix\(([^)]*)\)$/.exec(transform);
        const parts = matrix ? matrix[1].split(',').map(Number) : [];
        if (!matrix || Math.abs(parts[1]) > 1e-6 || Math.abs(parts[2]) > 1e-6 || !(parts[0] > 0) || !(parts[3] > 0)) return null;
      }
      const rotate = String(style.rotate || 'none');
      if (rotate !== 'none' && !/^0(deg|rad|grad|turn)?$/.test(rotate)) return null;
      const scale = String(style.scale || 'none');
      if (scale !== 'none' && scale.split(/\s+/).some(part => !(length(part) > 0))) return null;
      // A motion path turns the element along it.
      if (String(style.offsetPath || 'none') !== 'none') return null;
      const root = node.getRootNode ? node.getRootNode() : null;
      node = node.parentElement || (root && root.nodeType === 11 ? root.host : null);
    }
    const rect = frame.getBoundingClientRect();
    const style = view.getComputedStyle(frame);
    const left = length(style.borderLeftWidth) + length(style.paddingLeft);
    const top = length(style.borderTopWidth) + length(style.paddingTop);
    const right = length(style.borderRightWidth) + length(style.paddingRight);
    const bottom = length(style.borderBottomWidth) + length(style.paddingBottom);
    const innerWidth = Number(innerView && innerView.innerWidth) || Math.max(0, frame.clientWidth - length(style.paddingLeft) - length(style.paddingRight));
    const innerHeight = Number(innerView && innerView.innerHeight) || Math.max(0, frame.clientHeight - length(style.paddingTop) - length(style.paddingBottom));
    const width = innerWidth + left + right;
    const height = innerHeight + top + bottom;
    // An unscaled frame's drawn box differs from that size by rounding only.
    const sx = width > 0 && Math.abs(rect.width - width) > 1 ? rect.width / width : 1;
    const sy = height > 0 && Math.abs(rect.height - height) > 1 ? rect.height / height : 1;
    return (px, py) => ({ x: (px - rect.left) / sx - left, y: (py - rect.top) / sy - top });
  };
  const hit = (x, y) => {
    let doc = document;
    let cx = x;
    let cy = y;
    for (let depth = 0; depth < 8; depth++) {
      let el = doc.elementFromPoint(cx, cy);
      for (let i = 0; el && el.shadowRoot && i < 8; i++) {
        const inner = el.shadowRoot.elementFromPoint(cx, cy);
        if (!inner || inner === el) break;
        el = inner;
      }
      if (!el) return { el: null, opaque: false };
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'IFRAME' || tag === 'FRAME' || tag === 'OBJECT' || tag === 'EMBED') {
        let inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }
        const map = inner && inner.documentElement && (tag === 'IFRAME' || tag === 'FRAME') ? frameMap(el, inner.defaultView) : null;
        if (map) {
          const point = map(cx, cy);
          cx = point.x;
          cy = point.y;
          doc = inner;
          continue;
        }
        // A cross-origin frame (or plugin), or one drawn at an angle no
        // scale maps: what is under the point inside it cannot be read.
        return { el, opaque: true };
      }
      return { el, opaque: false };
    }
    return { el: null, opaque: false };
  };
  const cursorOf = el => {
    try {
      const view = el && el.ownerDocument && el.ownerDocument.defaultView;
      return view ? String(view.getComputedStyle(el).cursor || '') : '';
    } catch (e) { return ''; }
  };
  // The control a click at `node` activates: a semantic control on its
  // ancestor chain, nothing inside a text field, otherwise an element drawn
  // with a pointer cursor (framework buttons are often a bare <div> with a
  // listener; the cursor is the one sign of that a page script cannot hide
  // from this world).
  const controlOf = node => {
    for (let n = node, i = 0; n && i < 256; n = up(n), i++) {
      if (n.nodeType === 1 && typeof n.matches === 'function') {
        try {
          if (n.matches(CLICKABLE)) return { el: n, kind: String(n.tagName || '').toLowerCase() };
          if (n.matches(TEXT_ENTRY)) return null;
        } catch (e) { /* invalid in this document */ }
      }
    }
    return node && node.nodeType === 1 && cursorOf(node) === 'pointer' ? { el: node, kind: 'clickable element' } : null;
  };
  const dragAffordance = node => {
    if (DRAG_CURSORS.includes(cursorOf(node))) return true;
    for (let n = node, i = 0; n && i < 64; n = up(n), i++) {
      if (n.nodeType === 1 && typeof n.matches === 'function') {
        try { if (n.matches(DRAG_AFFORDANCE)) return true; } catch (e) { /* invalid in this document */ }
      }
    }
    return false;
  };
  // A point on an open dialog's own background rather than on anything in
  // it: 'backdrop' for the layer that dims the page around the dialog (often
  // the dialog element itself, its content box drawn inside it, or a modal's
  // full-viewport overlay), 'empty' for an empty area of the dialog's own
  // box. A click there reports success while the button the model aimed at
  // is elsewhere (a composer's Post button missed ten times in a trace).
  const DIALOG = 'dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const dialogBackgroundOf = (el, x, y) => {
    if (!el || el.nodeType !== 1 || typeof el.matches !== 'function') return '';
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'HTML' || tag === 'BODY') return '';
    const doc = el.ownerDocument;
    const view = doc && doc.defaultView;
    if (!view) return '';
    let rect = null;
    try { rect = el.getBoundingClientRect(); } catch (e) { return ''; }
    const covers = rect.width >= view.innerWidth * 0.8 && rect.height >= view.innerHeight * 0.8;
    let dialog = false;
    try { dialog = el.matches(DIALOG); } catch (e) { dialog = false; }
    if (dialog) {
      // A modal <dialog>'s ::backdrop is hit as the dialog element itself,
      // outside its own box.
      const outside = doc === document && (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom);
      return covers || outside ? 'backdrop' : 'empty';
    }
    // A fixed full-viewport layer outside an open modal: its overlay.
    if (!covers) return '';
    let fixed = false;
    try { fixed = view.getComputedStyle(el).position === 'fixed'; } catch (e) { fixed = false; }
    if (!fixed) return '';
    let modals = [];
    try { modals = Array.from(doc.querySelectorAll('[aria-modal="true"],dialog[open]')); } catch (e) { modals = []; }
    const modal = modals.find(node => {
      if (node === el || node.contains(el)) return false;
      if (String(node.tagName || '').toUpperCase() !== 'DIALOG') return true;
      try { return node.matches(':modal'); } catch (e) { return false; }
    });
    return modal ? 'backdrop' : '';
  };
  const points = Array.isArray(req.points) ? req.points.slice(0, 2) : [];
  const found = points.map(point => hit(Number(point && point.x), Number(point && point.y)));
  const infos = found.map((item, index) => {
    const el = item.el;
    if (!el) return { found: false };
    const control = controlOf(el);
    const info = {
      found: true,
      tag: String(el.tagName || '').toLowerCase(),
      clickable: !!control,
      opaqueFrame: item.opaque === true,
    };
    const role = el.getAttribute ? el.getAttribute('role') : '';
    if (role) info.role = String(role).slice(0, 32);
    if (control) info.control = control.kind;
    if (!control && !info.opaqueFrame) {
      const point = points[index] || {};
      const background = dialogBackgroundOf(el, Number(point.x), Number(point.y));
      if (background) info.dialogBackground = background;
    }
    if (typeof el.matches === 'function' && el.matches('input[type="number"]')) {
      const root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
      info.focusedNumberInput = !!root && root.activeElement === el;
    }
    const select = el.closest ? el.closest('select') : null;
    if (select && !select.multiple && !(select.size > 1)) {
      const options = Array.from(select.options || []).slice(0, 60).map(option => String(option.text || '').trim());
      const current = select.options && select.options[select.selectedIndex]
        ? String(select.options[select.selectedIndex].text || '').trim() : '';
      info.select = { current, options };
      if (index === 0 && req.focusSelect === true) {
        try { select.focus(); } catch (e) { /* focus is best effort */ }
      }
    }
    return info;
  });
  const result = { points: infos };
  if (req.focus === true) {
    // The focused element through shadow roots and same-origin frames.
    let active = document.activeElement;
    for (let i = 0; active && i < 16; i++) {
      const inner = active.shadowRoot && active.shadowRoot.activeElement;
      if (inner && inner !== active) { active = inner; continue; }
      const tag = String(active.tagName || '').toUpperCase();
      if (tag === 'IFRAME' || tag === 'FRAME') {
        let doc = null;
        try { doc = active.contentDocument; } catch (e) { doc = null; }
        if (doc && doc.activeElement && doc.activeElement !== doc.body) { active = doc.activeElement; continue; }
      }
      break;
    }
    const under = found[0] && found[0].el;
    const within = (node, ancestor) => {
      for (let n = node, i = 0; n && i < 256; n = up(n), i++) if (n === ancestor) return true;
      return false;
    };
    let editable = false;
    try {
      editable = !!active && active.nodeType === 1 && active !== active.ownerDocument.body
        && (active.isContentEditable === true || (active.matches(TEXT_ENTRY) && !active.matches('input[type="range"]')));
    } catch (e) { editable = false; }
    result.focus = { editable, matchesPoint: !!active && !!under && (within(under, active) || within(active, under)) };
  }
  if (req.pair === true && found.length === 2) {
    if (!found[0].el || !found[1].el) {
      result.pair = { known: false };
    } else {
      // The click a press and release produce goes to their nearest common
      // ancestor; it activates a control when that ancestor is (inside) one.
      const ancestors = new Set();
      for (let n = found[1].el, i = 0; n && i < 256; n = up(n), i++) ancestors.add(n);
      let common = null;
      for (let n = found[0].el, i = 0; n && i < 256; n = up(n), i++) {
        if (ancestors.has(n)) { common = n; break; }
      }
      let control = common ? controlOf(common) : null;
      // A pointer cursor alone does not turn a slider or handle drag into a click.
      if (control && control.kind === 'clickable element' && dragAffordance(found[0].el)) control = null;
      result.pair = { known: true, clickEquivalent: !!control };
      if (control) result.pair.control = control.kind;
    }
  }
  return result;
}

/** An expression that evaluates visionDomProbe(request) in a page. */
export function visionDomProbeExpression(request) {
  return `(${visionDomProbe.toString()})(${JSON.stringify(request || {})})`;
}

/** Minimum press-to-release distance (CSS px) for drag_at. */
export const VISION_MIN_DRAG_CSS_PX = 6;

/**
 * Dispatch checks shared by both builds. Each returns a no-dispatch result
 * to send back to the model, or null when the action may go ahead.
 */
export function visionMultiClickRefusal(probe, { clickCount = 1, recipientGuarded = false, submitDetected = false } = {}) {
  if (!(clickCount > 1)) return null;
  const point = probe?.points?.[0];
  const reason = recipientGuarded ? 'this is a protected messaging page'
    : submitDetected ? 'the point is a submit control'
      : !point || !point.found ? 'WebBrain could not check what is under the pointer'
        : point.opaqueFrame ? 'the point is inside an embedded frame WebBrain cannot inspect'
          : point.clickable ? `the point is on a ${point.control || 'control'}`
            : '';
  if (!reason) return null;
  return {
    success: false, dispatched: false, noDispatch: true, visionInputRefused: 'repeated_click',
    error: `Not dispatched: a ${clickCount === 2 ? 'double' : 'triple'} click was refused because ${reason}, where every extra click would repeat the control's action (for example submit twice). Use click_at with clicks: 1. Double and triple clicks are for selecting text.`,
  };
}

export function visionDragRefusal(probe, from, to) {
  const distance = Math.hypot((Number(to?.x) || 0) - (Number(from?.x) || 0), (Number(to?.y) || 0) - (Number(from?.y) || 0));
  const refuse = (code, reason) => ({
    success: false, dispatched: false, noDispatch: true, visionInputRefused: code,
    error: `Not dispatched: ${reason}`,
  });
  if (distance < VISION_MIN_DRAG_CSS_PX) {
    return refuse('drag_too_short', 'a drag this short is a click. Use click_at to click.');
  }
  if (!probe?.points || probe.points.length < 2 || !probe.pair) {
    return refuse('drag_unchecked', 'WebBrain could not check what is under the pointer. Take a screenshot and try again, or use click_at / scroll_at.');
  }
  if (probe.points.some(point => point?.opaqueFrame)) {
    return refuse('drag_opaque_frame', 'the drag starts or ends inside an embedded frame whose content WebBrain cannot inspect, so it could act as a click there. Use click_at or scroll_at instead.');
  }
  if (!probe.pair.known) {
    return refuse('drag_unchecked', 'there is nothing under one end of the drag. Choose points on the page.');
  }
  if (probe.pair.clickEquivalent) {
    return refuse('drag_is_click', `pressing and releasing there would click the ${probe.pair.control || 'control'} under both ends. Use click_at to click it; drag_at is for sliders, reordering and selecting.`);
  }
  return null;
}

export function visionWheelRefusal(probe) {
  const point = probe?.points?.[0];
  if (!point?.focusedNumberInput) return null;
  return {
    success: false, dispatched: false, noDispatch: true, visionInputRefused: 'wheel_number_input',
    error: 'Not dispatched: the point is over a focused number field, and the mouse wheel would change its value instead of scrolling. Scroll at another point, or press Escape / click elsewhere first.',
  };
}
