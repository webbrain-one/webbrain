/**
 * The Research section: /research/ (a mosaic of WebBrain's research lines)
 * and one page per line at /research/<slug>/.
 *
 * Content lives in web/build/research.json; this module turns it into the
 * {{research_*}} placeholders that web/build/research-template.html expects.
 * Pages are English-only, like the websites page.
 */

export const RESEARCH_PATH = '/research/';

const HF = 'https://huggingface.co/';

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Inline markup for copy: **bold** and [label](url); everything else is escaped. */
function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      const external = /^https?:/.test(url);
      return `<a href="${url}"${external ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`;
    });
}

function formatCount(n) {
  const value = Number(n) || 0;
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(value);
}

export function researchPathFor(slug) {
  return slug ? `${RESEARCH_PATH}${slug}/` : RESEARCH_PATH;
}

/** Totals across every listed Hugging Face repo (models and datasets). */
export function researchTotals(data) {
  const repos = new Map();
  for (const project of data.projects) {
    for (const repo of [...(project.models || []), ...(project.datasets || [])]) {
      repos.set(repo.id, repo);
    }
  }
  let downloads = 0;
  let likes = 0;
  for (const repo of repos.values()) {
    downloads += Number(repo.downloads) || 0;
    likes += Number(repo.likes) || 0;
  }
  return { repos: repos.size, downloads, likes };
}

/** Small pictures for tiles: each draws the idea of its research line. */
const VISUALS = {
  ternary: () => {
    // A weight matrix after ternary quantization: every value is -1, 0 or +1.
    const pattern = '+0-+00-+-0+0+-00+-+0-0+0-+0+-0-+00+-+0+-0+-00+0-+-0+00-+';
    const cells = [...pattern.slice(0, 48)].map((ch) => {
      const cls = ch === '+' ? 'pos' : ch === '-' ? 'neg' : 'zero';
      const label = ch === '+' ? '+1' : ch === '-' ? '−1' : '0';
      return `<span class="tv-${cls}">${label}</span>`;
    }).join('');
    return `<div class="viz viz-ternary" aria-hidden="true">${cells}</div>`;
  },
  routing: () => `<div class="viz viz-routing" aria-hidden="true">
      <span class="vr-in">“Add the cheapest one to my cart”</span>
      <span class="vr-arrow"></span>
      <span class="vr-tools"><b>click_ax</b><i>type_ax</i><i>read_page</i><i>scroll</i></span>
    </div>`,
  vld: () => `<div class="viz viz-vld" aria-hidden="true">
      <span class="vv-shot"><i></i><i></i><i></i><b></b></span>
      <span class="vv-plus">+</span>
      <span class="vv-text">“log in”</span>
      <span class="vv-arrow"></span>
      <span class="vv-out">click(412, 286)</span>
    </div>`,
  bars: (tile) => {
    const rows = (tile.bars || []).map((bar) => `<span class="vb-row${bar.highlight ? ' is-ours' : ''}">
        <span class="vb-label">${esc(bar.label)}</span>
        <span class="vb-track"><span class="vb-fill" style="width:${Math.max(4, Math.min(100, Number(bar.value) / Number(tile.barMax || 100) * 100)).toFixed(1)}%"></span></span>
        <span class="vb-value">${esc(bar.display || bar.value)}</span>
      </span>`).join('');
    return `<div class="viz viz-bars" aria-hidden="true">${rows}</div>`;
  },
  eye: () => `<div class="viz viz-eye" aria-hidden="true"><span class="ve-model">LLM</span><span class="ve-plus">+</span><span class="ve-eye"><i></i></span></div>`,
  shield: () => `<div class="viz viz-shield" aria-hidden="true"><span></span></div>`,
  bits: () => `<div class="viz viz-bits" aria-hidden="true">
      <span style="--w:100%"><b>BF16</b></span>
      <span style="--w:50%"><b>FP8</b></span>
      <span style="--w:25%"><b>NVFP4</b></span>
      <span style="--w:10%"><b>1.58-bit</b></span>
    </div>`,
  crosshair: () => `<div class="viz viz-crosshair" aria-hidden="true">
      <span class="vc-screen"><i></i><i></i><i></i><b></b><em></em></span>
      <span class="vc-out">click(640, 412)</span>
    </div>`,
  decision: () => `<div class="viz viz-decision" aria-hidden="true">
      <span class="vd-q">Is the cart ready to check out?</span>
      <span class="vd-a"><b>yes</b><i>no</i></span>
    </div>`,
  unified: () => `<div class="viz viz-unified" aria-hidden="true">
      <div class="vu-stack">
        <span class="vu-pill is-accent">Vision + Tools</span>
        <span class="vu-pill is-ok">pplx-decider</span>
        <span class="vu-pill is-ink">Heretic 0/8</span>
        <span class="vu-pill">15 MTP tensors</span>
      </div>
      <div class="vu-vram">
        <div class="vu-vram-head"><span>16 GB GPU fit (weights + vision)</span><b>11.95 / 16 GB</b></div>
        <div class="vu-vram-track">
          <span class="vu-seg-model" style="width:69.3%"></span>
          <span class="vu-seg-proj" style="width:5.4%"></span>
        </div>
        <div class="vu-vram-foot">
          <span><strong>IQ3_XXS</strong> 11.09 GB + <strong>mmproj</strong> 0.86 GB</span>
          <span>~4 GB free for KV cache</span>
        </div>
      </div>
      <div class="vu-formats">
        <span>imatrix GGUF (16–24 GB)</span>
        <span>AutoRound INT4 (Arc B70)</span>
        <span>NVFP4 + FP8 (Blackwell)</span>
        <span>BF16</span>
      </div>
    </div>`,
};

