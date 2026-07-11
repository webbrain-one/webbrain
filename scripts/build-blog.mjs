#!/usr/bin/env node
/**
 * WebBrain blog build.
 *
 * Reads Markdown files from web/blog/posts/*.md and writes:
 *   web/blog/index.html
 *   web/blog/<slug>/index.html
 *
 * Markdown files use a small front-matter block:
 *
 * ---
 * title: My post title
 * slug: my-post-title
 * date: 2026-05-31
 * readTime: 6 min read
 * sortOrder: 10
 * description: Short SEO description.
 * excerpt: Short card summary for /blog.
 * cardTitle: Optional title override for the /blog card.
 * keywords:
 *   - browser agent
 *   - local llm
 * author: Emre Sokullu
 * authorUrl: https://emresokullu.com
 * html: true
 * ---
 *
 * The first Markdown paragraph becomes the article lede unless front matter
 * provides `lede`. Add `draft: true` to skip a post by default, or pass
 * --drafts to include it. Add `html: true` only for trusted posts that need
 * raw inline/block HTML such as <span class="win"> markers or callouts.
 *
 * Pure Node ESM, no npm dependency.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_POSTS_DIR = path.join(REPO_ROOT, 'web', 'blog', 'posts');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'web', 'blog');
const DEFAULT_SITE_ORIGIN = 'https://webbrain.one';
const DEFAULT_AUTHOR = 'Emre Sokullu';
const DEFAULT_AUTHOR_URL = 'https://emresokullu.com';
const SOCIAL_IMAGE_PATH = '/og-image.png';
const TWITTER_IMAGE_PATH = '/twitter-image.png';
const SOCIAL_IMAGE_WIDTH = 1200;
const SOCIAL_IMAGE_HEIGHT = 630;

const LOCALES = [
  { code: 'en', label: 'English', path: '/' },
  { code: 'es', label: 'Espanol', path: '/es/' },
  { code: 'fr', label: 'Francais', path: '/fr/' },
  { code: 'tr', label: 'Turkce', path: '/tr/' },
  { code: 'zh', label: 'Chinese', path: '/zh/' },
  { code: 'ru', label: 'Russian', path: '/ru/' },
  { code: 'uk', label: 'Ukrainian', path: '/uk/' },
  { code: 'ar', label: 'Arabic', path: '/ar/' },
  { code: 'ja', label: 'Japanese', path: '/ja/' },
  { code: 'ko', label: 'Korean', path: '/ko/' },
  { code: 'id', label: 'Bahasa Indonesia', path: '/id/' },
  { code: 'th', label: 'Thai', path: '/th/' },
  { code: 'ms', label: 'Bahasa Melayu', path: '/ms/' },
  { code: 'tl', label: 'Filipino', path: '/tl/' },
];

function parseArgs(argv) {
  const args = {
    src: DEFAULT_POSTS_DIR,
    out: DEFAULT_OUT_DIR,
    site: DEFAULT_SITE_ORIGIN,
    includeDrafts: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--drafts') args.includeDrafts = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--src' && next) { args.src = path.resolve(next); i += 1; }
    else if (arg.startsWith('--src=')) args.src = path.resolve(arg.slice(6));
    else if (arg === '--out' && next) { args.out = path.resolve(next); i += 1; }
    else if (arg.startsWith('--out=')) args.out = path.resolve(arg.slice(6));
    else if (arg === '--site' && next) { args.site = normalizeOrigin(next); i += 1; }
    else if (arg.startsWith('--site=')) args.site = normalizeOrigin(arg.slice(7));
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.site = normalizeOrigin(args.site);
  return args;
}

function normalizeOrigin(origin) {
  return String(origin || DEFAULT_SITE_ORIGIN).replace(/\/+$/, '');
}

function printHelp() {
  console.log(`Usage: node scripts/build-blog.mjs [options]

Options:
  --src <dir>      Markdown source directory (default: web/blog/posts)
  --out <dir>      Blog output directory (default: web/blog)
  --site <origin>  Site origin for canonical URLs (default: https://webbrain.one)
  --drafts         Include posts with draft: true
  --dry-run        Parse and render without writing files
  --help           Show this help
`);
}

function escHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function escAttr(value) {
  return escHtml(value).replace(/`/g, '&#96;');
}

function escJsonLd(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'post';
}

function stripInlineMarkdown(value) {
  return String(value || '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToPlain(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(p|br|li|ul|ol|div|h[1-6]|blockquote|tr|td|th)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    .replace(/&middot;/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${cut.slice(0, at > 80 ? at : cut.length).trim()}...`;
}

async function listMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];

  const files = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(full);
      }
    }
  }
  await walk(dir);
  return files.sort((a, b) => a.localeCompare(b));
}

function parseFrontMatter(raw, filePath) {
  const source = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!source.startsWith('---\n')) {
    return { meta: {}, markdown: source };
  }

  const end = source.indexOf('\n---', 4);
  if (end === -1) {
    throw new Error(`${filePath}: front matter starts with --- but has no closing ---`);
  }

  const block = source.slice(4, end);
  const after = source.slice(source.indexOf('\n', end + 1) + 1);
  return { meta: parseFrontMatterBlock(block), markdown: after };
}

function parseFrontMatterBlock(block) {
  const lines = block.split('\n');
  const meta = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const rawValue = match[2].trim();

    if (rawValue === '|' || rawValue === '>') {
      const collected = [];
      i += 1;
      while (i < lines.length && (/^( {2,}|\t|$)/.test(lines[i]))) {
        collected.push(lines[i].replace(/^( {2}|\t)/, ''));
        i += 1;
      }
      i -= 1;
      meta[key] = rawValue === '>'
        ? collected.join(' ').replace(/\s+/g, ' ').trim()
        : collected.join('\n').trim();
      continue;
    }

    if (rawValue === '') {
      const list = [];
      let j = i + 1;
      while (j < lines.length) {
        const item = lines[j].match(/^\s+-\s+(.*)$/);
        if (!item) break;
        list.push(parseScalar(item[1].trim()));
        j += 1;
      }
      if (list.length) {
        meta[key] = list;
        i = j - 1;
      } else {
        meta[key] = '';
      }
      continue;
    }

    meta[key] = parseScalar(rawValue);
  }

  return meta;
}

function parseScalar(value) {
  const raw = String(value || '').trim();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);

  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    if (raw.startsWith('"')) {
      try { return JSON.parse(raw); } catch (_) { /* fall through */ }
    }
    return raw.slice(1, -1);
  }

  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((part) => parseScalar(part.trim()));
  }

  return raw;
}

