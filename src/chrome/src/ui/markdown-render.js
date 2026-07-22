/**
 * Small, dependency-free helpers for the sidepanel's chat Markdown output.
 * Highlighting always escapes source code before adding fixed token spans.
 */

const LANGUAGE_ALIASES = Object.freeze({
  js: 'javascript', javascript: 'javascript', jsx: 'javascript',
  ts: 'javascript', typescript: 'javascript', tsx: 'javascript',
  css: 'css', scss: 'css', less: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  json: 'json', jsonc: 'json',
  py: 'python', python: 'python',
  sh: 'shell', shell: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  c: 'clike', h: 'clike', cpp: 'clike', 'c++': 'clike',
  cs: 'clike', 'c#': 'clike', java: 'clike', kotlin: 'clike', kt: 'clike',
  go: 'clike', rust: 'clike', rs: 'clike', swift: 'clike',
  php: 'clike', ruby: 'clike', rb: 'clike',
});

const JS_KEYWORDS = new Set(('abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch throw try type typeof var void while with yield').split(' '));
const JS_CONSTANTS = new Set(('true false null undefined NaN Infinity').split(' '));
const JS_BUILTINS = new Set(('Array BigInt Boolean Date Error Intl JSON Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol WeakMap WeakSet console document globalThis window').split(' '));
const PYTHON_KEYWORDS = new Set(('and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield').split(' '));
const PYTHON_BUILTINS = new Set(('bool bytes dict enumerate filter float int len list map max min open print range reversed set sorted str sum super tuple type zip').split(' '));
const SHELL_KEYWORDS = new Set(('case do done elif else esac export fi for function if in local readonly select then time until while').split(' '));
const CLIKE_KEYWORDS = new Set(('abstract alignas async await bool break byte case catch char class const constexpr continue default defer delete do double else enum explicit export extends extern false final finally float fn for foreach from func function go goto if implements import in inline int interface internal is let long match namespace new nil null nullptr operator override package private protected protocol public raise readonly ref return sealed short signed sizeof static struct super switch template this throw throws trait true try type typedef typeof union unsigned use using var virtual void volatile where while yield').split(' '));
const CLIKE_TYPES = new Set(('Array Boolean Error List Map Object Option Promise Result Set String Vec').split(' '));
const CSS_BUILTINS = new Set(('calc clamp currentColor inherit initial linear-gradient min max none radial-gradient repeat revert transparent unset url var').split(' '));

