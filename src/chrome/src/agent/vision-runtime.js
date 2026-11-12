// Vision mode runtime: the agent-side half of vision-mode.js. Installed onto
// the Agent class of each build by installVisionRuntime(); the per-build
// agent.js supplies five small platform methods (probe, capture, wheel,
// hover, drag) and the click dispatch. Shared verbatim by both builds.
//
// Flow of a vision Act run:
//   1. The run starts with a fresh full frame (f<n>) after the user's message.
//   2. The model calls coordinate tools. click_at is rewritten into an
//      ordinary coordinate `click` before the batch pipeline, so every
//      permission gate and hard guard sees it; the other tools run here.
//   3. After the batch WebBrain waits for the screen to settle, diffs it
//      against what the model has seen and sends a patch, a new frame, or a
//      one-line "no visible change".
//   4. Only the current frame, its patches and zooms stay in the request;
//      older images become short placeholders (_visionPruneImages).

import { resolveVisionMode, normalizeVisionModeSetting } from './vision-mode.js';
import { VisionSession, VISION_MAX_LIVE_ZOOMS } from './vision-session.js';
import { diffFrames, planFrameUpdate, pointTouchesRegions } from './vision-diff.js';
import {
  VISION_PROFILES, planVisionImageSize, planZoomImageSize, estimateVisionTokens, visionEncodingFor,
  normalizeVisionQuality,
} from './vision-budget.js';
import { rasterizeFrame, encodeCanvasRegion, cropImage, supportsWebpEncoding } from './vision-encoder.js';
import {
  VISION_NATIVE_TOOLS, VISION_TRANSLATED_TOOLS, VISION_NO_OBSERVE_TOOLS, VISION_TOOL_NAMES,
  VISION_SCROLL_STEP_CSS_PX, VISION_DEFAULT_SCROLL_STEPS, VISION_MAX_WAIT_SECONDS,
  translateVisionClick, visionKeyframeNote, visionPatchNote, visionNoChangeNote, visionZoomNote,
  visionFilePickerBlockedResult,
} from './vision-tools.js';
import {
  VISION_MIN_DRAG_CSS_PX, visionMultiClickRefusal, visionDragRefusal, visionWheelRefusal,
} from './vision-dom-probe.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Errors that steer the run (stop, deadlines, page feedback) pass through;
// anything else in a vision tool or screen update becomes a result or a note
// instead of ending the run.
function isControlFlowError(error) {
  return error?.name === 'AbortError'
    || error?.code === 'content_action_timeout'
    || error?.code === 'page_feedback_pending';
}

function errorText(error) {
  return String(error?.message || error || 'unknown error').slice(0, 200);
}
// A point within this many keyframe px of a change made earlier in the same
// batch is refused: the model chose it on the screen before that change.
const STABILITY_MARGIN_PX = 12;
const SETTLE_INITIAL_DELAY_MS = 120;
const SETTLE_POLL_MS = 220;
const SETTLE_MAX_EXTRA_CAPTURES = 3;
// Images kept after the current frame (its patches and zooms), as data-URL
// characters: past this, the oldest zooms leave the request first. Patches
// are never dropped (they are the current screen); a long patch chain turns
// into a new frame instead (vision-diff.js planFrameUpdate).
const RETAINED_IMAGE_CHARS_BUDGET = 8_000_000;
// An upload handoff (_visionNoteUploadHandoff) lasts this many model
// decisions without a successful upload_file.
const UPLOAD_HANDOFF_DECISIONS = 5;
// A run stops handing off once this many handoffs have ended without an
// upload (expired, or the page was left): a page whose upload never succeeds
// goes back to vision and then reports the chooser instead of handing off
// again. A handoff that attached its file does not count, because each file
// takes its own handoff: a release with three assets needs three.
const UNSUCCESSFUL_UPLOAD_HANDOFFS_PER_RUN = 2;
// Screenshot redaction scans the page from a content script that starts when
// the document is idle: a capture right after a navigation often finds no
// scan yet. While the tab loads, WebBrain waits this long for one, then
// captures again.
const REDACTION_SCAN_WAIT_MS = 1500;
// A viewport measurement or screenshot that has not answered by then (a hung
// renderer, a stalled debugger) fails like any capture failure, with its own
// error code (never a control-flow one), and is not retried; Stop ends the
// wait at once (_visionBounded).
const VISION_CAPTURE_DEADLINE_MS = 15000;
// An observation whose capture failed for a passing reason (a navigation
// destroyed the page context, the page was not ready to paint) is tried
// again, within this many attempts and this much time. Input is never
// retried, nor a timeout, a privacy failure or anything not recognized here.
const OBSERVE_RETRY_ATTEMPTS = 4;
const OBSERVE_RETRY_BUDGET_MS = 3000;
const OBSERVE_RETRY_DELAY_MS = 250;
const REDACTION_SCAN_POLL_MS = 250;
// Redaction outcomes (agent _redactScreenshotDataUrl) that leave the image as
// captured although redaction is on. Redaction is best-effort: the image is
// still sent, and the user and the trace are told (_visionReportUnredacted).
const UNREDACTED_OUTCOMES = new Set(['decode_failed', 'scan_unavailable', 'pixelate_failed', 'error']);
// A change this small between two captures (a blinking caret, a ticking
// clock, a spinner: a few 16 px cells) is not the page still reacting to an
// action, and right after the model looked it is not worth a new image.
const MICRO_CHANGE_CELL_RATIO = 0.004;
const MICRO_CHANGE_MIN_CELLS = 6;
// Calls whose effect, or reading, is of the screen they acted on: in a vision
// run their loop identity includes the screen version (_loopScreenIdentity),
// as does the coordinate click click_at becomes.
const VISION_LOOP_SCREEN_TOOLS = new Set([...VISION_NATIVE_TOOLS, 'type_text', 'press_keys']);
// Calls that look at the page or wait without acting on it, besides those
// that get no screen update at all (VISION_NO_OBSERVE_TOOLS).
const VISION_LOOK_ONLY_TOOLS = new Set(['take_screenshot', 'wait']);

// Does this vision call place something at points of a screenshot (a click,
// hover, drag, zoom region, or a wheel at a point)?
function visionCallReadsPoints(name, args = {}) {
  if (['click_at', 'hover_at', 'drag_at', 'zoom'].includes(name)) return true;
  return name === 'scroll_at' && args?.x != null && args?.y != null;
}

export function isMicroScreenChange(diff) {
  return diff?.comparable === true && Number.isFinite(diff.changedCells)
    && diff.changedCells <= Math.max(MICRO_CHANGE_MIN_CELLS, Math.round((Number(diff.totalCells) || 0) * MICRO_CHANGE_CELL_RATIO));
}

function visionFrameTag(message) {
  return message && typeof message === 'object' ? message.webbrainVisionFrame : null;
}

function isImageBlock(block) {
  return block && (block.type === 'image_url' || block.type === 'image');
}

// Screen updates are app-owned user turns: never mistaken for a new user
// request (task anchors, plan guards), and their webbrain* keys never reach
// a provider.
function visionUserMessage(content, tag) {
  return { role: 'user', content, webbrainAppOwned: true, webbrainAppOwnedKind: 'vision_frame', webbrainVisionFrame: tag };
}

// Typing goes to whatever has focus, which only the screen shows.
const VISION_TYPING_TOOLS = new Set(['type_text', 'press_keys']);

/** Typing refused while the model has not seen the current screen. */
function visionScreenUnverifiedResult(name, { noFrame = false } = {}) {
  const verb = name === 'press_keys' ? 'pressed' : 'typed';
  const why = noFrame
    ? 'no screenshot of this page has been taken yet'
    : 'the screen could not be updated after the last action';
  return {
    success: false, dispatched: false, noDispatch: true, visionScreenUnverified: true,
    error: `Not ${verb}: ${why}, so what has focus now is unknown. Call take_screenshot and look first, or click_at the field in the same response before typing.`,
  };
}

/**
 * Why a viewport measurement or screenshot failed, from a closed list:
 * 'restricted' (a browser page screenshots cannot capture), 'transient' (the
 * page context changed or was not ready; worth one more look), or '' (any
 * other failure, a timeout, Stop).
 */
export function classifyVisionCaptureError(error) {
  if (!error || error.name === 'AbortError' || error.code === 'vision_capture_timeout') return '';
  const message = errorText(error);
  if (/cannot access (?:a )?(?:chrome(?:-extension|-untrusted)?|devtools):\/\/ URL\b/i.test(message)) return 'restricted';
  if (/permission|denied|not allowed|not attached|disconnected|no tab|target closed|session closed|tab (?:was |is )?closed/i.test(message)) return '';
  if (/execution context (?:was )?destroyed|cannot find (?:default )?(?:execution )?context|no such (?:realm|frame)|page changed during screenshot capture|unable to capture screenshot|cannot take screenshot with 0 (?:width|height)|page viewport could not be measured/i.test(message)) return 'transient';
  return '';
}

// What the model is told to do after a capture failure.
function captureFailureAdvice(error, retry = 'Call take_screenshot to look again.') {
  return classifyVisionCaptureError(error) === 'restricted'
    ? 'This is a browser page that screenshots cannot capture: open a web page with navigate({url}), or ask the user.'
    : retry;
}

// The page an upload handoff belongs to: its address without the fragment.
function pageKey(url) {
  return String(url || '').split('#')[0];
}

// upload_file put the file into its input, in any build's success shape
// (Chrome CDP, Firefox synthetic or BiDi, recipient-bound).
function uploadAttached(result) {
  return result?.success === true && result.discoveryOnly !== true && result.outcomeUnknown !== true
    && result.noDispatch !== true && ['input_attached', 'page_consumed'].includes(result.attachmentState);
}

// The selector a blocked chooser's result tells the model to pass to
// upload_file, kept with the handoff that covers it until the handoff starts
// (_visionUploadHandoffTick). The compact tier's upload_file names its target
// by its own discovery, never by selector.
function noteHandoffUploadSelector(handoff, result, compact) {
  const selector = typeof result?.selector === 'string' ? result.selector : '';
  const selectors = handoff.selectors ??= [];
  if (compact || handoff.active || !selector || selector.length > 4096 || selectors.includes(selector)
      || selectors.length >= 8) return;
  selectors.push(selector);
}

function regionLabel(region) {
  return { x: Math.round(region.x), y: Math.round(region.y), width: Math.round(region.width), height: Math.round(region.height) };
}

