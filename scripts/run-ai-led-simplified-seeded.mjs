// The four adversarial seeded probes, both arms, run sequentially per seed.
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
// TRACKED FIXTURES, NOT A RUN DIRECTORY. These lived under diagnostics/, which
// is gitignored, so the adversarial comparison could only be reproduced on the
// machine that had generated them -- and a clean checkout found an empty
// directory and reported four probes as zero rather than failing.
const seeds = process.env.AI_LED_SEED_DIR || 'scripts/fixtures/ai-led-seeded';
const output = process.env.AI_LED_OUTPUT || 'diagnostics/ai-led-simplified-seeded-v1';
await mkdir(output, { recursive: true });
const files = (await readdir(seeds)).filter(name => name.endsWith('.json')).sort();
if (files.length === 0) throw new Error(`No seeded probes in ${seeds}: an empty run is not a passing one.`);
const repetition = Number(process.env.AI_LED_REPETITION || 1);
const results = [];
for (const file of files) {
  const seed = JSON.parse(await readFile(`${seeds}/${file}`, 'utf8'));
  const path = `${output}/r${repetition}/${seed.id}`;
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--env-file-if-exists=.env.local', 'scripts/compare-ai-led-simplified-seeded.mjs'], {
    env: { ...process.env, AI_LED_SEED: `${seeds}/${file}`, AI_LED_REPETITION: String(repetition), AI_LED_OUTPUT: output },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', data => { log += data; process.stdout.write(data); });
  child.stderr.on('data', data => { log += data; });
  const code = await new Promise(resolve => child.on('exit', resolve));
  await mkdir(path, { recursive: true }); await writeFile(`${path}/run.log`, log);
  if (code) console.log(JSON.stringify({ seed: seed.id, harnessExit: code }));
  try { results.push(JSON.parse(await readFile(`${path}/summary.json`, 'utf8'))); } catch {}
  await writeFile(`${output}/batch-summary.json`, JSON.stringify({ finished: results.length, results }, null, 2));
}
console.log(JSON.stringify({ completed: results.length, output }));