function extractTitleAndLede(markdown, meta) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let title = typeof meta.title === 'string' ? meta.title.trim() : '';

  const firstMeaningful = lines.findIndex((line) => line.trim());
  if (firstMeaningful >= 0) {
    const h1 = lines[firstMeaningful].match(/^#\s+(.+?)\s*#*$/);
    if (h1 && (!title || stripInlineMarkdown(h1[1]) === title)) {
      if (!title) title = stripInlineMarkdown(h1[1]);
      lines.splice(firstMeaningful, 1);
    }
  }

  let lede = typeof meta.lede === 'string' ? meta.lede.trim() : '';
  if (!lede) {
    const start = lines.findIndex((line) => line.trim());
    if (start >= 0 && !isBlockStarter(lines, start)) {
      const para = [];
      let end = start;
      while (end < lines.length && lines[end].trim() && !isBlockStarter(lines, end)) {
        para.push(lines[end]);
        end += 1;
      }
      lede = para.join(' ').trim();
      lines.splice(start, end - start);
    }
  }

  return {
    title,
    lede,
    markdown: lines.join('\n').trim(),
  };
}

function isBlockStarter(lines, index, options = {}) {
  const line = lines[index] || '';
  const next = lines[index + 1] || '';
  return /^#{1,6}\s+/.test(line)
    || /^```/.test(line)
    || /^~~~/.test(line)
    || /^\s{0,3}([-*+]|\d+[.)])\s+/.test(line)
    || /^\s{0,3}>/.test(line)
    || /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || isTableStart(line, next)
    || (options.allowHtml && isHtmlBlockStart(line));
}

function renderMarkdown(markdown, options = {}) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const headingCounts = new Map();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (options.allowHtml && isHtmlBlockStart(line)) {
      const { block, nextIndex } = readHtmlBlock(lines, i);
      html.push(block.join('\n'));
      i = nextIndex;
      continue;
    }

    const fence = line.match(/^\s*(```|~~~)\s*([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith(marker)) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const classAttr = lang ? ` class="language-${escAttr(lang)}"` : '';
      html.push(`<pre><code${classAttr}>${escHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const level = heading[1].length;
      const rawText = heading[2].trim();
      const baseId = slugify(stripInlineMarkdown(rawText));
      const count = headingCounts.get(baseId) || 0;
      headingCounts.set(baseId, count + 1);
      const id = count ? `${baseId}-${count + 1}` : baseId;
      html.push(`<h${level} id="${escAttr(id)}">${renderInline(rawText, options)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html.push('<hr>');
      i += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quote = [];
      while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || !lines[i].trim())) {
        quote.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join('\n'), options)}</blockquote>`);
      continue;
    }

    const listMatch = line.match(/^(\s{0,3})([-*+]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+[.)]/.test(listMatch[2]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length) {
        const item = lines[i].match(/^(\s{0,3})([-*+]|\d+[.)])\s+(.+)$/);
        if (!item || (/\d+[.)]/.test(item[2]) !== ordered)) break;
        const itemLines = [item[3]];
        i += 1;
        while (i < lines.length && lines[i].trim() && !/^\s{0,3}([-*+]|\d+[.)])\s+/.test(lines[i])) {
          itemLines.push(lines[i].replace(/^\s{2,}/, ''));
          i += 1;
        }
        items.push(`<li>${renderInline(itemLines.join(' '), options)}</li>`);
      }
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const tableLines = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        tableLines.push(lines[i]);
        i += 1;
      }
      html.push(renderTable(tableLines, options));
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !isBlockStarter(lines, i, options)) {
      paragraph.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(' '), options)}</p>`);
  }

  return html.join('\n');
}

