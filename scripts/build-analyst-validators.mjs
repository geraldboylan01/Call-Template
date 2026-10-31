import { readFile, writeFile } from 'node:fs/promises';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import { TOOL_CATALOGUE } from '../js/planning/analyst/tool_catalogue.js';
const ajv = new Ajv({ allErrors: true, strict: false, multipleOfPrecision: 8, code: { source: true, esm: true } });
for (const tool of TOOL_CATALOGUE) ajv.addSchema(tool.inputSchema, tool.name);
// Ajv's standalone ESM output uses require() for its small runtime helpers.
// Convert those to static imports so both Node ESM and Workerd can load them.
const output = '// Generated from TOOL_CATALOGUE by build-analyst-validators.mjs; no runtime eval.\n' +
  standaloneCode(ajv, Object.fromEntries(TOOL_CATALOGUE.map(tool => [tool.name, tool.name])))
    .replace(/const (\w+) = require\("([^"]+)"\)\.default;/g, 'import $1Module from "$2.js"; const $1 = $1Module.default || $1Module;');
const target = new URL('../js/planning/analyst/tool_validation.generated.js', import.meta.url);
const existing = await readFile(target, 'utf8').catch(() => '');
if (process.argv.includes('--check')) {
  if (existing !== output) throw new Error('Stale analyst tool validators.');
} else if (existing !== output) await writeFile(target, output);
console.log('Analyst tool validators built from the shared catalogue.');
