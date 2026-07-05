/** Store-review prompt logic (#208) — stars first, then review or feedback. */

export const STORAGE_KEY = 'storeReviewPrompt';

export const STORE_URLS = {
  chrome: 'https://chromewebstore.google.com/detail/webbrain/ljhijonmfahplgbbacgcfnaihbjljhhb',
  firefox: 'https://addons.mozilla.org/en-US/firefox/addon/webbrain/',
};

export const FEEDBACK_ISSUES_URL = 'https://github.com/webbrain-one/webbrain/issues/new';

export const MIN_SUCCESSFUL_TASKS = 3;
export const MIN_DAYS_BEFORE_PROMPT = 0;
export const DISMISS_COOLDOWN_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function defaultState() {
  return {
    successfulTasks: 0,
    firstSuccessAt: null,
    lastShownAt: null,
    dismissedAt: null,
    neverAsk: false,
    ratedAt: null,
    rating: null,
    reviewOpened: false,
    feedbackSubmitted: false,
  };
}

export function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    successfulTasks: Number.isFinite(raw.successfulTasks) ? Math.max(0, raw.successfulTasks) : base.successfulTasks,
    firstSuccessAt: Number.isFinite(raw.firstSuccessAt) ? raw.firstSuccessAt : base.firstSuccessAt,
    lastShownAt: Number.isFinite(raw.lastShownAt) ? raw.lastShownAt : base.lastShownAt,
    dismissedAt: Number.isFinite(raw.dismissedAt) ? raw.dismissedAt : base.dismissedAt,
    neverAsk: !!raw.neverAsk,
    ratedAt: Number.isFinite(raw.ratedAt) ? raw.ratedAt : base.ratedAt,
    rating: Number.isFinite(raw.rating) ? raw.rating : base.rating,
    reviewOpened: !!raw.reviewOpened,
    feedbackSubmitted: !!raw.feedbackSubmitted,
  };
}

export function recordSuccessfulTask(state, { now = Date.now() } = {}) {
  const next = normalizeState(state);
  next.successfulTasks += 1;
  if (!next.firstSuccessAt) next.firstSuccessAt = now;
  return next;
}

export function shouldShowPrompt(state, {
  now = Date.now(),
  onboardingComplete = true,
} = {}) {
  const s = normalizeState(state);
  if (!onboardingComplete) return false;
  if (s.neverAsk) return false;
  if (s.reviewOpened || s.feedbackSubmitted) return false;
  if (s.successfulTasks < MIN_SUCCESSFUL_TASKS) return false;
  if (!s.firstSuccessAt) return false;
  if (now - s.firstSuccessAt < MIN_DAYS_BEFORE_PROMPT * MS_PER_DAY) return false;
  if (s.dismissedAt && now - s.dismissedAt < DISMISS_COOLDOWN_DAYS * MS_PER_DAY) return false;
  if (s.lastShownAt && !s.reviewOpened && !s.feedbackSubmitted && now - s.lastShownAt < DISMISS_COOLDOWN_DAYS * MS_PER_DAY) return false;
  return true;
}

export function markPromptShown(state, { now = Date.now() } = {}) {
  const next = normalizeState(state);
  next.lastShownAt = now;
  return next;
}

export function markDismissed(state, { neverAsk = false, now = Date.now() } = {}) {
  const next = normalizeState(state);
  next.dismissedAt = now;
  if (neverAsk) next.neverAsk = true;
  return next;
}

export function markRated(state, rating, { now = Date.now() } = {}) {
  const next = normalizeState(state);
  const stars = Math.max(1, Math.min(5, Math.round(Number(rating) || 0)));
  next.rating = stars;
  next.ratedAt = now;
  return next;
}

export function markReviewOpened(state) {
  const next = normalizeState(state);
  next.reviewOpened = true;
  return next;
}

export function markFeedbackSubmitted(state) {
  const next = normalizeState(state);
  next.feedbackSubmitted = true;
  return next;
}

export function positiveRating(rating) {
  return Number(rating) >= 4;
}

export function getStoreUrl(browserKey = 'chrome') {
  return STORE_URLS[browserKey] || STORE_URLS.chrome;
}

export function buildFeedbackUrl({ rating, comment = '' } = {}) {
  const title = encodeURIComponent(`WebBrain feedback (${rating}/5)`);
  const bodyParts = [
    `**Rating:** ${rating}/5`,
    '',
    String(comment || '').trim() || '_No additional comments provided._',
    '',
    '---',
    '_Submitted from the WebBrain side panel feedback prompt._',
  ];
  const body = encodeURIComponent(bodyParts.join('\n'));
  return `${FEEDBACK_ISSUES_URL}?title=${title}&body=${body}`;
}
