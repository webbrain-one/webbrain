// Runs halftone.py with the first Python that has what it needs: $PYTHON, then
// python3, python and the Windows py launcher.
//   node scripts/art/halftone.mjs

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'halftone.py');
const candidates = [process.env.PYTHON, 'python3', 'python', 'py'].filter(Boolean);

for (const exe of candidates) {
  const probe = spawnSync(exe, ['-c', 'import cv2, numpy, PIL'], { stdio: 'ignore' });
  if (probe.status !== 0) continue;
  const run = spawnSync(exe, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

console.error('halftone.py needs Python 3 with OpenCV, NumPy and Pillow:\n'
  + '  pip install opencv-python-headless numpy pillow');
process.exit(1);