function isTableStart(line, nextLine) {
  return line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine || '');
}

function isHtmlBlockStart(line) {
  return /^\s*<(address|article|aside|blockquote|details|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|ul)(\s|>|\/>)/i.test(line);
}

function readHtmlBlock(lines, startIndex) {
  const first = lines[startIndex];
  const tagMatch = first.match(/^\s*<([A-Za-z][A-Za-z0-9-]*)\b/i);
  if (!tagMatch) return { block: [first], nextIndex: startIndex + 1 };

  const tag = tagMatch[1].toLowerCase();
  if (/^\s*<hr\b/i.test(first) || /\/>\s*$/.test(first)) {
    return { block: [first], nextIndex: startIndex + 1 };
  }

  const block = [];
  let depth = 0;
  let i = startIndex;

  while (i < lines.length) {
    const current = lines[i];
    block.push(current);
    const openMatches = current.match(new RegExp(`<${tag}(\\s|>|/)`, 'gi')) || [];
    const closeMatches = current.match(new RegExp(`</${tag}>`, 'gi')) || [];
    depth += openMatches.length - closeMatches.length;
    i += 1;
    if (depth <= 0) break;
  }

  return { block, nextIndex: i };
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function renderTable(lines, options) {
  const head = splitTableRow(lines[0]);
  const body = lines.slice(2).map(splitTableRow);
  const headerHtml = head.map((cell) => `<th>${renderInline(cell, options)}</th>`).join('');
  const bodyHtml = body.map((row) => (
    `<tr>${row.map((cell) => `<td>${renderInline(cell, options)}</td>`).join('')}</tr>`
  )).join('');

  return [
    '<div class="table-wrap">',
    '<table>',
    `<thead><tr>${headerHtml}</tr></thead>`,
    `<tbody>${bodyHtml}</tbody>`,
    '</table>',
    '</div>',
  ].join('');
}

function renderInline(value, options = {}) {
  const allowHtml = Boolean(options.allowHtml);
  const codeTokens = [];
  const linkTokens = [];
  let text = String(value || '').replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `@@CODE${codeTokens.length}@@`;
    codeTokens.push(`<code>${escHtml(code)}</code>`);
    return token;
  });

  if (!allowHtml) text = escHtml(text);

  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, (_, alt, url, title) => {
    const titleAttr = title ? ` title="${escAttr(title)}"` : '';
    return `<img src="${escAttr(url)}" alt="${escAttr(stripInlineMarkdown(alt))}"${titleAttr}>`;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g, (_, label, url, title) => {
    const titleAttr = title ? ` title="${escAttr(title)}"` : '';
    const external = /^https?:\/\//i.test(url) ? ' target="_blank" rel="noopener"' : '';
    const token = `@@LINK${linkTokens.length}@@`;
    linkTokens.push(`<a href="${escAttr(url)}"${titleAttr}${external}>${label}</a>`);
    return token;
  });

  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^\*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\s][^_]*?)_/g, '$1<em>$2</em>');

  codeTokens.forEach((html, index) => {
    text = text.replace(`@@CODE${index}@@`, html);
  });
  linkTokens.forEach((html, index) => {
    text = text.replace(`@@LINK${index}@@`, html);
  });

  return text;
}

