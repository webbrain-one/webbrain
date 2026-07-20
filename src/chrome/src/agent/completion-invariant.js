const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const DIRECT_ACTION_TOOLS = new Set([
  'click',
  'click_ax',
  'set_checked',
  'iframe_click',
  'drag_drop',
  'type_text',
  'type_ax',
  'iframe_type',
  'upload_file',
  'execute_js',
  'inject_css',
  'remove_injected_css',
  'patch_element',
  'revert_patch',
  'solve_captcha',
  'schedule_resume',
  'schedule_task',
]);

const NAVIGATION_ACTION_TOOLS = new Set([
  'navigate',
  'new_tab',
  'go_back',
  'go_forward',
]);

// Intentionally excluded from action debt: resize_window is transient viewport
// setup, not a consequential task-result mutation in the v1 runtime contract.
const DOWNLOAD_ACTION_TOOLS = new Set([
  'download_files',
  'download_file',
  'download_resource_from_page',
  'download_social_media',
]);

// v1 deliberately enforces ordering, not semantic postcondition matching:
// any successful explicit observation in this allowlist after the latest
// action clears debt. This deterministically blocks success-without-a-read,
// but it cannot prove that the read was relevant to the task. Action-specific
// and domain-specific postconditions belong to a later enforcement layer.
const OBSERVATION_TOOLS = new Set([
  'get_accessibility_tree',
  'read_page',
  'read_pdf',
  'read_page_source',
  'get_interactive_elements',
  'extract_data',
  'verify_form',
  'iframe_read',
  'wait_for_element',
  'inspect_element_styles',
  'read_console',
  'inspect_network_requests',
  'get_shadow_dom',
  'shadow_dom_query',
  'get_frames',
  'screenshot',
  'full_page_screenshot',
  'list_downloads',
  'read_downloaded_file',
]);
// inspect_event_listeners briefly marks the live DOM to resolve refs. Treating
// that implementation-level mutation as verification would let it clear debt
// without observing the requested post-action state.

const DONE_OUTCOMES = new Set(['success', 'partial', 'failed']);

function normalizedMethod(args = {}) {
  return String(args?.method || 'GET').trim().toUpperCase();
}

function normalizedOutcome(value) {
  const outcome = String(value || '').trim().toLowerCase();
  return DONE_OUTCOMES.has(outcome) ? outcome : '';
}

function keyText(args = {}) {
  return JSON.stringify(args?.key ?? args?.keys ?? '').toLowerCase();
}

function isSelfVerifyingActionResult(name, result) {
  if (name !== 'schedule_task' && name !== 'schedule_resume') return false;
  return !!(
    result?.success === true
    && result?.scheduled === true
    && String(result?.jobId || '').trim()
    && Number.isFinite(Date.parse(String(result?.scheduledAt || '')))
  );
}

export function isCompletionActionTool(name, args = {}) {
  if (
    DIRECT_ACTION_TOOLS.has(name)
    || NAVIGATION_ACTION_TOOLS.has(name)
    || DOWNLOAD_ACTION_TOOLS.has(name)
    || args?.__completionDownloadAction === true
  ) {
    return true;
  }
  if (name === 'set_field') return true;
  if (name === 'press_keys') {
    const keys = keyText(args);
    const benign = /\b(tab|escape|esc)\b/.test(keys);
    const risky = /\b(enter|return)\b/.test(keys);
    // Arrow keys are consequential: Chrome's trusted CDP path can change
    // native select/range values, and either browser can trigger page key
    // handlers. Unsupported keys remain fail-closed here; their handlers opt
    // out with dispatched:false before emitting any keyboard event.
    return !benign || risky;
  }
  if (name === 'fetch_url' || name === 'research_url') {
    return MUTATION_METHODS.has(normalizedMethod(args));
  }
  return false;
}

export function didCompletionActionExecute(name, args = {}, result) {
  if (!isCompletionActionTool(name, args)) return false;
  if (name === 'fetch_url' || name === 'research_url') {
    // Once a write request reaches the network tool, an error response cannot
    // prove that the server did not commit the mutation.
    return true;
  }
  if (result == null) return true;
  if (
    name === 'set_checked'
    && result.success === true
    && result.idempotent === true
    && result.verified === true
    && result.dispatched === false
    && result.noDispatch === true
    && result.checkedAfter === args?.checked
  ) {
    return false;
  }
  if (result.dispatched === true) return true;
  if (
    result.missingToolResponse
    || result.outcomeUnknown
    || result.inconclusive
    || result.fallbackAttempted
    || result.noProgress
  ) {
    return true;
  }
  if (result.success === true) return true;
  if (
    result.denied
    || result.skipped
    || result.cancelled
    || result.noDispatch === true
    || result.dispatched === false
  ) {
    return false;
  }
  // click_ax reports fallbackAttempted:false only when it failed before either
  // the DOM click or the CDP fallback was dispatched (for example a stale ref).
  if (name === 'click_ax' && result.success === false && result.fallbackAttempted === false) {
    return false;
  }
  // upload_file handlers mark the point where file data reached the page.
  // Validation/download-resolution failures happen before that point.
  if (name === 'upload_file' && result.success === false && result.dispatched !== true) {
    return false;
  }
  // Once an action handler was invoked, an error is not proof that nothing
  // happened: page JS may mutate before throwing, uploads may be consumed
  // before confirmation fails, and navigation responses can be lost. Action
  // tools must opt into the false path with dispatched:false/noDispatch:true.
  if (result.success === false || result.error) return true;
  // Most legacy action tools return a result object without an explicit
  // success boolean. No error means the action was dispatched.
  return true;
}

