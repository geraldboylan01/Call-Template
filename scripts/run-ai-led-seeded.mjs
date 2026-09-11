import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
const directory = 'diagnostics/ai-led-seeded-proposals-v1';
const output = 'diagnostics/ai-led-seeded-results-v1';
const selected = new Set((process.env.AI_LED_SEED_CASES || '').split(',').filter(Boolean));
const queue = (await readdir(directory)).filter(x=>x.endsWith('.json') && (!selected.size || selected.has(x.replace(/\.json$/, ''))));
await mkdir(output, { recursive: true });
async function worker() {
  for (;;) {
    const file = queue.shift(); if (!file) return;
    const seedPath = `${directory}/${file}`;
    const seed = JSON.parse(await readFile(seedPath, 'utf8'));
    const child = spawn(process.execPath, ['--env-file=.env.local', 'scripts/compare-ai-led-seeded.mjs'], {
      env: { ...process.env, AI_LED_SEED: seedPath, AI_LED_OUTPUT: output }, stdio: ['ignore','pipe','pipe'] });
    let log=''; child.stdout.on('data',data=>{ log+=data; process.stdout.write(data); });
    child.stderr.on('data',data=>{ log+=data; });
    const code = await new Promise(resolve=>child.on('exit',resolve));
    await writeFile(`${output}/${seed.id}.log`,log);
    console.log(JSON.stringify({seed:seed.id,exit:code}));
  }
}
await Promise.all([worker(), worker()]);
