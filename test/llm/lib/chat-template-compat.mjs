// Compatibility shims for local OpenAI-compatible servers whose chat templates
// accept only a subset of OpenAI message roles.

export function getChatTemplateCompat({ model, value } = {}) {
  const explicit = normalizeCompatValue(value ?? process.env.LLM_CHAT_TEMPLATE_COMPAT);
  if (explicit) return explicit;

  // LM Studio's Molmo templates commonly reject `system` and `tool` roles with
  // "Conversation roles must alternate user/assistant/user/assistant/...".
  if (/molmo/i.test(model || '')) {
    return { mode: 'alternating', source: 'auto:molmo', omitStructuredTools: true };
  }

  return { mode: 'off', source: 'default' };
}

export function chatTemplateCompatLabel(compat) {
  if (!compat || compat.mode === 'off') return 'off';
  const details = [
    compat.source,
    compat.omitStructuredTools ? 'text tool calls' : null,
  ].filter(Boolean).join(', ');
  return `${compat.mode}${details ? ` (${details})` : ''}`;
}

export function prepareMessagesForChatTemplate(messages, compat, { tools = [] } = {}) {
  if (!compat || compat.mode === 'off') return messages;
  if (compat.mode === 'fold-system') return foldSystemMessages(messages);
  if (compat.mode === 'alternating') {
    return withTextToolCallInstruction(toAlternatingMessages(messages), compat, tools);
  }
  return messages;
}

export function prepareToolsForChatTemplate(tools, compat) {
  return compat?.omitStructuredTools ? undefined : tools;
}

function normalizeCompatValue(value) {
  if (value == null || value === '') return null;
  const key = String(value).trim().toLowerCase();
  if (['0', 'false', 'off', 'none', 'no'].includes(key)) {
    return { mode: 'off', source: 'explicit' };
  }
  if (['1', 'true', 'fold', 'fold-system', 'system'].includes(key)) {
    return { mode: 'fold-system', source: 'explicit' };
  }
  if (['alternating', 'strict-alternating', 'molmo'].includes(key)) {
    return { mode: 'alternating', source: 'explicit', omitStructuredTools: true };
  }
  throw new Error(
    `Bad LLM_CHAT_TEMPLATE_COMPAT value: ${value}. Expected off, fold-system, or alternating.`,
  );
}

function foldSystemMessages(messages) {
  const out = [];
  let pendingSystem = [];

  for (const msg of messages) {
    if (isInstructionRole(msg.role)) {
      pendingSystem.push(contentToText(msg.content));
      continue;
    }

    if (pendingSystem.length && msg.role === 'user') {
      out.push({ ...msg, content: withInstructions(pendingSystem, contentToText(msg.content)) });
      pendingSystem = [];
      continue;
    }

    if (pendingSystem.length) {
      out.push({ role: 'user', content: formatInstructions(pendingSystem) });
      pendingSystem = [];
    }
    out.push(msg);
  }

  if (pendingSystem.length) {
    const last = out[out.length - 1];
    if (last?.role === 'user') {
      last.content = `${contentToText(last.content)}\n\n${formatInstructions(pendingSystem)}`;
    } else {
      out.push({ role: 'user', content: formatInstructions(pendingSystem) });
    }
  }

  return out;
}

function toAlternatingMessages(messages) {
  const out = [];
  let pendingSystem = [];

  for (const msg of messages) {
    if (isInstructionRole(msg.role)) {
      pendingSystem.push(contentToText(msg.content));
      continue;
    }

    if (msg.role === 'user') {
      pushAlternating(out, 'user', withInstructions(pendingSystem, contentToText(msg.content)));
      pendingSystem = [];
      continue;
    }

    if (msg.role === 'assistant') {
      flushPendingSystem(out, pendingSystem);
      pendingSystem = [];
      pushAlternating(out, 'assistant', assistantMessageToText(msg));
      continue;
    }

    if (msg.role === 'tool') {
      pushAlternating(out, 'user', withInstructions(pendingSystem, toolMessageToText(msg)));
      pendingSystem = [];
      continue;
    }

    pushAlternating(
      out,
      'user',
      withInstructions(pendingSystem, `${msg.role || 'message'}:\n${contentToText(msg.content)}`),
    );
    pendingSystem = [];
  }

  flushPendingSystem(out, pendingSystem);
  if (out[0]?.role === 'assistant') {
    out.unshift({ role: 'user', content: 'Continue the prior task.' });
  }
  return out;
}

function flushPendingSystem(out, pendingSystem) {
  if (pendingSystem.length) {
    pushAlternating(out, 'user', formatInstructions(pendingSystem));
  }
}

function pushAlternating(out, role, content) {
  const text = contentToText(content).trim();
  if (!text) return;

  const last = out[out.length - 1];
  if (last?.role === role) {
    last.content = `${contentToText(last.content)}\n\n${text}`;
  } else {
    out.push({ role, content: text });
  }
}

function withTextToolCallInstruction(messages, compat, tools) {
  if (!compat?.omitStructuredTools || !Array.isArray(tools) || !tools.length) return messages;

  const names = tools.map((tool) => tool?.function?.name).filter(Boolean);
  if (!names.length) return messages;

  const instruction =
    'Tool-call compatibility mode: this server is not receiving OpenAI structured tool schemas. ' +
    'When the next action should be a tool call, reply with exactly one raw tool call and no prose, ' +
    'using this format: <tool_call>{"name":"tool_name","arguments":{...}}</tool_call>. ' +
    `Available tool names: ${names.join(', ')}.`;

  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') {
      out[i].content = `${contentToText(out[i].content)}\n\n${instruction}`;
      return out;
    }
  }

  out.push({ role: 'user', content: instruction });
  return out;
}

function assistantMessageToText(msg) {
  const parts = [];
  const content = contentToText(msg.content).trim();
  if (content) parts.push(content);

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    const calls = msg.tool_calls.map((tc) => {
      const name = tc?.function?.name || tc?.name || 'tool';
      const args = tc?.function?.arguments ?? tc?.arguments ?? tc?.args ?? {};
      return `- ${name}(${stringifyArgs(args)})`;
    });
    parts.push(`Assistant tool call(s):\n${calls.join('\n')}`);
  }

  return parts.join('\n\n');
}

function toolMessageToText(msg) {
  const name = msg.name || 'tool';
  const id = msg.tool_call_id ? ` ${msg.tool_call_id}` : '';
  return `Tool result from ${name}${id}:\n${contentToText(msg.content)}`;
}

function withInstructions(instructions, body) {
  if (!instructions.length) return body;
  return `${formatInstructions(instructions)}\n\n${body || ''}`.trim();
}

function formatInstructions(instructions) {
  return `System/developer instructions:\n${instructions.map((s) => s.trim()).filter(Boolean).join('\n\n')}`;
}

function isInstructionRole(role) {
  return role === 'system' || role === 'developer';
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      if (part?.type === 'image_url') return '[image_url omitted]';
      return JSON.stringify(part);
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(content);
}

function stringifyArgs(args) {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return '{}';
  }
}