async function buildPost(filePath, args) {
  const raw = await readFile(filePath, 'utf8');
  const { meta, markdown } = parseFrontMatter(raw, filePath);
  if (meta.draft === true && !args.includeDrafts) return null;

  const extracted = extractTitleAndLede(markdown, meta);
  const title = extracted.title || path.basename(filePath, '.md');
  const slug = String(meta.slug || slugify(title)).trim();
  const allowHtml = meta.html === true || meta.allowHtml === true;
  const bodyHtml = renderMarkdown(extracted.markdown, { allowHtml });
  const ledeHtml = extracted.lede ? renderInline(extracted.lede, { allowHtml }) : '';
  const ledeText = htmlToPlain(ledeHtml);
  const description = String(meta.description || truncateText(ledeText || htmlToPlain(bodyHtml), 180));
  const excerpt = String(meta.excerpt || description);
  const rawDate = meta.date ? String(meta.date) : (await stat(filePath)).mtime.toISOString().slice(0, 10);
  const published = normalizeDate(rawDate);
  const readTime = String(meta.readTime || meta.read_time || estimateReadTime(`${ledeText} ${htmlToPlain(bodyHtml)}`));
  const keywords = Array.isArray(meta.keywords)
    ? meta.keywords.map(String)
    : (typeof meta.keywords === 'string' ? meta.keywords.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const author = String(meta.author || DEFAULT_AUTHOR);
  const authorUrl = String(meta.authorUrl || meta.author_url || DEFAULT_AUTHOR_URL);

  return {
    filePath,
    title,
    slug,
    date: published.iso,
    sortOrder: Number(meta.sortOrder || meta.sort_order || 0),
    displayDate: published.display,
    readTime,
    description,
    excerpt,
    cardTitle: String(meta.cardTitle || meta.card_title || title),
    keywords,
    author,
    authorUrl,
    ledeHtml,
    bodyHtml,
    urlPath: `/blog/${slug}`,
    titleTag: String(meta.titleTag || meta.title_tag || `${title} - WebBrain Blog`),
    ogTitle: String(meta.ogTitle || meta.og_title || title),
    ogDescription: String(meta.ogDescription || meta.og_description || description),
    twitterTitle: String(meta.twitterTitle || meta.twitter_title || meta.ogTitle || meta.og_title || title),
    twitterDescription: String(meta.twitterDescription || meta.twitter_description || meta.ogDescription || meta.og_description || description),
  };
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : new Date(raw).toISOString().slice(0, 10);
  const date = new Date(`${iso}T00:00:00Z`);
  return {
    iso,
    display: new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date),
  };
}

