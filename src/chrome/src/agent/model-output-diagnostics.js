import { outputLimitNotice } from '../ui/locales/output-limit-copy.mjs';
export { outputLimitNotice };

const OUTPUT_LIMIT_RE = /(?:^|[_\s-])(?:length|max(?:imum)?(?:[_\s-]*(?:output|completion))?[_\s-]*tokens?|output[_\s-]*limit|token[_\s-]*limit)(?:$|[_\s-])/i;
const CONTENT_FILTER_RE = /content[_\s-]*filter|safety|blocked|refusal/i;

function finiteNonNegative(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.floor(number);
  }
  return null;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function finishReasonFor(result) {
  const raw = result?.raw || {};
  return String(
    result?.finishReason
      ?? result?.finish_reason
      ?? result?.stopReason
      ?? result?.stop_reason
      ?? raw?.choices?.[0]?.finish_reason
      ?? raw?.finish_reason
      ?? raw?.stopReason
      ?? raw?.stop_reason
      ?? '',
  ).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
}

function usageFor(result) {
  return result?.usage && typeof result.usage === 'object'
    ? result.usage
    : (result?.raw?.usage && typeof result.raw.usage === 'object' ? result.raw.usage : {});
}

function responseHasReasoningItem(result) {
  const items = Array.isArray(result?.responseItems)
    ? result.responseItems
    : (Array.isArray(result?.raw?.output) ? result.raw.output : []);
  return items.some((item) => {
    if (item?.type === 'reasoning') return true;
    if (item?.type !== 'webbrain_provider_replay' || !Array.isArray(item.content)) return false;
    return item.content.some(block => block?.type === 'thinking' || block?.type === 'redacted_thinking');
  });
}

export function normalizeRejectedToolResponse(value) {
  if (value?.provider === 'qwen') {
    if (!['xml_name_args', 'json_envelope', 'function_parameters', 'other_xml'].includes(value.format)
      || !['oversized', 'incomplete_response', 'mixed_content', 'invalid_envelope'].includes(value.reason)
      || !['named', 'auto', 'required', 'none', 'unspecified'].includes(value.choice)) return null;
    const output = { provider: 'qwen', format: value.format, reason: value.reason, choice: value.choice };
    for (const key of ['contentChars', 'offeredTools']) {
      if (Number.isSafeInteger(value[key]) && value[key] >= 0) output[key] = value[key];
    }
    return output;
  }
  if (value?.provider === 'openrouter_dolphin_venice') {
    if (value.reason !== 'invalid_or_unavailable_tool') return null;
    const output = { provider: 'openrouter_dolphin_venice', reason: value.reason };
    if (Number.isSafeInteger(value.offeredTools) && value.offeredTools >= 0) output.offeredTools = value.offeredTools;
    return output;
  }
  return null;
}

export function modelOutputDiagnostics(result, { requestedMaxTokens = null, recoveryAttempt = 0 } = {}) {
  const rejectedToolResponse = normalizeRejectedToolResponse(result?.rejectedToolResponse);
  const contentChars = typeof result?.content === 'string' ? result.content.trim().length : 0;
  const toolCallCount = Array.isArray(result?.toolCalls) ? result.toolCalls.length : 0;
  const reasoningChars = typeof result?.reasoningContent === 'string' ? result.reasoningContent.length : 0;
  const usage = usageFor(result);
  const reasoningTokens = finiteNonNegative(
    usage?.completion_tokens_details?.reasoning_tokens,
    usage?.output_tokens_details?.reasoning_tokens,
    usage?.reasoning_tokens,
  );
  const outputTokens = finiteNonNegative(
    usage?.completion_tokens,
    usage?.output_tokens,
    usage?.completionTokens,
    usage?.outputTokens,
  );
  const normalizedMaxTokens = finitePositive(requestedMaxTokens);
  const finishReason = finishReasonFor(result);
  const reasoningPresent = reasoningChars > 0
    || (reasoningTokens != null && reasoningTokens > 0)
    || responseHasReasoningItem(result);
  const empty = contentChars === 0 && toolCallCount === 0;
  let emptyReason = null;

  if (empty) {
    if (CONTENT_FILTER_RE.test(finishReason)) {
      emptyReason = 'content_filter';
    } else if (
      OUTPUT_LIMIT_RE.test(` ${finishReason} `)
      || (normalizedMaxTokens != null && outputTokens != null && outputTokens >= normalizedMaxTokens)
    ) {
      emptyReason = 'output_limit';
    } else if (reasoningPresent) {
      emptyReason = 'reasoning_only';
    } else {
      emptyReason = 'provider_empty';
    }
  }

  return {
    ...(rejectedToolResponse ? { rejectedToolResponse } : {}),
    empty,
    emptyReason,
    finishReason: finishReason || null,
    contentChars,
    toolCallCount,
    reasoningPresent,
    reasoningChars,
    reasoningTokens,
    outputTokens,
    requestedMaxTokens: normalizedMaxTokens,
    recoveryAttempt: Number.isInteger(recoveryAttempt) && recoveryAttempt > 0 ? recoveryAttempt : 0,
  };
}

// A finish reason that means the reply stopped because it ran out of output budget.
const CUT_OFF_FINISH_RE = /^(?:length|max_tokens|max_output_tokens|max_completion_tokens|output_limit)$/i;

export const RESPONSE_CUT_OFF_NOTICE = '\n\n[This reply reached the model\'s output limit and was cut off. Ask WebBrain to continue to get the rest.]';

// A prefix stays visible even when the partial Markdown ends in an open fence.
export function outputLimitedAnswer(content, locale = 'en') {
  const text = String(content ?? '');
  return text.trim() ? `[${outputLimitNotice(locale)}]\n\n${text}` : text;
}

// True when the provider says the reply was stopped by its output limit. In-browser
// WebGPU models have no finish reason, so they report `outputTruncated` instead.
export function outputWasCutOff(result) {
  if (result?.outputTruncated === true) return true;
  return CUT_OFF_FINISH_RE.test(finishReasonFor(result));
}

// Some providers (OpenAI Responses) report the output limit as an error rather than a
// result, with what the model wrote attached. Returns that text, or '' when the error
// is not a cut-off or carries nothing to show.
export function cutOffPartialFromError(error) {
  if (!CUT_OFF_FINISH_RE.test(String(error?.incompleteReason ?? '').trim())) return '';
  return String(error?.partialContent ?? '').trim();
}

export function emptyOutputFailureMessage(diagnostics = {}) {
  switch (diagnostics.emptyReason) {
    case 'output_limit':
      return '[The model reached its configured response-token limit without producing visible text or a tool call, even after a recovery nudge. Reduce reasoning effort or choose another model/provider.]';
    case 'reasoning_only':
      return '[The latest model response contained reasoning but no visible answer or tool call after the earlier empty response. Reduce reasoning effort or choose another model/provider.]';
    case 'content_filter':
      return '[The provider filtered the latest response after an earlier empty response, so no visible text or tool call was returned. Revise the request or try another provider.]';
    default:
      return '[The provider returned an empty completion with no visible text or tool call twice. Retry later or choose another model/provider.]';
  }
}
