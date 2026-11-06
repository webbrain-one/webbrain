// Murshid homepage: pick the visitor's system in the terminal and the platform
// cards, copy the commands, and reveal sections as they scroll in.

(() => {
  const ua = navigator.userAgent;
  const os = /Mac|iPhone|iPad/.test(ua) ? 'mac' : /Linux|Android|CrOS/.test(ua) ? 'linux' : 'win';

  const COMMANDS = {
    win: 'git clone -b murshid https://github.com/webbrain-one/webbrain.git\ncd webbrain\\murshid; npm install; npm start',
    mac: 'git clone -b murshid https://github.com/webbrain-one/webbrain.git\ncd webbrain/murshid && npm install && npm start',
    linux: 'git clone -b murshid https://github.com/webbrain-one/webbrain.git\ncd webbrain/murshid && npm install && npm start',
  };

  const terminal = document.querySelector('[data-terminal]');
  if (terminal) {
    const code = terminal.querySelector('[data-cmd]');
    const tabs = [...terminal.querySelectorAll('[data-os]')];
    const select = (which) => {
      tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.os === which)));
      code.textContent = COMMANDS[which];
    };
    tabs.forEach((tab) => tab.addEventListener('click', () => select(tab.dataset.os)));
    select(os);

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