function estimateReadTime(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.round(words / 220))} min read`;
}

function sortPosts(posts) {
  return [...posts].sort((a, b) => (
    b.date.localeCompare(a.date)
      || a.sortOrder - b.sortOrder
      || a.title.localeCompare(b.title)
  ));
}

function blogStyle() {
  return `<style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0b0e17;
      --bg-card: #111827;
      --bg-card-hover: #1a2233;
      --surface: #161d2e;
      --border: rgba(255,255,255,0.07);
      --text: #e4e4ec;
      --text-dim: #8b8fa4;
      --accent: #6c63ff;
      --accent-glow: rgba(108,99,255,0.25);
      --accent2: #a78bfa;
      --success: #34d399;
      --warning: #fbbf24;
      --danger: #f87171;
      --tint-soft: rgba(255,255,255,0.05);
      --tint-soft-2: rgba(255,255,255,0.04);
      --tint-medium: rgba(255,255,255,0.08);
      --nav-bg: rgba(11,14,23,0.85);
      --code-bg: #0a0e17;
      --inline-code-bg: rgba(255,255,255,0.06);
      --shadow-strong: rgba(0,0,0,0.40);
      --radius: 12px;
      --radius-lg: 16px;
      --max-w: 760px;
      color-scheme: dark;
    }
    :root[data-theme="light"] {
      --bg: #f7f1e6;
      --bg-card: #fffdf8;
      --bg-card-hover: #f2e9d4;
      --surface: #ede2cb;
      --border: rgba(89,55,25,0.15);
      --text: #2c1810;
      --text-dim: #6b5b47;
      --accent: #5b52e8;
      --accent-glow: rgba(91,82,232,0.20);
      --accent2: #7c6ce6;
      --success: #2d8866;
      --warning: #9a6500;
      --danger: #b74747;
      --tint-soft: rgba(89,55,25,0.05);
      --tint-soft-2: rgba(89,55,25,0.07);
      --tint-medium: rgba(89,55,25,0.10);
      --nav-bg: rgba(247,241,230,0.85);
      --code-bg: #fff7e6;
      --inline-code-bg: rgba(89,55,25,0.08);
      --shadow-strong: rgba(89,55,25,0.18);
      color-scheme: light;
    }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.75;
      font-size: 17px;
      overflow-x: hidden;
    }
    a { color: var(--accent2); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .glow-bg {
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      overflow: hidden;
    }
    .glow-bg::before,
    .glow-bg::after {
      content: '';
      position: absolute;
      border-radius: 50%;
      filter: blur(120px);
      opacity: 0.26;
    }
    .glow-bg::before {
      width: 500px;
      height: 500px;
      background: var(--accent);
      top: -220px;
      left: -160px;
    }
    .glow-bg::after {
      width: 500px;
      height: 500px;
      background: var(--accent2);
      right: -180px;
      bottom: -230px;
      opacity: 0.18;
    }
    nav {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--nav-bg);
      backdrop-filter: saturate(160%) blur(12px);
      -webkit-backdrop-filter: saturate(160%) blur(12px);
      border-bottom: 1px solid var(--border);
    }
    .nav-inner {
      max-width: var(--max-w);
      margin: 0 auto;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    .nav-brand {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      color: var(--text);
      font-size: 18px;
      font-weight: 700;
      text-decoration: none;
    }
    .nav-brand:hover { text-decoration: none; }
    .nav-brand .brand-logo { width: 26px; height: 26px; border-radius: 7px; flex: 0 0 auto; }
    .nav-brand .domain { opacity: 0.5; font-weight: 400; }
    .nav-links {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 16px;
      min-width: 0;
    }
    .nav-links a {
      color: var(--text-dim);
      font-size: 14px;
      font-weight: 500;
      white-space: nowrap;
    }
    .nav-links a:hover { color: var(--text); text-decoration: none; }
    .lang-dropdown {
      background: var(--tint-soft);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 13px;
      max-width: 120px;
    }
    .lang-dropdown:focus { outline: 2px solid var(--accent-glow); outline-offset: 1px; }
    .lang-dropdown option { background-color: var(--bg-card-hover); color: var(--text); }
    .theme-toggle {
      appearance: none;
      -webkit-appearance: none;
      background: var(--tint-soft-2);
      border: 1px solid var(--border);
      border-radius: 999px;
      width: 30px;
      height: 30px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      cursor: pointer;
      color: var(--text-dim);
      transition: background 0.2s, color 0.2s, border-color 0.2s, transform 0.1s;
    }
    .theme-toggle:hover {
      background: var(--tint-medium);
      border-color: var(--accent);
      color: var(--text);
      transform: translateY(-1px);
    }
    .theme-toggle:focus-visible {
      outline: 2px solid var(--accent2);
      outline-offset: 2px;
    }
    .theme-toggle svg { width: 16px; height: 16px; display: block; }
    .theme-toggle .icon-sun { display: block; }
    .theme-toggle .icon-moon { display: none; }
    :root[data-theme="light"] .theme-toggle .icon-sun { display: none; }
    :root[data-theme="light"] .theme-toggle .icon-moon { display: block; }
    main,
    article {
      max-width: var(--max-w);
      margin: 0 auto;
      padding: 64px 24px 80px;
    }
    .page-label {
      display: inline-block;
      font-size: 12px;
      letter-spacing: 0;
      text-transform: uppercase;
      color: var(--accent2);
      padding: 4px 10px;
      border: 1px solid color-mix(in srgb, var(--accent2) 28%, transparent);
      border-radius: 999px;
      margin-bottom: 18px;
    }
    h1 {
      font-size: 38px;
      line-height: 1.2;
      font-weight: 700;
      letter-spacing: 0;
      margin-bottom: 16px;
    }
    .page-sub,
    .lede {
      color: var(--text-dim);
      line-height: 1.6;
    }
    .page-sub {
      font-size: 17px;
      max-width: 580px;
      margin-bottom: 48px;
    }
    .lede {
      font-size: 19px;
      margin-bottom: 40px;
    }
    .meta {
      font-size: 13px;
      color: var(--text-dim);
      margin-bottom: 12px;
      letter-spacing: 0;
    }
    h2 {
      font-size: 24px;
      font-weight: 700;
      margin-top: 48px;
      margin-bottom: 14px;
      letter-spacing: 0;
    }
    h3 {
      font-size: 18px;
      font-weight: 600;
      margin-top: 32px;
      margin-bottom: 10px;
      color: var(--text);
    }
    h4, h5, h6 {
      color: var(--text);
      margin-top: 28px;
      margin-bottom: 10px;
      line-height: 1.35;
    }
    p { margin-bottom: 16px; }
    ul, ol { margin: 0 0 16px 20px; }
    li { margin-bottom: 6px; }
    code {
      font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
      font-size: 0.88em;
      background: var(--inline-code-bg);
      padding: 2px 6px;
      border-radius: 4px;
      color: color-mix(in srgb, var(--accent2) 80%, var(--text));
    }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 20px;
      overflow-x: auto;
      margin: 20px 0;
      font-size: 14px;
      line-height: 1.55;
      box-shadow: 0 18px 60px var(--shadow-strong);
    }
    pre code {
      background: transparent;
      padding: 0;
      color: inherit;
      font-size: inherit;
    }
    blockquote {
      border-left: 3px solid var(--accent);
      padding: 4px 0 4px 18px;
      margin: 20px 0;
      color: var(--text-dim);
      font-style: italic;
    }
    blockquote p:last-child { margin-bottom: 0; }
    hr {
      border: 0;
      border-top: 1px solid var(--border);
      margin: 36px 0;
    }
    article img {
      max-width: 100%;
      height: auto;
      display: block;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      margin: 24px 0;
    }
    .table-wrap { overflow-x: auto; margin: 24px 0; }
    table {
      width: 100%;
      min-width: 560px;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th {
      color: var(--text-dim);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0;
      background: var(--tint-soft-2);
    }
    td code { font-size: 12px; }
    .win { color: var(--success); font-weight: 600; }
    .lose { color: var(--danger); }
    .meh { color: var(--warning); }
    .callout {
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
      border-radius: var(--radius);
      padding: 16px 20px;
      margin: 24px 0;
      font-size: 15px;
      line-height: 1.65;
      color: var(--text-dim);
    }
    .callout strong { color: var(--text); }
    .author-box {
      margin-top: 64px;
      padding-top: 32px;
      border-top: 1px solid var(--border);
      color: var(--text-dim);
      font-size: 14px;
    }
    .post-list { display: flex; flex-direction: column; gap: 18px; }
    .post-card {
      display: block;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px 26px;
      transition: background 0.18s, border-color 0.18s, transform 0.18s;
    }
    .post-card:hover {
      background: var(--bg-card-hover);
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
      transform: translateY(-1px);
      text-decoration: none;
    }
    .post-meta {
      font-size: 12px;
      color: var(--text-dim);
      letter-spacing: 0;
      margin-bottom: 8px;
    }
    .post-title {
      font-size: 21px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 6px;
      letter-spacing: 0;
      line-height: 1.35;
    }
    .post-excerpt {
      color: var(--text-dim);
      font-size: 15px;
      line-height: 1.6;
    }
    footer {
      max-width: var(--max-w);
      margin: 0 auto;
      padding: 40px 24px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      gap: 24px;
      color: var(--text-dim);
      font-size: 13px;
    }
    footer a { color: var(--text-dim); }
    footer a:hover { color: var(--text); }
    @media (max-width: 700px) {
      body { font-size: 16px; }
      .nav-inner { padding: 14px 20px; align-items: flex-start; }
      .nav-links { gap: 12px; flex-wrap: wrap; }
      .lang-dropdown { display: none; }
      h1 { font-size: 28px; }
      .lede { font-size: 16px; }
      .page-sub { font-size: 15px; }
      main, article { padding: 48px 20px 64px; }
      h2 { font-size: 20px; margin-top: 36px; }
      .post-card { padding: 20px; }
      .post-title { font-size: 19px; }
      footer { flex-direction: column; padding: 32px 20px; }
    }
    @media (max-width: 420px) {
      .nav-inner { gap: 12px; }
      .nav-links a[href="https://github.com/webbrain-one/webbrain"] { display: none; }
      .theme-toggle { width: 28px; height: 28px; }
    }
  </style>`;
}

function themeBootstrapScript() {
  return `<script>
    (function () {
      try {
        var saved = localStorage.getItem('webbrain-theme');
        var theme = (saved === 'light' || saved === 'dark')
          ? saved
          : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', theme);
      } catch (_) {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    })();
  </script>`;
}

function themeToggleScript() {
  return `<script>
    (function () {
      const btn = document.getElementById('theme-toggle');
      if (!btn) return;
      const root = document.documentElement;

      function setTheme(theme, persist) {
        root.setAttribute('data-theme', theme);
        if (persist) {
          try { localStorage.setItem('webbrain-theme', theme); } catch (_) {}
        }
      }

      btn.addEventListener('click', function () {
        const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        setTheme(next, true);
      });

      const mq = window.matchMedia('(prefers-color-scheme: light)');
      function onMQ(e) {
        try {
          if (localStorage.getItem('webbrain-theme')) return;
        } catch (_) {}
        setTheme(e.matches ? 'light' : 'dark', false);
      }
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onMQ);
      else if (typeof mq.addListener === 'function') mq.addListener(onMQ);
    })();
  </script>`;
}

function languageScript() {
  const localeCodes = JSON.stringify(LOCALES.map((locale) => locale.code));
  return `<script>
    (function () {
      const LOCALES = ${localeCodes};
      const sel = document.getElementById('lang-dropdown');
      if (!sel) return;
      sel.value = sel.dataset.current || 'en';
      sel.addEventListener('change', function () {
        const target = sel.value;
        if (!LOCALES.includes(target)) return;
        window.location.href = target === 'en' ? '/' : '/' + target + '/';
      });
    })();
  </script>`;
}

function navHtml() {
  const options = LOCALES.map((locale) => (
    `<option value="${escAttr(locale.code)}">${escHtml(locale.label)}</option>`
  )).join('');

  return `<nav>
    <div class="nav-inner">
      <a href="/" class="nav-brand"><img class="brand-logo" src="/logo-github.png" alt="" aria-hidden="true"> WebBrain<span class="domain">.one</span></a>
      <div class="nav-links">
        <a href="/">Home</a>
        <a href="/docs/">Docs</a>
        <a href="/blog">Blog</a>
        <select class="lang-dropdown" id="lang-dropdown" aria-label="Select language" data-current="en">${options}</select>
        <button class="theme-toggle" type="button" id="theme-toggle" aria-label="Toggle light / dark theme" title="Toggle light / dark theme">
          <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"/>
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
          </svg>
          <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
        </button>
        <a href="https://github.com/webbrain-one/webbrain" target="_blank" rel="noopener">GitHub</a>
      </div>
    </div>
  </nav>`;
}

function hreflangLinks(site) {
  const links = LOCALES.map((locale) => (
    `  <link rel="alternate" hreflang="${escAttr(locale.code)}" href="${escAttr(site + locale.path)}">`
  ));
  links.push(`  <link rel="alternate" hreflang="x-default" href="${escAttr(site)}/">`);
  return links.join('\n');
}

function sharedHead({ title, description, canonical, ogType = 'website', ogTitle, ogDescription, twitterTitle, twitterDescription, keywords, jsonLd }, site) {
  const keywordsTag = keywords && keywords.length
    ? `\n  <meta name="keywords" content="${escAttr(keywords.join(', '))}">`
    : '';
  const socialImageUrl = `${site}${SOCIAL_IMAGE_PATH}`;
  const twitterImageUrl = `${site}${TWITTER_IMAGE_PATH}`;

  return `<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)}</title>
  <meta name="description" content="${escAttr(description)}">${keywordsTag}
  <meta property="og:title" content="${escAttr(ogTitle || title)}">
  <meta property="og:description" content="${escAttr(ogDescription || description)}">
  <meta property="og:type" content="${escAttr(ogType)}">
  <meta property="og:url" content="${escAttr(canonical)}">
  <meta property="og:image" content="${escAttr(socialImageUrl)}">
  <meta property="og:image:secure_url" content="${escAttr(socialImageUrl)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="${SOCIAL_IMAGE_WIDTH}">
  <meta property="og:image:height" content="${SOCIAL_IMAGE_HEIGHT}">
  <meta property="og:image:alt" content="WebBrain detailed brain logo">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escAttr(twitterTitle || ogTitle || title)}">
  <meta name="twitter:description" content="${escAttr(twitterDescription || ogDescription || description)}">
  <meta name="twitter:image" content="${escAttr(twitterImageUrl)}">
  <meta name="twitter:image:alt" content="WebBrain detailed brain logo">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="canonical" href="${escAttr(canonical)}">
  <!-- Blog is English-only; alternates point to locale homepages. -->