const JS_TOKENS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^\\`])*`|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\b(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b|\b[A-Za-z_$][\w$]*\b|===|!==|=>|\?\?|\?\.|\+\+|--|&&|\|\||[+\-*\/%=&|^!<>?:~]+|[{}\[\]();,.]/g;
const CSS_TOKENS = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|#[\da-fA-F]{3,8}\b|[.#][-_a-zA-Z][\w-]*|@[\w-]+|--[\w-]+|-?\d*\.?\d+(?:[a-zA-Z%]+)?|-?[_a-zA-Z][\w-]*|[{}[\]():;,>+~*=!]/g;
const MARKUP_TOKENS = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[A-Za-z][^>]*>|&(?:#\d+|#x[\da-fA-F]+|[A-Za-z][\w]+);/gi;
const JSON_TOKENS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b|[{}[\],:]/g;
const PYTHON_TOKENS = /#[^\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|@[A-Za-z_][\w.]*|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?j?\b|\b[A-Za-z_]\w*\b|:=|==|!=|<=|>=|\*\*|\/\/|->|[-+*\/%=&|^~<>:]+|[{}\[\]();,.]/g;
const SHELL_TOKENS = /#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\$\{[^}]+\}|\$[A-Za-z_][\w]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|&&|\|\||<<|>>|;;|[-+*\/%=&|!<>]+|[{}\[\]();]/g;
const SQL_TOKENS = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|<>|!=|<=|>=|::|[-+*\/%=<>]+|[(),.;]/gi;
const YAML_TOKENS = /#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:''|[^'])*'|&[\w-]+|\*[\w-]+|![\w!-]+|-?\b\d+(?:\.\d+)?\b|\b(?:true|false|null|yes|no|on|off)\b|(?:^|\n)[ \t-]*[\w.-]+(?=\s*:)|[\[\]{},:|>]/gi;
const CLIKE_TOKENS = /^[ \t]*#[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\$[A-Za-z_]\w*|\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b[A-Za-z_]\w*\b|::|=>|->|===|!==|==|!=|<=|>=|&&|\|\||\+\+|--|[-+*\/%=&|^!<>?:~]+|[{}\[\]();,.]/gm;

export function escapeCodeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

export function normalizeCodeLanguage(language) {
  return LANGUAGE_ALIASES[String(language || '').trim().toLowerCase()] || '';
}

export function codeFenceLanguage(infoString) {
  return String(infoString || '').trim().split(/\s+/, 1)[0] || '';
}

function tokenSpan(type, value) {
  const escaped = escapeCodeHtml(value);
  return type ? `<span class="syntax-${type}">${escaped}</span>` : escaped;
}

function tokenize(source, pattern, classify) {
  let output = '';
  let cursor = 0;
  pattern.lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    output += escapeCodeHtml(source.slice(cursor, match.index));
    output += tokenSpan(classify(match[0], match.index, source), match[0]);
    cursor = match.index + match[0].length;
  }
  return output + escapeCodeHtml(source.slice(cursor));
}

function quoted(token) {
  return token.startsWith('"') || token.startsWith("'") || token.startsWith('`');
}

function punctuation(token) {
  return token.length === 1 && '{}[]();,.'.includes(token);
}

function highlightJavascript(source) {
  return tokenize(source, JS_TOKENS, (token, index, input) => {
    if (token.startsWith('//') || token.startsWith('/*')) return 'comment';
    if (quoted(token)) return 'string';
    if (/^(?:\d|0[xXbBoO])/.test(token)) return 'number';
    if (JS_KEYWORDS.has(token)) return 'keyword';
    if (JS_CONSTANTS.has(token)) return 'constant';
    if (JS_BUILTINS.has(token)) return 'builtin';
    if (/^[A-Za-z_$]/.test(token) && /^\s*\(/.test(input.slice(index + token.length))) return 'function';
    return punctuation(token) ? 'punctuation' : (/^[\w$]+$/.test(token) ? '' : 'operator');
  });
}

function highlightCss(source) {
  return tokenize(source, CSS_TOKENS, (token, index, input) => {
    if (token.startsWith('/*')) return 'comment';
    if (quoted(token)) return 'string';
    if (/^#[\da-fA-F]{3,8}$/.test(token)) return 'constant';
    if (/^[.#]/.test(token)) return 'selector';
    if (token.startsWith('@')) return 'keyword';
    if (token.startsWith('--')) return 'variable';
    if (/^-?\d/.test(token)) return 'number';
    if (CSS_BUILTINS.has(token)) return 'builtin';
    if (/^[-_a-zA-Z]/.test(token) && /^\s*:/.test(input.slice(index + token.length))) return 'property';
    return /^[{}[\]():;,>+~*=!]$/.test(token) ? 'punctuation' : '';
  });
}

function highlightMarkup(source) {
  return tokenize(source, MARKUP_TOKENS, (token) => {
    if (token.startsWith('<!--')) return 'comment';
    if (/^<!doctype/i.test(token)) return 'keyword';
    if (token.startsWith('&')) return 'constant';
    return 'tag';
  });
}

function highlightJson(source) {
  return tokenize(source, JSON_TOKENS, (token, index, input) => {
    if (token.startsWith('//') || token.startsWith('/*')) return 'comment';
    if (token.startsWith('"')) return /^\s*:/.test(input.slice(index + token.length)) ? 'property' : 'string';
    if (/^-?\d/.test(token)) return 'number';
    if (/^(?:true|false|null)$/.test(token)) return 'constant';
    return 'punctuation';
  });
}

function highlightPython(source) {
  return tokenize(source, PYTHON_TOKENS, (token, index, input) => {
    if (token.startsWith('#')) return 'comment';
    if (quoted(token)) return 'string';
    if (token.startsWith('@')) return 'decorator';
    if (/^\d/.test(token)) return 'number';
    if (PYTHON_KEYWORDS.has(token)) return 'keyword';
    if (PYTHON_BUILTINS.has(token)) return 'builtin';
    if (/^[A-Za-z_]/.test(token) && /^\s*\(/.test(input.slice(index + token.length))) return 'function';
    return punctuation(token) ? 'punctuation' : (/^\w+$/.test(token) ? '' : 'operator');
  });
}

function highlightShell(source) {
  return tokenize(source, SHELL_TOKENS, (token) => {
    if (token.startsWith('#')) return 'comment';
    if (quoted(token)) return 'string';
    if (token.startsWith('$')) return 'variable';
    if (/^\d/.test(token)) return 'number';
    if (SHELL_KEYWORDS.has(token)) return 'keyword';
    return punctuation(token) ? 'punctuation' : (/^\w+$/.test(token) ? '' : 'operator');
  });
}

function highlightSql(source) {
  return tokenize(source, SQL_TOKENS, (token) => {
    const lower = token.toLowerCase();
    if (token.startsWith('--') || token.startsWith('/*')) return 'comment';
    if (quoted(token)) return 'string';
    if (/^\d/.test(token)) return 'number';
    if (('add all alter and as asc begin between by case check column commit constraint create database default delete desc distinct drop else end exists foreign from full grant group having if in index inner insert into is join key left like limit not null on or order outer primary references right rollback select set table then union unique update values view when where with').split(' ').includes(lower)) return 'keyword';
    return /^\w+$/.test(token) ? '' : 'operator';
  });
}

function highlightYaml(source) {
  return tokenize(source, YAML_TOKENS, (token) => {
    if (token.startsWith('#')) return 'comment';
    if (quoted(token)) return 'string';
    if (/^[&*!]/.test(token)) return 'variable';
    if (/^-?\d/.test(token)) return 'number';
    if (/^(?:true|false|null|yes|no|on|off)$/i.test(token)) return 'constant';
    if (/:\s*$/.test(token) || /^[\s-]*[\w.-]+$/.test(token)) return 'property';
    return 'punctuation';
  });
}

function highlightClike(source) {
  return tokenize(source, CLIKE_TOKENS, (token, index, input) => {
    if (/^\s*#/.test(token)) return 'keyword';
    if (token.startsWith('//') || token.startsWith('/*')) return 'comment';
    if (quoted(token)) return 'string';
    if (token.startsWith('$')) return 'variable';
    if (/^\d/.test(token)) return 'number';
    if (CLIKE_KEYWORDS.has(token)) return 'keyword';
    if (CLIKE_TYPES.has(token) || /^[A-Z][A-Za-z0-9_]*$/.test(token)) return 'type';
    if (/^[A-Za-z_]/.test(token) && /^\s*\(/.test(input.slice(index + token.length))) return 'function';
    return punctuation(token) ? 'punctuation' : (/^\w+$/.test(token) ? '' : 'operator');
  });
}

export function highlightCode(code, language) {
  const source = String(code == null ? '' : code);
  switch (normalizeCodeLanguage(language)) {
    case 'javascript': return highlightJavascript(source);
    case 'css': return highlightCss(source);
    case 'markup': return highlightMarkup(source);
    case 'json': return highlightJson(source);
    case 'python': return highlightPython(source);
    case 'shell': return highlightShell(source);
    case 'sql': return highlightSql(source);
    case 'yaml': return highlightYaml(source);
    case 'clike': return highlightClike(source);
    default: return escapeCodeHtml(source);
  }
}

/** Convert escaped ATX heading lines while leaving inline formatting for the caller. */
export function renderMarkdownHeadings(text) {
  return String(text == null ? '' : text).replace(
    /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?(?:\r?\n|$)/gm,
    (_match, hashes, content) => {
      const level = hashes.length;
      return `<h${level}>${content.replace(/[ \t]+$/, '')}</h${level}>`;
    }
  );
}