function renderTile(project) {
  const tile = project.tile || {};
  const visual = VISUALS[tile.visual] ? VISUALS[tile.visual](tile) : '';
  const stats = (tile.stats || []).map((stat) => `<span class="tile-stat"><b>${esc(stat.value)}</b><span>${esc(stat.label)}</span></span>`).join('');
  const body = `<span class="tile-kind">${esc(project.kind)}</span>
      <h2>${esc(project.name)}</h2>
      <p>${inline(project.summary)}</p>`;
  const tail = `${stats ? `<span class="tile-stats">${stats}</span>` : ''}
      <span class="tile-more">Read the introduction</span>`;
  if (tile.size === 'full') {
    return `<a class="tile tile-full" href="${researchPathFor(project.slug)}">
      <div class="tile-lead">
        ${body}
        ${tail}
      </div>
      ${visual}
    </a>`;
  }
  return `<a class="tile tile-${esc(tile.size || 'm')}" href="${researchPathFor(project.slug)}">
      ${body}
      ${visual}
      ${tail}
    </a>`;
}

function renderIndex(data) {
  const totals = researchTotals(data);
  const tiles = data.projects.map(renderTile).join('\n    ');
  const ideas = (data.index.principles || []).map((p) => `<li><h3>${esc(p.title)}</h3><p>${inline(p.body)}</p></li>`).join('\n      ');
  return `  <section class="research-hero" aria-labelledby="research-title">
    <div>
      <p class="kicker">${esc(data.index.kicker)}</p>
      <h1 id="research-title">${esc(data.index.title)}</h1>
    </div>
    <div class="research-lede">
      ${(data.index.lede || []).map((p) => `<p>${inline(p)}</p>`).join('\n      ')}
      <p class="research-totals"><span><b>${totals.repos}</b> open models and datasets</span><span><b>${formatCount(totals.downloads)}</b> downloads</span><span><b>${formatCount(totals.likes)}</b> likes</span><span class="research-asof">on <a href="${HF}webbrain-one" target="_blank" rel="noopener">Hugging Face</a>, ${esc(data.statsAsOf)}</span></p>
    </div>
  </section>

  <section class="mosaic" aria-label="Research lines">
    ${tiles}
  </section>

  <section class="principles" aria-labelledby="principles-title">
    <h2 id="principles-title">${esc(data.index.principlesTitle)}</h2>
    <ul>
      ${ideas}
    </ul>
  </section>`;
}

function renderRepoList(title, repos) {
  if (!repos || !repos.length) return '';
  const items = repos.map((repo) => `<li>
          <a href="${HF}${repo.dataset ? 'datasets/' : ''}${esc(repo.id)}" target="_blank" rel="noopener"><code>${esc(repo.id.replace(/^webbrain-one\//, ''))}</code></a>
          <span class="repo-note">${inline(repo.note || '')}</span>
          <span class="repo-stats">${formatCount(repo.downloads)} downloads · ${formatCount(repo.likes)} likes</span>
        </li>`).join('\n        ');
  return `<section class="detail-block">
      <h2>${esc(title)}</h2>
      <ul class="repo-list">
        ${items}
      </ul>
    </section>`;
}

function renderResults(results) {
  if (!results) return '';
  const head = results.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('');
  const rows = results.rows.map((row) => `<tr${row.highlight ? ' class="is-ours"' : ''}>${row.cells.map((cell, i) => (i === 0 ? `<th scope="row">${inline(cell)}</th>` : `<td>${inline(cell)}</td>`)).join('')}</tr>`).join('\n          ');
  return `<section class="detail-block">
      <h2>${esc(results.title || 'Results')}</h2>
      <div class="table-wrap">
        <table>
          <thead><tr>${head}</tr></thead>
          <tbody>
          ${rows}
          </tbody>
        </table>
      </div>
      ${results.note ? `<p class="table-note">${inline(results.note)}</p>` : ''}
    </section>`;
}

