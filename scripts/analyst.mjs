import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { callLocalTool, createLocalCase } from './analyst-local-store.mjs';
import { TOOL_CATALOGUE, refused } from '../js/planning/analyst/contracts.js';

// Native module diagnostics go to stderr; stdout is exactly one JSON result.
console.info = console.warn = console.log = (...args) => console.error(...args);
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    case: { type: 'string' }, input: { type: 'string' }
  } });
  const [name] = positionals;
  let result;
  if (!name || positionals.length !== 1) result = refused('invalid_input', '/tool', 'Use analyst <tool> --case <directory> --input <file.json>, or analyst init --input <confirmed-export.json>.');
  else if (name === 'init') {
    if (!values.input) throw Object.assign(new Error('Supply a confirmed export JSON file.'), { path: '/input' });
    result = await createLocalCase(JSON.parse(await readFile(values.input, 'utf8')));
  } else {
    if (!values.case) throw Object.assign(new Error('Supply a case directory.'), { path: '/case' });
    const tool = TOOL_CATALOGUE.find(row => row.name === name);
    // Unknown/unavailable tools do not read an input file at all. Their calls
    // still enter the case log through the common dispatcher.
    const input = !tool || tool.unavailable ? null : JSON.parse(await readFile(values.input, 'utf8'));
    result = await callLocalTool(values.case, name, input);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify(refused(error.code ?? 'invalid_input', error.path ?? '/input', error.message)) + '\n');
  process.exitCode = 1;
}
