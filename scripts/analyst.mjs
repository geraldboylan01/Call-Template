import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { callLocalTool, createLocalCase } from './analyst-local-store.mjs';
import { TOOL_CATALOGUE, refused } from '../js/planning/analyst/contracts.js';
import { listAnalystFixtures, newFixtureCase } from './analyst-fixtures.mjs';

// Native module diagnostics go to stderr; stdout is exactly one JSON result.
console.info = console.warn = console.log = (...args) => console.error(...args);
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    case: { type: 'string' }, input: { type: 'string' }, fixture: { type: 'string' }
  } });
  const [name] = positionals;
  let result;
  if (!name || positionals.length !== 1) result = refused('invalid_input', '/tool', 'Use analyst <tool> --case <directory> --input <file.json>, analyst new-case --fixture <name>, or analyst list-fixtures.');
  else if (name === 'list-fixtures') result = await listAnalystFixtures();
  else if (name === 'new-case') result = await newFixtureCase(values.fixture);
  else if (name === 'init') {
    if (!values.input) throw Object.assign(new Error('Supply a confirmed export JSON file.'), { path: '/input' });
    result = await createLocalCase(JSON.parse(await readFile(values.input, 'utf8')));
  } else {
    if (!values.case) throw Object.assign(new Error('Supply a case directory.'), { path: '/case' });
    const tool = TOOL_CATALOGUE.find(row => row.name === name);
    // Even an unavailable pricing tool needs its route for the shared budget.
    const input = !tool ? null : JSON.parse(await readFile(values.input, 'utf8'));
    result = await callLocalTool(values.case, name, input);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ...refused(error.code ?? 'invalid_input', error.path ?? '/input', error.message),
    ...(error.diagnostics ? { data: { diagnostics: error.diagnostics } } : {}) }) + '\n');
  process.exitCode = 1;
}