${hreflangLinks(site)}
  ${blogStyle()}
  ${themeBootstrapScript()}
  <script type="application/ld+json">
${escJsonLd(jsonLd)}
  </script>
</head>`;
}

function renderPostPage(post, args) {
  const canonical = `${args.site}${post.urlPath}`;
  const socialImageUrl = `${args.site}${SOCIAL_IMAGE_PATH}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    author: {
      '@type': 'Person',
      name: post.author,
      url: post.authorUrl,
    },
    datePublished: post.date,
    image: socialImageUrl,
    publisher: {
      '@type': 'Organization',
      name: 'WebBrain',
      logo: {
        '@type': 'ImageObject',
        url: `${args.site}/logo-github.png`,
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': canonical,
    },
  };

  return `<!DOCTYPE html>
<html lang="en">
${sharedHead({
    title: post.titleTag,
    description: post.description,
    canonical,
    ogType: 'article',
    ogTitle: post.ogTitle,
    ogDescription: post.ogDescription,
    twitterTitle: post.twitterTitle,
    twitterDescription: post.twitterDescription,
    keywords: post.keywords,
    jsonLd,
  }, args.site)}
<body>
  <div class="glow-bg"></div>
  ${navHtml()}

  <article>
    <div class="meta">${escHtml(post.displayDate)} &middot; ${escHtml(post.readTime)} &middot; <a href="/blog">&larr; All posts</a></div>
    <h1>${escHtml(post.title)}</h1>
    ${post.ledeHtml ? `<p class="lede">${post.ledeHtml}</p>` : ''}
${post.bodyHtml}

    <div class="author-box">
      Written by <a href="${escAttr(post.authorUrl)}" target="_blank" rel="noopener">${escHtml(post.author)}</a>. WebBrain is MIT-licensed and open on <a href="https://github.com/webbrain-one/webbrain" target="_blank" rel="noopener">GitHub</a>.
    </div>
  </article>

  ${footerHtml()}
  ${themeToggleScript()}
  ${languageScript()}
</body>
</html>
`;
}

