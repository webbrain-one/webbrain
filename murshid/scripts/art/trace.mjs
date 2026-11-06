// Runs trace.py with the first Python that has what it needs: $PYTHON, then
// python3, python and the Windows py launcher.
//   node scripts/art/trace.mjs [portrait|semazen|all] [--debug=DIR]

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'trace.py');
const candidates = [process.env.PYTHON, 'python3', 'python', 'py'].filter(Boolean);

for (const exe of candidates) {
  const probe = spawnSync(exe, ['-c', 'import cv2, numpy, scipy, skimage'], { stdio: 'ignore' });
  if (probe.status !== 0) continue;
  const run = spawnSync(exe, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

console.error('trace.py needs Python 3 with OpenCV, NumPy, SciPy and scikit-image:\n'
  + '  pip install opencv-python-headless numpy scipy scikit-image\n'
  + 'or point PYTHON at an interpreter that has them.');
process.exit(1);
