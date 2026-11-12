import { diagnosticFailure, diagnosticMessages, toolDiagnostic } from './cloud-diagnostics.js';
import { CloudHandoffGate } from './agent/cloud-handoff.js';
import {
  compileSuccessfulWorkflowByRunId,
  finalizeSavedWorkflowDraft,
  normalizeSavedWorkflow,
} from './agent/workflows.js';
import { normalizeTaskMemory, redactBotMemoryValue } from './agent/bot-memory.js';
import { isCredentialField } from './agent/credential-fields.js';
import { validateResumeArgs } from './agent/scheduler.js';
import { PRIVATE_RESULT_TYPE, importPrivateResultRecipient, encryptPrivateResult } from './private-results.js';
const PRIVATE_RESULT_PLACEHOLDER = '[Private final answer encrypted for this workspace.]';

const DEFAULT_CLOUD_BRIDGE_URL = 'ws://127.0.0.1:17374/extension';
const CLOUD_RUN_STORAGE_KEY = 'webbrainCloudRunSnapshots';
const CLOUD_HANDOFF_GUARD_KEY = 'webbrainCloudHandoffGuards';
const CLOUD_UPDATE_LIMIT = 200;
const CLOUD_RUN_LIMIT = 50;
const CLOUD_STRING_LIMIT = 16 * 1024;
const CLOUD_RUN_PERSIST_BYTES_LIMIT = 256 * 1024;
const CLOUD_PERSIST_BYTES_LIMIT = 4 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);
// In-handle continuations hold the tab lock, permission grant and recording.
// Clamp them to a worker-survivable window; longer waits must return partial.
const CLOUD_RESUME_MAX_DELAY_MS = 5 * 60 * 1000;
const CLOUD_RESUME_MAX_DELAY_LABEL = '5 minutes';
// Suffix match on normalized keys (non-alnum stripped). Avoid bare `pin` as a
// suffix — it over-matches `spin`, `mapPin`, etc. Short exact keys live in the set.
const SENSITIVE_CLOUD_KEY = /(?:authorization|cookie|password|passwd|passphrase|passcode|pincode|(?:verification|confirmation|security|auth|email|twofactor|2fa|mfa|onetime|recovery)code|secret|credential|privatekey|apikey|token|accesskeyid|secretaccesskey)$/i;
const SENSITIVE_CLOUD_KEY_EXACT = new Set(['code', 'pin', 'otp', 'cvv', 'cvc', 'ssn']);
const LARGE_IMAGE_KEY = /(?:attachimage|screenshot|image|imagedata|dataurl)$/i;
const CLOUD_TEXT_ENTRY_TOOLS = new Set(['set_field', 'type_ax', 'type_text', 'iframe_type']);
const VERIFY_FORM_VALUE_KEYS = new Set(['value', 'controlvalue', 'valueprefix', 'valuesuffix']);
// Strict-secret mode is deny-by-default: an update leaves the browser carrying
// only the evidence a cloud caller needs to score the run. A per-tool allowlist
// is the wrong shape here — a secret typed into a visible field comes straight
// back out of the next page read, and model prose repeats it in plain text.
// These are the narrow carve-outs that survive, keyed by what grading reads.
const CLOUD_STRICT_MODEL_TEXT_TYPES = new Set(['text', 'text_delta']);
// `error` and `run_status` carry the model's final response as `message`.
const CLOUD_STRICT_DROPPED_MESSAGE_TYPES = new Set(['error', 'run_status']);
// done_json and verify_form keep their shape through dedicated value-level
// redactors below; every other tool result is reduced to a bare envelope.
const CLOUD_STRICT_STRUCTURED_RESULT_TOOLS = new Set(['done_json', 'verify_form']);
// Scalar, non-page-derived argument keys. `fetch_url` is handled separately so
// its URL is reduced to origin-only evidence rather than dropped.
const CLOUD_STRICT_ARG_EVIDENCE_KEYS = new Set(['skill_id', 'method', 'url_origin']);
// A caller has to read a clarification to answer it, so `clarify` cannot be
// blanked the way model prose is. Prompt instructions are not a redaction
// boundary either, so strict runs additionally redact by *value*: every secret
// this run typed into a page is remembered and struck from the text of every
// later update, clarifications included. That leaves a usable question while
// removing the literal the key-based scrubber cannot recognize.
const CLOUD_STRICT_SECRET_VALUE_LIMIT = 256;
// Short values would mangle ordinary prose on a coincidental substring match.
// Numeric PIN/CVV fragments are still security-sensitive, so they are tracked
// with boundary-aware replacement below.
const CLOUD_STRICT_SECRET_MIN_LENGTH = 4;
const WORKFLOW_PARAMETER_VALUE_LIMIT = 10_000;
const SENSITIVE_URL_COMPONENT_KEY = /(?:^|[-_.\s])(?:auth(?:orization)?|api[-_.\s]?key|key|token|secret|signature|sig|code|credential|password|passcode|otp)(?:$|[-_.\s])/i;
const SENSITIVE_URL_PATH_LABELS = new Set([
  'auth', 'authorization', 'apikey', 'key', 'token', 'accesstoken', 'refreshtoken',
  'secret', 'signature', 'sig', 'code', 'authcode', 'verificationcode',
  'credential', 'password', 'passcode', 'otp', 'downloadkey', 'sharetoken',
]);

function cloudRunError(message, status) {
  return Object.assign(new Error(message), { status });
}

function normalizeCloudTaskMemory(msg) {
  const values = [msg.taskMemory, msg.task_memory].filter(value => value !== undefined);
  if (!values.length) return null;
  try {
    if (values.some(value => value === null)
        || (values.length === 2 && JSON.stringify(values[0]) !== JSON.stringify(values[1]))) throw new Error();
    return normalizeTaskMemory(values[0]);
  } catch {
    throw cloudRunError('Invalid private task memory configuration.', 400);
  }
}

