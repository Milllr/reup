// Puts the two keys only a person has into Infisical, and the Gemini key on the deployed hub.
// Usage: node tools/secrets.mjs             asks for each key with hidden input. Enter skips one.
//        node tools/secrets.mjs --no-push   Infisical only. The deployed hub is left alone.
//        node tools/secrets.mjs --check     says which names are set. Asks for nothing and shows no values.
// Before the first run: infisical login, then infisical init in the repo root.
// A key is never printed, logged or written to a file here. Run this yourself: a key does not belong in a chat.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

/** Where each key goes. path is the Infisical folder, worker is the Cloudflare Worker that reads it once deployed. */
const KEYS = [
  { name: 'GEMINI_API_KEY', what: 'Gemini API key (names a new part). From https://aistudio.google.com/apikey', paths: ['/', '/hub'], worker: join('apps', 'hub') },
  { name: 'TINYFISH_API_KEY', what: 'TinyFish API key (the buyer shops with it)', paths: ['/'], worker: null },
];

/** Runs the Infisical CLI. Its output is kept off the screen: on a change it prints a table of what it stored. */
function infisical(list) {
  const r = spawnSync('infisical', list, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** The first line of what went wrong, with the value taken out in case the CLI echoed it. */
const reason = (text, value) => (text.split(/\r?\n/).find((line) => /error|unable|fail|denied|not /i.test(line)) ?? text.trim().split(/\r?\n/).at(-1) ?? '').split(value).join('[key]').trim();

function ask(label) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(label);
    // What is typed or pasted is not echoed.
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function check() {
  const names = KEYS.map((k) => k.name);
  const code = `console.log(${JSON.stringify(names)}.map((k) => k + ': ' + (process.env[k] ? 'set' : 'missing')).join('\\n'))`;
  const r = spawnSync('infisical', ['run', '--silent', '--', process.execPath, '-e', code], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    console.error('Could not read from Infisical. Run infisical login, then infisical init in the repo root.');
    process.exit(1);
  }
  console.log(r.stdout.trim());
}

async function main() {
  if (spawnSync('infisical', ['--version'], { stdio: 'ignore' }).status !== 0) {
    console.error('The Infisical CLI is not installed. See https://infisical.com/docs/cli/overview');
    process.exit(1);
  }
  if (!['.infisical.json', '.infisical.yaml', '.infisical.yml'].some((f) => existsSync(join(root, f)))) {
    console.error('This repo is not linked to an Infisical project yet. Run these two, then this again:');
    console.error('  infisical login');
    console.error('  infisical init');
    process.exit(1);
  }
  if (args.has('--check')) return check();

  console.log('Paste each key and press Enter. Nothing shows while you paste. Enter alone skips a key.');
  let failed = false;
  for (const key of KEYS) {
    const value = await ask(`${key.what}: `);
    if (value === '') {
      console.log(`  ${key.name}: skipped.`);
      continue;
    }
    if (/\s/.test(value)) {
      console.log(`  ${key.name}: that has a space or a line break in it, so it is not a key. Skipped.`);
      failed = true;
      continue;
    }
    for (const path of key.paths) {
      // A folder that is already there is fine.
      if (path !== '/') infisical(['secrets', 'folders', 'create', '--name', path.slice(1), '--path', '/', '--silent']);
      const set = infisical(['secrets', 'set', `${key.name}=${value}`, '--path', path, '--silent']);
      if (set.ok) console.log(`  ${key.name}: stored in Infisical at ${path}`);
      else {
        failed = true;
        console.log(`  ${key.name}: Infisical did not take it at ${path}. ${reason(set.text, value)}`);
      }
    }
    if (key.worker && !args.has('--no-push')) {
      // The value goes to wrangler on its input, not on the command line.
      const put = spawnSync(`npx wrangler secret put ${key.name}`, { cwd: join(root, key.worker), shell: true, input: `${value}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (put.status === 0) console.log(`  ${key.name}: set on the deployed hub.`);
      else {
        failed = true;
        console.log(`  ${key.name}: the deployed hub did not take it. ${reason(`${put.stdout ?? ''}${put.stderr ?? ''}`, value)}`);
      }
    }
  }
  console.log(failed ? 'Some of it did not go through. See the lines above.' : 'Done. Check with: node tools/secrets.mjs --check');
  process.exit(failed ? 1 : 0);
}

await main();
