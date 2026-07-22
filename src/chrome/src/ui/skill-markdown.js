/**
 * Small, dependency-free Markdown formatter for read-only skill previews.
 * All skill-controlled HTML is escaped before fixed markup is introduced.
 */

import { sanitizeMarkdownLinks } from './markdown-link.js';
import { renderMarkdownHeadings } from './markdown-render.js';

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function renderEmphasis(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function renderInlineMarkdown(value) {
  let text = sanitizeMarkdownLinks(value);
  const links = [];

  // Link destinations can legitimately contain `*`. Protect the complete
  // sanitized anchor while applying emphasis only to its visible label.
  text = text.replace(
    /(<a href="[^"]*" target="_blank" rel="noopener noreferrer">)([\s\S]*?)(<\/a>)/g,
    (_match, open, label, close) => {
      const placeholder = `__SKILL_LINK_${links.length}__`;
      links.push(`${open}${renderEmphasis(label)}${close}`);
      return placeholder;
    },
  );

  text = renderEmphasis(text);
  links.forEach((link, index) => {
    text = text.replace(`__SKILL_LINK_${index}__`, () => link);
  });
  return text;
}

export function renderSkillMarkdown(content) {
  let text = String(content || '');
  const codeBlocks = [];
  text = text.replace(/```[ \t]*([^`\r\n]*)\r?\n([\s\S]*?)```/g, (_match, _info, code) => {
    const placeholder = `__SKILL_CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(code);
    return placeholder;
  });
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const placeholder = `__SKILL_INLINE_CODE_${inlineCodes.length}__`;
    inlineCodes.push(code);
    return placeholder;
  });

  text = escapeHtml(text);

  // Pull list markers out before parsing emphasis so a `*` bullet cannot be
  // paired with an emphasis marker later in the same item.
  const listBlocks = [];
  const extractLists = (input, pattern, tag, markerPattern) => input.replace(pattern, (block) => {
    const placeholder = `__SKILL_LIST_BLOCK_${listBlocks.length}__`;
    const items = block.trimEnd().split(/\r?\n/)
      .map((line) => line.replace(markerPattern, '').trim());
    listBlocks.push({ tag, items });
    return `${placeholder}\n`;
  });
  text = extractLists(text, /(?:^[ \t]*[-+*][ \t]+[^\r\n]*(?:\r?\n|$))+/gm, 'ul', /^[ \t]*[-+*][ \t]+/);
  text = extractLists(text, /(?:^[ \t]*\d+\.[ \t]+[^\r\n]*(?:\r?\n|$))+/gm, 'ol', /^[ \t]*\d+\.[ \t]+/);

  text = renderInlineMarkdown(renderMarkdownHeadings(text)).replace(/\n/g, '<br>');

  listBlocks.forEach(({ tag, items }, index) => {
    const block = `<${tag}>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${tag}>`;
    text = text.replace(`__SKILL_LIST_BLOCK_${index}__`, () => block);
  });
  inlineCodes.forEach((code, index) => {
    text = text.replace(`__SKILL_INLINE_CODE_${index}__`, () => `<code>${escapeHtml(code)}</code>`);
  });
  codeBlocks.forEach((code, index) => {
    text = text.replace(`__SKILL_CODE_BLOCK_${index}__`, () => `<pre><code>${escapeHtml(code)}</code></pre>`);
  });
  return text;
}
