// Duration belongs to a video deliverable, not to the whole conversation.
// Unfinished retries keep their target; named videos can be worked on in any
// order without one video's receipt satisfying another video's request.
const STATES = new Set(['pending', 'enough', 'short', 'unverified', 'unjoined', 'failed']);
const seconds = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 86400 ? value : null;
const videoId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value) ? value : null;
const TOLERANCE_SECONDS = 0.25;
const CLIP_TOLERANCE_SECONDS = 0.1;
// generate_image makes a video of at most this many clips.
const MAX_CLIPS = 24;
const MAX_DELIVERABLES = 24;
const clips = value => Number.isSafeInteger(value) && value > 1 ? Math.min(value, MAX_CLIPS) : null;

/**
 * How much shorter than requested a measured video may be and still be long
 * enough: a quarter second for container and frame rounding, and a tenth more
 * for every further clip of a video made of clips, since each clip ends on its
 * own frame. A video of 8 clips may be 0.95 s short; one of 24, 2.55 s.
 */
export function videoDurationTolerance(clipCount) {
  return TOLERANCE_SECONDS + CLIP_TOLERANCE_SECONDS * ((clips(clipCount) || 1) - 1);
}

function normalizeReceipt(value) {
  const requestedSeconds = seconds(value?.requestedSeconds);
  if (!requestedSeconds) return null;
  const approved = seconds(value?.approvedDurationSeconds);
  const measured = seconds(value?.durationSeconds);
  const contract = { requestedSeconds, status: STATES.has(value.status) ? value.status : 'pending' };
  if (Number.isSafeInteger(value.deliverableId) && value.deliverableId > 0) contract.deliverableId = value.deliverableId;
  if (videoId(value.videoId)) contract.videoId = value.videoId;
  if (approved && approved <= requestedSeconds) contract.approvedDurationSeconds = approved;
  if (measured) contract.durationSeconds = measured;
  // How many clips the measured video was made of, for its tolerance.
  if (measured && clips(value.clipCount)) contract.clipCount = clips(value.clipCount);
  if (contract.status === 'short' && !measured) contract.status = 'unverified';
  if (contract.status === 'enough' && (!measured || measured + videoDurationTolerance(contract.clipCount) < videoDurationRequiredSeconds(contract))) {
    contract.status = measured ? 'short' : 'unverified';
  }
  return contract;
}

export function normalizeVideoDurationContract(value) {
  const active = normalizeReceipt(value);
  if (!active) return null;
  const ids = new Set([active.deliverableId || 0]);
  const names = new Set(active.videoId ? [active.videoId] : []);
  const others = (Array.isArray(value.otherDeliverables) ? value.otherDeliverables : []).slice(0, MAX_DELIVERABLES - 1)
    .map(normalizeReceipt).filter(receipt => {
      if (!receipt || ids.has(receipt.deliverableId || 0) || (receipt.videoId && names.has(receipt.videoId))) return false;
      ids.add(receipt.deliverableId || 0);
      if (receipt.videoId) names.add(receipt.videoId);
      return true;
    });
  return others.length ? { ...active, otherDeliverables: others } : active;
}

export function videoDurationRequiredSeconds(contract) {
  return contract.approvedDurationSeconds || contract.requestedSeconds;
}

function receipts(contract) {
  if (!contract) return [];
  const { otherDeliverables, ...active } = contract;
  return [active, ...(otherDeliverables || [])];
}

function activate(all, active) {
  const others = all.filter(receipt => receipt !== active);
  return others.length ? { ...active, otherDeliverables: others } : { ...active };
}