/** Highest epoch and image number a history already used (session seeds). */
export function visionHistoryCounters(messages) {
  let epoch = 0;
  let counter = 0;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const tag = visionFrameTag(message);
      if (!tag) continue;
      epoch = Math.max(epoch, Number(tag.epoch) || 0);
      for (const id of Array.isArray(tag.ids) ? tag.ids : []) {
        const number = Number(String(id).slice(1));
        if (Number.isFinite(number)) counter = Math.max(counter, number);
      }
    }
  }
  return { epoch, counter };
}

/**
 * Keep only the current screen's images: the LAST full frame in the history
 * and the patches and zooms after it. Position decides, not the epoch
 * number, which starts over in a new session (another model, a restarted
 * worker). Exported for the unit suite; agents call it via _pruneOldImages.
 * Returns { messages, latestEpoch } where `messages` is a shallow copy.
 */
export function pruneVisionImages(messages) {
  if (!Array.isArray(messages)) return { messages, latestEpoch: 0 };
  let latestKeyIndex = -1;
  let retireIndex = -1;
  for (let index = messages.length - 1; index >= 0 && latestKeyIndex < 0; index--) {
    const tag = visionFrameTag(messages[index]);
    if (tag?.kind === 'key') latestKeyIndex = index;
    else if (tag?.kind === 'retire' && retireIndex < 0) retireIndex = index;
  }
  if (latestKeyIndex < 0) return { messages, latestEpoch: 0 };
  const latestEpoch = Math.max(1, Number(visionFrameTag(messages[latestKeyIndex]).epoch) || 1);
  // A run whose first capture failed retires the last frame: it showed an
  // earlier run's screen, and no point may be read from it any more.
  const boundary = retireIndex > latestKeyIndex ? retireIndex : latestKeyIndex;
  const out = messages.map((message, index) => {
    const tag = visionFrameTag(message);
    if (!Array.isArray(message?.content)) return message;
    if (tag && index >= boundary) return message;
    // Untagged screenshots older than the current frame (an Ask-mode capture
    // before an automatic switch to Act) are superseded by it too. User
    // attachments are never touched.
    if (!tag && (index > boundary || message.role !== 'user')) return message;
    let inAttachments = false;
    let changed = false;
    const content = message.content.map(block => {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith('[UNTRUSTED USER ATTACHMENTS')) {
        inAttachments = true;
        return block;
      }
      if (!isImageBlock(block) || inAttachments) return block;
      changed = true;
      return { type: 'text', text: `[older screenshot${tag?.ids?.length ? ` ${tag.ids.join(', ')}` : ''} omitted — superseded by the current frame]` };
    });
    return changed ? { ...message, content } : message;
  });
  return { messages: dropOldZooms(out, boundary), latestEpoch };
}

/**
 * After the current frame, only the newest VISION_MAX_LIVE_ZOOMS zooms keep
 * their images (as only they stay usable, VisionSession.registerZoom), and
 * older zooms go first while the kept images exceed
 * RETAINED_IMAGE_CHARS_BUDGET. A tagged message's image blocks are its ids,
 * in order.
 */
function dropOldZooms(messages, boundary) {
  const slots = [];
  let chars = 0;
  messages.forEach((message, index) => {
    const tag = visionFrameTag(message);
    if (index < boundary || !tag || !Array.isArray(message.content) || !Array.isArray(tag.ids)) return;
    const blocks = message.content.map((block, at) => (isImageBlock(block) ? at : -1)).filter(at => at >= 0);
    blocks.forEach((at, order) => {
      const block = message.content[at];
      const size = String(block.image_url?.url || block.image_url || block.source?.data || '').length;
      chars += size;
      if (blocks.length === tag.ids.length && /^z\d+$/.test(tag.ids[order])) slots.push({ index, at, id: tag.ids[order], size });
    });
  });
  const drop = new Set();
  const excess = slots.length - VISION_MAX_LIVE_ZOOMS;
  for (const slot of slots.slice(0, Math.max(0, excess))) { drop.add(slot); chars -= slot.size; }
  for (const slot of slots) {
    if (chars <= RETAINED_IMAGE_CHARS_BUDGET) break;
    if (!drop.has(slot)) { drop.add(slot); chars -= slot.size; }
  }
  if (!drop.size) return messages;
  const out = messages.slice();
  for (const slot of drop) {
    const message = out[slot.index];
    const content = message.content.slice();
    content[slot.at] = { type: 'text', text: `[zoom ${slot.id} omitted — older than the zooms kept; zoom again if needed]` };
    out[slot.index] = { ...message, content };
  }
  return out;
}

