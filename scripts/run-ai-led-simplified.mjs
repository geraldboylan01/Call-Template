// Three concurrent synthetic cases. Each case runs both paired arms sequentially.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { FIRST20_SEMANTIC_CORPUS } from './first20-semantic-corpus.mjs';
import { AI_LED_HOLDOUTS } from './ai-led-holdouts.mjs';
const output = process.env.AI_LED_OUTPUT || 'diagnostics/ai-led-simplified-v1';
await mkdir(output, { recursive: true });
const queue = [1, 2].flatMap(repetition => [...FIRST20_SEMANTIC_CORPUS, ...AI_LED_HOLDOUTS].map(test => ({ id: test.id, repetition })));
const results = [];
async function worker() {
  for (;;) {
    const item = queue.shift(); if (!item) return;
    const path = `${output}/r${item.repetition}/${item.id}`;
    try { const saved = JSON.parse(await readFile(`${path}/summary.json`, 'utf8'));
      if (saved.arms.length === 2) { results.push(saved); continue; }
    } catch {}
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--env-file-if-exists=.env.local', 'scripts/compare-ai-led-simplified.mjs'], {
      env: { ...process.env, AI_LED_CASE: item.id, AI_LED_REPETITION: String(item.repetition), AI_LED_OUTPUT: output },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', data => { log += data; process.stdout.write(data); });
    child.stderr.on('data', data => { log += data; });
    const code = await new Promise(resolve => child.on('exit', resolve));
    await mkdir(path, { recursive: true }); await writeFile(`${path}/run.log`, log);
    if (code) console.log(JSON.stringify({ ...item, harnessExit: code }));
    try { results.push(JSON.parse(await readFile(`${path}/summary.json`, 'utf8'))); } catch {}
    await writeFile(`${output}/batch-summary.json`, JSON.stringify({ finished: results.length, pending: queue.length, results }, null, 2));
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log(JSON.stringify({ completed: results.length, output }));
