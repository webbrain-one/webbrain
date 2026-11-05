(function () {
  const root = document.documentElement;
  const themeButton = document.querySelector('[data-theme-toggle]');
  const sidebarButton = document.querySelector('[data-sidebar-toggle]');
  const sidebar = document.querySelector('.docs-sidebar');

  function preferredTheme() {
    try {
      const saved = localStorage.getItem('webbrain-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (_) {}
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function setTheme(theme, persist) {
    root.dataset.theme = theme;
    if (themeButton) {
      themeButton.setAttribute('aria-label', theme === 'dark' ? 'Use light theme' : 'Use dark theme');
      themeButton.textContent = theme === 'dark' ? '☀' : '☾';
    }
    if (persist) {
      try { localStorage.setItem('webbrain-theme', theme); } catch (_) {}
    }
  }

  setTheme(preferredTheme(), false);
  document.querySelectorAll('[data-copy-target]').forEach(function (button) {
    const target = document.getElementById(button.dataset.copyTarget);
    const status = button.closest('.mcp-quickstart-step')?.querySelector('[data-copy-status]');
    if (!target) return;
    const original = button.textContent;
    let timer;
    function copied() {
      button.textContent = 'Copied!';
      if (status) status.textContent = 'Setup prompt copied.';
      clearTimeout(timer);
      timer = setTimeout(function () {
        button.textContent = original;
        if (status) status.textContent = '';
      }, 2000);
    }
    function fallback() {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
      try {
        if (document.execCommand('copy')) {
          copied();
          return;
        }
      } catch (_) {}
      if (status) status.textContent = 'Select and copy the setup prompt above.';
    }
    button.addEventListener('click', function () {
      clearTimeout(timer);
      button.textContent = original;
      if (status) status.textContent = '';
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(target.textContent.trim()).then(copied, fallback);
      } else {
        fallback();
      }
    });
  });
  themeButton?.addEventListener('click', function () {
    setTheme(root.dataset.theme === 'light' ? 'dark' : 'light', true);
  });

  function normalizeSearchText(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizedPath(value) {
    const url = new URL(value, window.location.href);
    return url.pathname.replace(/index\.html$/, '').replace(/\/+$/, '') + '/';
  }

  function initializeDocsSearch() {
    if (!sidebar) return;

    const isChinese = document.documentElement.lang.toLowerCase().startsWith('zh');
    const copy = isChinese ? {
      label: '搜索文档',
      placeholder: '搜索文档…',
      clear: '清除',
      loading: '正在建立索引…',
      empty: '没有匹配结果。请尝试其他关键词。',
      count: function (shown, total) { return shown < total ? `显示 ${shown} / ${total} 个结果` : `找到 ${total} 个结果`; },
    } : {
      label: 'Search docs',
      placeholder: 'Search docs…',
      clear: 'Clear',
      loading: 'Indexing the guide…',
      empty: 'No matches. Try another term.',
      count: function (shown, total) { return shown < total ? `Showing ${shown} of ${total} results` : `${total} result${total === 1 ? '' : 's'}`; },
    };

    const search = document.createElement('search');
    search.className = 'docs-search';
    search.innerHTML = `
      <label class="docs-search-label" for="docs-search-input">${copy.label}</label>
      <div class="docs-search-control">
        <svg class="docs-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m16.5 16.5 4 4"></path></svg>
        <input id="docs-search-input" type="search" placeholder="${copy.placeholder}" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="docs-search-results" aria-expanded="false">
        <button class="docs-search-clear" type="button" aria-label="${copy.clear}" hidden>×</button>
        <kbd class="docs-search-key" aria-hidden="true">/</kbd>
      </div>
      <div class="docs-search-results" id="docs-search-results" role="listbox" hidden></div>
      <div class="docs-search-status" role="status" aria-live="polite"></div>`;
    sidebar.insertBefore(search, sidebar.firstChild);

    const input = search.querySelector('input');
    const clearButton = search.querySelector('.docs-search-clear');
    const shortcut = search.querySelector('.docs-search-key');
    const results = search.querySelector('.docs-search-results');
    const status = search.querySelector('.docs-search-status');
    let searchIndex = null;
    let indexPromise = null;
    let activeIndex = -1;

    const pageLinks = Array.from(sidebar.querySelectorAll('a[href^="/docs/"]'));
    const pageNames = new Map();
    pageLinks.forEach(function (link) {
      const url = new URL(link.href, window.location.href);
      if (!url.hash) pageNames.set(normalizedPath(url.href), link.textContent.trim());
    });
    const pagePaths = Array.from(pageNames.keys());

    function indexDocument(doc, pagePath) {
      const main = doc.querySelector('.doc-main');
      if (!main) return [];
      const h1 = main.querySelector('h1');
      const pageName = pageNames.get(pagePath)
        || doc.querySelector('.breadcrumb')?.textContent.split('/').pop().trim()
        || h1?.textContent.trim()
        || pagePath;
      const description = doc.querySelector('meta[name="description"]')?.content || '';
      const entries = [{
        title: pageName,
        page: isChinese ? '文档' : 'Guide',
        detail: h1?.textContent.trim() || description,
        url: pagePath,
        text: `${pageName} ${description} ${main.textContent}`,
      }];

      main.querySelectorAll('h2, h3').forEach(function (heading) {
        const section = heading.closest('[id]');
        const id = heading.id || section?.id || '';
        const contextParts = [];
        let sibling = heading.nextElementSibling;
        while (sibling && !sibling.matches('h2, h3')) {
          contextParts.push(sibling.textContent.trim());
          sibling = sibling.nextElementSibling;
        }
        const context = contextParts.filter(Boolean).join(' ');
        entries.push({
          title: heading.textContent.trim(),
          page: pageName,
          detail: contextParts.find(Boolean) || '',
          url: pagePath + (id ? `#${encodeURIComponent(id)}` : ''),
          text: `${heading.textContent} ${pageName} ${context}`,
        });
      });
      return entries;
    }

    async function buildIndex() {
      if (searchIndex) return searchIndex;
      if (indexPromise) return indexPromise;
      status.textContent = copy.loading;
      indexPromise = Promise.all(pagePaths.map(async function (pagePath) {
        try {
          if (pagePath === normalizedPath(window.location.href)) {
            return indexDocument(document, pagePath);
          }
          const response = await fetch(pagePath, { credentials: 'same-origin' });
          if (!response.ok) return [];
          const html = await response.text();
          return indexDocument(new DOMParser().parseFromString(html, 'text/html'), pagePath);
        } catch (_) {
          return [];
        }
      })).then(function (groups) {
        searchIndex = groups.flat();
        status.textContent = '';
        return searchIndex;
      });
      return indexPromise;
    }

    function scoreEntry(entry, query, terms) {
      const title = normalizeSearchText(entry.title);
      const page = normalizeSearchText(entry.page);
      const text = normalizeSearchText(entry.text);
      if (!terms.every(function (term) { return text.includes(term); })) return -1;
      let score = 0;
      if (title === query) score += 120;
      else if (title.startsWith(query)) score += 80;
      else if (title.includes(query)) score += 60;
      if (page.includes(query)) score += 30;
      terms.forEach(function (term) {
        if (title.includes(term)) score += 14;
        if (page.includes(term)) score += 7;
      });
      return score;
    }

    function setActive(index) {
      const options = Array.from(results.querySelectorAll('[role="option"]'));
      if (!options.length) {
        activeIndex = -1;
        input.removeAttribute('aria-activedescendant');
        return;
      }
      activeIndex = (index + options.length) % options.length;
      options.forEach(function (option, optionIndex) {
        option.classList.toggle('is-active', optionIndex === activeIndex);
        option.setAttribute('aria-selected', String(optionIndex === activeIndex));
      });
      const active = options[activeIndex];
      input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    }

    function closeResults() {
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      activeIndex = -1;
    }

    function renderResults(matches, query) {
      results.replaceChildren();
      activeIndex = -1;
      if (!query) {
        status.textContent = '';
        closeResults();
        return;
      }
      results.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      const shown = Math.min(matches.length, 8);
      status.textContent = matches.length ? copy.count(shown, matches.length) : copy.empty;

      matches.slice(0, 8).forEach(function (entry, index) {
        const link = document.createElement('a');
        link.className = 'docs-search-result';
        link.id = `docs-search-option-${index}`;
        link.href = entry.url;
        link.setAttribute('role', 'option');
        link.setAttribute('aria-selected', 'false');
        link.innerHTML = '<span class="docs-search-result-page"></span><strong></strong><span class="docs-search-result-detail"></span>';
        link.querySelector('.docs-search-result-page').textContent = entry.page;
        link.querySelector('strong').textContent = entry.title;
        link.querySelector('.docs-search-result-detail').textContent = entry.detail;
        results.appendChild(link);
      });
    }

    async function updateResults() {
      const query = normalizeSearchText(input.value);
      clearButton.hidden = !query;
      shortcut.hidden = Boolean(query);
      if (!query) {
        renderResults([], '');
        return;
      }
      const index = await buildIndex();
      if (query !== normalizeSearchText(input.value)) return;
      const terms = query.split(' ').filter(Boolean);
      const matches = index
        .map(function (entry) { return { entry: entry, score: scoreEntry(entry, query, terms) }; })
        .filter(function (candidate) { return candidate.score >= 0; })
        .sort(function (a, b) { return b.score - a.score || a.entry.title.localeCompare(b.entry.title); })
        .map(function (candidate) { return candidate.entry; });
      renderResults(matches, query);
    }

    input.addEventListener('focus', buildIndex);
    input.addEventListener('input', updateResults);
    input.addEventListener('keydown', function (event) {
      const options = results.querySelectorAll('[role="option"]');
      if (event.key === 'ArrowDown' && options.length) {
        event.preventDefault();
        setActive(activeIndex + 1);
      } else if (event.key === 'ArrowUp' && options.length) {
        event.preventDefault();
        setActive(activeIndex - 1);
      } else if (event.key === 'Enter' && options.length) {
        event.preventDefault();
        const target = options[activeIndex < 0 ? 0 : activeIndex];
        window.location.assign(target.href);
      } else if (event.key === 'Escape') {
        if (input.value) {
          input.value = '';
          updateResults();
        } else {
          closeResults();
          input.blur();
        }
      }
    });
    clearButton.addEventListener('click', function () {
      input.value = '';
      updateResults();
      input.focus();
    });
    results.addEventListener('click', function () {
      document.body.classList.remove('sidebar-open');
      sidebarButton?.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('pointerdown', function (event) {
      if (!search.contains(event.target)) closeResults();
    });
    document.addEventListener('keydown', function (event) {
      const target = event.target;
      const typing = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target?.isContentEditable;
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  initializeDocsSearch();

  sidebarButton?.addEventListener('click', function () {
    const open = document.body.classList.toggle('sidebar-open');
    sidebarButton.setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('.docs-sidebar a').forEach(function (link) {
    link.addEventListener('click', function () {
      document.body.classList.remove('sidebar-open');
      sidebarButton?.setAttribute('aria-expanded', 'false');
    });
  });
})();
