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
    const copyLabel = copy.getAttribute('aria-label');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        copy.classList.add('done');
        copy.setAttribute('aria-label', copy.dataset.copied);
        setTimeout(() => {
          copy.classList.remove('done');
          copy.setAttribute('aria-label', copyLabel);
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

  // The circle at the end of the nav turns the top of the page yellow or red
  // (the rest of the page stays as it is). The <head> script has already
  // applied a remembered choice; here the button follows it, the other hero
  // picture is fetched once the page has loaded, and a switch waits for that
  // picture so the colours and the picture change together.
  const hue = document.querySelector('[data-hue]');
  const photo = document.querySelector('.arch .photo');
  if (hue && photo) {
    const root = document.documentElement;
    const meta = document.querySelector('meta[name="theme-color"]');
    const THEME = { yellow: '#e2aa3a', red: '#9e1b2b' };
    const ready = {};
    const load = (name) => ready[name] ||= new Promise((resolve) => {
      const img = new Image();
      img.src = photo.dataset[name];
      img.decode().then(resolve, resolve);
    });
    const current = () => (root.dataset.hero === 'red' ? 'red' : 'yellow');
    const sync = () => {
      const red = current() === 'red';
      hue.setAttribute('aria-pressed', String(red));
      hue.title = red ? hue.dataset.toYellow : hue.dataset.toRed;
    };
    sync();
    const prefetch = () => setTimeout(() => load(current() === 'red' ? 'yellow' : 'red'), 400);
    if (document.readyState === 'complete') prefetch();
    else addEventListener('load', prefetch, { once: true });

    hue.addEventListener('click', async () => {
      const next = current() === 'red' ? 'yellow' : 'red';
      await load(next);
      const apply = () => {
        root.dataset.hero = next;
        photo.src = photo.dataset[next];
        meta?.setAttribute('content', THEME[next]);
        sync();
      };
      try { localStorage.setItem('murshid-hero', next); } catch {}
      if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        document.startViewTransition(apply);
      } else {
        apply();
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
    // The system's name stays English: in Turkish capitals, Windows would
    // become WİNDOWS.
    const label = get.dataset[os];
    const name = { win: 'Windows', mac: 'macOS', linux: 'Linux' }[os];
    const at = label.indexOf(name);
    const text = get.querySelector('span');
    if (at < 0) text.textContent = label;
    else {
      const word = document.createElement('span');
      word.lang = 'en';
      word.textContent = name;
      text.replaceChildren(label.slice(0, at), word, label.slice(at + name.length));
    }
  }

  // The language menu in the nav (a <details>): close it on a click outside
  // or on Escape, which returns focus to its button.
  const lang = document.querySelector('[data-lang]');
  if (lang) {
    document.addEventListener('click', (event) => {
      if (lang.open && !lang.contains(event.target)) lang.open = false;
    });
    lang.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && lang.open) {
        lang.open = false;
        lang.querySelector('summary').focus();
      }
    });
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