export function pinVideoDurationTarget(args, previous) {
  const prior = normalizeVideoDurationContract(previous);
  const requestedId = videoId(args?.video_id);
  const video = args?.media === 'video' || (args?.media == null && (requestedId || (prior && prior.status !== 'enough')
    || ['duration', 'estimated_duration', 'scenes', 'aspect_ratio', 'resolution'].some(key => args?.[key] !== undefined)));
  const unchanged = { args, contract: prior, trackDuration: false };
  if (args?.video_id !== undefined && (!requestedId || args.media === 'image')) {
    return { ...unchanged, error: 'video_id is video-only and must be 1–80 letters, numbers, hyphens or underscores, starting with a letter or number.' };
  }
  if (!video) return unchanged;
  const all = receipts(prior);
  const declaredSeconds = seconds(args?.estimated_duration) || seconds(args?.duration);
  // An unlabeled first call can acquire its stable label on a retry. Once
  // labeled, different ids always name distinct deliverables.
  let active = requestedId ? all.find(receipt => receipt.videoId === requestedId)
    || (prior && !prior.videoId && prior.status !== 'enough'
      && (!declaredSeconds || declaredSeconds === prior.requestedSeconds || declaredSeconds === videoDurationRequiredSeconds(prior)) ? all[0] : null)
    : prior && prior.status !== 'enough' ? all[0] : null;
  if (!active) {
    const requestedSeconds = declaredSeconds;
    if (!requestedSeconds) return requestedId
      ? { ...unchanged, error: 'For a new video_id, give estimated_duration or duration. Reuse the same video_id when retrying that video.' }
      : unchanged;
    if (all.length >= MAX_DELIVERABLES) return { ...unchanged, error: 'This task already tracks 24 video deliverables. Finish or retry an existing video_id before requesting another task.' };
    active = { requestedSeconds, status: 'pending', deliverableId: Math.max(0, ...all.map(receipt => receipt.deliverableId || 0)) + 1 };
    all.push(active);
  }
  if (!active.deliverableId) active.deliverableId = Math.max(0, ...all.map(receipt => receipt.deliverableId || 0)) + 1;
  if (requestedId) active.videoId = requestedId;
  const contract = activate(all, active);
  return { args: { ...args, media: 'video', estimated_duration: videoDurationRequiredSeconds(active) }, contract, trackDuration: true };
}

function updateReceipt(previous, deliverableId, update) {
  const contract = normalizeVideoDurationContract(previous);
  if (!contract) return null;
  const all = receipts(contract);
  const index = deliverableId === undefined ? 0 : all.findIndex(receipt => receipt.deliverableId === deliverableId);
  if (index < 0) return contract; // A late result never recreates a discarded obligation.
  all[index] = update(all[index]);
  return activate(all, all[0]);
}

export function approveVideoDurationTarget(previous, approvedSeconds, deliverableId) {
  return updateReceipt(previous, deliverableId, receipt => normalizeReceipt({ ...receipt, approvedDurationSeconds: approvedSeconds }));
}

export function recordVideoDurationResult(previous, result, deliverableId) {
  return updateReceipt(previous, deliverableId, contract => {
    // An existing verified artifact for this same video still satisfies its
    // request. A new video always starts a separate pending receipt.
    if (contract.status === 'enough') return contract;
    const approved = seconds(result?.approvedDurationSeconds);
    if (approved && approved <= contract.requestedSeconds) contract.approvedDurationSeconds = approved;
    delete contract.durationSeconds;
    delete contract.clipCount;
    if (result?.success !== true || result.error) return { ...contract, status: 'failed' };
    if (result.joined === false) return { ...contract, status: 'unjoined' };
    const video = result.mediaType === 'video' || /^video\//.test(result.mimeType || '');
    const measured = video && (result.mediaId || result.url) ? seconds(result.durationSeconds) : null;
    if (!measured) return { ...contract, status: 'unverified' };
    const clipCount = clips(result.clipCount);
    return { ...contract, durationSeconds: measured, ...(clipCount ? { clipCount } : {}),
      status: measured + videoDurationTolerance(clipCount) >= videoDurationRequiredSeconds(contract) ? 'enough' : 'short' };
  });
}

export function videoDurationCompletionBlock(value, outcome = 'success') {
  if (outcome !== 'success') return null;
  const all = receipts(normalizeVideoDurationContract(value));
  // A merely unverified active video must not hide another video's known
  // shortfall when the completion policy chooses its outcome and caveat.
  const contract = all.find(receipt => !['enough', 'unverified'].includes(receipt.status))
    || all.find(receipt => receipt.status === 'unverified');
  if (!contract) return null;
  const requiredSeconds = videoDurationRequiredSeconds(contract);
  const detail = contract.status === 'short' ? `The delivered video measures ${contract.durationSeconds} seconds.`
    : contract.status === 'unjoined' ? 'The clips have not been joined into one video.'
    : contract.status === 'unverified' ? 'The delivered video duration could not be verified.'
    : 'No completed video with a verified duration has been delivered.';
  return { success: false, blockedDone: true, videoDurationIncomplete: true,
    reason: 'video_duration_incomplete', requiredSeconds, durationStatus: contract.status,
    ...(contract.videoId ? { videoId: contract.videoId } : {}),
    ...(contract.durationSeconds ? { durationSeconds: contract.durationSeconds } : {}),
    error: `The requested video${contract.videoId ? ` (${contract.videoId})` : ''} requires ${requiredSeconds} seconds. ${detail} Keep this video's full target on retries; for local ComfyUI omit unsupported video options while WebBrain retains its verification target. Preserve and report existing assets and any limitation. If the target cannot be delivered or verified, use outcome:"partial" or outcome:"failed". Do not regenerate paid clips merely to replace missing verification.` };
}
