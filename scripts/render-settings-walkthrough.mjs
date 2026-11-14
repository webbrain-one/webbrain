#!/usr/bin/env node
/**
 * Capture the actual Settings UI with a synthetic extension profile, then join
 * scene stills with individually timed narration. No user browser/profile is read.
 *
 * node scripts/render-settings-walkthrough.mjs --capture
 * <generate audio with scripts/narrate-settings-walkthrough.py>
 * node scripts/render-settings-walkthrough.mjs --render
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = resolve(root, '.build/settings-walkthrough');
const assets = resolve(root, 'web/assets');
const basename = 'webbrain-settings-walkthrough';
const { version } = JSON.parse(await readFile(resolve(root, 'src/chrome/manifest.json'), 'utf8'));
const scenes = JSON.parse(await readFile(resolve(root, 'assets/video-scripts/settings-walkthrough-scenes.json'), 'utf8'));
const fps = 25;
const lead = 0.35;
const tail = 0.65;
await mkdir(work, { recursive: true });

function run(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? accept(stdout) : reject(new Error(`${command} exited ${code}\n${stderr}`)));
  });
}

// The same browser-API boundary as the repository's Settings UI tests. Provider
// defaults and all rendering still come from the current product source.
function installProfile({ version }) {
  localStorage.setItem('wbLocale', 'en');
  localStorage.setItem('wbTheme', 'dark');
  localStorage.setItem('wbUiScale', '100');
  const data = { wbLocale: 'en', theme: 'dark', uiScale: 100, activeProvider: 'webbrain_cloud',
    wb_permissions: [
      { host: 'docs.example.com', capability: 'click', action: 'allow' },
      { host: 'mail.example.com', capability: 'type', action: 'deny' },
    ],
  };
  const listeners = [];
  const storage = {
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const names = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      return Object.fromEntries(names.map(key => [key, data[key] ?? (typeof keys === 'object' && !Array.isArray(keys) ? keys[key] : undefined)]));
    },
    async set(values) {
      const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: data[key], newValue }]));
      Object.assign(data, structuredClone(values));
      listeners.forEach(listener => listener(changes, 'local'));
    },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  };
  let managerPromise;
  async function reply(message) {
    if (message.action === 'get_providers') {
      managerPromise ||= import('/src/chrome/src/providers/manager.js').then(async ({ ProviderManager }) => {
        const manager = new ProviderManager();
        await manager.load();
        return manager;
      });
      const manager = await managerPromise;
      return { providers: manager.getAll(), active: 'webbrain_cloud' };
    }
    if (message.action === 'get_user_memory') return { ok: true, enabled: true, records: [] };
    if (message.action === 'get_in_browser_models') return { ok: true, models: [] };
    if (message.action === 'get_webgpu_vision_choice') return { ok: true, choice: 'auto', bonsaiReady: false };
    if (message.action === 'profile_sync_state') return {};
    if (message.action === 'apocalypse_mode') return { enabled: false, archives: [], installedCount: 0, totalBytes: 0, storage: { usage: 0 } };
    return {};
  }
  window.chrome = window.browser = {
    storage: { local: storage, session: { get: async () => ({}) }, onChanged: { addListener: fn => listeners.push(fn) } },
    runtime: {
      id: 'settings-walkthrough', getManifest: () => ({ version }),
      getURL: path => `${location.origin}/src/chrome/${path}`, getPlatformInfo: async () => ({ os: 'win', arch: 'x64' }),
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        const promise = reply(message);
        if (callback) promise.then(callback);
        return promise;
      },
    },
    commands: { getAll: async () => [] }, tabs: { create: async () => ({}) },
  };
}

async function capture() {
  const directory = resolve(work, 'frames');
  await mkdir(directory, { recursive: true });
  const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };
  const server = createServer(async (request, response) => {
    try {
      const file = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
      if (!file.startsWith(root + sep)) throw Error('outside workspace');
      response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: 'dark', reducedMotion: 'reduce' });
    // The capture never calls provider services or downloads optional models.
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await context.addInitScript(installProfile, { version });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/src/chrome/src/ui/settings.html`);
    await page.waitForFunction(() => document.documentElement.dataset.settingsReady === 'true', null, { timeout: 30000 });
    await page.addStyleTag({ content: `
      html { scroll-behavior: auto !important; }
      body { padding-bottom: 200px; }
      .settings-sidebar { max-height: calc(100vh - 104px); }
      [data-walkthrough-focus] { outline: 2px solid #a99cff; outline-offset: 6px; border-radius: 8px; }
      #walkthrough-caption { position: fixed; inset: auto 0 0; height: 78px; z-index: 10000; background: #111320; border-top: 1px solid #44405e; color: #f7f5ff; display: flex; align-items: center; justify-content: space-between; padding: 0 42px; font-family: 'Segoe UI', sans-serif; }
      #walkthrough-caption strong { font-size: 21px; font-weight: 600; }
      #walkthrough-caption small { display: block; margin-bottom: 3px; color: #aaa6bb; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; }
      #walkthrough-caption .number { font-size: 14px; color: #bdb2ff; font-variant-numeric: tabular-nums; }
    ` });
    await page.evaluate(() => { const bar = document.createElement('div'); bar.id = 'walkthrough-caption'; document.body.append(bar); });
    const captures = [];
    for (let index = 0; index < scenes.length; index++) {
      const scene = scenes[index];
      await page.evaluate(() => { document.querySelectorAll('[data-walkthrough-focus]').forEach(el => el.removeAttribute('data-walkthrough-focus')); scrollTo(0, 0); });
      await page.locator(`.tab-btn[data-tab="${scene.tab}"]`).click();
      await page.evaluate(({ title, version, index, total }) => {
        const bar = document.getElementById('walkthrough-caption');
        bar.replaceChildren();
        const labels = document.createElement('div');
        const meta = document.createElement('small'); meta.textContent = `WebBrain ${version} · Settings walkthrough`;
        const heading = document.createElement('strong'); heading.textContent = title;
        labels.append(meta, heading);
        const number = document.createElement('span'); number.className = 'number'; number.textContent = `${String(index + 1).padStart(2, '0')} / ${total}`;
        bar.append(labels, number); scrollTo(0, 0);
      }, { title: scene.title, version, index, total: scenes.length });
      await page.waitForTimeout(160);
      const entry = resolve(directory, `${scene.id}-entry.png`);
      await page.screenshot({ path: entry, animations: 'disabled', caret: 'hide' });
      const focusShots = [];
      for (const [shotIndex, shot] of [{ selector: scene.selector, cue: null }, ...(scene.shots || [])].entries()) {
        await page.evaluate(() => document.querySelectorAll('[data-walkthrough-focus]').forEach(el => el.removeAttribute('data-walkthrough-focus')));
        const target = page.locator(shot.selector).first();
        if (await target.count() !== 1) throw Error(`${scene.id}: missing ${shot.selector}`);
        // Open actual collapsed provider cards/details when the shot needs them.
        await target.evaluate(el => {
          for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.tagName === 'DETAILS') ancestor.open = true;
            if (ancestor.classList.contains('provider-card') && ancestor.classList.contains('collapsed')) ancestor.querySelector('.provider-header')?.click();
          }
        });
        await target.waitFor({ state: 'visible' });
        await target.evaluate(el => {
          const rect = el.getBoundingClientRect();
          const top = rect.top + scrollY;
          if (!el.closest('.settings-sidebar') && (rect.bottom > innerHeight - 100 || rect.top < 24)) scrollTo(0, Math.max(0, top - 90));
          el.setAttribute('data-walkthrough-focus', '');
        });
        await page.mouse.move(0, 0);
        await page.waitForTimeout(120);
        const focus = resolve(directory, `${scene.id}-focus${shotIndex ? '-' + shotIndex : ''}.png`);
        await page.screenshot({ path: focus, animations: 'disabled', caret: 'hide' });
        focusShots.push({ file: focus, cue: shot.cue });
      }
      captures.push({ id: scene.id, entry, focus: focusShots[0].file, shots: focusShots, tab: scene.tab, selector: scene.selector });
      console.log(`Captured ${index + 1}/${scenes.length}: ${scene.title}`);
    }
    if (errors.length) throw Error(`Settings page errors: ${errors.join('\n')}`);
    const sourceHash = createHash('sha256').update(await readFile(resolve(root, 'src/chrome/src/ui/settings.html'))).digest('hex');
    await writeFile(resolve(work, 'captures.json'), JSON.stringify({ version, sourceHash, captures }, null, 2) + '\n');
  } finally { await browser.close(); await new Promise(accept => server.close(accept)); }
}

const stamp = seconds => {
  const millis = Math.round(seconds * 1000);
  return `${String(Math.floor(millis / 3600000)).padStart(2, '0')}:${String(Math.floor(millis / 60000) % 60).padStart(2, '0')}:${String(Math.floor(millis / 1000) % 60).padStart(2, '0')}.${String(millis % 1000).padStart(3, '0')}`;
};
const concatPath = file => file.replaceAll('\\', '/').replaceAll("'", "'\\''");

async function render() {
  const captureManifest = JSON.parse(await readFile(resolve(work, 'captures.json'), 'utf8'));
  const audioManifest = JSON.parse(await readFile(resolve(work, 'audio/manifest.json'), 'utf8'));
  if (captureManifest.version !== version) throw Error('Recapture Settings after a version change');
  const captureById = new Map(captureManifest.captures.map(scene => [scene.id, scene]));
  const audioById = new Map(audioManifest.scenes.map(scene => [scene.id, scene]));
  const clips = resolve(work, 'clips'); await mkdir(clips, { recursive: true });
  const timeline = [];
  let offset = 0;
  for (const scene of scenes) {
    const audio = audioById.get(scene.id), capture = captureById.get(scene.id);
    if (!audio || !capture) throw Error(`Missing audio/capture for ${scene.id}`);
    if (audio.narrationSha256 !== createHash('sha256').update(scene.narration).digest('hex')) throw Error(`Regenerate changed narration for ${scene.id}`);
    const duration = Math.ceil((audio.duration + lead + tail) * fps) / fps;
    timeline.push({ ...scene, audio, capture, start: offset, duration });
    offset += duration;
  }
  for (let index = 0; index < timeline.length; index++) {
    const scene = timeline[index];
    const frames = resolve(clips, `${scene.id}.ffconcat`);
    const words = JSON.parse(await readFile(resolve(root, scene.audio.words), 'utf8'));
    const normalize = text => text.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const shots = [{ file: scene.capture.entry, start: 0 }, { file: scene.capture.focus, start: 1.2 }];
    for (const shot of (scene.capture.shots || []).slice(1)) {
      const index = words.findIndex((_, i) => normalize(words.slice(i, i + 12).map(word => word.text).join(' ')).startsWith(normalize(shot.cue)));
      if (index < 0) throw Error(`${scene.id}: speech cue not found: ${shot.cue}`);
      shots.push({ file: shot.file, start: Math.round((words[index].start + lead) * fps) / fps });
    }
    shots.sort((a, b) => a.start - b.start);
    if (shots.some((shot, index) => index && shot.start <= shots[index - 1].start)) throw Error(`${scene.id}: overlapping shot cues`);
    await writeFile(frames, 'ffconcat version 1.0\n' + shots.map((shot, index) =>
      `file '${concatPath(shot.file)}'\nduration ${((shots[index + 1]?.start ?? scene.duration) - shot.start).toFixed(3)}\n`).join('') +
      `file '${concatPath(shots.at(-1).file)}'\n`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-safe', '0', '-f', 'concat', '-i', frames,
      '-i', resolve(root, scene.audio.file), '-vf', `fps=${fps},format=yuv420p`,
      '-af', `adelay=${lead * 1000}:all=1,loudnorm=I=-16:TP=-1.5:LRA=9,apad`,
      '-t', scene.duration.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '21', '-threads', '4',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '1', '-video_track_timescale', '25000', resolve(clips, `${scene.id}.mp4`)]);
    console.log(`Rendered ${index + 1}/${timeline.length}: ${scene.title}`);
  }
  let chapters = 'WEBVTT\n\n', captions = 'WEBVTT\n\n';
  let metadata = `;FFMETADATA1\ntitle=WebBrain ${version} Settings walkthrough\nartist=WebBrain\ncomment=Current Settings UI; synthetic demonstration profile; English narration\n`;
  for (const scene of timeline) {
    chapters += `${stamp(scene.start)} --> ${stamp(scene.start + scene.duration)}\n${scene.title}\n\n`;
    metadata += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(scene.start * 1000)}\nEND=${Math.round((scene.start + scene.duration) * 1000)}\ntitle=${scene.title.replace(/[=;#\\\n]/g, ' ')}\n`;
    const srt = await readFile(resolve(root, scene.audio.subtitles), 'utf8');
    const time = input => input.split(':').reduce((total, part) => total * 60 + Number(part.replace(',', '.')), 0);
    for (const block of srt.trim().split(/\r?\n\s*\r?\n/)) {
      const lines = block.split(/\r?\n/);
      const timing = lines.findIndex(line => line.includes(' --> '));
      if (timing < 0) continue;
      const [start, end] = lines[timing].split(' --> ').map(time);
      captions += `${stamp(scene.start + lead + start)} --> ${stamp(scene.start + lead + end)}\n${lines.slice(timing + 1).join('\n')}\n\n`;
    }
  }
  await writeFile(resolve(assets, `${basename}-en.vtt`), captions.trimEnd() + '\n');
  await writeFile(resolve(assets, `${basename}-chapters.vtt`), chapters.trimEnd() + '\n');
  const metadataFile = resolve(work, 'chapters.ffmetadata'); await writeFile(metadataFile, metadata);
  const list = resolve(work, 'clips.ffconcat');
  await writeFile(list, 'ffconcat version 1.0\n' + timeline.map(scene => `file '${concatPath(resolve(clips, `${scene.id}.mp4`))}'`).join('\n') + '\n');
  const output = resolve(assets, `${basename}-1080p.mp4`);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-safe', '0', '-f', 'concat', '-i', list, '-i', metadataFile,
    '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', '-metadata:s:a:0', 'language=eng', '-movflags', '+faststart', output]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', timeline[0].capture.entry, '-frames:v', '1', '-q:v', '2', resolve(assets, `${basename}-poster.jpg`)]);
  await writeFile(resolve(work, 'timeline.json'), JSON.stringify({ version, duration: offset, voice: audioManifest.voice,
    scenes: timeline.map(({ id, title, tab, start, duration }) => ({ id, title, tab, start, duration })) }, null, 2) + '\n');
  console.log(`Created ${output}\nDuration: ${offset.toFixed(2)} seconds; ${timeline.length} scenes; ${version}`);
}

if (!process.argv.includes('--render')) await capture();
if (!process.argv.includes('--capture')) await render();