export function installVisionRuntime(AgentClass, { trace = null } = {}) {
  const proto = AgentClass.prototype;

  /** Vision decision for this tab's run (or the live settings between runs). */
  proto._visionRunState = function _visionRunState(tabId, mode = null) {
    const runMode = mode || (typeof this._effectiveRunMode === 'function' ? this._effectiveRunMode(tabId) : 'ask');
    const snapshot = this._visionRunSnapshots?.get(tabId);
    let provider = null;
    try { provider = this._activeProvider(tabId); } catch { provider = null; }
    const standalone = !!(this._standaloneChatRunTabs?.has(tabId) || this._tinyAskRunTabs?.has(tabId)
      || this._standaloneWebgpuRunTabs?.has(tabId));
    return resolveVisionMode(snapshot ? snapshot.setting : this.visionMode, {
      mode: runMode,
      provider,
      standalone,
      quality: snapshot ? snapshot.quality : this.visionQuality,
      ledgerWorkflow: this._planExecutionGuards?.get?.(tabId)?.siteWorkflow?.job?.requiresLedger === true,
      completeThreadRead: this.readCompletenessStates?.get?.(tabId)?.required === true,
      nativeChatPage: this._visionNativeChatPage?.(tabId) === true,
      uploadHandoff: snapshot?.uploadHandoff?.active === true,
    });
  };

  proto._visionToolOptions = function _visionToolOptions(tabId, mode) {
    const state = this._visionRunState(tabId, mode);
    return state.active ? { coordinates: state.coordinates } : null;
  };

  /**
   * Freeze the setting for the length of one run (see vision-mode.js). The
   * previous run's screen is retired: a run acts only on frames it captured
   * itself, so a failed first capture can never leave the model aiming at
   * the last run's page.
   */
  proto._beginVisionRun = function _beginVisionRun(tabId) {
    if (!this._visionRunSnapshots) this._visionRunSnapshots = new Map();
    this._visionRunSnapshots.set(tabId, {
      setting: normalizeVisionModeSetting(this.visionMode, 'off'),
      quality: normalizeVisionQuality(this.visionQuality),
      // A file upload handed to the element tools (_visionNoteUploadHandoff):
      // per run, so an enclosing run gets its own back with its snapshot.
      // `uploadHandoffs` counts every handoff (for the trace);
      // `unsuccessfulUploadHandoffs` only those that ended without an upload.
      uploadHandoff: null,
      uploadHandoffs: 0,
      unsuccessfulUploadHandoffs: 0,
      // Whether the step being run was planned with the tree tools
      // (_visionNoteStepTools).
      treeStep: false,
    });
    this._visionSessions?.get(tabId)?.retireKeyframe?.();
    void this._visionPlatformLateTab?.(tabId, { cancel: true })?.catch?.(() => {});
  };

  /** `previous` is the snapshot of an enclosing run on the same tab, if any. */
  proto._endVisionRun = function _endVisionRun(tabId, previous = null) {
    if (previous) this._visionRunSnapshots?.set(tabId, previous);
    else this._visionRunSnapshots?.delete(tabId);
    void this._visionPlatformLateTab?.(tabId, { cancel: true })?.catch?.(() => {});
  };

  /**
   * A run that does not start on vision (the setting off, a text-only model,
   * a page that needs the element inventory, Ask) after a vision run in the
   * same conversation: the last frame and its patches would still be sent
   * (pruneVisionImages keeps them). A retire marker drops them; the run's own
   * frames, if vision starts later, come after it. Returns true if pushed.
   */
  proto._visionRetireEarlierFrames = function _visionRetireEarlierFrames(messages) {
    if (!Array.isArray(messages)) return false;
    const lastKey = messages.findLastIndex(message => visionFrameTag(message)?.kind === 'key');
    if (lastKey < 0 || messages.findLastIndex(message => visionFrameTag(message)?.kind === 'retire') > lastKey) return false;
    messages.push(visionUserMessage('[Screenshots from earlier vision steps are not shown: this run works without them. Read the page again before relying on what it showed.]', { epoch: 0, kind: 'retire' }));
    return true;
  };

  /**
   * A vision click_at the file-chooser guard stopped, in either build and on
   * any dispatch path, hands the next steps to the element tools, upload_file
   * among them; a successful upload_file hands them back. Called once per
   * model tool call from the batch pipeline with the final result, which it
   * returns as the model should read it. Changes take effect at the next step
   * (_visionUploadHandoffTick): the rest of this batch, and its screen update,
   * run in the mode they were planned in. Every file gets its own handoff;
   * only handoffs that ended without an upload count toward
   * UNSUCCESSFUL_UPLOAD_HANDOFFS_PER_RUN.
   */
  proto._visionNoteUploadHandoff = function _visionNoteUploadHandoff(tabId, name, result, { vision = null, promptTier = '' } = {}) {
    const snapshot = this._visionRunSnapshots?.get(tabId);
    if (vision?.tool === 'click_at' && result?.filePickerBlocked === true) {
      const compact = promptTier === 'compact';
      // Only Chrome's protocol guard saw the chooser: its input is in a frame
      // or a closed shadow root, which upload_file cannot reach either. A
      // build whose upload_file has no file to use says so (agent
      // _visionUploadSourceAvailable).
      let reason = result.protocolOnly === true ? 'unreachable'
        : this._visionUploadSourceAvailable?.(tabId, promptTier) === false ? 'no_source' : '';
      if (!snapshot) return visionFilePickerBlockedResult(result, { compact, reason });
      // Another chooser in the batch that armed a handoff: that handoff gives
      // the next steps upload_file for this input too, so the model is told
      // so, not that uploads are unavailable.
      if (!reason && snapshot.uploadHandoff) {
        noteHandoffUploadSelector(snapshot.uploadHandoff, result, compact);
        return visionFilePickerBlockedResult(result, { handoff: true, compact });
      }
      if (!reason && snapshot.unsuccessfulUploadHandoffs >= UNSUCCESSFUL_UPLOAD_HANDOFFS_PER_RUN) reason = 'exhausted';
      if (reason) {
        this._visionTraceNote(tabId, 'vision_upload_handoff', { stage: 'refused', reason });
        return visionFilePickerBlockedResult(result, { compact, reason });
      }
      snapshot.uploadHandoffs += 1;
      snapshot.uploadHandoff = { active: false, done: false, since: 0, url: '', selectors: [] };
      noteHandoffUploadSelector(snapshot.uploadHandoff, result, compact);
      this._visionTraceNote(tabId, 'vision_upload_handoff', { stage: 'armed', count: snapshot.uploadHandoffs });
      return visionFilePickerBlockedResult(result, { handoff: true, compact });
    }
    const handoff = snapshot?.uploadHandoff;
    if (handoff?.active && name === 'upload_file' && uploadAttached(result)) handoff.done = true;
    return result;
  };

  /**
   * Once per loop iteration, before anything in the step depends on vision:
   * an armed handoff starts on the page the tab shows now (the click that
   * armed it may itself have changed the address), and an active one ends
   * after its upload, when that page is left, or after
   * UPLOAD_HANDOFF_DECISIONS decisions without an upload; the last two count
   * as unsuccessful. `step` is the loop's count of model calls, which grows
   * only when the model decides. Starting runs before the step's page
   * capture, so the blocked inputs the click's result named are observed for
   * the first upload_file (page-feedback.js _pageFeedbackObserveUploadTargets).
   */
  proto._visionUploadHandoffTick = async function _visionUploadHandoffTick(tabId, step) {
    const snapshot = this._visionRunSnapshots?.get(tabId);
    const handoff = snapshot?.uploadHandoff;
    if (!handoff) return;
    if (!handoff.active) {
      handoff.active = true;
      handoff.since = step;
      handoff.url = pageKey(await this._currentUrl?.(tabId));
      if (handoff.selectors?.length) await this._pageFeedbackObserveUploadTargets?.(tabId, handoff.selectors);
      return;
    }
    let end = handoff.done ? 'uploaded' : '';
    if (!end && handoff.url) {
      const url = pageKey(await this._currentUrl?.(tabId));
      if (url && url !== handoff.url) end = 'navigated';
    }
    if (!end && step - handoff.since >= UPLOAD_HANDOFF_DECISIONS) end = 'expired';
    if (end) {
      snapshot.uploadHandoff = null;
      if (end !== 'uploaded') snapshot.unsuccessfulUploadHandoffs += 1;
      this._visionTraceNote(tabId, 'vision_upload_handoff', { stage: 'ended', reason: end });
    }
  };

  /** Records whether the step about to run was planned with the vision tools. */
  proto._visionNoteStepTools = function _visionNoteStepTools(tabId, vision) {
    const snapshot = this._visionRunSnapshots?.get(tabId);
    if (snapshot) snapshot.treeStep = !vision;
  };

  /**
   * Back on vision after steps on the tree path (an upload handoff, a page
   * that needed the element inventory): the last frame may no longer show
   * the screen. It is retired first, so a failed capture leaves no frame to
   * aim at, and a settled full frame starts the step.
   */
  proto._visionResumeKeyframe = async function _visionResumeKeyframe(tabId, messages, onUpdate, { mode = 'act' } = {}) {
    const state = this._visionRunState(tabId, mode);
    if (!state.active) return null;
    this._visionSessions?.get(tabId)?.retireKeyframe?.();
    try {
      const frame = await this._visionCaptureRetrying(tabId, () => this._visionCaptureSettled(tabId, state));
      return await this._visionPushKeyframe(tabId, messages, onUpdate, { state, frame, reason: 'vision resumed' });
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      const message = `[SCREEN: the screen could not be captured on returning to screenshots (${errorText(error).slice(0, 160)}). Earlier screenshots show an older screen and cannot be used for coordinates. ${captureFailureAdvice(error, 'Call take_screenshot to try again.')}]`;
      messages.push(visionUserMessage(message, { epoch: 0, kind: 'retire' }));
      this._visionTraceNote(tabId, 'vision_frame_error', { stage: 'resume', error: String(error?.message || error).slice(0, 200) });
      return null;
    }
  };

  /** A closed tab or cleared conversation drops its screen state. */
  proto._visionForgetTab = function _visionForgetTab(tabId) {
    this._visionSessions?.delete(tabId);
    this._visionProbeContexts?.delete(tabId);
    this._lastTabUrls?.delete(tabId);
  };

  proto._visionSessionFor = function _visionSessionFor(tabId, state) {
    if (!this._visionSessions) this._visionSessions = new Map();
    const previous = this._visionSessions.get(tabId);
    if (previous && previous.coordinates === state.coordinates && previous.profileId === state.profileId) return previous;
    // A new session (first use, another model, a restarted worker) continues
    // the history's numbering so its ids and epochs never repeat.
    const history = visionHistoryCounters(this.conversations?.get?.(tabId));
    const session = new VisionSession({
      coordinates: state.coordinates,
      startEpoch: Math.max(history.epoch, previous?.epoch || 0),
      startCounter: Math.max(history.counter, previous?.counter || 0),
    });
    session.profileId = state.profileId;
    if (previous) {
      for (const [id, retired] of previous.retired) session.retired.set(id, retired);
      for (const [id, image] of previous.images) session.retired.set(id, { epoch: image.epoch, replacedBy: null });
    }
    this._visionSessions.set(tabId, session);
    return session;
  };

  /** The click submit probe at a CSS point: its reading when it is a submit, else null. */
  proto._visionSubmitAt = async function _visionSubmitAt(tabId, point) {
    if (typeof this._detectLikelySubmitAction !== 'function') return null;
    try {
      const detected = await this._detectLikelySubmitAction(tabId, 'click', { x: point.x, y: point.y, coordinate_space: 'css' });
      return detected?.isSubmit === true ? detected : null;
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      return null;
    }
  };

  /** What is under CSS points (vision-dom-probe.js); null when it cannot be read. */
  proto._visionDomProbe = async function _visionDomProbe(tabId, request) {
    if (typeof this._visionPlatformDomProbe !== 'function') return null;
    try {
      return await this._visionPlatformDomProbe(tabId, request);
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      return null;
    }
  };

  /**
   * Checks right before a vision click is dispatched, in both builds: a
   * native <select> is focused for type_text (its popup never shows in a
   * screenshot), and a double/triple click that would repeat a control's
   * action is refused. Returns { refusal } or { target }.
   */
  proto._visionClickPreflight = async function _visionClickPreflight(tabId, {
    x, y, button = 'left', clickCount = 1, recipientGuarded = false, submitDetected = false,
  } = {}) {
    const probe = await this._visionDomProbe(tabId, { points: [{ x, y }], focusSelect: button === 'left' });
    const point = probe?.points?.[0] || null;
    if (point?.select && button === 'left') {
      return {
        refusal: {
          success: false, dispatched: false, noDispatch: true, nativeSelect: true, tag: 'SELECT',
          text: point.select.current, options: point.select.options,
          error: `That point is a native dropdown (current: "${point.select.current}"). It is focused now: choose an option with type_text({text: "<option label>"}). Options: ${point.select.options.join(', ')}`,
        },
      };
    }
    const refusal = visionMultiClickRefusal(probe, { clickCount, recipientGuarded, submitDetected });
    if (refusal) return { refusal };
    const background = ['backdrop', 'empty'].includes(point?.dialogBackground) ? point.dialogBackground : '';
    return {
      target: point?.found ? { tag: point.tag, ...(point.role ? { role: point.role } : {}),
        ...(background ? { dialogBackground: background } : {}) } : null,
      // The click still goes: outside a dialog may be how it closes. The
      // model is told the point is on no control, which a bare
      // {tag:'div', role:'dialog'} target did not make plain enough.
      ...(button === 'left' && background ? { note: visionDialogBackgroundNote(background) } : {}),
    };
  };

  /**
   * A vision click that the deletion guard, or the check of a publish or
   * commit after a correction, authorized is bound to the control the submit
   * probe read at its point (agent _resourceMutationActionKey). So is one the
   * user approved on WebBrain's publication or submission card, whose answer
   * covers the action they saw. A ref click cannot land anywhere else; a
   * point can, if the page changed since. So right before input goes out the
   * point is read again, and a different control there (or one that cannot
   * be read) is refused.
   */
  proto._visionMutationBindingBlock = async function _visionMutationBindingBlock(tabId, args, detected) {
    if (!detected || typeof this._resourceMutationActionKey !== 'function') return null;
    const key = this._resourceMutationActionKey(tabId, 'click', args, detected);
    const authorization = this._planExecutionGuards?.get?.(tabId)?.resourceMutationAuthorization;
    const override = key ? this._publicationGuardOverrideRequest?.(tabId, 'click', args, detected) : null;
    const approved = !!override
      && this._unverifiedStepApproval?.(tabId, override.guardId, override.stepKey, { peek: true })?.source === 'user';
    if (!key || (authorization?.key !== key && !approved)) return null;
    let fresh = null;
    try {
      fresh = await this._detectLikelySubmitAction(tabId, 'click', args, { mutationReconciliation: true });
    } catch (error) {
      if (isControlFlowError(error)) throw error;
    }
    if (fresh && this._resourceMutationActionKey(tabId, 'click', args, fresh) === key
        && (!approved || this._publicationGuardOverrideRequest(tabId, 'click', args, fresh)?.stepKey === override.stepKey)) return null;
    const classification = detected.mutationKind === 'delete' ? 'delete' : detected.publicationControl === true ? 'publish' : 'submit';
    return {
      success: false, dispatched: false, noDispatch: true, visionScreenChanged: true,
      actionGuard: { stage: 'resource_mutation', reason: 'resource_changed_before_dispatch', classification },
      error: 'Not dispatched: the control at this point is no longer the one WebBrain checked. Look at the updated screen and choose the point again.',
    };
  };

  /**
   * Loop detection (loop-detector.js) in a vision run: an action's identity
   * includes the screen it acted on. The same point, key or scroll after the
   * screen visibly changed is progress (the next row moved under the point,
   * the next stretch of a list), while a repeat on a screen that did not
   * change still adds up to a loop. A click leaves out what the page changes
   * on its own (VisionSession.clickScreenVersion): a video playing behind a
   * dialog is no new screen for the dialog's button.
   */
  proto._loopScreenIdentity = function _loopScreenIdentity(tabId, name, args) {
    const screenTool = name === 'click' ? args?.coordinate_space === 'css' : VISION_LOOP_SCREEN_TOOLS.has(name);
    if (!screenTool || this._visionRunState(tabId).active !== true) return '';
    const session = this._visionSessions?.get(tabId);
    if (!session?.keyframe) return '';
    return name === 'click' && Number.isInteger(session.clickScreenVersion)
      ? `c${session.clickScreenVersion}` : `v${session.screenVersion || 0}`;
  };

  /** Loop advice names what a vision run offers (loop-detector.js). */
  proto._loopVisionRun = function _loopVisionRun(tabId) {
    return this._visionRunState(tabId).active === true;
  };

  /**
   * A CAPTCHA gate (agent _observeCaptchaChallenge) sees a solved or manually
   * completed challenge go away only through an authoritative root read of
   * the accessibility tree, a tool a vision run does not have. Before a page
   * action while a gate is pending (agent _inspectCaptchaBeforeMutation),
   * WebBrain makes that read itself; its text never reaches the model.
   */
  proto._visionCaptchaRootRead = async function _visionCaptchaRootRead(tabId, abortSignal = null) {
    if (this._visionRunState(tabId).active !== true || typeof this._observeCaptchaChallenge !== 'function') return null;
    const args = { filter: 'all', maxDepth: 15, maxChars: 60000 };
    let result = null;
    // An app-owned read, like page feedback's: not the model's observation.
    try { result = await this.executeTool(tabId, 'get_accessibility_tree', args, null, { pageFeedbackRead: true }); }
    catch (error) {
      if (isControlFlowError(error) || this._checkAbort?.(tabId)) throw error;
      return null;
    }
    this._throwIfAborted?.(abortSignal);
    if (!result || typeof result !== 'object' || result.error || result.success === false) return null;
    return (await this._observeCaptchaChallenge(tabId, 'get_accessibility_tree', result, args, abortSignal))?.gate || null;
  };

  proto._visionTraceNote = function _visionTraceNote(tabId, note, data) {
    const runId = this.currentRunId?.get?.(tabId);
    if (!runId || !trace?.recordNote) return;
    try { trace.recordNote(runId, null, note, data); } catch { /* traces are optional */ }
  };

  proto._visionEncoding = async function _visionEncoding(profile) {
    let webpSupported = false;
    try { webpSupported = await supportsWebpEncoding(); } catch { webpSupported = false; }
    return visionEncodingFor(profile, { webpSupported });
  };

  /**
   * Capture the viewport at the planned model size. The platform capture may
   * return any size (device pixels, emulated DPR, zoom); rasterizeFrame
   * resamples to the plan so the coordinate map is exact. `hold` is a screen
   * update's (_visionCaptureSettled), which shows WebBrain's page UI again
   * after its last capture.
   */
  proto._visionCaptureFrame = async function _visionCaptureFrame(tabId, state, { redactionRetry = true, hold = null } = {}) {
    const probe = await this._visionBounded(tabId, 'viewport measurement', () => this._visionPlatformProbe(tabId));
    if (!probe || !(probe.cssWidth > 0) || !(probe.cssHeight > 0)) throw new Error('The page viewport could not be measured.');
    const profile = VISION_PROFILES[state.profileId] || VISION_PROFILES.default;
    const size = planVisionImageSize({ cssWidth: probe.cssWidth, cssHeight: probe.cssHeight, profile, quality: state.quality });
    let dataUrl = await this._visionBounded(tabId, 'screenshot', () => this._visionPlatformCapture(tabId, { probe, outWidth: size.width, outHeight: size.height, hold }));
    if (!dataUrl) throw new Error('The browser returned no screenshot.');
    let redaction = null;
    if (this.screenshotRedaction && typeof this._redactScreenshotDataUrl === 'function') {
      const outcome = {};
      try {
        // The capture spans the visual viewport (no scrollbars), so the
        // redactor gets that box in page space rather than its own
        // innerWidth-based viewport.
        dataUrl = await this._redactScreenshotDataUrl(tabId, dataUrl, {
          coordinateSpace: 'page',
          capturedCssBounds: { x: probe.scrollX || 0, y: probe.scrollY || 0, width: probe.cssWidth, height: probe.cssHeight },
          outcome,
        });
      } catch (error) {
        if (isControlFlowError(error)) throw error;
        outcome.status = 'error';
      }
      // No scan yet on a loading page: wait for it, then capture again so the
      // scan and the image show the same page.
      if (outcome.status === 'scan_unavailable' && redactionRetry && await this._visionTabLoading?.(tabId) === true) {
        await this._visionAwaitRedactionScan(tabId);
        return this._visionCaptureFrame(tabId, state, { redactionRetry: false, hold });
      }
      redaction = outcome.status || 'error';
    }
    const raster = await this._visionRasterize(dataUrl, size.width, size.height);
    if (probe.url) (this._lastTabUrls ??= new Map()).set(tabId, String(probe.url));
    return { raster, probe, size, profile, redaction };
  };

  // Indirections over vision-encoder.js so the Node suite can substitute
  // canvas-free fakes; browsers always use the real encoder.
  proto._visionRasterize = function _visionRasterize(dataUrl, width, height) {
    return rasterizeFrame(dataUrl, width, height);
  };

  proto._visionEncodeRegion = function _visionEncodeRegion(canvas, region, options) {
    return encodeCanvasRegion(canvas, region, options);
  };

  /** Chrome's capture cuts the viewport out of the tab surface here (agent _visionPlatformCapture). */
  proto._visionCropImage = function _visionCropImage(dataUrl, rect, width, height) {
    return cropImage(dataUrl, rect, width, height);
  };

  /**
   * Runs one platform read (`what` names it in the error) against the run's
   * Stop and VISION_CAPTURE_DEADLINE_MS (`_visionCaptureDeadlineMs` overrides
   * it). The read itself is not cancelled; its late answer is ignored.
   */
  proto._visionBounded = async function _visionBounded(tabId, what, run) {
    const signal = this._runAbortSignal?.(tabId) || null;
    this._throwIfAborted?.(signal);
    const deadlineMs = Number(this._visionCaptureDeadlineMs) > 0 ? Number(this._visionCaptureDeadlineMs) : VISION_CAPTURE_DEADLINE_MS;
    let timer = null;
    let onAbort = null;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`The ${what} did not finish within ${deadlineMs / 1000} s.`);
          error.code = 'vision_capture_timeout';
          reject(error);
        }, deadlineMs);
        if (signal?.addEventListener) {
          onAbort = () => reject(signal.reason instanceof Error ? signal.reason
            : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
          signal.addEventListener('abort', onAbort, { once: true });
        }
        Promise.resolve().then(run).then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener?.('abort', onAbort);
    }
  };

  /**
   * An observation's capture, tried again while it fails for a transient
   * reason (classifyVisionCaptureError), within OBSERVE_RETRY_ATTEMPTS and
   * OBSERVE_RETRY_BUDGET_MS. Only screen reads come through here.
   */
  proto._visionCaptureRetrying = async function _visionCaptureRetrying(tabId, capture) {
    const deadline = Date.now() + OBSERVE_RETRY_BUDGET_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        return await capture();
      } catch (error) {
        if (isControlFlowError(error) || attempt >= OBSERVE_RETRY_ATTEMPTS
          || classifyVisionCaptureError(error) !== 'transient' || Date.now() + OBSERVE_RETRY_DELAY_MS > deadline) throw error;
        this._visionTraceNote(tabId, 'vision_capture_retry', { attempt, code: 'transient' });
        await sleep(OBSERVE_RETRY_DELAY_MS);
        this._throwIfAborted?.(this._runAbortSignal?.(tabId));
      }
    }
  };

  /** Waits up to REDACTION_SCAN_WAIT_MS for the page's redaction scan to answer. */
  proto._visionAwaitRedactionScan = async function _visionAwaitRedactionScan(tabId) {
    const deadline = Date.now() + REDACTION_SCAN_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(REDACTION_SCAN_POLL_MS);
      this._throwIfAborted?.(this._runAbortSignal?.(tabId));
      let snapshot = null;
      try { snapshot = await this._captureScreenshotRedactionSnapshot?.(tabId, { coordinateSpace: 'page' }); }
      catch { snapshot = null; }
      if (snapshot) return true;
    }
    return false;
  };

  /**
   * Images sent to the model although screenshot redaction is on and could
   * not run on them (UNREDACTED_OUTCOMES): each gets a coded trace note, and
   * the side panel warns once per page and run. `entries` are
   * { kind, redaction } for the images of one update.
   */
  proto._visionReportUnredacted = function _visionReportUnredacted(tabId, onUpdate, entries, url = '') {
    const unredacted = entries.filter(entry => UNREDACTED_OUTCOMES.has(entry?.redaction));
    if (!unredacted.length) return;
    for (const entry of unredacted) this._visionTraceNote(tabId, 'vision_redaction_skipped', { code: entry.redaction, context: entry.kind });
    const snapshot = this._visionRunSnapshots?.get(tabId);
    const page = pageKey(url);
    if (snapshot) {
      snapshot.redactionWarned ??= new Set();
      if (snapshot.redactionWarned.has(page)) return;
      snapshot.redactionWarned.add(page);
    }
    try {
      onUpdate?.('warning', { message: 'Screenshot redaction could not run on this page, so a screenshot was sent to the model unredacted. Redaction is best-effort; see Settings.' });
    } catch { /* UI updates are best effort */ }
  };

  /**
   * Capture until two consecutive frames match (bounded). Micro changes (a
   * caret, a clock, a spinner) count as a match: they never stop, and waiting
   * for them only cost the full settle time on every step. WebBrain's own
   * page UI (border, cursor, Stop button) stays hidden from the first
   * capture to the last (`hold`, agent _withIndicatorsHidden) and is shown
   * again once at the end, also when a capture fails or is given up on, so
   * it does not blink on every step.
   */
  proto._visionCaptureSettled = async function _visionCaptureSettled(tabId, state) {
    await sleep(SETTLE_INITIAL_DELAY_MS);
    this._throwIfAborted?.(this._runAbortSignal?.(tabId));
    const hold = { ended: false };
    try {
      let frame = await this._visionCaptureFrame(tabId, state, { hold });
      for (let attempt = 0; attempt < SETTLE_MAX_EXTRA_CAPTURES; attempt++) {
        await sleep(SETTLE_POLL_MS);
        let next;
        try { next = await this._visionCaptureFrame(tabId, state, { hold }); } catch { break; }
        const sameShape = next.size.width === frame.size.width && next.size.height === frame.size.height;
        const moving = !sameShape || !isMicroScreenChange(diffFrames(frame.raster.pixels, next.raster.pixels, next.size.width, next.size.height));
        frame = next;
        if (!moving) break;
      }
      return frame;
    } finally {
      // Sent after every hide of the update, even one still unanswered:
      // the page handles them in order.
      hold.ended = true;
      this._showIndicatorsAfterToolUse?.(tabId);
    }
  };

  /**
   * Page feedback before a decision (page-feedback.js): is the screen still
   * what the model last saw, give or take a micro change? One capture, no
   * settling; anything else (another page, another size, a requested frame,
   * a capture failure) answers false and gets a full observation.
   */
  proto._visionScreenUnchanged = async function _visionScreenUnchanged(tabId) {
    const state = this._visionRunState(tabId);
    const session = this._visionSessions?.get(tabId);
    if (!state.active || !session?.keyframe || !session.seenPixels || session.forceKeyframe || session.pendingZooms?.length) return false;
    let frame;
    try { frame = await this._visionCaptureFrame(tabId, state); }
    catch (error) {
      if (isControlFlowError(error)) throw error;
      return false;
    }
    if (frame.size.width !== session.keyframe.width || frame.size.height !== session.keyframe.height
        || session.needsKeyframe({ cssWidth: frame.probe.cssWidth, cssHeight: frame.probe.cssHeight,
          devicePixelRatio: frame.probe.devicePixelRatio, url: frame.probe.url })) return false;
    return isMicroScreenChange(diffFrames(session.seenPixels, frame.raster.pixels, frame.size.width, frame.size.height));
  };

  // `detail: 'high'` regardless of the Image detail setting: OpenAI's low
  // detail would shrink the frame to 512 px on the server, and every point
  // the model returned would be off by that factor. Size is governed by the
  // vision screenshot size setting instead; other providers ignore detail.
  proto._visionImageMessage = function _visionImageMessage(textNote, images, tag) {
    return visionUserMessage([
      { type: 'text', text: textNote },
      ...images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'high' } })),
    ], tag);
  };

  proto._visionEmitUpdate = function _visionEmitUpdate(tabId, onUpdate, result, images = []) {
    try {
      onUpdate?.('tool_call', { name: 'auto_screenshot', args: {} });
      onUpdate?.('tool_result', { name: 'auto_screenshot', result });
    } catch { /* UI updates are best effort */ }
    const runId = this.currentRunId?.get?.(tabId);
    if (runId && trace?.recordScreenshot) {
      for (const image of images) {
        try { trace.recordScreenshot(runId, null, image.dataUrl, `vision ${image.id} (${image.kind})`); } catch {}
      }
    }
  };

  proto._visionRecordObservation = async function _visionRecordObservation(tabId, url) {
    // While a submission waits for proof, the status texts on screen (a toast,
    // an alert, a live region) are recorded with the update, as reading the
    // tree records them: one gone before done was still seen.
    let statusMessages = null;
    if (this._completionSubmitStates?.get?.(tabId)) {
      try { statusMessages = await this._completionLiveStatusMessages?.(tabId); }
      catch (error) { if (isControlFlowError(error)) throw error; }
    }
    try {
      this._recordCompletionToolResult?.(tabId, 'auto_screenshot', {}, {
        success: true, method: 'image_attach', _attachImage: true, pageUrl: url || '',
        ...(Array.isArray(statusMessages) && statusMessages.length ? { statusMessages: statusMessages.slice(0, 6) } : {}),
      });
    } catch { /* completion bookkeeping is best effort */ }
  };

  /** Push a full frame (keyframe) for the current screen. */
  proto._visionPushKeyframe = async function _visionPushKeyframe(tabId, messages, onUpdate, { state, frame = null, reason = '', unchanged = false, lookedOnly = false } = {}) {
    const session = this._visionSessionFor(tabId, state);
    const captured = frame || await this._visionCaptureFrame(tabId, state);
    const encoding = await this._visionEncoding(captured.profile);
    const encoded = await this._visionEncodeRegion(captured.raster.canvas, null, { mimeType: encoding.mimeType, quality: encoding.quality });
    const keyframe = session.registerKeyframe({
      imageWidth: captured.size.width,
      imageHeight: captured.size.height,
      cssWidth: captured.probe.cssWidth,
      cssHeight: captured.probe.cssHeight,
      devicePixelRatio: captured.probe.devicePixelRatio,
      scrollX: captured.probe.scrollX,
      scrollY: captured.probe.scrollY,
      url: captured.probe.url,
    }, captured.raster.pixels, { unchanged, lookedOnly });
    // Zooms taken earlier in this batch belong to the previous frame, whose
    // ids this keyframe retires; the fresh frame supersedes them.
    const droppedZooms = this._visionTakePendingZooms(tabId);
    const note = visionKeyframeNote(keyframe, { coordinates: session.coordinates, reason })
      + (droppedZooms.length ? ` (${droppedZooms.map(zoom => zoom.id).join(', ')} not shown: the screen was re-captured; zoom again if needed.)` : '');
    messages.push(this._visionImageMessage(note, [{ dataUrl: encoded.dataUrl }],
      { epoch: keyframe.epoch, kind: 'key', ids: [keyframe.id] }));
    const tokens = estimateVisionTokens(keyframe.width, keyframe.height, captured.profile);
    this._visionEmitUpdate(tabId, onUpdate, {
      success: true,
      method: 'image_attach',
      description: `Vision frame ${keyframe.id} attached (${keyframe.width}x${keyframe.height}, ${encoded.mimeType}).`,
      vision: { kind: 'keyframe', imageId: keyframe.id, reason, bytes: encoded.bytes, estimatedTokens: tokens, mimeType: encoded.mimeType },
      imageDimensions: { width: keyframe.width, height: keyframe.height },
      cssViewportDimensions: { width: keyframe.cssWidth, height: keyframe.cssHeight },
      devicePixelRatio: keyframe.devicePixelRatio,
    }, [{ id: keyframe.id, kind: 'keyframe', dataUrl: encoded.dataUrl }]);
    this._visionTraceNote(tabId, 'vision_frame', {
      kind: 'keyframe', id: keyframe.id, reason, width: keyframe.width, height: keyframe.height,
      cssWidth: keyframe.cssWidth, cssHeight: keyframe.cssHeight, devicePixelRatio: keyframe.devicePixelRatio,
      captureWidth: captured.raster.sourceWidth, captureHeight: captured.raster.sourceHeight,
      bytes: encoded.bytes, mimeType: encoded.mimeType, estimatedTokens: tokens, profile: captured.profile.id,
    });
    this._visionReportUnredacted(tabId, onUpdate, [{ kind: 'keyframe', redaction: captured.redaction }], keyframe.url);
    await this._visionRecordObservation(tabId, keyframe.url);
    return keyframe;
  };

  /**
   * Start of a vision turn: the model gets a fresh full frame before its
   * first decision. Failures leave the run usable (take_screenshot retries).
   */
  proto._visionEnsureKeyframe = async function _visionEnsureKeyframe(tabId, messages, onUpdate, { mode = 'act', reason = 'start of turn' } = {}) {
    const state = this._visionRunState(tabId, mode);
    if (!state.active) return null;
    try {
      const frame = await this._visionCaptureRetrying(tabId, () => this._visionCaptureFrame(tabId, state));
      const keyframe = await this._visionPushKeyframe(tabId, messages, onUpdate, { state, frame, reason });
      // The opening frame is the run's first look at the page, as a read is on
      // the tree path: a question answered from it has task evidence.
      try { this._markPlanExecutionToolCall?.(tabId, 'take_screenshot', { success: true, method: 'image_attach' }); } catch {}
      return keyframe;
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      // The run starts with no screen (_beginVisionRun retired the last one);
      // the tag retires the last frame in the history for the model too.
      const message = `[SCREEN: the first screenshot could not be captured (${errorText(error).slice(0, 160)}). Earlier screenshots show an older screen and cannot be used for coordinates. ${captureFailureAdvice(error, 'Call take_screenshot to try again.')}]`;
      messages.push(visionUserMessage(message, { epoch: 0, kind: 'retire' }));
      this._visionTraceNote(tabId, 'vision_frame_error', { stage: 'start', error: String(error?.message || error).slice(0, 200) });
      return null;
    }
  };

  proto._visionTakePendingZooms = function _visionTakePendingZooms(tabId) {
    const session = this._visionSessions?.get(tabId);
    if (!session?.pendingZooms?.length) return [];
    const zooms = session.pendingZooms;
    session.pendingZooms = [];
    return zooms;
  };

  /**
   * After a tool batch: show the model what changed. `toolCalls` are the
   * calls the batch ran (translated or not).
   */
  proto._visionObserveAfterBatch = async function _visionObserveAfterBatch(tabId, messages, onUpdate, { toolCalls = [], force = false } = {}) {
    const state = this._visionRunState(tabId);
    if (!state.active) return null;
    // A batch planned on the tree path gets no screen update even when it
    // ends with vision back on (a page that needed the inventory left): the
    // next step starts on a fresh frame instead (_visionResumeKeyframe).
    if (!force && this._visionRunSnapshots?.get(tabId)?.treeStep === true) return null;
    // Once per batch: the batch's own end and the wrapper that catches the
    // batches leaving early (agent _executeToolBatch) both ask.
    if (toolCalls.length) {
      this._visionObservedBatches ??= new WeakSet();
      if (this._visionObservedBatches.has(toolCalls)) return null;
      this._visionObservedBatches.add(toolCalls);
    }
    const result = await this._visionObserveAfterBatchOnce(tabId, messages, onUpdate, { state, toolCalls, force });
    // A screen that changed after looking, scrolling or waiting is new
    // evidence: the delivery checkpoint counts only observations of a screen
    // that stayed the same (agent DELIVERY_OBSERVATION_TOOLS).
    if ((result?.kind === 'patch' || result?.kind === 'keyframe') && result.unchanged !== true) {
      this.deliveryObservationStreaks?.delete?.(tabId);
    }
    return result;
  };

  proto._visionObserveAfterBatchOnce = async function _visionObserveAfterBatchOnce(tabId, messages, onUpdate, { state, toolCalls = [], force = false } = {}) {
    const session = this._visionSessionFor(tabId, state);
    const names = toolCalls.map(call => call?._vision?.tool || call?.function?.name).filter(Boolean);
    // An accepted done ends the run before this point, so a batch with done
    // only gets here when done was refused: the model is told to look again,
    // and gets a screen to look at.
    const observe = force || session.forceKeyframe
      || names.some(name => !VISION_NO_OBSERVE_TOOLS.has(name) || name === 'done' || name === 'done_json');
    const zoomsOnly = !observe && session.pendingZooms?.length;
    if (zoomsOnly) {
      const zooms = this._visionTakePendingZooms(tabId);
      messages.push(this._visionImageMessage(zooms.map(zoom => zoom.note).join('\n'), zooms,
        { epoch: session.epoch, kind: 'zoom', ids: zooms.map(zoom => zoom.id) }));
      this._visionEmitUpdate(tabId, onUpdate, { success: true, method: 'image_attach', vision: { kind: 'zoom', imageIds: zooms.map(zoom => zoom.id) } },
        zooms.map(zoom => ({ id: zoom.id, kind: 'zoom', dataUrl: zoom.dataUrl })));
      this._visionReportUnredacted(tabId, onUpdate, zooms.map(zoom => ({ kind: 'zoom', redaction: zoom.redaction })), session.keyframe?.url || '');
      return { kind: 'zoom' };
    }
    if (!observe) return null;
    const failed = (stage, error) => {
      // The next update is a full frame; until then the model knows the
      // screen it last saw may be out of date, and its points and typing are
      // checked against the live screen (_visionTranslateToolCalls).
      session.forceKeyframe = true;
      session.observationFailed = true;
      messages.push(visionUserMessage(`[SCREEN: the screen could not be ${stage === 'observe' ? 'captured' : 'prepared'} after the action (${errorText(error).slice(0, 160)}). ${captureFailureAdvice(error)}]`,
        { epoch: session.epoch, kind: 'error' }));
      this._visionTraceNote(tabId, 'vision_frame_error', { stage, error: errorText(error) });
      return { kind: 'error' };
    };
    // A tab a click opened late is rerouted into this tab first, so the
    // update shows what the click opened (Chrome only); one that opens while
    // the screen settles is rerouted and the screen read again.
    const rerouteLateTab = async () => {
      try { return await this._visionPlatformLateTab?.(tabId); }
      catch (error) { if (isControlFlowError(error)) throw error; return null; }
    };
    await rerouteLateTab();
    let frame;
    try {
      frame = await this._visionCaptureRetrying(tabId, () => this._visionCaptureSettled(tabId, state));
      if ((await rerouteLateTab())?.redirected) frame = await this._visionCaptureRetrying(tabId, () => this._visionCaptureSettled(tabId, state));
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      return failed('observe', error);
    }
    // A batch that did not act on the page (it looked, waited or read): what
    // changed meanwhile, the page changed on its own (VisionSession
    // clickScreenVersion).
    const lookedOnly = names.length > 0 && names.every(name => VISION_LOOK_ONLY_TOOLS.has(name) || VISION_NO_OBSERVE_TOOLS.has(name));
    try {
      return await this._visionObserveFrame(tabId, messages, onUpdate, { state, session, frame, lookedOnly });
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      return failed('encode', error);
    }
  };

  /** The part of _visionObserveAfterBatch after a settled capture. */
  proto._visionObserveFrame = async function _visionObserveFrame(tabId, messages, onUpdate, { state, session, frame, lookedOnly = false }) {
    const meta = {
      cssWidth: frame.probe.cssWidth, cssHeight: frame.probe.cssHeight,
      devicePixelRatio: frame.probe.devicePixelRatio, url: frame.probe.url,
    };
    const sameSize = session.keyframe && session.keyframe.width === frame.size.width && session.keyframe.height === frame.size.height;
    if (session.needsKeyframe(meta) || !sameSize) {
      const urlChanged = session.keyframe && session.keyframe.url !== frame.probe.url;
      // A frame asked for on the same page and layout (take_screenshot) shows
      // the model nothing new unless its pixels differ from what it saw.
      const same = sameSize && !session.layoutChanged(meta)
        ? diffFrames(session.seenPixels, frame.raster.pixels, frame.size.width, frame.size.height) : null;
      const unchanged = same?.comparable === true && same.regions.length === 0;
      await this._visionPushKeyframe(tabId, messages, onUpdate, {
        state, frame, unchanged, lookedOnly, reason: session.forceKeyframe ? 'requested' : (urlChanged ? 'page changed' : (session.keyframe ? 'layout changed' : 'first frame')),
      });
      return { kind: 'keyframe', ...(unchanged ? { unchanged: true } : {}) };
    }
    const d = diffFrames(session.seenPixels, frame.raster.pixels, frame.size.width, frame.size.height);
    const plan = planFrameUpdate(d, {
      width: frame.size.width,
      height: frame.size.height,
      patchChainLength: session.patchChainLength,
      estimateTokens: (w, h) => estimateVisionTokens(w, h, frame.profile),
      align: frame.profile.align,
    });
    if (plan.kind === 'keyframe') {
      await this._visionPushKeyframe(tabId, messages, onUpdate, { state, frame, lookedOnly, reason: plan.reason === 'large_change' ? 'large change' : plan.reason.replace(/_/g, ' ') });
      return { kind: 'keyframe', reason: plan.reason };
    }
    const zooms = this._visionTakePendingZooms(tabId);
    if (plan.kind === 'none') {
      session.registerNoChange();
      session.noteObservedScroll(frame.probe.scrollX, frame.probe.scrollY);
      this._visionRefreshZooms(session, zooms, frame);
      const note = visionNoChangeNote(session.keyframe);
      if (zooms.length) {
        messages.push(this._visionImageMessage([note, ...zooms.map(zoom => zoom.note)].join('\n'), zooms,
          { epoch: session.epoch, kind: 'zoom', ids: zooms.map(zoom => zoom.id) }));
        this._visionReportUnredacted(tabId, onUpdate, zooms.map(zoom => ({ kind: 'zoom', redaction: zoom.redaction })), frame.probe.url);
      } else {
        messages.push(visionUserMessage(note, { epoch: session.epoch, kind: 'none' }));
      }
      this._visionEmitUpdate(tabId, onUpdate, { success: true, method: 'vision_no_change', description: 'No visible change in the viewport.', vision: { kind: 'none', changedRatio: d.changedRatio } });
      this._visionTraceNote(tabId, 'vision_frame', { kind: 'none', keyframe: session.keyframe.id, changedRatio: d.changedRatio });
      await this._visionRecordObservation(tabId, frame.probe.url);
      return { kind: 'none' };
    }
    const encoding = await this._visionEncoding(frame.profile);
    const encodedPatches = [];
    for (const region of plan.regions) {
      const encoded = await this._visionEncodeRegion(frame.raster.canvas, region, { mimeType: encoding.mimeType, quality: encoding.quality });
      encodedPatches.push({ region, encoded });
    }
    const patches = session.registerPatches(plan.regions.map(regionLabel), frame.raster.pixels, { lookedOnly });
    session.noteObservedScroll(frame.probe.scrollX, frame.probe.scrollY);
    this._visionRefreshZooms(session, zooms, frame);
    const note = visionPatchNote(patches, session.keyframe, { coordinates: session.coordinates });
    const images = patches.map((patch, index) => ({ id: patch.id, kind: 'patch', dataUrl: encodedPatches[index].encoded.dataUrl }));
    messages.push(this._visionImageMessage([note, ...zooms.map(zoom => zoom.note)].join('\n'), [...images, ...zooms],
      { epoch: session.epoch, kind: 'patch', ids: [...patches.map(patch => patch.id), ...zooms.map(zoom => zoom.id)] }));
    this._visionReportUnredacted(tabId, onUpdate, [{ kind: 'patch', redaction: frame.redaction },
      ...zooms.map(zoom => ({ kind: 'zoom', redaction: zoom.redaction }))], frame.probe.url);
    const bytes = encodedPatches.reduce((sum, item) => sum + item.encoded.bytes, 0);
    this._visionEmitUpdate(tabId, onUpdate, {
      success: true,
      method: 'image_attach',
      description: `Vision patch ${patches.map(patch => patch.id).join(', ')} attached (${Math.round(d.regionAreaRatio * 100)}% of the screen).`,
      vision: { kind: 'patch', imageIds: patches.map(patch => patch.id), keyframe: session.keyframe.id, regions: plan.regions.map(regionLabel), bytes, estimatedTokens: plan.patchTokens, frameTokens: plan.frameTokens },
    }, images);
    this._visionTraceNote(tabId, 'vision_frame', {
      kind: 'patch', ids: patches.map(patch => patch.id), keyframe: session.keyframe.id, regions: plan.regions.map(regionLabel),
      bytes, estimatedTokens: plan.patchTokens, frameTokens: plan.frameTokens, changedRatio: d.changedRatio,
    });
    await this._visionRecordObservation(tabId, frame.probe.url);
    return { kind: 'patch', patches };
  };

  /**
   * Zooms of this batch sent with this update: one taken after the batch's
   * earlier actions (with a frame-scale capture beside it) already shows
   * what this update reports, so it is made as current as the update and
   * stays stale only where the screen changed after the zoom.
   */
  proto._visionRefreshZooms = function _visionRefreshZooms(session, zooms, frame) {
    for (const zoom of zooms || []) {
      const base = zoom?.base;
      if (!base || base.width !== frame.size.width || base.height !== frame.size.height || base.url !== frame.probe.url) continue;
      session.markZoomCurrent(zoom.id, diffFrames(base.pixels, frame.raster.pixels, frame.size.width, frame.size.height).regions);
    }
  };

  /**
   * Rewrite click_at into the canonical coordinate click and mark which
   * coordinate calls follow an earlier action in the same batch (those are
   * re-checked against the live screen right before dispatch).
   */
  proto._visionTranslateToolCalls = function _visionTranslateToolCalls(tabId, toolCalls, { staleLayout = null } = {}) {
    const state = this._visionRunState(tabId);
    if (!state.active || !Array.isArray(toolCalls)) return toolCalls;
    const coordinates = toolCalls.some(call => VISION_TOOL_NAMES.has(call?.function?.name));
    if (!coordinates && !toolCalls.some(call => VISION_TYPING_TOOLS.has(call?.function?.name))) return toolCalls;
    const session = this._visionSessionFor(tabId, state);
    // No screen of this page yet, or the last update failed: the model does
    // not know what the screen shows now. Its points are re-checked against
    // the live screen, and typing waits for a fresh look or a checked click.
    const unverified = !session.keyframe || session.observationFailed === true;
    if (!coordinates && !unverified) return toolCalls;
    let actedBefore = false;
    // Where the last click_at of this batch landed: type_text / press_keys
    // after it type into the field that click focused.
    let clickedAt = null;
    return toolCalls.map(call => {
      const name = call?.function?.name || '';
      let translated = call;
      // A point is re-checked against the live screen when an earlier action
      // of the batch ran, or when the page changed while the model decided
      // (page feedback notes a response it kept despite that).
      const recheck = actedBefore || session.observationFailed === true || session.screenMoved === true
        || (!!call && typeof call === 'object' && this._visionRecheckCalls?.has(call) === true);
      if (VISION_TRANSLATED_TOOLS.has(name) || VISION_NATIVE_TOOLS.has(name)) {
        let args = {};
        try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call.function.arguments || {}); }
        catch { args = null; }
        if (args && staleLayout && visionCallReadsPoints(name, args)) {
          // Read from a frame the window was resized or zoomed since
          // (_visionStaleLayoutRefusal): refused, and the rest of the batch
          // with it, before any gate runs.
          translated = { ...call, _vision: { tool: name, error: staleLayout } };
        } else if (args && VISION_TRANSLATED_TOOLS.has(name)) {
          const result = translateVisionClick(args, session);
          translated = result.ok
            ? { ...call, function: { ...call.function, name: result.name, arguments: JSON.stringify(result.args) },
              _vision: { ...result.vision, internalName: result.name, needsStabilityCheck: recheck } }
            : { ...call, _vision: { tool: name, error: result.result } };
          clickedAt = result.ok && result.vision.button === 'left' ? { ...result.vision.cssPoint } : null;
        } else if (args) {
          // hover_at and drag_at bind the page monitor to the element at
          // their point (a drag's start; its end is held by the pixel check),
          // as a translated click does, so unrelated churn before dispatch
          // does not void them (page-feedback.js, rebaseVisionPreparation).
          const at = name === 'hover_at' ? { x: args.x, y: args.y, image: args.image }
            : name === 'drag_at' ? { x: args.start_x, y: args.start_y, image: args.image } : null;
          const point = at ? session.resolvePoint(at) : null;
          // A wheel binds no element, but its point (where scroll_at will
          // send it) finds the embedded frame it goes to, which is prepared
          // with the top document (page-feedback.js prepareReceiverFrame).
          const wheel = name !== 'scroll_at' ? null : args.x != null && args.y != null
            ? session.resolvePoint({ x: args.x, y: args.y, image: args.image })
            : session.keyframe ? { ok: true, cssX: session.keyframe.cssWidth / 2, cssY: session.keyframe.cssHeight / 2 } : null;
          translated = { ...call, _vision: { tool: name, needsStabilityCheck: recheck,
            ...(point?.ok ? { monitorPoint: { x: point.cssX, y: point.cssY } } : {}),
            ...(wheel?.ok ? { wheelPoint: { x: wheel.cssX, y: wheel.cssY } } : {}) } };
        }
      } else if (VISION_TYPING_TOOLS.has(name) && clickedAt) {
        translated = { ...call, _vision: { tool: name, focusFollowUp: { ...clickedAt } } };
      } else if (VISION_TYPING_TOOLS.has(name) && unverified) {
        translated = { ...call, _vision: { tool: name, error: visionScreenUnverifiedResult(name, { noFrame: !session.keyframe }) } };
      }
      if (!VISION_NO_OBSERVE_TOOLS.has(name) && name !== 'take_screenshot') {
        actedBefore = true;
        if (!['click_at', 'type_text', 'press_keys'].includes(name)) clickedAt = null;
      }
      return translated;
    });
  };

  /**
   * Before a batch that uses screenshot points: has the window been resized
   * or zoomed (CSS viewport size or device pixel ratio) since the frame they
   * were read from? Page feedback sets a decision aside for a resize it
   * reported while the model decided; this catches one it had not reported
   * yet, which would otherwise send the points through the old geometry.
   * Returns the refusal for those points (a full frame follows), or null.
   */
  proto._visionStaleLayoutRefusal = async function _visionStaleLayoutRefusal(tabId, toolCalls) {
    const state = this._visionRunState(tabId);
    const session = state.active ? this._visionSessions?.get(tabId) : null;
    const keyframe = session?.keyframe;
    if (!keyframe || !Array.isArray(toolCalls)) return null;
    const reads = toolCalls.some(call => {
      const name = call?.function?.name || '';
      if (!VISION_TOOL_NAMES.has(name)) return false;
      try { return visionCallReadsPoints(name, typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call.function.arguments || {})); }
      catch { return false; }
    });
    if (!reads) return null;
    let probe = null;
    try { probe = await this._visionBounded(tabId, 'viewport measurement', () => this._visionPlatformProbe(tabId)); }
    catch (error) {
      // Stop: this runs before the batch can answer its calls on a throw;
      // the batch's per-call abort check answers every one of them instead.
      if (isControlFlowError(error) && error?.name !== 'AbortError') throw error;
      return null;
    }
    if (!probe) return null;
    // Another page than the one the frame shows (a navigation page feedback
    // has not reported yet): its points no longer apply.
    if (probe.url && keyframe.url && String(probe.url) !== keyframe.url) {
      session.forceKeyframe = true;
      this._visionTraceNote(tabId, 'vision_layout_changed', { frame: keyframe.id, reason: 'page_changed' });
      return {
        success: false, dispatched: false, noDispatch: true, visionCoordinateError: 'page_changed',
        error: `Not dispatched: the tab shows another page than ${keyframe.id} did, so points read from it no longer apply. A fresh full frame follows; read the point again there.`,
      };
    }
    // Scrolled since the model looked (a scroll anchoring on a feed, an
    // auto-scroll): not refused, but every point is checked against the live
    // screen before it goes out (_visionTranslateToolCalls, _visionStabilityBlock).
    const seen = session.observedScroll;
    if (seen && (Math.abs((Number(probe.scrollX) || 0) - seen.x) > 1 || Math.abs((Number(probe.scrollY) || 0) - seen.y) > 1)) {
      session.screenMoved = true;
      this._visionTraceNote(tabId, 'vision_layout_changed', { frame: keyframe.id, reason: 'scrolled' });
    }
    if (!session.layoutChanged({ cssWidth: probe.cssWidth, cssHeight: probe.cssHeight, devicePixelRatio: probe.devicePixelRatio })) return null;
    session.forceKeyframe = true;
    const size = (width, height) => `${Math.round(Number(width) || 0)}x${Math.round(Number(height) || 0)}`;
    this._visionTraceNote(tabId, 'vision_layout_changed', {
      frame: keyframe.id, was: size(keyframe.cssWidth, keyframe.cssHeight), now: size(probe.cssWidth, probe.cssHeight),
      dpr: [keyframe.devicePixelRatio, probe.devicePixelRatio],
    });
    return {
      success: false, dispatched: false, noDispatch: true, visionCoordinateError: 'viewport_changed',
      error: `Not dispatched: the browser window was resized or zoomed after ${keyframe.id} was taken (viewport ${size(keyframe.cssWidth, keyframe.cssHeight)} CSS px then, ${size(probe.cssWidth, probe.cssHeight)} now), so points read from it no longer land where you saw them. A fresh full frame follows; read the point again there.`,
    };
  };

  /**
   * Keyboard input right after a vision click: does the focused element sit
   * at the clicked point and take text? Then the click's own page effects
   * (a composer expanding, a hint appearing) do not call for a fresh
   * observation before typing (page-feedback.js).
   */
  proto._visionFocusFollowsClick = async function _visionFocusFollowsClick(tabId, point) {
    if (!point || !this._visionRunState(tabId).active) return false;
    const probe = await this._visionDomProbe(tabId, { points: [point], focus: true });
    return probe?.focus?.editable === true && probe.focus.matchesPoint === true;
  };

  /** A screen update now (page feedback superseded a decision). */
  proto._visionObserveNow = async function _visionObserveNow(tabId, messages, onUpdate) {
    if (!this._visionRunState(tabId).active) return null;
    return this._visionObserveAfterBatch(tabId, messages, onUpdate, { force: true });
  };

  /**
   * Before a coordinate action that follows another action in the same
   * batch: refuse it when the screen changed near its point. `cssPoint` may
   * be a list (a drag's start and end), checked against one fresh capture;
   * a point's `label` names it in the refusal.
   */
  proto._visionStabilityBlock = async function _visionStabilityBlock(tabId, cssPoint) {
    const state = this._visionRunState(tabId);
    const session = this._visionSessions?.get(tabId);
    if (!state.active || !session?.keyframe || !session.seenPixels) return null;
    const points = (Array.isArray(cssPoint) ? cssPoint : [cssPoint]).filter(Boolean);
    const which = points.length > 1 ? 'these points' : 'this point';
    const refuse = reason => ({
      success: false, dispatched: false, noDispatch: true, visionScreenChanged: true,
      error: `Not dispatched: ${reason}. Look at the updated screen WebBrain shows next and choose the ${points.length > 1 ? 'points' : 'point'} again.`,
    });
    let frame;
    try { frame = await this._visionCaptureFrame(tabId, state); }
    catch (error) {
      if (isControlFlowError(error)) throw error;
      // The point was chosen before the earlier action; without a fresh
      // capture nothing shows it is still right.
      session.forceKeyframe = true;
      session.observationFailed = true;
      return refuse(`WebBrain could not re-check the screen around ${which}`);
    }
    if (frame.probe.url !== session.keyframe.url) return refuse(`the page navigated since you read ${which}`);
    if (frame.size.width !== session.keyframe.width || frame.size.height !== session.keyframe.height) return refuse(`the viewport changed since you read ${which}`);
    const d = diffFrames(session.seenPixels, frame.raster.pixels, frame.size.width, frame.size.height);
    if (d.regionAreaRatio > 0.6) return refuse(`most of the screen changed since you read ${which}`);
    for (const point of points) {
      const kfPoint = session.cssToKeyframe(point.x, point.y);
      if (pointTouchesRegions(kfPoint, d.regions, STABILITY_MARGIN_PX)) {
        return refuse(`the screen changed near ${point.label || 'this point'} since you read it`);
      }
    }
    return null;
  };

  /**
   * Resolve model points to CSS for a native tool, with batch stability:
   * every point (a drag's end as much as its start) is re-checked against
   * the live screen when an earlier action of the batch ran.
   */
  proto._visionResolvePointsForTool = async function _visionResolvePointsForTool(tabId, points, vision) {
    const state = this._visionRunState(tabId);
    if (!state.active) return { error: { success: false, noDispatch: true, error: 'Vision mode is not active for this run.' } };
    const session = this._visionSessionFor(tabId, state);
    const resolved = [];
    for (const point of points) {
      const result = session.resolvePoint(point);
      if (!result.ok) return { error: { success: false, dispatched: false, noDispatch: true, visionCoordinateError: result.code, error: result.error } };
      resolved.push(result);
    }
    if (vision?.needsStabilityCheck) {
      const blocked = await this._visionStabilityBlock(tabId, resolved.map((result, index) => ({
        x: result.cssX, y: result.cssY, ...(points[index].label ? { label: points[index].label } : {}),
      })));
      if (blocked) return { error: blocked };
    }
    return { resolved, session, state };
  };

  /** Resolve one model point to CSS for a native tool, with batch stability. */
  proto._visionResolveForTool = async function _visionResolveForTool(tabId, point, vision) {
    const result = await this._visionResolvePointsForTool(tabId, [point], vision);
    return result.error ? result : { resolved: result.resolved[0], session: result.session, state: result.state };
  };

  /**
   * Execute take_screenshot, zoom, scroll_at, hover_at, drag_at and wait. A
   * failure becomes a tool result (no dispatch, or an unknown outcome once
   * input may have been sent) instead of ending the run.
   */
  proto._executeVisionTool = async function _executeVisionTool(tabId, name, args = {}, context = {}) {
    const dispatch = { started: false };
    try {
      return await this._executeVisionToolInner(tabId, name, args, context, dispatch);
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      this._visionTraceNote(tabId, 'vision_tool_error', { tool: name, error: errorText(error), dispatched: dispatch.started });
      if (dispatch.started) {
        const session = this._visionSessions?.get(tabId);
        if (session) session.forceKeyframe = true;
        return { success: false, outcomeUnknown: true, error: `${name} failed while sending input (${errorText(error)}). Look at the next screen before repeating it.` };
      }
      return { success: false, dispatched: false, noDispatch: true, error: `${name} failed before any input was sent (${errorText(error)}).` };
    }
  };

  // Stop pressed while the checks before an input ran (probes, captures, a
  // drag's submit test): no input goes out.
  proto._visionThrowIfStopped = function _visionThrowIfStopped(tabId, context = null) {
    this._throwIfAborted?.(context?._contentActionAbortSignal);
    this._throwIfAborted?.(this._runAbortSignal?.(tabId));
  };

  proto._executeVisionToolInner = async function _executeVisionToolInner(tabId, name, args, context, dispatch) {
    const vision = context?._vision || null;
    const state = this._visionRunState(tabId);
    if (!state.active) {
      return { success: false, noDispatch: true, error: `${name} is only available in vision mode.` };
    }
    const session = this._visionSessionFor(tabId, state);
    if (name === 'take_screenshot') {
      session.forceKeyframe = true;
      return { success: true, note: 'A fresh full frame follows this result.' };
    }
    if (name === 'wait') {
      const seconds = Math.min(VISION_MAX_WAIT_SECONDS, Math.max(0.2, Number(args.seconds) || 1));
      await sleep(Math.round(seconds * 1000));
      return { success: true, waitedSeconds: seconds };
    }
    if (name === 'zoom') {
      if (!session.keyframe) return { success: false, noDispatch: true, error: 'Take a screenshot before zooming.' };
      const region = session.resolveRegion({ x: args.x, y: args.y, width: args.width, height: args.height, image: args.image });
      if (!region.ok) return { success: false, noDispatch: true, visionCoordinateError: region.code, error: region.error };
      // After an earlier action of the batch the zoom shows the screen that
      // action left, which the update after the batch reports as changed. A
      // frame-scale capture now lets that update keep the zoom current where
      // nothing changed after it (_visionRefreshZooms).
      let base = null;
      if (vision?.needsStabilityCheck) {
        try {
          const frame = await this._visionCaptureFrame(tabId, state);
          base = { pixels: frame.raster.pixels, width: frame.size.width, height: frame.size.height, url: frame.probe.url };
        } catch (error) {
          if (isControlFlowError(error)) throw error;
        }
      }
      const profile = VISION_PROFILES[state.profileId] || VISION_PROFILES.default;
      const probe = await this._visionBounded(tabId, 'viewport measurement', () => this._visionPlatformProbe(tabId));
      const plan = planZoomImageSize({ regionWidth: region.cssRegion.width, regionHeight: region.cssRegion.height, devicePixelRatio: probe?.devicePixelRatio || 1, profile });
      let dataUrl = await this._visionBounded(tabId, 'zoom screenshot', () => this._visionPlatformCapture(tabId, { probe, cssRegion: region.cssRegion, outWidth: plan.width, outHeight: plan.height }));
      if (!dataUrl) throw new Error('The browser returned no screenshot.');
      let redaction = null;
      if (this.screenshotRedaction && typeof this._redactScreenshotDataUrl === 'function') {
        const outcome = {};
        try {
          // A crop is a page-space box; the redactor maps element rects into it.
          dataUrl = await this._redactScreenshotDataUrl(tabId, dataUrl, {
            coordinateSpace: 'page',
            capturedCssBounds: {
              x: (probe?.scrollX || 0) + region.cssRegion.x,
              y: (probe?.scrollY || 0) + region.cssRegion.y,
              width: region.cssRegion.width,
              height: region.cssRegion.height,
            },
            outcome,
          });
        } catch (error) {
          if (isControlFlowError(error)) throw error;
          outcome.status = 'error';
        }
        // Reported when the zoom is sent (_visionReportUnredacted).
        redaction = outcome.status || 'error';
      }
      const raster = await this._visionRasterize(dataUrl, plan.width, plan.height);
      const encoding = await this._visionEncoding(profile);
      const encoded = await this._visionEncodeRegion(raster.canvas, null, { mimeType: encoding.mimeType, quality: Math.min(0.9, encoding.quality + 0.05) });
      const zoom = session.registerZoom(region.keyframeRegion, plan.width, plan.height);
      session.pendingZooms.push({
        id: zoom.id, kind: 'zoom', dataUrl: encoded.dataUrl,
        note: visionZoomNote(zoom, session.keyframe, region.keyframeRegion, { coordinates: session.coordinates }),
        ...(base ? { base } : {}),
        ...(redaction ? { redaction } : {}),
      });
      this._visionTraceNote(tabId, 'vision_frame', { kind: 'zoom', id: zoom.id, region: region.keyframeRegion, width: plan.width, height: plan.height, bytes: encoded.bytes });
      return { success: true, image: zoom.id, width: plan.width, height: plan.height, note: `Zoom ${zoom.id} follows this result.` };
    }
    if (name === 'scroll_at') {
      const direction = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : 'down';
      const steps = Math.min(30, Math.max(1, Number(args.amount) || VISION_DEFAULT_SCROLL_STEPS));
      let point = null;
      if (args.x != null && args.y != null) {
        const resolved = await this._visionResolveForTool(tabId, { x: args.x, y: args.y, image: args.image }, vision);
        if (resolved.error) return resolved.error;
        point = { x: resolved.resolved.cssX, y: resolved.resolved.cssY };
      } else if (session.keyframe) {
        point = { x: session.keyframe.cssWidth / 2, y: session.keyframe.cssHeight / 2 };
      } else {
        const probe = await this._visionBounded(tabId, 'viewport measurement', () => this._visionPlatformProbe(tabId));
        point = { x: (probe?.cssWidth || 800) / 2, y: (probe?.cssHeight || 600) / 2 };
      }
      // A focused number field under the pointer takes the wheel as +/-.
      const refused = visionWheelRefusal(await this._visionDomProbe(tabId, { points: [point] }));
      if (refused) return { ...refused, at: point };
      const distance = steps * VISION_SCROLL_STEP_CSS_PX;
      const deltaX = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
      const deltaY = direction === 'up' ? -distance : direction === 'down' ? distance : 0;
      this._visionThrowIfStopped(tabId, context);
      dispatch.started = true;
      const result = await this._visionPlatformWheel(tabId, { x: point.x, y: point.y, deltaX, deltaY });
      return { success: result?.success !== false, dispatched: result?.dispatched !== false, direction, amount: steps, at: point, ...(result || {}) };
    }
    if (name === 'hover_at') {
      const resolved = await this._visionResolveForTool(tabId, { x: args.x, y: args.y, image: args.image }, vision);
      if (resolved.error) return resolved.error;
      const point = { x: resolved.resolved.cssX, y: resolved.resolved.cssY };
      this._visionThrowIfStopped(tabId, context);
      dispatch.started = true;
      const result = await this._visionPlatformHover(tabId, point);
      return { success: result?.success !== false, at: point, ...(result || {}) };
    }
    if (name === 'drag_at') {
      // Both ends are where the model read them: an earlier action of the
      // batch that changed the drop target refuses the drag as surely as one
      // that changed its start.
      const ends = await this._visionResolvePointsForTool(tabId, [
        { x: args.start_x, y: args.start_y, image: args.image, label: "the drag's start point" },
        { x: args.end_x, y: args.end_y, image: args.image, label: "the drag's end point" },
      ], vision);
      if (ends.error) return ends.error;
      const [start, end] = ends.resolved;
      const from = { x: start.cssX, y: start.cssY };
      const to = { x: end.cssX, y: end.cssY };
      // A press and release on the same control is a click that no click
      // guard has seen; a frame WebBrain cannot inspect could hide one.
      const longEnough = Math.hypot(to.x - from.x, to.y - from.y) >= VISION_MIN_DRAG_CSS_PX;
      const probe = longEnough ? await this._visionDomProbe(tabId, { points: [from, to], pair: true }) : null;
      const refused = visionDragRefusal(probe, from, to);
      if (refused) return { ...refused, from, to };
      if (await this._visionSubmitAt(tabId, from)) {
        return {
          success: false, dispatched: false, noDispatch: true, visionInputRefused: 'drag_on_submit', from, to,
          error: 'Not dispatched: the drag starts on a control WebBrain reads as a submit, send, delete or payment action, and a drag never gets the confirmation a click gets. Use click_at on it.',
        };
      }
      this._visionThrowIfStopped(tabId, context);
      dispatch.started = true;
      const result = await this._visionPlatformDrag(tabId, { from, to, steps: 12 });
      return { success: result?.success !== false, from, to, ...(result || {}) };
    }
    return { success: false, noDispatch: true, error: `Unknown vision tool ${name}.` };
  };

  /** The vision half of _pruneOldImages. */
  proto._visionPruneImages = function _visionPruneImages(messages) {
    return pruneVisionImages(messages);
  };
}

/**
 * What the model is told after a click on an open dialog's background
 * (vision-dom-probe.js dialogBackground).
 */
export function visionDialogBackgroundNote(background) {
  const where = background === 'backdrop'
    ? "on the backdrop around an open dialog, outside the dialog's content"
    : 'on an empty area of an open dialog';
  return `This point was ${where}, not on a button, link or field. If you meant a control in the dialog, this click missed it: `
    + 'find that control in the dialog on the latest screen and click its own point (zoom on the dialog first if it is small). '
    + 'If you meant to close the dialog by clicking outside it, check the next screen.';
}
