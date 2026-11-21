// Compiles and runs the host side C++ tests (edge/qnx/tests/*_test.cpp) with g++.
// These cover the plain C++ logic of the shelf node (reach detection, pocket math) that needs no QNX SDK.
// CI always has g++. On a laptop without it the tests are skipped with a note, so the check still runs on Windows.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here).filter((f) => f.endsWith('_test.cpp'));
if (!tests.length) {
  console.log('No C++ tests yet.');
  process.exit(0);
}
const gxx = process.env.CXX || 'g++';
if (spawnSync(gxx, ['--version'], { stdio: 'ignore' }).status !== 0) {
  if (process.env.CI) {
    console.error(`${gxx} not found in CI.`);
    process.exit(1);
  }
  console.log(`${gxx} not found: skipping ${tests.length} C++ test file(s). CI runs them.`);
  process.exit(0);
}
const out = mkdtempSync(path.join(os.tmpdir(), 'reup-cpp-'));
let failed = 0;
try {
  for (const t of tests) {
    const bin = path.join(out, t.replace(/\.cpp$/, process.platform === 'win32' ? '.exe' : ''));
    const build = spawnSync(gxx, ['-std=c++17', '-Wall', '-Wextra', '-O1', '-I', path.join(here, '..', 'vision', 'src'), '-o', bin, path.join(here, t)], { stdio: 'inherit' });
    if (build.status !== 0) {
      console.error(`FAILED to compile ${t}`);
      failed += 1;
      continue;
    }
    const run = spawnSync(bin, [], { stdio: 'inherit' });
    console.log(`${run.status === 0 ? 'ok    ' : 'FAILED'} ${t}`);
    if (run.status !== 0) failed += 1;
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
