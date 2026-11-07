// Browsers shared by the tests of one file.
//
// Launching and closing a browser is the most load-sensitive step of a
// browser suite. On the loaded 2026-11-07 QA runner, a parent test whose four
// subtests took 4.4 s in all spent more than 80 s more launching and closing
// its own browser, and timed out with every subtest passed. Here each engine
// launches in a before hook and closes in an after hook. Each hook has its own
// bounded timeout, so a launch or close that hangs still fails the file, but
// no test's budget pays for it.
//
// One browser cannot serve a whole file, though: Firefox gets slower with
// every context it has served (each new context took 0.6 s at first and 1.6 s
// after 80), so a browser that has served CONTEXTS_PER_BROWSER contexts is
// replaced at the next lease. That launch counts against the test that takes
// the lease; the old browser closes in the background once its last lease is
// done, and the after hook waits for it.
//
// Tests take a lease and use it as they used the Browser: newContext() and
// newPage() open isolated contexts as usual, and the lease's close() closes
// the contexts opened through that lease, and only those, so a test that fails
// half way leaves nothing open for the next one.
import { after, before } from 'node:test';
import { scaled } from './time-budget.mjs';

// Playwright's own launch timeout is 180 s, so its error comes first.
export const BROWSER_LAUNCH_MS = 240000;
export const BROWSER_CLOSE_MS = 120000;
export const CONTEXTS_PER_BROWSER = 25;

class SharedBrowser {
  served = 0;
  leases = 0;
  retired = false;
  #closing = null;
  constructor(browser) { this.browser = browser; }
  close() { return this.#closing ??= this.browser.close(); }
  retire() {
    this.retired = true;
    // A browser that already crashed has failed its tests; only a close that
    // hangs is news, and the after hook's timeout reports that.
    if (!this.leases) this.close().catch(() => {});
  }
}

class BrowserLease {
  #shared;
  #contexts = new Set();
  #released = false;
  constructor(shared) { this.#shared = shared; shared.leases++; }
  #track(context) {
    this.#shared.served++;
    this.#contexts.add(context);
    context.once('close', () => this.#contexts.delete(context));
    return context;
  }
  async newContext(options) { return this.#track(await this.#shared.browser.newContext(options)); }
  // As Browser.newPage: the page owns its own context, which closes with it.
  async newPage(options) {
    const page = await this.#shared.browser.newPage(options);
    this.#track(page.context());
    return page;
  }
  async close() {
    await Promise.all([...this.#contexts].map(context => context.close()));
    if (this.#released) return;
    this.#released = true;
    if (--this.#shared.leases === 0 && this.#shared.retired) this.#shared.close().catch(() => {});
  }
}

// engines: Playwright browser types, such as [chromium, firefox].
export function sharedBrowsers(engines, launchOptions = { headless: true }, { contextsPerBrowser = CONTEXTS_PER_BROWSER } = {}) {
  const current = new Map(), launched = new Set();
  const launch = async engine => {
    const shared = new SharedBrowser(await engine.launch(launchOptions));
    launched.add(shared);
    return shared;
  };
  before(async () => {
    for (const engine of engines) current.set(engine, launch(engine));
    const results = await Promise.allSettled(current.values());
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }, { timeout: scaled(BROWSER_LAUNCH_MS) });
  after(async () => {
    await Promise.allSettled([...launched].map(shared => shared.close()));
  }, { timeout: scaled(BROWSER_CLOSE_MS) });
  return {
    async lease(engine) {
      for (;;) {
        const pending = current.get(engine);
        if (!pending) throw new Error(`No shared ${engine?.name?.() || 'browser'} is running: lease it inside a test.`);
        const shared = await pending;
        if (shared.retired) continue; // another lease replaced it meanwhile
        if (shared.served < contextsPerBrowser) return new BrowserLease(shared);
        shared.retire();
        current.set(engine, launch(engine));
      }
    },
  };
}