async function cloudMemoryOwner(memory) {
  if (!memory) return null;
  const digest = async (field, value) => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bot-memory-owner-v1:${field}:${value}`));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  };
  return { version: 1, botIdHash: await digest('bot', memory.botId),
    runIdHash: await digest('run', memory.runId), callbackTokenHash: await digest('token', memory.callbackToken) };
}

function assertMemoryContinuation(parent, owner) {
  if (!parent?.memoryProtected && !owner) return;
  const previous = parent?.memoryOwner;
  if (!parent?.memoryProtected || previous?.version !== 1
      || !['botIdHash', 'runIdHash', 'callbackTokenHash'].every(key => /^[a-f0-9]{64}$/.test(previous[key] || ''))) {
    throw cloudRunError('Protected continuation identity is unavailable. Start an independent task.', 409);
  }
  if (!owner) throw cloudRunError('A protected continuation requires fresh private task memory.', 409);
  if (owner.botIdHash !== previous.botIdHash) {
    throw cloudRunError('A protected continuation must belong to the same bot.', 409);
  }
  if (owner.runIdHash === previous.runIdHash || owner.callbackTokenHash === previous.callbackTokenHash) {
    throw cloudRunError('A protected continuation requires a new run-scoped memory envelope.', 409);
  }
}

export function normalizeCloudRunMode(value, fallback = 'act') {
  const mode = String(value ?? '').trim().toLowerCase();
  if (!mode) return fallback;
  if (!['ask', 'act'].includes(mode)) {
    throw cloudRunError('Cloud run `mode` must be `ask` or `act`.', 400);
  }
  return mode;
}

function normalizedCloudKey(key) {
  return String(key || '').replace(/[^a-z0-9]/gi, '');
}

export function normalizeCloudBridgeUrl(value = DEFAULT_CLOUD_BRIDGE_URL) {
  const url = new URL(String(value || DEFAULT_CLOUD_BRIDGE_URL));
  const host = url.hostname.toLowerCase();
  // WHATWG URL keeps the brackets on IPv6 literals: ws://[::1]/… parses to
  // hostname "[::1]", so both spellings must be allowlisted (same as
  // LOCAL_OLLAMA_HOSTS in ollama-handoff.js).
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('WebBrain cloud bridge URL must use ws:// on localhost.');
  }
  return url.href;
}

export function isSensitiveCloudKey(key) {
  const normalizedKey = normalizedCloudKey(key);
  if (!normalizedKey) return false;
  return SENSITIVE_CLOUD_KEY.test(normalizedKey) || SENSITIVE_CLOUD_KEY_EXACT.has(normalizedKey);
}

function hasCloudOutputSchema(value) {
  return value !== null && value !== undefined;
}

function scrubCloudValue(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, item) => {
      const normalizedKey = normalizedCloudKey(key);
      if (normalizedKey && isSensitiveCloudKey(key)) {
        return '[redacted]';
      }
      if (typeof item === 'string' && /^data:image\//i.test(item)) {
        return `[image omitted: ${item.length} chars]`;
      }
      if (LARGE_IMAGE_KEY.test(normalizedKey) && typeof item === 'string' && item.length > 500) {
        return `[large payload omitted: ${item.length} chars]`;
      }
      if (key === 'ciphertext' && typeof item === 'string' && item.length <= 90000
          && /^[A-Za-z0-9+/]*={0,2}$/.test(item)) return item;
      if (typeof item === 'string' && item.length > CLOUD_STRING_LIMIT) {
        return `${item.slice(0, CLOUD_STRING_LIMIT)}\n[truncated ${item.length - CLOUD_STRING_LIMIT} chars for cloud persistence]`;
      }
      return item;
    }));
  } catch {
    return { unserializable: true };
  }
}

function cloudUrlEvidence(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return {};
    return { url_origin: url.origin };
  } catch {
    return {};
  }
}

function cloudTerminalUrl(value, { strictSecretMode = false } = {}) {
  if (!strictSecretMode) return value;
  return cloudUrlEvidence(value).url_origin || '';
}

function redactVerifyFormValues(value) {
  try {
    return JSON.parse(JSON.stringify(value, (key, item) => (
      VERIFY_FORM_VALUE_KEYS.has(normalizedCloudKey(key).toLowerCase())
        ? '[redacted form value]'
        : item
    )));
  } catch {
    return { success: false, sensitivePayloadRedacted: true };
  }
}

// Every leaf a secret can be encoded in goes, not just strings: a six-digit OTP
// serialized as `verification_code: 481920` is a number, and no key pattern
// recognizes that field name. Booleans and null survive because neither can
// carry a credential — which is also what makes a strict structured run
// gradable, since a `true` outcome flag comes through intact. A strict run's
// structured output is therefore assertable on booleans only.
function redactStrictStructuredValues(value) {
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === 'string') return '[redacted strict value]';
      if (typeof item === 'number' || typeof item === 'bigint') return '[redacted strict number]';
      return item;
    }));
  } catch {
    return { sensitivePayloadRedacted: true };
  }
}

function cloudSafeUpdateData(type, data, { strictSecretMode = false } = {}) {
  if (!data || typeof data !== 'object') return data;
  if (type === 'page_feedback') {
    return { id: String(data.id || ''), source: data.source, kinds: data.kinds,
      navigation: data.navigation === true,
      ...(data.navigation ? { message: 'Page changed while the task was running. Continuing the task.' } : {}) };
  }
  const name = String(data.name || data.tool || '');
  if (type === 'tool_result') data = { ...data, diagnostic: toolDiagnostic(data.result) };
  if (strictSecretMode && CLOUD_STRICT_MODEL_TEXT_TYPES.has(type)) {
    return {
      ...data,
      ...(Object.hasOwn(data, 'content') ? { content: '[redacted strict text]' } : {}),
    };
  }
  if (strictSecretMode && CLOUD_STRICT_DROPPED_MESSAGE_TYPES.has(type)) {
    // Dropped rather than replaced so the run-level fallbacks below still pick
    // their own descriptive constant instead of storing a placeholder.
    const { message: _message, ...rest } = data;
    return type === 'error' ? { ...rest, diagnostic: { version: 1, outcome: 'failed', failureKind: diagnosticFailure(data.message) }, message: diagnosticMessages[diagnosticFailure(data.message)] } : rest;
  }
  if (!strictSecretMode && type === 'tool_call' && CLOUD_TEXT_ENTRY_TOOLS.has(name)) {
    const args = data.args && typeof data.args === 'object' ? data.args : {};
    return {
      ...data,
      args: {
        ...args,
        ...(Object.hasOwn(args, 'text') ? { text: '[redacted typed text]' } : {}),
        ...(Object.hasOwn(args, 'value') ? { value: '[redacted typed text]' } : {}),
      },
    };
  }
  if (strictSecretMode && type === 'tool_call' && name === 'fetch_url') {
    const args = data.args && typeof data.args === 'object' ? data.args : {};
    const method = String(args.method || '').toUpperCase();
    return {
      ...data,
      args: {
        ...(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? { method } : {}),
        ...cloudUrlEvidence(args.url),
        ...(Object.hasOwn(args, 'body') ? { body: '[redacted request body]' } : {}),
      },
    };
  }
  if (strictSecretMode && type === 'tool_result' && name === 'fetch_url') {
    const result = data.result && typeof data.result === 'object' ? data.result : {};
    return {
      ...data,
      result: {
        ...(typeof result.success === 'boolean' ? { success: result.success }
          : result.error || result.isError === true ? { success: false } : {}),
        ...(Number.isFinite(Number(result.status)) ? { status: Number(result.status) } : {}),
        sensitivePayloadRedacted: true,
      },
    };
  }
  if (strictSecretMode && type === 'tool_result' && name === 'verify_form') {
    return {
      ...data,
      result: redactVerifyFormValues(data.result),
    };
  }
  if (strictSecretMode && type === 'tool_call' && name === 'done_json') {
    const args = data.args && typeof data.args === 'object' ? data.args : {};
    return {
      ...data,
      args: {
        ...args,
        ...(Object.hasOwn(args, 'result') ? { result: redactStrictStructuredValues(args.result) } : {}),
        ...(Object.hasOwn(args, 'summary') ? { summary: '[redacted strict summary]' } : {}),
      },
    };
  }
  if (strictSecretMode && type === 'tool_result' && name === 'done_json') {
    const result = data.result && typeof data.result === 'object' ? data.result : {};
    return {
      ...data,
      result: {
        ...result,
        ...(Object.hasOwn(result, 'result') ? { result: redactStrictStructuredValues(result.result) } : {}),
        ...(Object.hasOwn(result, 'cloudResult') ? { cloudResult: redactStrictStructuredValues(result.cloudResult) } : {}),
        ...(Object.hasOwn(result, 'invalidResult') ? { invalidResult: redactStrictStructuredValues(result.invalidResult) } : {}),
        ...(Object.hasOwn(result, 'summary') ? { summary: '[redacted strict summary]' } : {}),
      },
    };
  }
  if (strictSecretMode && type === 'tool_call') {
    const args = data.args && typeof data.args === 'object' ? data.args : {};
    const evidence = Object.fromEntries(Object.entries(args).filter(([key, value]) => (
      CLOUD_STRICT_ARG_EVIDENCE_KEYS.has(key) && (typeof value !== 'object' || value === null)
    )));
    return {
      ...data,
      args: { ...evidence, ...cloudUrlEvidence(args.url), sensitiveArgsRedacted: true },
    };
  }
  if (strictSecretMode && type === 'tool_result' && !CLOUD_STRICT_STRUCTURED_RESULT_TOOLS.has(name)) {
    // Any read tool echoes back whatever was typed into the page, so success
    // and HTTP status are all a result may carry out of a strict run.
    const result = data.result && typeof data.result === 'object' ? data.result : {};
    return {
      ...data,
      result: {
        ...(typeof result.success === 'boolean' ? { success: result.success }
          : result.error || result.isError === true ? { success: false } : {}),
        ...(Number.isFinite(Number(result.status)) ? { status: Number(result.status) } : {}),
        sensitivePayloadRedacted: true,
      },
    };
  }
  return data;
}

// Walks a raw tool result for string or numeric values sitting under a key the
// scrubber already treats as sensitive. Depth-bounded: a page read can be
// enormous, and this runs on every update.
function collectSensitiveStrings(value, into, depth = 0, sensitiveParent = false) {
  if (depth > 6 || into.length > CLOUD_STRICT_SECRET_VALUE_LIMIT) return;
  if (typeof value === 'string') {
    if (sensitiveParent) into.push(value);
    return;
  }
  if (typeof value === 'number') {
    if (sensitiveParent && Number.isFinite(value)) into.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveStrings(item, into, depth + 1, sensitiveParent);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    collectSensitiveStrings(
      item,
      into,
      depth + 1,
      sensitiveParent || isSensitiveCloudKey(key),
    );
    if (into.length > CLOUD_STRICT_SECRET_VALUE_LIMIT) return;
  }
}

function isSensitiveUrlComponentKey(value) {
  const text = String(value || '');
  return isSensitiveCloudKey(text)
    || SENSITIVE_URL_COMPONENT_KEY.test(text)
    || /(?:Key|Code|Signature|Token|Secret|Password)$/.test(text);
}

function isSensitiveUrlPathLabel(value) {
  return SENSITIVE_URL_PATH_LABELS.has(normalizedCloudKey(value).toLowerCase());
}

// URL paths and queries are withheld wholesale from strict trace evidence, but
// the value registry must be narrower: registering `/profile` or `?tab=activity`
// as a secret corrupts legitimate caller-visible results. Remember userinfo,
// values under credential-like query keys, and path/hash components that either
// carry credential vocabulary themselves or follow an explicit credential label.
function collectUrlSecretStrings(value, into) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  const add = (candidate) => {
    const text = String(candidate || '');
    if (text && into.length <= CLOUD_STRICT_SECRET_VALUE_LIMIT) into.push(text);
  };
  const addEncoded = (candidate) => {
    add(candidate);
    try {
      add(decodeURIComponent(String(candidate || '')));
    } catch {}
  };
  addEncoded(url.username);
  addEncoded(url.password);
  let followsSensitivePathLabel = false;
  for (const segment of url.pathname.split('/').filter(Boolean)) {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch {}
    const isLabel = isSensitiveUrlPathLabel(decoded);
    if (followsSensitivePathLabel || (!isLabel && isSensitiveUrlComponentKey(decoded))) {
      addEncoded(segment);
    }
    followsSensitivePathLabel = isLabel;
  }
  for (const [key, item] of url.searchParams) {
    if (isSensitiveUrlComponentKey(key)) addEncoded(item);
  }
  const hash = url.hash.replace(/^#/, '');
  if (hash) {
    let decodedHash = hash;
    try { decodedHash = decodeURIComponent(hash); } catch {}
    let foundSensitiveHashParam = false;
    if (decodedHash.includes('=')) {
      const hashParams = new URLSearchParams(decodedHash.replace(/^\?/, ''));
      for (const [key, item] of hashParams) {
        if (!isSensitiveUrlComponentKey(key)) continue;
        foundSensitiveHashParam = true;
        addEncoded(item);
      }
    }
    if (!foundSensitiveHashParam
        && !isSensitiveUrlPathLabel(decodedHash)
        && isSensitiveUrlComponentKey(decodedHash)) {
      addEncoded(hash);
    }
  }
}

// URL credentials are not unique to fetch_url: navigate, new_tab, read tools,
// downloads, custom skills, and tool results can all carry URL-shaped fields.
// Walk only fields whose normalized name ends in url/urls, but follow arrays
// and nested containers below such a field so credential-like components in
// every concrete http(s) value are registered before later prose is published.
function collectUrlSecretsFromNamedFields(value, into, depth = 0, urlBearing = false) {
  if (depth > 6 || into.length > CLOUD_STRICT_SECRET_VALUE_LIMIT) return;
  if (typeof value === 'string') {
    if (urlBearing) collectUrlSecretStrings(value, into);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrlSecretsFromNamedFields(item, into, depth + 1, urlBearing);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizedCloudKey(key).toLowerCase();
    collectUrlSecretsFromNamedFields(
      item,
      into,
      depth + 1,
      urlBearing || /urls?$/.test(normalizedKey),
    );
    if (into.length > CLOUD_STRICT_SECRET_VALUE_LIMIT) return;
  }
}

// Full URLs are trace-only sensitive in strict mode even when their individual
// path/query components are ordinary public data. Keep this registry separate
// from credential values so a repeated URL is removed from prose updates while
// a schema-valid result such as `{ section: 'profile' }` stays intact.
function collectUrlTraceStringsFromNamedFields(value, into, depth = 0, urlBearing = false) {
  if (depth > 6 || into.length > CLOUD_STRICT_SECRET_VALUE_LIMIT) return;
  if (typeof value === 'string') {
    if (!urlBearing) return;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      into.push(value);
      if (url.href !== value) into.push(url.href);
    } catch {}
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrlTraceStringsFromNamedFields(item, into, depth + 1, urlBearing);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizedCloudKey(key).toLowerCase();
    collectUrlTraceStringsFromNamedFields(
      item,
      into,
      depth + 1,
      urlBearing || /urls?$/.test(normalizedKey),
    );
    if (into.length > CLOUD_STRICT_SECRET_VALUE_LIMIT) return;
  }
}

// verify_form represents an input's identity and value as siblings, for
// example `{ name: 'api_key', value: 'secret' }`. The generic key walk above
// cannot connect those fields, so reuse the same credential detector that
// classifies fields when they are filled and register only that field record's
// value-bearing leaves.
function collectCredentialFieldValues(value, into, depth = 0) {
  if (depth > 6 || into.length > CLOUD_STRICT_SECRET_VALUE_LIMIT) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialFieldValues(item, into, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const credential = isCredentialField({
    type: value.type,
    name: value.name,
    id: value.id,
    autocomplete: value.autocomplete,
    ariaLabel: value.ariaLabel ?? value.aria_label,
    placeholder: value.placeholder,
    labelText: value.labelText ?? value.label,
  }).sensitive;
  if (credential) {
    for (const [key, item] of Object.entries(value)) {
      if (!VERIFY_FORM_VALUE_KEYS.has(normalizedCloudKey(key).toLowerCase())) continue;
      if (typeof item === 'string') into.push(item);
      else if (typeof item === 'number' && Number.isFinite(item)) into.push(String(item));
    }
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') collectCredentialFieldValues(item, into, depth + 1);
    if (into.length > CLOUD_STRICT_SECRET_VALUE_LIMIT) return;
  }
}

// A request body is a string argument, so the key-walk above cannot see into
// it. Both encodings a mutating call realistically uses are cheap to parse.
function collectRequestBodySecrets(body, into) {
  if (typeof body !== 'string' || !body) return false;
  // Do not silently skip a body that is too large for bounded inspection. The
  // caller marks the run as overflowed so every later scalar is redacted rather
  // than relying on the model not to repeat an unknown credential.
  if (body.length > WORKFLOW_PARAMETER_VALUE_LIMIT) return true;
  try {
    collectSensitiveStrings(JSON.parse(body), into);
    return false;
  } catch {
    // Not JSON — fall through to the form encoding.
  }
  try {
    for (const [key, value] of new URLSearchParams(body)) {
      if (isSensitiveCloudKey(key)) into.push(value);
    }
  } catch {
    // Undecodable body: nothing to register, and the argument is dropped anyway.
  }
  return false;
}

function redactWorkflowRuntimeValues(value, runtimeValues = [], label = '[workflow parameter]') {
  if (value == null) return value;
  const variants = new Set();
  for (const parameterValue of runtimeValues) {
    if (typeof parameterValue !== 'string' || !parameterValue.length) continue;
    variants.add(parameterValue);
    try {
      const componentEncoded = encodeURIComponent(parameterValue);
      variants.add(componentEncoded);
      variants.add(componentEncoded.replace(/%20/g, '+'));
      variants.add(encodeURI(parameterValue));
      const formEncoded = new URLSearchParams([['value', parameterValue]])
        .toString()
        .slice('value='.length);
      variants.add(formEncoded);
    } catch {
      // Raw replacement above still protects malformed strings that URI
      // encoders cannot represent (for example, lone UTF-16 surrogates).
    }
  }
  const values = [...variants]
    .sort((a, b) => b.length - a.length);
  if (!values.length) return value;
  const normalizePercentEscapes = input => input.replace(
    /%[0-9a-f]{2}/gi,
    match => match.toUpperCase(),
  );
  const redactString = (input) => values.reduce((text, parameterValue) => {
    const normalizedText = normalizePercentEscapes(text);
    const normalizedValue = normalizePercentEscapes(parameterValue);
    if (!normalizedText.includes(normalizedValue)) return text;
    let result = '';
    let offset = 0;
    let index = normalizedText.indexOf(normalizedValue, offset);
    while (index !== -1) {
      const boundaryMatch = parameterValue.length >= CLOUD_STRICT_SECRET_MIN_LENGTH
        || (
          (index === 0 || !/[A-Za-z0-9]/.test(normalizedText[index - 1]))
          && (
            index + normalizedValue.length === normalizedText.length
            || !/[A-Za-z0-9]/.test(normalizedText[index + normalizedValue.length])
          )
        );
      if (!boundaryMatch) {
        const nextOffset = index + normalizedValue.length;
        result += text.slice(offset, nextOffset);
        offset = nextOffset;
        index = normalizedText.indexOf(normalizedValue, offset);
        continue;
      }
      result += `${text.slice(offset, index)}${label}`;
      offset = index + parameterValue.length;
      index = normalizedText.indexOf(normalizedValue, offset);
    }
    return result + text.slice(offset);
  }, input);
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => (
      // A secret typed as text can come back as a JSON number — a six-digit OTP
      // is the obvious case. Match on the number's exact string form: a
      // substring rule would strike an unrelated `3` out of `481920`.
      typeof item === 'number' && values.includes(String(item))
        ? label
        : (typeof item === 'string' ? redactString(item) : item)
    )));
  } catch {
    return { unserializable: true };
  }
}

function serializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function compactCloudRunForPersistence(run) {
  const row = scrubCloudValue(run);
  row.structured = row.structured ?? hasCloudOutputSchema(run?.outputSchema);
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  const omittedUpdates = Array.isArray(row.updates) ? row.updates.length : 0;
  row.updates = [];
  row.persistenceTruncated = { omittedUpdates };
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  row.content = '';
  row.outputSchema = null;
  row.persistenceTruncated.omittedContent = true;
  row.persistenceTruncated.omittedSchema = true;
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  delete row.result;
  row.persistenceTruncated.omittedResult = true;
  if (serializedBytes(row) <= CLOUD_RUN_PERSIST_BYTES_LIMIT) return row;

  return scrubCloudValue({
    runId: run?.runId,
    status: run?.status,
    workflowId: run?.workflowId || null,
    traceRunId: run?.traceRunId || null,
    parentRunId: run?.parentRunId || null,
    conversationKey: run?.conversationKey || null,
    memoryProtected: run?.memoryProtected === true,
    memoryOwner: run?.memoryOwner || null,
    handoff: run?.handoff || null,
    providerId: run?.providerId || null,
    expectedModel: run?.expectedModel || null,
    mode: run?.mode || 'act',
    captchaDiagnostics: run?.captchaDiagnostics || null,
    tabId: run?.tabId,
    task: run?.task,
    structured: hasCloudOutputSchema(run?.outputSchema) || run?.structured === true,
    pendingInput: run?.pendingInput || null,
    summary: run?.summary,
    content: '',
    finalUrl: run?.finalUrl,
    error: run?.error,
    createdAt: run?.createdAt,
    updatedAt: run?.updatedAt,
    completedAt: run?.completedAt,
    updates: [],
    persistenceTruncated: { omittedUpdates, omittedResult: true, omittedSchema: true },
  });
}

/**
 * Scheduled jobs answer a cloud query over the same bridge as run updates, so
 * they need the same strict-secret treatment: a summarized job otherwise ships
 * `lastResult`, `lastError`, `pendingClarify`, `target.url`, and
 * `watch.lastObservation` — a child task's raw prompt and output — straight past
 * every redaction applied to the parent run. Strict mode keeps only structural
 * and enumerated fields; free text and URLs are dropped.
 */
export function cloudSafeScheduledJob(job, { strictSecretMode = false } = {}) {
  if (!job || !strictSecretMode) return job;
  return {
    id: job.id,
    kind: job.kind,
    source: job.source || null,
    status: job.status,
    scheduledAt: job.scheduledAt,
    // Same as summarizeScheduledJob: a paused job has no next run.
    nextRunAt: job.status === 'paused' ? null : (job.nextRunAt || job.scheduledAt),
    lastOutcome: job.lastOutcome || null,
    needsUserInput: job.needsUserInput === true,
    clarificationRequired: job.clarificationRequired === true,
    completedAt: job.completedAt || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    sensitiveFieldsRedacted: true,
  };
}

export function buildCloudPersistenceRows(runs) {
  const values = Array.isArray(runs) ? [...runs] : [...(runs?.values?.() || [])];
  const candidates = values
    .sort((a, b) => {
      // Manual control must survive restart even when this task is older than
      // the retained history or the history fills the storage byte budget.
      const holdsControl = run => !!run?.handoff && !TERMINAL_STATUSES.has(run.status);
      return Number(holdsControl(b)) - Number(holdsControl(a))
        || String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
    })
    .slice(0, CLOUD_RUN_LIMIT)
    .map(compactCloudRunForPersistence);
  const rows = [];
  let totalBytes = 2;
  for (const row of candidates) {
    const rowBytes = serializedBytes(row) + (rows.length ? 1 : 0);
    if (totalBytes + rowBytes > CLOUD_PERSIST_BYTES_LIMIT) continue;
    rows.push(row);
    totalBytes += rowBytes;
  }
  return rows;
}

// Session snapshots disappear on extension reload and browser restart. Keep
// only the identity needed to reserve manual ownership in durable storage.
function normalizeCloudHandoffGuard(row) {
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  // Cloud callers may supply correlation IDs containing punctuation or
  // Unicode. Match the existing start API rather than changing that contract.
  if (!row || typeof row.runId !== 'string' || !row.runId.trim() || row.runId.length > CLOUD_STRING_LIMIT
    || !Number.isSafeInteger(row.tabId) || row.tabId < 0 || row.tabId > 2147483647
    || !timestamp(row.createdAt) || !timestamp(row.updatedAt)
    || row.pausedAt != null && !timestamp(row.pausedAt)) throw new Error('Browser handoff guard could not be reconciled.');
  return { runId: row.runId, tabId: row.tabId, createdAt: row.createdAt,
    updatedAt: row.updatedAt, pausedAt: row.pausedAt || null };
}

function cloudSnapshot(run, { includeUpdates = true } = {}) {
  if (!run) return null;
  return {
    runId: run.runId,
    status: run.status,
    workflowId: run.workflowId || null,
    parentRunId: run.parentRunId || null,
    mode: run.mode || 'act',
    tabId: run.tabId,
    task: run.task,
    structured: run.structured ?? hasCloudOutputSchema(run.outputSchema),
    pendingInput: run.pendingInput || null,
    handoff: run.handoff || null,
    ...(run.captchaDiagnostics ? { captchaDiagnostics: run.captchaDiagnostics } : {}),
    result: run.result,
    persistenceTruncated: run.persistenceTruncated,
    summary: run.summary,
    content: run.content,
    finalUrl: run.finalUrl,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    updates: includeUpdates ? run.updates : undefined,
  };
}

function isUsableCloudTab(tab) {
  if (tab?.id == null) return false;
  try {
    // Chrome can leave an unpacked-extension startup tab's `url` empty while
    // exposing the loaded page through `pendingUrl`, even with status=complete.
    const url = new URL(tab.url || tab.pendingUrl || '');
    return ['http:', 'https:', 'file:'].includes(url.protocol) || url.href === 'about:blank';
  } catch {
    return false;
  }
}

export function createCloudRunController({
  chromeApi,
  agent,
  ensureOffscreen,
  sendIndicator = () => {},
  startRecording = null,
  stopRecording = null,
  workflowTrace = null,
  now = () => new Date(),
  makeRunId = () => `run_${globalThis.crypto.randomUUID()}`,
  waitForResume = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const api = chromeApi;
  const runs = new Map();
  const startingTabs = new Set();
  const startingRunIds = new Set();
  let pendingStarts = 0;
  const handoffGates = new Map();
  const activeExecutions = new Set();
  const startingConversations = new Set();
  const runAbortControllers = new Map();
  // Private envelopes live only for the active handle, outside snapshots and
  // session persistence. Only hashed identity binding survives a restart.
  const memoryConfigurations = new Map();
  let hydratePromise = null;
  let persistQueue = Promise.resolve();
  let persistTimer = null;
  const durableHandoffGuards = new Map();
  let storedHandoffGuard = false;

  const isoNow = () => now().toISOString();

  function snapshot(run, options) {
    const result = cloudSnapshot(run, options);
    // Handler errors and cancellation can assign a terminal status before
    // asynchronous cleanup finishes. A retained guard remains authoritative
    // for pollers and streamers until confirmed removal releases ownership.
    if (result && durableHandoffGuards.has(run.runId) && TERMINAL_STATUSES.has(result.status)) {
      result.status = run.handoff ? 'paused' : 'aborting';
      result.handoff = run.handoff ? { ...run.handoff, state: 'paused', resumable: false, interrupted: true } : null;
      result.completedAt = null;
    }
    return result;
  }

  // MV3 service workers suspend after ~30s idle; a bare setTimeout does not
  // reset that timer. Ping getPlatformInfo on a 20s interval for the duration
  // of an in-handle resume wait so Chrome keeps the worker alive. Best-effort:
  // if the worker is still torn down, hydrate() fails the run safely.
  function startResumeKeepAlive() {
    try {
      const runtime = api?.runtime;
      if (typeof runtime?.getPlatformInfo !== 'function') return () => {};
      const ping = () => {
        try {
          const maybePromise = runtime.getPlatformInfo(() => { void runtime.lastError; });
          if (maybePromise?.catch) maybePromise.catch(() => {});
        } catch { /* keepalive is best-effort */ }
      };
      ping();
      const timer = setInterval(ping, 20 * 1000);
      timer?.unref?.();
      return () => clearInterval(timer);
    } catch {
      return () => {};
    }
  }

  async function persist({ clearHandoffRunId = null } = {}) {
    persistQueue = persistQueue
      .catch(() => {})
      .then(async () => {
        // Build inside the queue so an older ordinary checkpoint cannot put
        // back a reservation already cleared by confirmed reconciliation.
        const cancellationPending = id => activeExecutions.has(id) && runAbortControllers.get(id)?.signal.aborted;
        const clearing = [...durableHandoffGuards.entries()].filter(([id]) => {
          const run = runs.get(id);
          return !cancellationPending(id) && (id === clearHandoffRunId
            || (run && TERMINAL_STATUSES.has(run.status) && !activeExecutions.has(id)));
        });
        const clearedIds = new Set(clearing.map(([id]) => id));
        const guards = [...durableHandoffGuards.values()].filter(row => !clearedIds.has(row.runId));
        // A failed session write must not remove the durable reservation.
        await api.storage?.session?.set?.({ [CLOUD_RUN_STORAGE_KEY]: buildCloudPersistenceRows(runs) });
        if (guards.length || storedHandoffGuard || clearing.length) {
          if (!api.storage?.local?.set) throw new Error('Durable browser handoff storage is unavailable.');
          await api.storage.local.set({ [CLOUD_HANDOFF_GUARD_KEY]: guards });
          // Cancellation can arrive during an awaited handback clear. Keep
          // the in-memory reservation and restore its durable row before this
          // checkpoint can acknowledge anything or allow another actor in.
          const retained = clearing.filter(([id]) => cancellationPending(id));
          if (retained.length) {
            await api.storage.local.set({ [CLOUD_HANDOFF_GUARD_KEY]: [
              ...guards, ...retained.map(([id, row]) => durableHandoffGuards.get(id) || row),
            ] });
          }
          storedHandoffGuard = guards.length > 0 || retained.length > 0;
          const retainedIds = new Set(retained.map(([id]) => id));
          for (const [id, row] of clearing) if (!retainedIds.has(id) && durableHandoffGuards.get(id) === row) durableHandoffGuards.delete(id);
        }
      });
    await persistQueue;
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist().catch(() => {});
    }, 100);
  }

  async function hydrate() {
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      const local = await api.storage?.local?.get?.(CLOUD_HANDOFF_GUARD_KEY) || {};
      const guardRows = local[CLOUD_HANDOFF_GUARD_KEY] === undefined ? [] : local[CLOUD_HANDOFF_GUARD_KEY];
      if (!Array.isArray(guardRows) || guardRows.length > CLOUD_RUN_LIMIT) throw new Error('Browser handoff guard could not be reconciled.');
      for (const row of guardRows) {
        const guard = normalizeCloudHandoffGuard(row);
        if (durableHandoffGuards.has(guard.runId)) throw new Error('Browser handoff guard could not be reconciled.');
        durableHandoffGuards.set(guard.runId, guard);
      }
      storedHandoffGuard = durableHandoffGuards.size > 0;
      // Preserve main's fail-closed session read. Read failures are not proof
      // that no run owns this profile.
      const stored = await api.storage?.session?.get?.(CLOUD_RUN_STORAGE_KEY) || {};
      const rows = Array.isArray(stored?.[CLOUD_RUN_STORAGE_KEY]) ? stored[CLOUD_RUN_STORAGE_KEY] : [];
      for (const guard of durableHandoffGuards.values()) {
        const old = rows.findIndex(row => row?.runId === guard.runId);
        const restored = { ...(old < 0 ? { updates: [] } : rows[old]), ...guard, status: 'paused',
          handoff: { state: 'paused', resumable: false, interrupted: true,
            ...(guard.pausedAt ? { pausedAt: guard.pausedAt } : {}) }, completedAt: null };
        if (old < 0) rows.push(restored); else rows[old] = restored;
      }
      let changed = false;
      for (const row of rows) {
        if (!row?.runId) continue;
        const rawUpdates = Array.isArray(row.updates) ? row.updates : [];
        let nextUpdateSeq = 0;
        const updates = rawUpdates.map((update) => {
          const candidate = Number(update?.seq);
          const seq = Number.isSafeInteger(candidate) && candidate > nextUpdateSeq
            ? candidate
            : nextUpdateSeq + 1;
          if (seq !== candidate) changed = true;
          nextUpdateSeq = seq;
          return { ...update, seq };
        });
        const restored = { ...row, updates, nextUpdateSeq };
        if (restored.handoff && !TERMINAL_STATUSES.has(restored.status)) {
          // A lost worker has lost ephemeral guards/provider/memory context.
          // Keep the browser reserved for its owner; never replay this run.
          restored.status = 'paused';
          restored.handoff = { ...restored.handoff, state: 'paused', resumable: false, interrupted: true };
          durableHandoffGuards.set(restored.runId, normalizeCloudHandoffGuard({
            runId: restored.runId, tabId: restored.tabId,
            createdAt: durableHandoffGuards.get(restored.runId)?.createdAt || isoNow(),
            updatedAt: isoNow(), pausedAt: restored.handoff.pausedAt || null,
          }));
          restored.error = 'WebBrain restarted during browser handoff. Inspect the page and explicitly stop this interrupted run before starting further work.';
          startingTabs.add(restored.tabId);
          pushUpdate(restored, 'handoff', restored.handoff);
          changed = true;
        } else if (!TERMINAL_STATUSES.has(restored.status)) {
          const at = isoNow();
          restored.status = restored.status === 'aborting' ? 'aborted' : 'failed';
          restored.pendingInput = null;
          restored.error = restored.status === 'aborted'
            ? 'Run aborted when the WebBrain service worker restarted.'
            : 'Run interrupted when the WebBrain service worker restarted.';
          restored.updatedAt = at;
          restored.completedAt = at;
          changed = true;
        }
        runs.set(restored.runId, restored);
      }
      if (changed) await persist();
    })();
    return hydratePromise;
  }

  async function activateTab(tab) {
    if (!tab?.id) return tab;
    await api.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId != null && api.windows?.update) {
      await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return tab;
  }

  async function resolveTabId(requestedTabId, startup = null) {
    if (requestedTabId != null && requestedTabId !== '') {
      const tab = await api.tabs.get(Number(requestedTabId));
      if (!isUsableCloudTab(tab)) throw new Error(`Tab ${requestedTabId} is not a controllable webpage.`);
      return tab.id;
    }

    const active = await api.tabs.query({ active: true, lastFocusedWindow: true });
    const activeTab = active.find(isUsableCloudTab);
    if (activeTab) return activeTab.id;

    const allTabs = await api.tabs.query({});
    const fallback = allTabs.find(isUsableCloudTab);
    if (fallback) return fallback.id;

    const created = await api.tabs.create({ url: 'about:blank', active: true });
    if (created?.id == null) throw new Error('Could not create a browser tab for the cloud run.');
    if (startup) startup.createdTabId = created.id;
    return created.id;
  }

  async function getTabUrl(tabId) {
    try {
      return (await api.tabs.get(tabId))?.url || '';
    } catch {
      return '';
    }
  }

  // Kept out of the run object so a literal secret can never reach session
  // storage or a persistence row. Dropped when the run leaves the map.
  const strictSecretValues = new Map();
  const strictTraceValues = new Map();
  const strictSecretOverflowRuns = new Set();
  const privateRecipients = new Map();
  const privateStructuredResults = new Map();
  const strictTraceOverflowRuns = new Set();

  function rememberStrictCandidates(run, candidates, registry, overflowRuns) {
    if (!candidates.length) return;
    const known = registry.get(run.runId) || [];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const shortNumericSecret = /^\d{1,3}$/.test(candidate);
      if (candidate.length < CLOUD_STRICT_SECRET_MIN_LENGTH && !shortNumericSecret) continue;
      if (candidate.length > WORKFLOW_PARAMETER_VALUE_LIMIT) continue;
      if (known.includes(candidate)) continue;
      if (known.length >= CLOUD_STRICT_SECRET_VALUE_LIMIT) {
        // Never evict an earlier credential or trace-only URL and silently
        // expose it later. Losing free-text utility is preferable to leakage.
        overflowRuns.add(run.runId);
        break;
      }
      known.push(candidate);
    }
    if (known.length) registry.set(run.runId, known);
  }

  // Whatever a strict run types into a page is a value the caller must never
  // read back, wherever it later resurfaces — a clarification question, a
  // warning, a captcha diagnostic. Remember it here, before the redactors drop
  // the argument that carried it.
  function rememberStrictSecrets(run, type, data) {
    const name = String(data?.name || data?.tool || '');
    const candidates = [];
    const traceCandidates = [];
    if (type === 'tool_call') {
      const args = data?.args && typeof data.args === 'object' ? data.args : {};
      if (CLOUD_TEXT_ENTRY_TOOLS.has(name)) candidates.push(args.text, args.value);
      collectUrlSecretsFromNamedFields(args, candidates);
      collectUrlTraceStringsFromNamedFields(args, traceCandidates);
      // A credential does not have to be typed into a page to exist. The
      // disposable-signup scenario mints its account password inside the JSON
      // body of `POST /accounts` and never types it, so registering only
      // text-entry arguments left it unknown to the value redactor.
      collectSensitiveStrings(args, candidates);
      if (collectRequestBodySecrets(args.body, candidates)) {
        strictSecretOverflowRuns.add(run.runId);
      }
    } else if (type === 'tool_result') {
      // The value under a sensitive key is already known to be a secret; the
      // key-based scrubber only masks it in place, so register the literal and
      // strike it from later prose as well.
      //
      // Known limit: a secret the model only ever *reads* out of an
      // unremarkable field — an OTP in the body text of an inbox message — is
      // never seen here in a form this can recognize, so a clarification that
      // quotes it is covered by the strict system prompt alone. Closing that
      // would mean either blanking clarification text, which makes a strict run
      // unanswerable, or entropy guessing at prose.
      collectSensitiveStrings(data?.result, candidates);
      collectUrlSecretsFromNamedFields(data?.result, candidates);
      collectUrlTraceStringsFromNamedFields(data?.result, traceCandidates);
      if (name === 'verify_form') collectCredentialFieldValues(data?.result, candidates);
    }
    rememberStrictCandidates(run, candidates, strictSecretValues, strictSecretOverflowRuns);
    rememberStrictCandidates(run, traceCandidates, strictTraceValues, strictTraceOverflowRuns);
  }

  function redactStrictSecretValues(run, value, strictSecretMode) {
    if (!strictSecretMode) return value;
    if (strictSecretOverflowRuns.has(run.runId)) return redactStrictStructuredValues(value);
    const known = strictSecretValues.get(run.runId);
    if (!known?.length) return value;
    return redactWorkflowRuntimeValues(value, known, '[redacted strict value]');
  }

  function redactStrictTraceValues(run, value, strictSecretMode) {
    const withoutSecrets = redactStrictSecretValues(run, value, strictSecretMode);
    if (!strictSecretMode || strictSecretOverflowRuns.has(run.runId)) return withoutSecrets;
    if (strictTraceOverflowRuns.has(run.runId)) return redactStrictStructuredValues(withoutSecrets);
    const known = strictTraceValues.get(run.runId);
    if (!known?.length) return withoutSecrets;
    return redactWorkflowRuntimeValues(withoutSecrets, known, '[redacted strict URL]');
  }

  // Answers retain ordinary article links. Credentials remain value-redacted;
  // trace updates still withhold page URLs and arbitrary tool payloads.
  function redactStrictTerminal(run, value, strictSecretMode) {
    return redactStrictSecretValues(run, value, strictSecretMode);
  }

  const pendingActivity = new WeakMap();
  function pushUpdate(run, type, data, runtimeValues = []) {
    const memory = memoryConfigurations.get(run.runId);
    if (memory) data = redactBotMemoryValue(data, memory, { includeContext: true });
    run.updatedAt = isoNow();
    const previous = run.updates.at(-1);
    const strictSecretMode = privateRecipients.has(run.runId) || agent.strictSecretMode === true;
    if (strictSecretMode) rememberStrictSecrets(run, type, data);
    // Consecutive text_delta events upsert the same seq: content grows in place
    // and ts advances. Full-array pollers are fine; append-only / seq-cursor
    // clients must re-read that row (or take a full snapshot) rather than
    // assuming each seq is immutable.
    if (type === 'text_delta' && previous?.type === 'text_delta') {
      // Deltas must pass through the same redaction as any other update: this
      // branch used to append raw model output straight onto the stored row.
      const safeDelta = cloudSafeUpdateData(type, data, { strictSecretMode });
      previous.data = scrubCloudValue(redactStrictTraceValues(run, redactWorkflowRuntimeValues({
        ...previous.data,
        content: strictSecretMode
          ? (safeDelta?.content || '')
          : `${previous.data?.content || ''}${safeDelta?.content || ''}`,
      }, runtimeValues), strictSecretMode));
      previous.ts = run.updatedAt;
      schedulePersist();
      return;
    }
    run.nextUpdateSeq = (Number(run.nextUpdateSeq) || 0) + 1;
    const safeData = cloudSafeUpdateData(type, data, { strictSecretMode });
    const scrubbedData = scrubCloudValue(
      redactStrictTraceValues(run, redactWorkflowRuntimeValues(safeData, runtimeValues), strictSecretMode),
    );
    // A bare URL equals its origin, so the trace URL redactor also masks the
    // explicit origin metadata. Restore only that validated field, still passing
    // it through credential/workflow redaction and respecting overflow guards.
    if (strictSecretMode && type === 'tool_call' && safeData?.args?.url_origin
        && !strictTraceOverflowRuns.has(run.runId)) {
      const evidence = scrubCloudValue(redactStrictSecretValues(run,
        redactWorkflowRuntimeValues({ url_origin: safeData.args.url_origin }, runtimeValues), true));
      const origin = evidence?.url_origin;
      if (origin && origin === cloudUrlEvidence(origin).url_origin && scrubbedData?.args) {
        scrubbedData.args.url_origin = origin;
      }
    }
    // Correlate only an unambiguous request/return pair. Never guess when a
    // parallel batch has multiple outstanding calls of the same tool.
    if (['tool_call', 'tool_result'].includes(type) && scrubbedData?.name) {
      const pending = pendingActivity.get(run) || new Map();
      pendingActivity.set(run, pending);
      const calls = pending.get(scrubbedData.name) || [];
      if (type === 'tool_call') {
        calls.push({ seq: run.nextUpdateSeq, at: Date.parse(run.updatedAt), ambiguous: calls.length > 0 });
        if (calls.length > 1) calls.forEach(call => { call.ambiguous = true; });
        pending.set(scrubbedData.name, calls);
        scrubbedData.toolCallSeq = run.nextUpdateSeq;
      } else if (calls.length) {
        const call = calls.shift();
        if (!call.ambiguous) {
          scrubbedData.toolCallSeq = call.seq;
          scrubbedData.durationMs = Math.max(0, Date.parse(run.updatedAt) - call.at);
        }
        if (!calls.length) pending.delete(scrubbedData.name);
      }
    }
    run.updates.push({ seq: run.nextUpdateSeq, type, data: scrubbedData, ts: run.updatedAt });
    if (run.updates.length > CLOUD_UPDATE_LIMIT) {
      run.updates.splice(0, run.updates.length - CLOUD_UPDATE_LIMIT);
    }
    if (type === 'tool_result' && scrubbedData?.name === 'done_json') {
      const result = data.result || {};
      const safeResult = scrubbedData.result || {};
      // Two different jobs, so two different redactors. The update row above is
      // trace and persistence with no contract to honour, and takes the blunt
      // leaf-type redaction. `run.result` and `run.summary` are the caller's
      // answer — the schema they asked for — so they take value redaction:
      // registered credentials are struck and everything else the contract
      // declares survives. Redacting those by leaf type returned `completed`
      // with every string and number replaced by a placeholder, which satisfies
      // strict mode by making the run useless.
      const publicSummary = privateRecipients.has(run.runId) ? PRIVATE_RESULT_PLACEHOLDER : strictSecretMode
        ? redactStrictSecretValues(run, result.summary, true)
        : safeResult.summary;
      if (result.cloudFailed) {
        run.status = 'failed';
        run.error = safeResult.error || 'done_json failed';
        run.summary = publicSummary || run.summary;
      } else if (Object.prototype.hasOwnProperty.call(result, 'cloudResult')) {
        if (privateRecipients.has(run.runId)) privateStructuredResults.set(run.runId, structuredClone(result.cloudResult));
        run.result = privateRecipients.has(run.runId) ? PRIVATE_RESULT_PLACEHOLDER : strictSecretMode
          ? redactStrictSecretValues(run, result.cloudResult, true)
          : result.cloudResult;
        run.summary = publicSummary || run.summary;
      }
    }
    if (type === 'tool_result' && ['done', 'done_json'].includes(data?.name)) {
      const outcome = data?.result?.outcome;
      if (['partial', 'failed', 'blocked'].includes(outcome)) {
        run.agentOutcome = outcome;
        run.agentDoneSuccess = false;
      } else if (outcome === 'success') {
        // An explicit successful done wins over recovery trace statuses below.
        run.agentOutcome = 'done';
        run.agentDoneSuccess = true;
      }
    }
    if (type === 'run_status' && data?.status) {
      if (run.agentDoneSuccess !== true) run.agentOutcome = data.status;
      else if (data.status === 'done') run.agentOutcome = 'done';
    }
    if (type === 'captcha_gate') {
      // Keep the latest sanitized frame/vendor snapshot at run level so it
      // survives the rolling 200-update window in exported cloud traces.
      run.captchaDiagnostics = { ...scrubbedData, observedAt: run.updatedAt };
    }
    if (type === 'clarify' && scrubbedData?.clarifyId
        && ['running', 'needs_user_input', 'pausing', 'paused', 'resuming'].includes(run.status)) {
      if (!run.handoff) run.status = 'needs_user_input';
      run.pendingInput = scrubbedData;
    }
    if (type === 'clarify_timeout_extended' && scrubbedData?.clarifyId
        && (run.pendingInput?.clarifyId || run.pendingInput?.clarify_id) === scrubbedData.clarifyId
        && run.status === 'needs_user_input' && Number(scrubbedData.deadlineTs) > 0) {
      run.pendingInput = { ...run.pendingInput, deadlineTs: Number(scrubbedData.deadlineTs) };
    }
    if (type === 'clarify_auto' && scrubbedData?.clarifyId
        && (run.pendingInput?.clarifyId || run.pendingInput?.clarify_id) === scrubbedData.clarifyId
        && (run.status === 'needs_user_input' || run.handoff)) {
      if (!run.handoff) run.status = 'running';
      run.pendingInput = null;
    }
    if (type === 'run_status'
        && ['clarification_required', 'captcha_manual_required'].includes(scrubbedData?.status)
        && run.status !== 'aborting'
        && run.status !== 'aborted') {
      run.status = 'failed';
      run.error = scrubbedData.message
        || (scrubbedData.status === 'captcha_manual_required'
          ? 'Cloud run stopped because manual CAPTCHA completion is required.'
          : 'Cloud run stopped because explicit clarification authorization is required.');
      run.pendingInput = null;
    }
    if (type === 'plan_review' && run.status === 'running') {
      run.status = 'failed';
      run.error = 'Managed cloud runs cannot wait for interactive plan review.';
      agent.abort(run.tabId);
    }
    schedulePersist();
  }

  function validateWorkflowParameters(workflow, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw cloudRunError('`parameters` must be an object.', 400);
    }
    const descriptors = new Map((workflow.parameters || []).map(parameter => [parameter.id, parameter]));
    const parameters = Object.create(null);
    for (const [id, value] of Object.entries(input)) {
      if (!descriptors.has(id)) throw cloudRunError(`Unknown workflow parameter: ${id}`, 400);
      if (typeof value !== 'string') throw cloudRunError(`Workflow parameter ${id} must be a string.`, 400);
      if (value.length > WORKFLOW_PARAMETER_VALUE_LIMIT) {
        throw cloudRunError(`Workflow parameter ${id} exceeds ${WORKFLOW_PARAMETER_VALUE_LIMIT} characters.`, 400);
      }
      parameters[id] = value;
    }
    for (const descriptor of descriptors.values()) {
      if (descriptor.required !== false && !Object.hasOwn(parameters, descriptor.id)) {
        throw cloudRunError(`Missing workflow parameter: ${descriptor.id}`, 400);
      }
    }
    return parameters;
  }

  function activeHandoff() {
    return [...runs.values()].find(run => run.handoff && !TERMINAL_STATUSES.has(run.status));
  }

  function assertNoHandoff() {
    if (durableHandoffGuards.size || activeHandoff()) {
      throw cloudRunError('Browser control belongs to an active handoff. Return control or explicitly reconcile the interrupted run before starting another task.', 409);
    }
  }

  async function startRun(msg = {}) {
    // Reserve startup before its first await, including model/memory lookup
    // and helper-tab creation. Handoff cannot grant control during this work.
    pendingStarts++;
    try { return await startRunWithReservation(msg); }
    finally { pendingStarts--; }
  }

  async function startRunWithReservation(msg = {}) {
    const taskMemory = normalizeCloudTaskMemory(msg);
    if (taskMemory && msg._workflow) throw cloudRunError('Memory-protected tasks require ordinary guarded browser execution.', 409);
    const memoryOwner = await cloudMemoryOwner(taskMemory);
    const key = msg.conversationKey ?? msg.conversation_key;
    if (key != null && startingConversations.has(key)) throw cloudRunError('Conversation is already starting.', 409);
    if (key != null) startingConversations.add(key);
    const startup = { createdTabId: null };
    try { return await startRunReserved(msg, startup, taskMemory, memoryOwner); }
    catch (error) {
      // A rejected start has no run owner to clean up a newly created helper.
      // Track creation explicitly so borrowed user/conversation tabs survive.
      if (startup.createdTabId != null && !startingTabs.has(startup.createdTabId)
          && !agent.isRunning(startup.createdTabId)) {
        startingTabs.add(startup.createdTabId);
        try { await api.tabs.remove(startup.createdTabId); } catch { /* already closed */ }
        finally { startingTabs.delete(startup.createdTabId); }
      }
      if (taskMemory) {
        // Rebuild the error: changing message alone leaves its original stack
        // and extra fields available to background diagnostics.
        const safe = cloudRunError(redactBotMemoryValue(error?.message || String(error), taskMemory, { includeContext: true }), error?.status);
        if (typeof error?.code === 'string') safe.code = redactBotMemoryValue(error.code, taskMemory);
        throw safe;
      }
      throw error;
    }
    finally { if (key != null) startingConversations.delete(key); }
  }

  async function startRunReserved(msg = {}, startup = null, taskMemory = null, memoryOwner = null) {
    await hydrate();
    assertNoHandoff();
    const recipient = msg.private_result_public_key == null
      ? null : await importPrivateResultRecipient(msg.private_result_public_key);
    const suppliedRunId = msg.runId ?? msg.run_id;
    const requestedRunId = suppliedRunId == null ? '' : String(suppliedRunId).trim();
    if (requestedRunId.length > CLOUD_STRING_LIMIT) throw cloudRunError('Cloud run ID exceeds the supported length.', 400);
    const parentRunId = String(msg.parentRunId || msg.parent_run_id || '').trim() || null;
    const savedParent = parentRunId ? runs.get(parentRunId) : null;
    if (parentRunId) assertMemoryContinuation(savedParent, memoryOwner);
    const providerId = msg.providerId ?? msg.provider_id ?? savedParent?.providerId ?? null;
    const expectedModel = msg.expectedModel ?? msg.expected_model ?? savedParent?.expectedModel ?? null;
    if (providerId != null || expectedModel != null) {
      if (msg._workflow || typeof providerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(providerId)
          || typeof expectedModel !== 'string' || !expectedModel.trim() || expectedModel.length > 256) {
        throw cloudRunError('Per-run model selection requires provider_id and expected_model.', 400);
      }
      let provider;
      try { provider = agent.providerManager?.getProvider?.(providerId); } catch { /* reject missing providers below */ }
      if (!provider || provider.model !== expectedModel) {
        throw cloudRunError('The configured browser model is missing or changed. Reconfigure this browser before running the task.', 409);
      }
      if (savedParent?.providerId && (providerId !== savedParent.providerId || expectedModel !== savedParent.expectedModel)) {
        throw cloudRunError('A continuation must use its parent run model.', 409);
      }
    }
    let parentRun = null;
    let requestedTabId = msg.tabId ?? msg.tab_id;
    const conversationKey = msg.conversationKey ?? msg.conversation_key ?? null;
    if (conversationKey != null && (
      typeof conversationKey !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(conversationKey)
      || parentRunId || requestedTabId != null || msg._workflow
    )) throw cloudRunError('conversation_key requires a UUID and an independent run without an explicit tab.', 400);
    if (conversationKey) {
      // Each caller-owned task/chat gets its own tab in the same browser profile.
      // A fresh root resets only its own conversation; child messages retain it.
      const previous = [...runs.values()].filter(run => run.conversationKey === conversationKey)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if (previous) assertMemoryContinuation(previous, memoryOwner);
      let tab = previous ? await api.tabs.get(previous.tabId).catch(() => null) : null;
      if (!isUsableCloudTab(tab)) {
        tab = await api.tabs.create({ url: 'about:blank', active: true });
        if (startup && tab?.id != null) startup.createdTabId = tab.id;
      }
      if (tab?.id == null) throw cloudRunError('Could not create a conversation tab.', 500);
      requestedTabId = tab.id;
    }
    if (parentRunId) {
      parentRun = runs.get(parentRunId) || null;
      if (parentRun) {
        if (!TERMINAL_STATUSES.has(parentRun.status)) {
          throw cloudRunError('Parent cloud run must be finished before it can be continued.', 409);
        }
        const existingChild = [...runs.values()].find(candidate => candidate.parentRunId === parentRunId);
        if (existingChild) {
          throw cloudRunError(`Cloud run has already been continued as ${existingChild.runId}.`, 409);
        }
        requestedTabId = parentRun.tabId;
      } else if (requestedTabId == null || requestedTabId === '') {
        throw cloudRunError('Parent cloud run is no longer available and has no saved tab.', 409);
      }
    }
    const tabId = await resolveTabId(requestedTabId, startup);
    const workflow = msg._workflow || null;
    const mode = workflow ? 'act' : normalizeCloudRunMode(msg.mode, parentRun?.mode || 'act');
    const workflowParameters = msg._workflowParameters || {};
    const workflowParameterValues = workflow ? Object.values(workflowParameters) : [];
    const redactWorkflowValue = value => {
      const redacted = redactWorkflowRuntimeValues(value, workflowParameterValues);
      return taskMemory ? redactBotMemoryValue(redacted, taskMemory, { includeContext: true }) : redacted;
    };
    const task = workflow
      ? `Run saved workflow: ${workflow.name}`
      : String(msg.task || msg.text || '').trim();
    if (!task) throw new Error('cloud_run requires `task`.');
    if (startingTabs.has(tabId) || agent.isRunning(tabId)) {
      throw cloudRunError('This browser tab is busy with another run. Wait for it to finish.', 409);
    }

    const apiMutationsAllowed = msg.apiMutationsAllowed === true || msg.api_mutations_allowed === true;
    if (apiMutationsAllowed && mode !== 'act') {
      throw cloudRunError('API mutation permission requires cloud_run mode `act`.', 400);
    }
    // The default-on persistent setting alone can still ask per site, so a
    // run that names API mutations adds its own grant unless one already
    // waives that prompt.
    const grantApiMutationsForRun = apiMutationsAllowed
      && agent.isApiMutationPromptWaived?.(tabId) !== true;
    const outputSchema = workflow
      ? null
      : msg.outputSchema ?? msg.output_schema ?? msg.responseFormat?.schema ?? msg.response_format?.schema ?? null;
    const structured = hasCloudOutputSchema(outputSchema);
    const runId = requestedRunId || String(makeRunId());
    // Cloud-assigned IDs are valid correlation keys, but they must not replace
    // an active or persisted run. Besides losing the older run from status
    // queries, replacement aliases both runs' strict-secret registries; the
    // first run to finish would then clear the second run's redaction state.
    if (runs.has(runId) || startingRunIds.has(runId)) {
      throw cloudRunError(`Cloud run ${runId} already exists.`, 409);
    }
    // Distinct tabs can reach the awaited startup checks concurrently. Reserve
    // the caller ID before yielding so both cannot claim the same run record.
    startingRunIds.add(runId);
    startingTabs.add(tabId);
    try {
      await agent.assertRunStartAllowed?.(tabId, 'cloud', { cloudRun: true });
      if (conversationKey) await agent.clearConversation(tabId);
      const targetTab = await api.tabs.get(tabId);
      await activateTab(targetTab);
      assertNoHandoff();
    } catch (error) {
      startingTabs.delete(tabId);
      startingRunIds.delete(runId);
      throw error;
    }
    const createdAt = isoNow();
    const run = {
      runId,
      conversationKey: conversationKey || parentRun?.conversationKey || null,
      providerId,
      expectedModel,
      memoryProtected: !!taskMemory,
      memoryOwner,
      status: 'running',
      workflowId: workflow?.id || null,
      traceRunId: null,
      parentRunId,
      mode,
      tabId,
      task: redactWorkflowValue(task),
      structured,
      outputSchema: redactWorkflowValue(outputSchema),
      capture: msg.capture === 'video' ? 'video' : 'none',
      result: undefined,
      summary: '',
      content: '',
      finalUrl: '',
      error: '',
      pendingInput: null,
      updates: [],
      nextUpdateSeq: 0,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    };
    const handoffGate = new CloudHandoffGate({
      async onState(state) {
        const checkpoint = async options => {
          try { await persist(options); } catch (error) {
            // An abort may close the gate while this write is pending. Keep
            // cancellation pending until cleanup; never resurrect its pause.
            if (!handoffGate.closed && !cancelled()) {
              run.status = 'paused';
              run.handoff = { state: 'paused', resumable: false, interrupted: true };
              run.error = 'Browser handoff could not be saved safely. Keep the browser read-only and explicitly stop this run.';
              pushUpdate(run, 'handoff', run.handoff);
            }
            throw error;
          }
        };
        if (state === 'running') {
          await checkpoint({ clearHandoffRunId: run.runId });
          if (handoffGate.closed || cancelled()) return;
          run.handoff = null;
          run.status = run.pendingInput ? 'needs_user_input' : 'running';
        } else {
          if (handoffGate.closed || cancelled()) return;
          // Guard ownership from the pause request onwards. Neither polling
          // nor streaming may see writable paused state before this write.
          durableHandoffGuards.set(run.runId, normalizeCloudHandoffGuard({
            runId: run.runId, tabId: run.tabId, createdAt: run.createdAt, updatedAt: isoNow(),
            pausedAt: state === 'paused' ? isoNow() : run.handoff?.pausedAt || null,
          }));
          await checkpoint();
          if (handoffGate.closed || cancelled()) return;
          run.status = state;
          run.handoff = { state, resumable: true, interrupted: false,
            ...(state === 'paused' ? { pausedAt: isoNow() } : run.handoff?.pausedAt ? { pausedAt: run.handoff.pausedAt } : {}) };
        }
        run.updatedAt = isoNow();
        pushUpdate(run, 'handoff', run.handoff || { state: null });
        await checkpoint();
      },
      keepAlive() {
        const ping = () => { try { const p = api.runtime?.getPlatformInfo?.(() => { void api.runtime.lastError; }); p?.catch?.(() => {}); } catch {} };
        ping();
        const timer = setInterval(ping, 20000);
        timer?.unref?.();
        return () => clearInterval(timer);
      },
    });
    handoffGates.set(run.runId, handoffGate);
    runs.set(run.runId, run);
    if (taskMemory) memoryConfigurations.set(run.runId, taskMemory);
    startingRunIds.delete(runId);
    if (recipient) privateRecipients.set(run.runId, recipient);
    const runController = new AbortController();
    runAbortControllers.set(runId, runController);
    const cancelled = () => runController.signal.aborted;
    const checkCancellation = () => {
      if (cancelled()) throw new Error('Abort requested.');
    };
    const cancellationOptions = {
      signal: runController.signal,
      isDetachedStartCancelled: cancelled,
    };
    try {
      await persist();
    } catch (error) {
      runs.delete(run.runId);
      runAbortControllers.delete(runId);
      handoffGate.close();
      handoffGates.delete(run.runId);
      privateRecipients.delete(run.runId);
      memoryConfigurations.delete(run.runId);
      startingTabs.delete(tabId);
      throw error;
    }

    activeExecutions.add(run.runId);
    (async () => {
      let recordingId = null;
      const strictSecretMode = !!recipient || agent.strictSecretMode === true;
      try {
        // A continuation starts only after its parent has finished, so the
        // agent's active-run map cannot identify the parent here. The cloud
        // run record keeps the actual trace id; resolve its session from that
        // trace instead of attaching the tab's potentially unrelated session.
        let parentTraceRunId = parentRun?.traceRunId || null;
        let parentTraceSessionId = null;
        if (parentTraceRunId && typeof workflowTrace?.getRun === 'function') {
          try {
            const parentTrace = await workflowTrace.getRun(parentTraceRunId);
            parentTraceSessionId = parentTrace?.conversationId || null;
          } catch { /* lineage lookup is best-effort and must not fail a run */ }
        }
        checkCancellation();
        if (run.capture === 'video') {
          try {
            if (!startRecording || !stopRecording) throw new Error('Cloud run video capture is unavailable.');
            const recording = await startRecording(tabId, {
              video: true,
              mic: false,
              showBanner: false,
              filename: `webbrain-ci-${run.runId}.webm`,
            });
            if (!recording?.ok) throw new Error(recording?.error || 'Cloud run video capture could not start.');
            recordingId = recording.state?.recordingId || null;
          } catch (captureError) {
            pushUpdate(run, 'capture_error', {
              kind: 'video',
              message: captureError?.message || String(captureError),
            });
            throw captureError;
          }
          pushUpdate(run, 'artifact_started', {
            kind: 'video',
            filename: `webbrain-ci-${run.runId}.webm`,
          });
        }
        checkCancellation();
        if (grantApiMutationsForRun) agent.setTemporaryApiMutationsAllowed(tabId, true);
        sendIndicator(tabId, 'WB_SHOW_AGENT_INDICATORS');
        const publishUpdate = (type, data) => {
          if (taskMemory && memoryConfigurations.get(run.runId) !== taskMemory) return;
          pushUpdate(run, type, workflow && type === 'text_delta'
            ? { ...(data || {}), content: '[workflow output redacted]' } : data, workflowParameterValues);
        };
        let content;
        if (workflow) {
          const replay = await agent.replaySavedWorkflow(
            tabId,
            workflow,
            workflowParameters,
            publishUpdate,
            { cloudRun: true, independentRun: true, ...cancellationOptions },
          );
          content = redactWorkflowValue(replay.summary || '');
          run.summary = redactWorkflowValue(replay.summary || run.summary);
          if (replay.status === 'fallback') {
            checkCancellation();
            pushUpdate(run, 'workflow_fallback', {
              workflowId: workflow.id,
              stepIndex: replay.stepIndex,
              reason: replay.reason,
            });
            content = redactWorkflowValue(await agent.processMessage(
              tabId, replay.prompt, publishUpdate, 'act', [], {
                cloudRun: true,
                independentRun: true,
                preserveRichTextToolbarAudit: true,
                ...cancellationOptions,
              },
            ));
          } else if (replay.status === 'stopped') {
            run.status = 'failed';
            run.error = redactWorkflowValue(
              replay.summary || replay.reason || 'Saved workflow stopped safely.'
            );
          }
        } else {
          let prompt = task;
          let continuation = false;
          let resumeCount = 0;
          do {
            checkCancellation();
            let requestedResume = null;
            run.agentOutcome = null;
            run.agentDoneSuccess = false;
            content = await agent.processMessage(tabId, prompt, publishUpdate, mode, [], {
              cloudRun: true,
              handoffBoundary: async () => {
                if (handoffGate.state === 'pausing' && typeof agent._persistNow === 'function') {
                  const saved = await agent._persistNow(tabId);
                  if (saved?.ok !== true) throw new Error('The current browser state could not be saved for safe handoff.');
                }
                return handoffGate.boundary();
              },
              handoffObserved: () => handoffGate.observed(),
              privateFinalResult: !!recipient,
              ...(taskMemory ? { taskMemory } : {}),
              ...(providerId == null ? {} : { providerId }),
              independentRun: !continuation,
              trustedContinuation: continuation,
              scheduledResume: continuation,
              ...cancellationOptions,
              apiMutationsDenied: mode === 'ask',
              outputSchema,
              deferResume(args) {
                if (resumeCount >= 3) return { success: false, dispatched: false, noDispatch: true,
                  error: 'Cloud continuation limit reached. Return an honest partial or failed outcome.' };
                const parsed = validateResumeArgs(args, now().getTime());
                if (!parsed.ok) return { success: false, dispatched: false, noDispatch: true, error: parsed.error };
                if (parsed.scheduledAtMs - now().getTime() > CLOUD_RESUME_MAX_DELAY_MS) {
                  return { success: false, dispatched: false, noDispatch: true,
                    error: `Cloud continuations support delays up to ${CLOUD_RESUME_MAX_DELAY_LABEL}. Return an honest partial or failed outcome.` };
                }
                // No browser-native alarm: it would run outside this Cloud handle,
                // releasing the workspace lock and allowing the profile to pause.
                requestedResume = parsed;
                return { success: true, scheduled: true, done: true, jobId: run.runId,
                  scheduledAt: parsed.scheduledAt, summary: `Scheduled a resume for ${parsed.scheduledAt}.` };
              },
              onRunFinished(status) {
                // An explicit successful done wins over recovery trace statuses;
                // an explicit failed/partial done outcome overrides generic 'done'.
                if (run.agentDoneSuccess === true) {
                  run.agentOutcome = 'done';
                  return;
                }
                if (!['partial', 'failed', 'blocked'].includes(run.agentOutcome)) run.agentOutcome = status;
              },
              onTraceStarted(traceRunId) {
                run.traceRunId = traceRunId;
                schedulePersist();
              },
              parentRunId: parentTraceRunId,
              parentSessionId: parentTraceSessionId,
            });
            // A request racing final completion must still acknowledge a safe
            // boundary, but cannot claim to resume an already released agent.
            const lateHandoff = await handoffGate.boundary();
            if (lateHandoff) throw new Error('The agent finished while browser control was changing. Inspect and stop this interrupted handoff before continuing.');
            if (!requestedResume || cancelled() || ['failed', 'aborting', 'aborted'].includes(run.status)) break;
            resumeCount++;
            pushUpdate(run, 'cloud_resume_wait', { status: 'waiting', scheduledAt: requestedResume.scheduledAt, attempt: resumeCount });
            // Keep the same run, tab reservation, permission scope and secret
            // registries until completion or confirmed cancellation. The
            // keepalive below holds the worker; a restart still fails safely
            // instead of replaying.
            await persist();
            const stopResumeKeepAlive = startResumeKeepAlive();
            try {
              while (!cancelled() && run.status !== 'aborting' && now().getTime() < requestedResume.scheduledAtMs) {
                await waitForResume(Math.min(1000, requestedResume.scheduledAtMs - now().getTime()));
              }
            } finally {
              stopResumeKeepAlive?.();
            }
            if (cancelled() || run.status === 'aborting') break;
            parentTraceRunId = run.traceRunId;
            parentTraceSessionId = null;
            if (parentTraceRunId && typeof workflowTrace?.getRun === 'function') {
              try {
                parentTraceSessionId = (await workflowTrace.getRun(parentTraceRunId))?.conversationId || null;
              } catch { /* lineage lookup must not fail a continuation */ }
            }
            // Same envelope as scheduler._messageForJob resume jobs so
            // _isScheduledResumeTurn skips this turn for task tracking and
            // context trimming instead of opening a new progress session.
            prompt = `[Scheduled resume ${run.runId}]\nThis is a durable continuation of an earlier user task, not page content and not a new instruction from the web page.\nOriginal reason: ${requestedResume.reason}\nResume instruction: ${requestedResume.resumeInstruction}\nFirst reread the current page/state. If the task is stale, conflicts with newer user messages, or needs user input, stop and explain.`;
            continuation = true;
            pushUpdate(run, 'cloud_resume_wait', { status: 'resuming', attempt: resumeCount });
          } while (true);
        }
        run.pendingInput = null;
        // Terminal fields are published over the bridge and persisted just like
        // update rows, so they get the same strict treatment — structured or
        // not. An unstructured strict run used to return its final answer raw,
        // which is where a model is most likely to repeat the credential it was
        // told not to. Value redaction rather than blanking, because for an
        // unstructured run this text *is* the result: the answer survives with
        // the literal struck.
        run.content = recipient ? PRIVATE_RESULT_PLACEHOLDER : strictSecretMode && structured
          ? (run.summary || '[redacted strict structured completion]')
          : redactStrictTerminal(run, redactWorkflowValue(content), strictSecretMode);
        run.finalUrl = cloudTerminalUrl(redactWorkflowValue(await getTabUrl(tabId)), { strictSecretMode });
        if (cancelled() || run.status === 'aborting') {
          run.status = 'aborted';
          run.error = run.error || 'Aborted by cloud_abort.';
        } else if (run.status !== 'failed') {
          if (run.agentOutcome && run.agentOutcome !== 'done') {
            run.status = run.agentOutcome === 'cancelled' ? 'aborted' : 'failed';
            run.error = `Browser task did not finish successfully (${run.agentOutcome}). Review the returned result before retrying.`;
            if (!structured) run.result = run.content;
          } else if (structured && run.result === undefined) {
            run.status = 'failed';
            run.error = 'Structured cloud run finished without a valid done_json result.';
          } else {
            run.status = 'completed';
            if (!structured) {
              run.result = redactStrictTerminal(run, redactWorkflowValue(content), strictSecretMode);
            }
          }
        }
        if (recipient && run.status !== 'aborted') {
          const raw = structured ? privateStructuredResults.get(run.runId) : content;
          if (raw !== undefined) {
            // Encryption is asynchronous. Pollers must not observe completion
            // until the encrypted result is ready, or release the browser lock.
            const terminalStatus = run.status;
            run.status = 'running';
            const privateResult = await encryptPrivateResult(recipient, run.runId, redactWorkflowValue(raw));
            if (run.status === 'aborting') {
              run.status = 'aborted';
              run.error = run.error || 'Aborted by cloud_abort.';
            } else {
              run.summary = PRIVATE_RESULT_PLACEHOLDER;
              run.result = { type: PRIVATE_RESULT_TYPE, public_result: PRIVATE_RESULT_PLACEHOLDER,
                private_result: privateResult };
              run.status = terminalStatus;
            }
          }
        }
      } catch (error) {
        run.pendingInput = null;
        run.status = cancelled() || run.status === 'aborting' ? 'aborted' : 'failed';
        run.error = recipient ? 'Private Cloud run failed before delivering its encrypted final answer. Review the redacted trace before retrying.' : redactStrictTerminal(
          run, redactWorkflowValue(error?.message || String(error)), strictSecretMode,
        );
        run.finalUrl = cloudTerminalUrl(redactWorkflowValue(await getTabUrl(tabId)), { strictSecretMode });
      } finally {
        handoffGate.close();
        handoffGates.delete(run.runId);
        if (run.handoff && run.status !== 'aborting' && run.status !== 'aborted') {
          run.status = 'paused';
          run.handoff = { ...run.handoff, state: 'paused', resumable: false, interrupted: true };
          pushUpdate(run, 'handoff', run.handoff);
        }
        privateRecipients.delete(run.runId);
        privateStructuredResults.delete(run.runId);
        // The bridge flag is a run-scoped grant, not the sidebar's persistent
        // /allow-api setting. Revoke only permission this run added; preserve a
        // pre-existing per-conversation or global user grant.
        if (grantApiMutationsForRun) agent.setTemporaryApiMutationsAllowed(tabId, false);

        // Do not expose a terminal status until the requested recording has
        // finished flushing to Downloads; pollers use terminality as the cue
        // that traces and artifacts are complete.
        const terminalStatus = recordingId && TERMINAL_STATUSES.has(run.status)
          ? run.status
          : null;
        if (terminalStatus) run.status = 'running';
        if (recordingId) {
          try {
            const capture = await stopRecording({ expectedRecordingId: recordingId });
            if (!capture?.ok) throw new Error(capture?.error || 'Cloud run video capture could not stop.');
            pushUpdate(run, 'artifact', {
              kind: 'video',
              filename: capture.filename || `webbrain-ci-${run.runId}.webm`,
            });
          } catch (captureError) {
            pushUpdate(run, 'capture_error', {
              kind: 'video',
              message: captureError?.message || String(captureError),
            });
          }
        }
        if (cancelled()) run.status = 'aborted';
        else if (terminalStatus) run.status = terminalStatus;
        runAbortControllers.delete(runId);
        run.completedAt = run.handoff ? null : isoNow();
        run.updatedAt = isoNow();
        // The run is over, so nothing more can quote these; do not hold the
        // literals in memory any longer than the run that typed them.
        strictSecretValues.delete(run.runId);
        strictTraceValues.delete(run.runId);
        strictSecretOverflowRuns.delete(run.runId);
        strictTraceOverflowRuns.delete(run.runId);
        memoryConfigurations.delete(run.runId);
        activeExecutions.delete(run.runId);
        if (run.status === 'aborted' && durableHandoffGuards.has(run.runId)) {
          // The handler and recording cleanup have settled. Clear the durable
          // reservation before publicly acknowledging terminal cancellation.
          run.status = 'aborting';
          run.completedAt = null;
          try {
            await persist({ clearHandoffRunId: run.runId });
            run.status = 'aborted';
            run.completedAt = isoNow();
          } catch {
            run.status = 'paused';
            run.handoff = { state: 'paused', resumable: false, interrupted: true };
            run.error = 'Browser handoff cancellation could not be saved. Keep the browser read-only and explicitly stop this run again.';
            pushUpdate(run, 'handoff', run.handoff);
          }
        }
        sendIndicator(tabId, 'WB_HIDE_AGENT_INDICATORS');
        // Recording flush is still owned by this run. Keep the tab reserved
        // through all cleanup so aborting a nonterminal capture cannot cancel
        // a replacement run or hide its indicators.
        if (!run.handoff) startingTabs.delete(tabId);
        await persist().catch(() => {});
      }
    })();

    return snapshot(run, { includeUpdates: false });
  }

  async function startWorkflowRun(msg = {}) {
    const workflow = normalizeSavedWorkflow(msg.workflow);
    if (!workflow) throw cloudRunError('Saved workflow is missing or invalid.', 400);
    if (msg.parentRunId || msg.parent_run_id) {
      throw cloudRunError('Saved workflow runs cannot be continuations.', 400);
    }
    const parameters = validateWorkflowParameters(
      workflow,
      msg.parameters ?? {},
    );
    return startRun({
      ...msg,
      task: '',
      text: '',
      outputSchema: null,
      output_schema: null,
      _workflow: workflow,
      _workflowParameters: parameters,
    });
  }

  async function compileWorkflow(msg = {}) {
    await hydrate();
    const runId = String(msg.runId || msg.run_id || '').trim();
    const name = String(msg.name || '').trim();
    if (!runId) return { ok: false, status: 400, reason: 'run_required', warnings: [] };
    if (!name) return { ok: false, status: 400, reason: 'name_required', warnings: [] };
    const run = runs.get(runId);
    if (!run) return { ok: false, status: 404, reason: 'run_not_found', warnings: [] };
    if (run.workflowId) {
      return { ok: false, status: 422, reason: 'workflow_run_not_compilable', warnings: [] };
    }
    if (run.memoryProtected) {
      return { ok: false, status: 409, reason: 'memory_protected_workflow_unsupported', warnings: [] };
    }
    if (run.status !== 'completed') {
      return { ok: false, status: 409, reason: 'successful_run_required', warnings: [] };
    }
    if (!run.traceRunId || !workflowTrace) {
      return { ok: false, status: 409, reason: 'trace_unavailable', warnings: [] };
    }
    const draft = typeof agent.getLatestWorkflowDraft === 'function'
      ? await agent.getLatestWorkflowDraft(run.tabId)
      : null;
    let compiled = draft?.sourceRunId === run.traceRunId
      ? finalizeSavedWorkflowDraft(draft, { name })
      : null;
    if (!compiled) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        compiled = await compileSuccessfulWorkflowByRunId(workflowTrace, {
          runId: run.traceRunId,
          name,
        });
        if (compiled.workflow || compiled.reason !== 'successful_run_required') break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (!compiled?.workflow) {
      return {
        ok: false,
        status: compiled?.reason === 'no_replayable_steps' ? 422 : 409,
        reason: compiled?.reason || 'workflow_compilation_failed',
        warnings: compiled?.warnings || [],
      };
    }
    return { ok: true, workflow: compiled.workflow, warnings: compiled.warnings || [] };
  }

  async function status(msg = {}) {
    await hydrate();
    // Pause acknowledgement is externally visible only after its checkpoint
    // has finished writing; a poll cannot race a pending storage write.
    await persistQueue;
    const runId = msg.runId || msg.run_id;
    if (!runId) return { runs: [...runs.values()].map(run => snapshot(run, { includeUpdates: false })) };
    const run = runs.get(runId);
    if (!run) throw new Error('Unknown cloud run.');
    return snapshot(run);
  }

  async function abort(msg = {}) {
    await hydrate();
    const run = runs.get(msg.runId || msg.run_id);
    if (!run) throw new Error('Unknown cloud run.');
    if (run.handoff?.interrupted && !activeExecutions.has(run.runId)) {
      await persist({ clearHandoffRunId: run.runId });
      run.status = 'aborted';
      run.handoff = null;
      pushUpdate(run, 'handoff', { state: null });
      run.pendingInput = null;
      run.completedAt = isoNow();
      run.updatedAt = run.completedAt;
      run.error = 'Interrupted handoff stopped explicitly. Inspect the browser before starting a new task.';
      startingTabs.delete(run.tabId);
      await persist();
    } else if (['running', 'needs_user_input', 'pausing', 'paused', 'resuming'].includes(run.status)) {
      run.status = 'aborting';
      run.handoff = null;
      handoffGates.get(run.runId)?.close();
      run.pendingInput = null;
      run.error = 'Abort requested.';
      run.updatedAt = isoNow();
      runAbortControllers.get(run.runId)?.abort();
      agent.abort(run.tabId);
      await persist();
    } else if (run.status === 'aborted') await persist();
    return snapshot(run);
  }

  async function pause(msg = {}) {
    await hydrate();
    await persistQueue;
    const run = runs.get(msg.runId || msg.run_id);
    if (!run) throw cloudRunError('Unknown cloud run.', 404);
    if (run.workflowId) throw cloudRunError('Saved workflow replay does not support browser handoff.', 409);
    if (run.handoff) {
      // A duplicate pause must not expose a checkpoint still being written.
      await persistQueue;
      return snapshot(run);
    }
    if (!['running', 'needs_user_input'].includes(run.status)) throw cloudRunError('Only a running browser task can be paused.', 409);
    if (pendingStarts || [...runs.values()].some(other => other !== run && !TERMINAL_STATUSES.has(other.status))
        || agent.hasOtherRunningTabs?.(run.tabId)) {
      throw cloudRunError('Another agent is running or starting in this browser. Wait for it to finish before taking control.', 409);
    }
    const waitingClarification = run.status === 'needs_user_input' && !!run.pendingInput;
    if (waitingClarification && agent.canPauseAtClarification?.(run.tabId,
        run.pendingInput.clarifyId || run.pendingInput.clarify_id) !== true) {
      throw cloudRunError('Answer the pending action approval before taking control; its browser action has not settled yet.', 409);
    }
    const gate = handoffGates.get(run.runId);
    if (!gate) throw cloudRunError('The active browser run is unavailable for handoff.', 409);
    await gate.request();
    if (waitingClarification) {
      // Only standalone clarify() is a safe wait; internal action approvals
      // may continue a page mutation before the next tool boundary.
      // Keep its question pending; handback is not a clarification response.
      if (typeof agent._persistNow === 'function') {
        const saved = await agent._persistNow(run.tabId);
        if (saved?.ok !== true) throw cloudRunError('The clarification state could not be saved for safe handoff.', 409);
      }
      await gate.acknowledge();
    }
    return snapshot(run);
  }

  async function resume(msg = {}) {
    await hydrate();
    await persistQueue;
    const run = runs.get(msg.runId || msg.run_id);
    if (!run) throw cloudRunError('Unknown cloud run.', 404);
    if (run.status !== 'paused' || run.handoff?.state !== 'paused' || !run.handoff.resumable || run.handoff.interrupted) {
      throw cloudRunError('This handoff was interrupted. Inspect the browser and explicitly stop the interrupted run; it cannot safely resume.', 409);
    }
    if (typeof (msg.note ?? '') !== 'string' || (msg.note || '').length > 2000) throw cloudRunError('The handoff note must be text of at most 2000 characters.', 400);
    const gate = handoffGates.get(run.runId);
    if (!gate) throw cloudRunError('The browser handoff is no longer resumable.', 409);
    await gate.resume((msg.note || '').trim());
    return snapshot(run);
  }

  async function respond(msg = {}) {
    await hydrate();
    const run = runs.get(msg.runId || msg.run_id);
    if (!run) throw cloudRunError('Unknown cloud run.', 404);
    if (run.status !== 'needs_user_input' && !(run.status === 'resuming' && run.pendingInput)) {
      throw cloudRunError('Cloud run is not waiting for user input.', 409);
    }
    const clarifyId = String(msg.clarifyId || msg.clarify_id || '').trim();
    if (!clarifyId) throw cloudRunError('cloud_respond requires `clarify_id`.', 400);
    const pendingClarifyId = String(run.pendingInput?.clarifyId || run.pendingInput?.clarify_id || '').trim();
    if (!pendingClarifyId || clarifyId !== pendingClarifyId) {
      throw cloudRunError('Clarification is no longer pending for this cloud run.', 409);
    }
    const answer = String(msg.answer ?? '').trim();
    if (!answer) throw cloudRunError('cloud_respond requires `answer`.', 400);
    if (!agent.submitClarifyResponse(run.tabId, clarifyId, answer, 'cloud_api')) {
      throw cloudRunError('Clarification is no longer available in the active WebBrain run.', 409);
    }
    run.status = run.handoff?.state || 'running';
    run.pendingInput = null;
    run.error = '';
    pushUpdate(run, 'clarify_response', { clarifyId, source: 'cloud_api' });
    await persist();
    return snapshot(run);
  }

  // Persistent bridge identity (chrome.storage.local). The token is the Cloud
  // Bridge credential only; it is unrelated to provider API keys. The pairing
  // key authenticates this browser to a local MCP / LM Studio bridge.
  //
  // Concurrent starts (a settings save triggers syncBridge while the page also
  // sends cloud_bridge_start) must not each mint an installation id, so the
  // read-or-create step is single-flight.
  let installationIdInit = null;
  function ensureInstallationId() {
    if (!installationIdInit) {
      installationIdInit = (async () => {
        const stored = await api.storage.local.get('webbrainCloudBridgeInstallationId');
        if (stored.webbrainCloudBridgeInstallationId) return stored.webbrainCloudBridgeInstallationId;
        const created = crypto.randomUUID();
        await api.storage.local.set({ webbrainCloudBridgeInstallationId: created });
        return created;
      })().finally(() => { installationIdInit = null; });
    }
    return installationIdInit;
  }

  async function bridgeIdentity() {
    const installationId = await ensureInstallationId();
    const stored = await api.storage.local.get([
      'webbrainCloudBridgeToken',
      'webbrainCloudBridgeBrowserId',
      'webbrainCloudBridgePairingKey',
      'webbrainCloudBridgeLegacyBearerAuth',
    ]);
    return {
      token: stored.webbrainCloudBridgeToken || '',
      browserId: stored.webbrainCloudBridgeBrowserId || installationId,
      installationId,
      extensionVersion: api.runtime.getManifest?.().version || '',
      pairingKey: stored.webbrainCloudBridgePairingKey || '',
      // Deprecated opt-in for controllers that only accept the token in the
      // hello; off unless explicitly set (docs/cloud-bridge-browser-approval.md).
      legacyBearerAuth: stored.webbrainCloudBridgeLegacyBearerAuth === true,
    };
  }

  async function startBridge(url = DEFAULT_CLOUD_BRIDGE_URL) {
    await ensureOffscreen();
    return api.runtime.sendMessage({
      type: 'cloud-bridge-start',
      url: normalizeCloudBridgeUrl(url),
      ...(await bridgeIdentity()),
    });
  }

  async function stopBridge() {
    return api.runtime.sendMessage({ type: 'cloud-bridge-stop' });
  }

  async function bridgeStatus() {
    await ensureOffscreen();
    return api.runtime.sendMessage({ type: 'cloud-bridge-status' });
  }

  async function syncBridge() {
    const stored = await api.storage.local.get(['webbrainCloudBridgeEnabled', 'webbrainCloudBridgeUrl']);
    if (!stored.webbrainCloudBridgeEnabled) return stopBridge().catch(() => ({ enabled: false, connected: false }));
    return startBridge(stored.webbrainCloudBridgeUrl || DEFAULT_CLOUD_BRIDGE_URL);
  }

  return {
    runs,
    async guardRunStart(tabId, { kind } = {}) {
      // A scheduled/sidebar run can arrive before any Cloud status request.
      // Restore the persisted handoff before letting it touch the browser.
      await hydrate();
      const owner = activeHandoff();
      const settlingOwner = kind === 'cloud' && owner?.tabId === tabId
        && owner.handoff?.state === 'pausing' && !owner.handoff.interrupted;
      if ((durableHandoffGuards.size || owner) && !settlingOwner) {
        throw cloudRunError('The browser is reserved for manual control. Return control or reconcile the interrupted handoff before starting an agent.', 409);
      }
    },
    isRunning: (tabId) => startingTabs.has(tabId) || [...durableHandoffGuards.values()].some(row => row.tabId === tabId),
    startRun,
    startWorkflowRun,
    compileWorkflow,
    status,
    respond,
    pause,
    resume,
    abort,
    startBridge,
    stopBridge,
    bridgeStatus,
    syncBridge,
    hydrate,
  };
}