function renderIndexPage(posts, args) {
  const canonical = `${args.site}/blog`;
  const socialImageUrl = `${args.site}${SOCIAL_IMAGE_PATH}`;
  const description = 'Engineering notes from WebBrain - the open-source AI browser agent.';
  const cards = posts.map((post) => (
    `<a href="${escAttr(post.urlPath)}" class="post-card">
        <div class="post-meta">${escHtml(post.displayDate)} &middot; ${escHtml(post.readTime)}</div>
        <div class="post-title">${escHtml(post.cardTitle || post.title)}</div>
        <div class="post-excerpt">${escHtml(post.excerpt)}</div>
      </a>`
  )).join('\n');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'WebBrain Blog',
    description,
    url: canonical,
    image: socialImageUrl,
    blogPost: posts.map((post) => ({
      '@type': 'BlogPosting',
      headline: post.title,
      url: `${args.site}${post.urlPath}`,
      datePublished: post.date,
      description: post.description,
      author: { '@type': 'Person', name: post.author, url: post.authorUrl },
    })),
  };

  return `<!DOCTYPE html>
<html lang="en">
${sharedHead({
    title: 'WebBrain Blog',
    description,
    canonical,
    ogTitle: 'WebBrain Blog',
    ogDescription: description,
    twitterTitle: 'WebBrain Blog',
    twitterDescription: 'Engineering notes from WebBrain.',
    jsonLd,
  }, args.site)}
<body>
  <div class="glow-bg"></div>
  ${navHtml()}

  <main>
    <span class="page-label">Blog</span>
    <h1>Engineering notes</h1>
    <p class="page-sub">Short write-ups on design decisions, failure modes, and benchmarks from building an open-source AI browser agent.</p>

    <div class="post-list">
      ${cards}
    </div>
  </main>

  ${footerHtml()}
  ${themeToggleScript()}
  ${languageScript()}
</body>
</html>
`;
}

