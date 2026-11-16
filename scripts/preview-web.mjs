#!/usr/bin/env node
/**
 * Preview the WebBrain marketing site locally.
 *
 * 1. Compiles the site for ALL languages (runs web/build/build.mjs, which
 *    renders web/index.html + web/<locale>/index.html + FAQ pages from
 *    web/build/template.html and web/build/locales/*.json).
 * 2. Serves the resulting web/ directory on localhost so it can be reviewed
 *    in a browser.
 *
 * No npm dependencies — pure Node stdlib.
 *
 * Usage:
 *   node scripts/preview-web.mjs [--port 8000] [--host 127.0.0.1]
 *                                [--no-build] [--open]
 *
 *   --port <n>   Port to listen on (default 8000). If taken, the next free
 *                port is tried automatically unless --strict-port is given.
 *   --host <h>   Interface to bind (default 127.0.0.1).
 *   --no-build   Skip the build step and only serve the existing output.
 *   --open       Open the site in the default browser after starting.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(REPO_ROOT, 'web');
const BUILD_SCRIPT = path.join(WEB_DIR, 'build', 'build.mjs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const opts = {
    port: 8000,
    host: '127.0.0.1',
    build: true,
    open: false,
    strictPort: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length));
    else if (arg === '--host' && argv[i + 1]) opts.host = argv[++i];
    else if (arg.startsWith('--host=')) opts.host = arg.slice('--host='.length);
    else if (arg === '--no-build') opts.build = false;
    else if (arg === '--open') opts.open = true;
    else if (arg === '--strict-port') opts.strictPort = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/preview-web.mjs [--port 8000] [--host 127.0.0.1] [--no-build] [--open]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error(`Invalid --port: ${opts.port}`);
    process.exit(1);
  }
  return opts;
}

function runBuild() {
  return new Promise((resolve, reject) => {
    console.log(`Building site for all languages: node ${path.relative(REPO_ROOT, BUILD_SCRIPT)}`);
    const child = spawn(process.execPath, [BUILD_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`web/build/build.mjs exited with code ${code}`));
    });
  });
}

async function resolveFile(requestPath) {
  // Strip query/hash, decode, and block path traversal.
  const clean = decodeURIComponent(requestPath.split('?')[0].split('#')[0]);
  const joined = path.normalize(path.join(WEB_DIR, clean));
  if (joined !== WEB_DIR && !joined.startsWith(WEB_DIR + path.sep)) return null;

  const candidates = [joined];
  if (!path.extname(joined)) {
    candidates.push(`${joined}.html`);
    candidates.push(path.join(joined, 'index.html'));
  } else if (clean.endsWith('/')) {
    candidates.push(path.join(joined, 'index.html'));
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function formatUrlHost(host) {
  if (host === '0.0.0.0' || host === '::') return 'localhost';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

function startServer(host, port, strictPort) {
  const urlHost = formatUrlHost(host);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${urlHost}:${port}`);
      const file = await resolveFile(url.pathname);
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      const mime = MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const total = (await stat(file)).size;
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m) {
          let start = m[1] === '' ? null : Number(m[1]);
          let end = m[2] === '' ? null : Number(m[2]);
          if (start === null && end !== null) {
            // Suffix range: last N bytes.
            if (end === 0) {
              res.writeHead(416, {
                'Content-Range': `bytes */${total}`,
                'Accept-Ranges': 'bytes',
              });
              res.end();
              return;
            }
            start = Math.max(0, total - end);
            end = total - 1;
          } else if (start !== null && end === null) {
            end = total - 1;
          }
          if (
            start === null || end === null ||
            !Number.isInteger(start) || !Number.isInteger(end) ||
            start < 0 || end < start || start >= total
          ) {
            res.writeHead(416, {
              'Content-Range': `bytes */${total}`,
              'Accept-Ranges': 'bytes',
            });
            res.end();
            return;
          }
          if (end >= total) end = total - 1;
          res.writeHead(206, {
            'Content-Type': mime,
            'Cache-Control': 'no-store',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': end - start + 1,
          });
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          createReadStream(file, { start, end })
            .on('error', (err) => {
              console.error('Stream error:', err.message);
              if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('500 Internal Server Error');
            })
            .pipe(res);
          return;
        }
        // Malformed Range header: fall through to full response.
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
        'Content-Length': total,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(file)
        .on('error', (err) => {
          console.error('Stream error:', err.message);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('500 Internal Server Error');
        })
        .pipe(res);
    } catch (err) {
      console.error('Request error:', err.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && !strictPort) {
        console.warn(`Port ${port} in use, trying ${port + 1}…`);
        startServer(host, port + 1, strictPort).then(resolve, reject);
        return;
      }
      reject(err);
    });
    server.listen(port, host, () => resolve({ server, port }));
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'win32'
    ? `cmd /c start "" "${url}"`
    : platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.warn(`Could not open browser automatically (${err.message}). Open ${url} manually.`);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.build) {
    await runBuild();
  } else {
    console.log('Skipping build (--no-build). Serving existing web/ output.');
  }
  const { server, port } = await startServer(opts.host, opts.port, opts.strictPort);
  const url = `http://${formatUrlHost(opts.host)}:${port}/`;
  console.log(`\nServing ${path.relative(REPO_ROOT, WEB_DIR)}/ at ${url}`);
  console.log('Localized homes: /es/ /fr/ /tr/ /zh/ /ru/ /uk/ /ar/ /ja/ /ko/ /id/ /th/ /ms/ /tl/ /he/ /hi/ /pt/ /vi/ /bn/ /fa/ /nl/ /de/');
  console.log('Press Ctrl+C to stop.');
  if (opts.open) openBrowser(url);

  const shutdown = () => {
    console.log('\nStopping preview server…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
