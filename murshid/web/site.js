// Murshid homepage: pick the visitor's system in the terminal and the platform
// cards, copy the commands, and reveal sections as they scroll in.

(() => {
  const ua = navigator.userAgent;
  const os = /Mac|iPhone|iPad/.test(ua) ? 'mac' : /Linux|Android|CrOS/.test(ua) ? 'linux' : 'win';

  // The murshid branch lives on esokullu/webbrain until it is merged.
  const REPO = 'https://github.com/esokullu/webbrain.git';
  // "Exclude binaries": only the latest commit, and only the folders Murshid
  // runs from (murshid/ and the WebBrain extension in src/chrome), so the
  // history, release zips, videos and test fixtures are never downloaded.
  const FAST_CLONE = `git clone --depth 1 --filter=blob:none --sparse -b murshid ${REPO}`;
  const COMMANDS = {
    fast: {
      win: `${FAST_CLONE}\ncd webbrain; git sparse-checkout set murshid src/chrome\ncd murshid; npm install; npm start`,
      mac: `${FAST_CLONE}\ncd webbrain && git sparse-checkout set murshid src/chrome\ncd murshid && npm install && npm start`,
      linux: `${FAST_CLONE}\ncd webbrain && git sparse-checkout set murshid src/chrome\ncd murshid && npm install && npm start`,
    },
    full: {
      win: `git clone -b murshid ${REPO}\ncd webbrain\\murshid; npm install; npm start`,
      mac: `git clone -b murshid ${REPO}\ncd webbrain/murshid && npm install && npm start`,
      linux: `git clone -b murshid ${REPO}\ncd webbrain/murshid && npm install && npm start`,
    },
  };

  const terminal = document.querySelector('[data-terminal]');
  if (terminal) {
    const code = terminal.querySelector('[data-cmd]');
    const tabs = [...terminal.querySelectorAll('[data-os]')];
    const fast = terminal.querySelector('[data-fast]');
    const note = terminal.querySelector('[data-fast-note]');
    let which = os;
    const show = () => {
      tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.os === which)));
      code.textContent = COMMANDS[fast.checked ? 'fast' : 'full'][which];
      note.hidden = !fast.checked;
    };
    tabs.forEach((tab) => tab.addEventListener('click', () => { which = tab.dataset.os; show(); }));
    fast.addEventListener('change', show);
    show();

    const copy = terminal.querySelector('.copy');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        copy.classList.add('done');
        copy.setAttribute('aria-label', 'Copied');
        setTimeout(() => {
          copy.classList.remove('done');
          copy.setAttribute('aria-label', 'Copy commands');
        }, 1600);
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
  }

  document.querySelector(`[data-platform="${os}"]`)?.classList.add('is-you');

  // Visitors get their installer straight from the hero
  // (on Linux, the AppImage, which runs on any distribution).
  const get = document.querySelector('[data-get]');
  const installer = document.querySelector(`[data-platform="${os}"] .download`);
  if (get && installer) {
    get.href = installer.getAttribute('href');
    get.setAttribute('download', '');
    get.firstChild.textContent = `Download for ${{ win: 'Windows', mac: 'macOS', linux: 'Linux' }[os]} `;
  }

  const targets = document.querySelectorAll('.card, .steps li, .platform, .section-head, .tray-inner > *');
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      }
    }, { rootMargin: '0px 0px -8% 0px' });
    targets.forEach((el, i) => {
      el.classList.add('reveal');
      el.style.transitionDelay = `${(i % 3) * 80}ms`;
      io.observe(el);
    });
  }
})();