function footerHtml() {
  return `<footer>
    <div>&copy; 2026 WebBrain &middot; <a href="/privacy">Privacy</a></div>
    <div><a href="https://github.com/webbrain-one/webbrain" target="_blank" rel="noopener">GitHub</a></div>
  </footer>`;
}

async function writeOutput(filePath, content, dryRun) {
  if (dryRun) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const files = await listMarkdownFiles(args.src);
  if (!files.length) {
    console.log(`No Markdown posts found in ${path.relative(process.cwd(), args.src) || args.src}.`);
    console.log('Create files in web/blog/posts/*.md, then run npm run build:blog.');
    return;
  }

  const posts = [];
  for (const file of files) {
    const post = await buildPost(file, args);
    if (post) posts.push(post);
  }

  const slugs = new Set();
  for (const post of posts) {
    if (slugs.has(post.slug)) throw new Error(`Duplicate blog slug: ${post.slug}`);
    slugs.add(post.slug);
  }

  const sorted = sortPosts(posts);
  for (const post of sorted) {
    const outFile = path.join(args.out, post.slug, 'index.html');
    await writeOutput(outFile, renderPostPage(post, args), args.dryRun);
    console.log(`${args.dryRun ? 'would write' : 'wrote'} ${path.relative(process.cwd(), outFile)}`);
  }

  const indexFile = path.join(args.out, 'index.html');
  await writeOutput(indexFile, renderIndexPage(sorted, args), args.dryRun);
  console.log(`${args.dryRun ? 'would write' : 'wrote'} ${path.relative(process.cwd(), indexFile)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
