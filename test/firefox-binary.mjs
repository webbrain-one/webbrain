// Which Firefox the WebDriver BiDi harnesses start. FIREFOX_BINARY wins; then
// the system Firefox (the macOS default place, or `firefox` on PATH); then the
// Firefox build Playwright installed, so a machine with no system Firefox still
// runs the suite instead of failing with spawn ENOENT.
import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const MAC_FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox';

function isFile(file) {
  try { return statSync(file).isFile(); } catch { return false; }
}

function onPath(name) {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE').split(';').filter(Boolean) : [''];
  return (process.env.PATH || '').split(delimiter).filter(Boolean)
    .some(directory => extensions.some(extension => isFile(join(directory, name + extension))));
}

// { binary, source }: source is 'env', 'system', 'playwright' or 'missing'.
export async function firefoxBinary() {
  if (process.env.FIREFOX_BINARY) return { binary: process.env.FIREFOX_BINARY, source: 'env' };
  const system = process.platform === 'darwin' ? MAC_FIREFOX : 'firefox';
  if (process.platform === 'darwin' ? isFile(MAC_FIREFOX) : onPath('firefox')) return { binary: system, source: 'system' };
  try {
    const { firefox } = await import('playwright');
    const bundled = firefox.executablePath();
    if (isFile(bundled)) {
      console.warn(`Firefox is not installed here; using Playwright's Firefox (${bundled}). Set FIREFOX_BINARY to choose another.`);
      return { binary: bundled, source: 'playwright' };
    }
  } catch { /* Playwright or its Firefox is not installed */ }
  // Nothing found: spawn reports ENOENT for the name the harness tried before.
  return { binary: system, source: 'missing' };
}