function renderDetail(data, project) {
  const page = project.page || {};
  const stats = (page.stats || project.tile?.stats || []).map((stat) => `<div><b>${esc(stat.value)}</b><span>${esc(stat.label)}</span></div>`).join('');
  const sections = (page.sections || []).map((section) => `<section class="detail-block">
      <h2>${esc(section.heading)}</h2>
      ${section.paragraphs.map((p) => `<p>${inline(p)}</p>`).join('\n      ')}
    </section>`).join('\n    ');
  const caveats = page.caveats?.length
    ? `<section class="detail-block caveats">
      <h2>Caveats</h2>
      <ul>${page.caveats.map((c) => `<li>${inline(c)}</li>`).join('')}</ul>
    </section>`
    : '';
  const posts = (project.posts || []).map((post) => `<li><a href="/blog/${esc(post.slug)}/">${esc(post.title)}</a><span>${esc(post.date)}</span></li>`).join('');
  const links = (project.links || []).map((link) => `<a class="detail-link" href="${esc(link.url)}"${/^https?:/.test(link.url) ? ' target="_blank" rel="noopener"' : ''}>${esc(link.label)}</a>`).join('');
  const index = data.projects.findIndex((p) => p.slug === project.slug);
  const next = data.projects[(index + 1) % data.projects.length];
  return `  <nav class="crumbs" aria-label="Breadcrumb"><a href="${RESEARCH_PATH}">Research</a><span aria-hidden="true">/</span><span>${esc(project.name)}</span></nav>
  <section class="detail-hero" aria-labelledby="detail-title">
    <div>
      <p class="kicker">${esc(project.kind)}</p>
      <h1 id="detail-title">${esc(project.name)}</h1>
      <p class="detail-lede">${inline(page.lede || project.summary)}</p>
      ${links ? `<div class="detail-links">${links}</div>` : ''}
    </div>
    ${stats ? `<div class="detail-stats">${stats}</div>` : ''}
  </section>

  <div class="detail-body">
    ${page.why ? `<section class="detail-block why"><h2>Why it matters</h2><p>${inline(page.why)}</p></section>` : ''}
    ${sections}
    ${renderResults(page.results)}
    ${renderRepoList('Models', project.models)}
    ${renderRepoList('Datasets', project.datasets)}
    ${caveats}
    ${posts ? `<section class="detail-block"><h2>Read more on the blog</h2><ul class="post-list">${posts}</ul></section>` : ''}
  </div>

  <nav class="detail-next" aria-label="More research">
    <a href="${RESEARCH_PATH}">All research</a>
    <a href="${researchPathFor(next.slug)}">Next: ${esc(next.name)}</a>
  </nav>`;
}

function jsonLd(value) {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c');
}

/**
 * Every Research page, ready for applyTemplate(): [{ path, slug, html }].
 * `origin` is the site origin used for canonical URLs.
 */
export function renderResearchPages(template, data, { origin, styles }) {
  const pages = [];
  const fill = (main, { title, description, slug, ld }) => template
    .replace(/\{\{research_title\}\}/g, () => esc(title))
    .replace(/\{\{research_description\}\}/g, () => esc(description))
    .replace(/\{\{research_jsonld\}\}/g, () => jsonLd(ld))
    .replace(/\{\{research_styles\}\}/g, () => styles)
    .replace(/\{\{research_nav_current\}\}/g, () => (slug ? '' : ' aria-current="page"'))
    .replace(/\{\{page_url\}\}/g, () => `${origin}${researchPathFor(slug)}`)
    .replace(/\{\{research_main\}\}/g, () => main);

  pages.push({
    slug: '',
    html: fill(renderIndex(data), {
      title: data.index.metaTitle,
      description: data.index.metaDescription,
      slug: '',
      ld: {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: data.index.metaTitle,
        url: `${origin}${RESEARCH_PATH}`,
        description: data.index.metaDescription,
        publisher: { '@type': 'Organization', name: 'WebBrain', url: `${origin}/` },
      },
    }),
  });
  for (const project of data.projects) {
    pages.push({
      slug: project.slug,
      html: fill(renderDetail(data, project), {
        title: `${project.name} — WebBrain Research`,
        description: project.summary.replace(/\*\*|\[|\]\([^)]*\)/g, ''),
        slug: project.slug,
        ld: {
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: project.name,
          url: `${origin}${researchPathFor(project.slug)}`,
          description: project.summary.replace(/\*\*|\[|\]\([^)]*\)/g, ''),
          author: { '@type': 'Organization', name: 'WebBrain', url: `${origin}/` },
        },
      }),
    });
  }
  return pages;
}
