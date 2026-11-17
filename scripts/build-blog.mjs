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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAUSIBLE_ANALYTICS } from '../web/build/plausible.mjs';
import { SITE_FOOTER_STYLES, siteFooter } from '../web/build/site-footer.mjs';

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
// The blog is English-only; its footer uses the English site strings.
const ENGLISH_STRINGS = JSON.parse(readFileSync(path.join(REPO_ROOT, 'web', 'build', 'locales', 'en.json'), 'utf8'));

// Labels use each language's own script, matching web/build/template.html's
// dropdown — keep the two lists in sync when adding a new locale.
const LOCALES = [
  { code: 'en', label: 'English', path: '/' },
  { code: 'es', label: 'Español', path: '/es/' },
  { code: 'fr', label: 'Français', path: '/fr/' },
  { code: 'tr', label: 'Türkçe', path: '/tr/' },
  { code: 'zh', label: '中文', path: '/zh/' },
  { code: 'ru', label: 'Русский', path: '/ru/' },
  { code: 'uk', label: 'Українська', path: '/uk/' },
  { code: 'ar', label: 'العربية', path: '/ar/' },
  { code: 'ja', label: '日本語', path: '/ja/' },
  { code: 'ko', label: '한국어', path: '/ko/' },
  { code: 'id', label: 'Bahasa Indonesia', path: '/id/' },
  { code: 'th', label: 'ไทย', path: '/th/' },
  { code: 'ms', label: 'Bahasa Melayu', path: '/ms/' },
  { code: 'tl', label: 'Filipino', path: '/tl/' },
  { code: 'he', label: 'עברית', path: '/he/' },
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

  // Restore links before inline code so code spans used as link labels are
  // replaced after the surrounding anchor has been put back into the text.
  linkTokens.forEach((html, index) => {
    text = text.replace(`@@LINK${index}@@`, html);
  });
  codeTokens.forEach((html, index) => {
    text = text.replace(`@@CODE${index}@@`, html);
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
      /* Line the shared site footer up with the blog's header. */
      --wb-footer-width: min(calc(var(--max-w) - 48px), calc(100% - 48px));
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
      position: relative;
      color: var(--text-dim);
      font-size: 14px;
      font-weight: 500;
      white-space: nowrap;
    }
    .nav-links a:hover { color: var(--text); text-decoration: none; }
    .nav-links a[aria-current="page"] { color: var(--text); }
    .nav-links a[aria-current="page"]::after {
      content: '';
      position: absolute;
      left: 1px;
      right: 1px;
      bottom: -7px;
      height: 3px;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--accent2), var(--accent));
      box-shadow: 0 2px 12px var(--accent-glow);
    }
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
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    h1 {
      font-size: 38px;
      line-height: 1.2;
      font-weight: 700;
      letter-spacing: 0;
      margin-bottom: 16px;
    }
    .lede {
      color: var(--text-dim);
      line-height: 1.6;
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
    @media (max-width: 700px) {
      :root { --wb-footer-width: calc(100% - 40px); }
      body { font-size: 16px; }
      .nav-inner { padding: 14px 20px; align-items: flex-start; }
      .nav-links { gap: 12px; flex-wrap: wrap; }
      .lang-dropdown { display: none; }
      h1 { font-size: 28px; }
      .lede { font-size: 16px; }
      main, article { padding: 48px 20px 64px; }
      h2 { font-size: 20px; margin-top: 36px; }
      .post-card { padding: 20px; }
      .post-title { font-size: 19px; }
    }
    @media (max-width: 420px) {
      .nav-inner { gap: 12px; }
      .nav-links a[href="https://github.com/webbrain-one/webbrain"] { display: none; }
      .theme-toggle { width: 28px; height: 28px; }
    }
  </style>`;
}

function blogIndexStyle() {
  return `<style>
    [hidden] { display: none !important; }
    body.blog-index {
      --max-w: 1280px;
      --wb-footer-width: min(calc(var(--max-w) - 48px), calc(100% - 48px));
    }
    .blog-index main { padding-top: 36px; }
    .blog-tools {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        "label label"
        "search status";
      align-items: center;
      gap: 8px 20px;
      margin: 0 0 24px;
      padding-left: 18px;
      scroll-margin-top: 88px;
    }
    .blog-tools::before {
      content: '';
      position: absolute;
      inset: 2px auto 2px 0;
      width: 2px;
      border-radius: 999px;
      background: linear-gradient(180deg, var(--accent2), color-mix(in srgb, var(--accent) 12%, transparent));
      box-shadow: 0 0 18px var(--accent-glow);
    }
    .archive-search-label {
      grid-area: label;
      display: block;
      margin-bottom: 0;
      color: var(--text-dim);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .search-shell {
      grid-area: search;
      width: 100%;
      max-width: 560px;
      display: flex;
      align-items: center;
      min-height: 46px;
      background: color-mix(in srgb, var(--bg-card) 92%, transparent);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 14px 50px color-mix(in srgb, var(--shadow-strong) 58%, transparent);
      transition: border-color 0.18s, box-shadow 0.18s, background 0.18s;
    }
    .search-shell:focus-within {
      background: var(--bg-card);
      border-color: color-mix(in srgb, var(--accent2) 64%, var(--border));
      box-shadow: 0 0 0 3px var(--accent-glow), 0 18px 56px color-mix(in srgb, var(--shadow-strong) 64%, transparent);
    }
    .search-icon {
      width: 18px;
      height: 18px;
      margin-left: 16px;
      flex: 0 0 auto;
      color: var(--text-dim);
    }
    .blog-search {
      width: 100%;
      min-width: 0;
      padding: 10px;
      appearance: none;
      -webkit-appearance: none;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--text);
      font: inherit;
      font-size: 15px;
    }
    .blog-search::-webkit-search-cancel-button { display: none; }
    .blog-search::placeholder { color: color-mix(in srgb, var(--text-dim) 78%, transparent); }
    .search-key {
      margin-right: 12px;
      padding: 2px 7px;
      flex: 0 0 auto;
      border: 1px solid var(--border);
      border-bottom-color: color-mix(in srgb, var(--border) 60%, var(--text-dim));
      border-radius: 5px;
      background: var(--tint-soft-2);
      color: var(--text-dim);
      font: 11px/1.5 'SF Mono', 'Menlo', 'Consolas', monospace;
    }
    .search-clear {
      margin-right: 8px;
      padding: 6px 8px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    .search-clear:hover { background: var(--tint-medium); color: var(--text); }
    .search-clear:focus-visible,
    .page-button:focus-visible,
    .empty-clear:focus-visible,
    .post-card:focus-visible {
      outline: 2px solid var(--accent2);
      outline-offset: 3px;
    }
    .archive-status {
      grid-area: status;
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 24px;
      margin-top: 0;
      white-space: nowrap;
      color: var(--text-dim);
      font-size: 13px;
    }
    .archive-status-rule {
      width: 24px;
      height: 1px;
      background: var(--border);
    }
    .blog-index .post-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
    }
    .blog-index .post-card {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-width: 0;
      padding: 20px 22px;
    }
    .blog-index .post-meta { margin-bottom: 8px; }
    .blog-index .post-title {
      font-size: 18px;
      line-height: 1.32;
      margin-bottom: 8px;
      overflow-wrap: break-word;
    }
    .blog-index .post-excerpt {
      font-size: 14px;
      line-height: 1.55;
      overflow-wrap: break-word;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .empty-state {
      padding: 38px 24px;
      border: 1px dashed color-mix(in srgb, var(--accent2) 36%, var(--border));
      border-radius: var(--radius-lg);
      text-align: center;
      color: var(--text-dim);
      background: color-mix(in srgb, var(--bg-card) 72%, transparent);
    }
    .empty-state strong { display: block; margin-bottom: 5px; color: var(--text); }
    .empty-clear {
      margin-top: 14px;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--tint-soft);
      color: var(--text);
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
    }
    .empty-clear:hover { border-color: var(--accent2); background: var(--tint-medium); }
    .pagination {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      margin-top: 28px;
      padding-top: 22px;
      border-top: 1px solid var(--border);
    }
    .page-numbers { display: flex; align-items: center; justify-content: center; gap: 6px; }
    .page-ellipsis {
      min-width: 24px;
      color: var(--text-dim);
      text-align: center;
      font-size: 13px;
    }
    .page-button {
      min-width: 36px;
      height: 36px;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--tint-soft-2);
      color: var(--text-dim);
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      transition: color 0.16s, background 0.16s, border-color 0.16s, transform 0.16s;
    }
    .page-button:hover:not(:disabled) {
      color: var(--text);
      background: var(--tint-medium);
      border-color: color-mix(in srgb, var(--accent2) 50%, var(--border));
      transform: translateY(-1px);
    }
    .page-button[aria-current="page"] {
      color: #fff;
      border-color: var(--accent);
      background: var(--accent);
      box-shadow: 0 7px 22px var(--accent-glow);
    }
    .page-button:disabled { opacity: 0.38; cursor: not-allowed; }
    .page-direction { min-width: 86px; }
    @media (max-width: 1040px) {
      .blog-index .post-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 700px) {
      body.blog-index { --wb-footer-width: calc(100% - 40px); }
      .blog-tools {
        grid-template-columns: 1fr;
        grid-template-areas:
          "label"
          "search"
          "status";
        gap: 8px;
      }
      .search-shell { max-width: none; }
      .blog-index .post-list { grid-template-columns: 1fr; }
      .blog-index .post-card { padding: 18px 20px; }
      .pagination { gap: 8px; }
      .page-button { min-width: 32px; height: 34px; padding: 0 8px; }
      .page-direction { min-width: 72px; }
    }
    @media (max-width: 420px) {
      .blog-tools { padding-left: 13px; }
      .search-key { display: none; }
      .pagination { flex-wrap: wrap; justify-content: center; }
      .page-numbers { order: -1; width: 100%; }
      .page-direction { flex: 1 1 40%; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      .post-card, .page-button { transition: none; }
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

function blogIndexScript(pageSize = 24) {
  return `<script>
    (function () {
      const PAGE_SIZE = ${pageSize};
      const searchInput = document.getElementById('blog-search');
      const clearButton = document.getElementById('search-clear');
      const emptyClearButton = document.getElementById('empty-clear');
      const resultsCount = document.getElementById('results-count');
      const pageStatus = document.getElementById('page-status');
      const emptyState = document.getElementById('empty-state');
      const emptyQuery = document.getElementById('empty-query');
      const pagination = document.getElementById('pagination');
      const pageNumbers = document.getElementById('page-numbers');
      const previousButton = document.getElementById('page-previous');
      const nextButton = document.getElementById('page-next');
      const tools = document.getElementById('blog-tools');
      const cards = Array.from(document.querySelectorAll('.post-card'));
      if (!searchInput || !cards.length) return;

      let query = '';
      let currentPage = 1;

      function normalize(value) {
        return String(value || '')
          .normalize('NFD')
          .replace(/[\\u0300-\\u036f]/g, '')
          .toLocaleLowerCase();
      }

      function readUrl() {
        const params = new URLSearchParams(window.location.search);
        query = (params.get('q') || '').trim();
        const requestedPage = Number.parseInt(params.get('page') || '1', 10);
        currentPage = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;
        searchInput.value = query;
      }

      function writeUrl(mode) {
        if (!mode) return;
        const url = new URL(window.location.href);
        if (query) url.searchParams.set('q', query);
        else url.searchParams.delete('q');
        if (currentPage > 1) url.searchParams.set('page', String(currentPage));
        else url.searchParams.delete('page');
        const target = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '') + url.hash;
        window.history[mode + 'State']({}, '', target);
      }

      function pageSequence(total, active) {
        if (total <= 7) return Array.from({ length: total }, function (_, index) { return index + 1; });
        const candidates = [1, total, active - 2, active - 1, active, active + 1, active + 2]
          .filter(function (value) { return value >= 1 && value <= total; });
        const pages = Array.from(new Set(candidates)).sort(function (a, b) { return a - b; });
        const sequence = [];
        pages.forEach(function (value, index) {
          if (index && value - pages[index - 1] > 1) sequence.push('ellipsis-' + value);
          sequence.push(value);
        });
        return sequence;
      }

      function goToPage(page) {
        currentPage = page;
        render('push');
        tools.scrollIntoView({ block: 'start' });
        window.requestAnimationFrame(function () {
          const active = pageNumbers.querySelector('[aria-current="page"]');
          if (active) active.focus({ preventScroll: true });
        });
      }

      function renderPageButtons(totalPages) {
        pageNumbers.replaceChildren();
        pageSequence(totalPages, currentPage).forEach(function (entry) {
          if (typeof entry === 'string') {
            const ellipsis = document.createElement('span');
            ellipsis.className = 'page-ellipsis';
            ellipsis.textContent = '\u2026';
            ellipsis.setAttribute('aria-hidden', 'true');
            pageNumbers.appendChild(ellipsis);
            return;
          }
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'page-button';
          button.textContent = String(entry);
          button.setAttribute('aria-label', 'Go to page ' + entry);
          if (entry === currentPage) button.setAttribute('aria-current', 'page');
          button.addEventListener('click', function () { goToPage(entry); });
          pageNumbers.appendChild(button);
        });
      }

      function render(historyMode) {
        const terms = normalize(query).split(/\\s+/).filter(Boolean);
        const matches = cards.filter(function (card) {
          const haystack = normalize(card.dataset.search);
          return terms.every(function (term) { return haystack.includes(term); });
        });
        const totalPages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
        currentPage = Math.min(currentPage, totalPages);
        const visible = new Set(matches.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE));

        cards.forEach(function (card) { card.hidden = !visible.has(card); });
        clearButton.hidden = !query;
        emptyState.hidden = matches.length !== 0;
        emptyQuery.textContent = query;
        pagination.hidden = matches.length === 0 || totalPages <= 1;
        previousButton.disabled = currentPage === 1;
        nextButton.disabled = currentPage === totalPages;
        resultsCount.textContent = query
          ? matches.length + (matches.length === 1 ? ' note found' : ' notes found')
          : matches.length + (matches.length === 1 ? ' note' : ' notes');
        pageStatus.textContent = matches.length ? 'Page ' + currentPage + ' of ' + totalPages : '';
        renderPageButtons(totalPages);
        writeUrl(historyMode);
      }

      function clearSearch() {
        query = '';
        currentPage = 1;
        searchInput.value = '';
        render('push');
        searchInput.focus();
      }

      searchInput.addEventListener('input', function () {
        query = searchInput.value.trim();
        currentPage = 1;
        render('replace');
      });
      clearButton.addEventListener('click', clearSearch);
      emptyClearButton.addEventListener('click', clearSearch);
      previousButton.addEventListener('click', function () { if (currentPage > 1) goToPage(currentPage - 1); });
      nextButton.addEventListener('click', function () { goToPage(currentPage + 1); });
      window.addEventListener('popstate', function () { readUrl(); render(); });
      document.addEventListener('keydown', function (event) {
        const target = event.target;
        const isEditable = target instanceof HTMLElement && (
          target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
        );
        if (event.key === '/' && !isEditable && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault();
          searchInput.focus();
          searchInput.select();
        }
        if (event.key === 'Escape' && document.activeElement === searchInput) {
          if (searchInput.value) clearSearch();
          else searchInput.blur();
        }
      });

      readUrl();
      render('replace');
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
        <a href="/blog" aria-current="page">Blog</a>
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

function sharedHead({ title, description, canonical, ogType = 'website', ogTitle, ogDescription, twitterTitle, twitterDescription, keywords, jsonLd, extraHead = '' }, site) {
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
  <meta property="og:image:alt" content="WebBrain — Open-source AI browser agent">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escAttr(twitterTitle || ogTitle || title)}">
  <meta name="twitter:description" content="${escAttr(twitterDescription || ogDescription || description)}">
  <meta name="twitter:image" content="${escAttr(twitterImageUrl)}">
  <meta name="twitter:image:alt" content="WebBrain — Open-source AI browser agent">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="canonical" href="${escAttr(canonical)}">
  <!-- Blog is English-only; alternates point to locale homepages. -->
${hreflangLinks(site)}
  ${blogStyle()}${extraHead ? `\n  ${extraHead}` : ''}
${SITE_FOOTER_STYLES}
  ${themeBootstrapScript()}
${PLAUSIBLE_ANALYTICS}
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
      Written by <a href="${escAttr(post.authorUrl)}" target="_blank" rel="noopener">${escHtml(post.author)}</a>. WebBrain is GPL-3.0-or-later and open on <a href="https://github.com/webbrain-one/webbrain" target="_blank" rel="noopener">GitHub</a>.
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
  const cards = posts.map((post) => {
    const searchText = [
      post.title,
      post.cardTitle,
      post.excerpt,
      post.description,
      post.displayDate,
      post.date,
      ...post.keywords,
    ].join(' ');
    return `<a href="${escAttr(post.urlPath)}" class="post-card" data-search="${escAttr(searchText)}">
        <div class="post-meta">${escHtml(post.displayDate)} &middot; ${escHtml(post.readTime)}</div>
        <div class="post-title">${escHtml(post.cardTitle || post.title)}</div>
        <div class="post-excerpt">${escHtml(post.excerpt)}</div>
      </a>`;
  }).join('\n');

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
    extraHead: blogIndexStyle(),
  }, args.site)}
<body class="blog-index">
  <div class="glow-bg"></div>
  ${navHtml()}

  <main>
    <h1 class="sr-only">WebBrain Blog</h1>

    <section class="blog-tools" id="blog-tools" aria-label="Search the blog archive">
      <label class="archive-search-label" for="blog-search">Search the archive</label>
      <div class="search-shell">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="m20 20-4-4"></path>
        </svg>
        <input class="blog-search" id="blog-search" type="search" placeholder="Models, benchmarks, tools…" autocomplete="off" spellcheck="false" aria-controls="post-list">
        <button class="search-clear" id="search-clear" type="button" hidden>Clear</button>
        <kbd class="search-key" aria-hidden="true">/</kbd>
      </div>
      <div class="archive-status" role="status" aria-live="polite" aria-atomic="true">
        <span id="results-count">${posts.length} notes</span>
        <span class="archive-status-rule" aria-hidden="true"></span>
        <span id="page-status"></span>
      </div>
    </section>

    <div class="post-list" id="post-list">
      ${cards}
    </div>

    <div class="empty-state" id="empty-state" hidden>
      <strong>No notes match “<span id="empty-query"></span>”</strong>
      Try a model name, benchmark, or tool instead.
      <div><button class="empty-clear" id="empty-clear" type="button">Clear search</button></div>
    </div>

    <div class="pagination" id="pagination" role="navigation" aria-label="Blog pages" hidden>
      <button class="page-button page-direction" id="page-previous" type="button">Previous</button>
      <div class="page-numbers" id="page-numbers"></div>
      <button class="page-button page-direction" id="page-next" type="button">Next</button>
    </div>
  </main>

  ${footerHtml()}
  ${themeToggleScript()}
  ${languageScript()}
  ${blogIndexScript()}
</body>
</html>
`;
}

function footerHtml() {
  return siteFooter(ENGLISH_STRINGS);
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