export function isCompletionObservationTool(name, args = {}, result) {
  if (name === 'fetch_url' || name === 'research_url') {
    if (MUTATION_METHODS.has(normalizedMethod(args))) return false;
  } else if (!OBSERVATION_TOOLS.has(name)) {
    return false;
  }
  if (result == null || result.missingToolResponse || result.outcomeUnknown) return false;
  if (
    result.success === false
    || result.denied
    || result.skipped
    || result.cancelled
    || result.error
  ) {
    return false;
  }
  if (name === 'wait_for_element' && (result.found !== true || result.timedOut === true)) {
    return false;
  }
  if (name === 'screenshot' || name === 'full_page_screenshot') {
    if (result.method === 'save_only') return false;
    if (result.method === 'vision_describe') return !!result.description;
    if (result.method === 'image_attach') return !!result._attachImage;
    return !!(result._attachImage || result.image || result.dataUrl);
  }
  return true;
}

export function createCompletionInvariantState(runToken = '') {
  return {
    runToken: String(runToken || ''),
    sequence: 0,
    hadAction: false,
    verificationDebt: false,
    lastAction: null,
    lastObservation: null,
    consumedActionSequence: 0,
    consumedObservationSequence: 0,
  };
}

export function recordCompletionToolResult(state, name, args = {}, result) {
  const current = state || createCompletionInvariantState();
  const sequence = Number(current.sequence || 0) + 1;
  const next = { ...current, sequence };

  if (didCompletionActionExecute(name, args, result)) {
    const selfVerified = isSelfVerifyingActionResult(name, result);
    next.hadAction = true;
    // A persisted scheduler result proves its own mutation, but it must never
    // erase verification debt opened by an earlier page action.
    if (selfVerified && current.verificationDebt) return next;
    next.verificationDebt = !selfVerified;
    next.lastAction = {
      name,
      sequence,
      ...(selfVerified ? { selfVerified: true } : {}),
      uncertain: !!(
        result == null
        || result?.missingToolResponse
        || result?.outcomeUnknown
        || result?.inconclusive
        || result?.fallbackAttempted
        || result?.noProgress
        || (result?.dispatched === true && result?.success !== true)
        || result?.success === false
        || result?.error
      ),
    };
    return next;
  }

  if (isCompletionObservationTool(name, args, result)) {
    next.lastObservation = { name, sequence };
    if (current.verificationDebt) next.verificationDebt = false;
  }
  return next;
}

export function hasFreshCompletionObservation(state) {
  if (!state?.hadAction || state.verificationDebt) return false;
  const actionSequence = Number(state.lastAction?.sequence || 0);
  const observationSequence = Number(state.lastObservation?.sequence || 0);
  return observationSequence > actionSequence;
}

export function hasUnconsumedCompletionObservation(state) {
  if (!hasFreshCompletionObservation(state)) return false;
  const actionSequence = Number(state.lastAction?.sequence || 0);
  const observationSequence = Number(state.lastObservation?.sequence || 0);
  const consumedActionSequence = Number(state.consumedActionSequence || 0);
  const consumedSequence = Number(state.consumedObservationSequence || 0);
  return actionSequence > consumedActionSequence && observationSequence > consumedSequence;
}

export function hasUnconsumedCompletionObservationResult(state) {
  const actionSequence = Number(state?.lastAction?.sequence || 0);
  const observationSequence = Number(state?.lastObservation?.sequence || 0);
  const consumedSequence = Number(state?.consumedObservationSequence || 0);
  return observationSequence > actionSequence && observationSequence > consumedSequence;
}

export function consumeCompletionObservation(state) {
  if (!hasUnconsumedCompletionObservation(state)) return state;
  return {
    ...state,
    consumedActionSequence: Number(state.lastAction?.sequence || 0),
    consumedObservationSequence: Number(state.lastObservation?.sequence || 0),
  };
}

export function consumeCompletionObservationResult(state) {
  if (!hasUnconsumedCompletionObservationResult(state)) return state;
  return {
    ...state,
    consumedObservationSequence: Number(state.lastObservation?.sequence || 0),
  };
}

export function completionDoneBlock(state, toolName, args = {}) {
  const isDoneJson = toolName === 'done_json';
  const outcome = isDoneJson ? 'success' : normalizedOutcome(args?.outcome);
  if (!isDoneJson && !outcome) {
    return {
      reason: 'missing_outcome',
      error: 'done requires outcome="success", "partial", or "failed". Use partial or failed when the task is not fully verified.',
    };
  }
  if (outcome === 'partial' || outcome === 'failed') return null;
  if (state?.verificationDebt) {
    return {
      reason: 'verification_required',
      error: 'The latest consequential action has not been verified by a successful explicit page/state observation. Re-read the relevant state after the action, then call done again; otherwise finish with outcome="partial" or outcome="failed".',
      lastAction: state.lastAction ? {
        name: state.lastAction.name,
        sequence: state.lastAction.sequence,
        uncertain: state.lastAction.uncertain,
      } : null,
    };
  }
  return null;
}

export function completionPlainFinalBlock(state) {
  if (!state?.hadAction) return null;
  return '[RUNTIME COMPLETION BLOCK: This Act/Dev run executed a consequential action, so a plain final answer cannot end it. Call done with an explicit outcome of success, partial, or failed. Use success only after a post-action observation verified the current state.]';
}
