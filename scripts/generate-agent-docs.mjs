#!/usr/bin/env node

/**
 * THE ASSISTANT DOCUMENTATION, FROM THE SAME SCHEMA AS THE FORM.
 *
 * Writes, from js/case_application/:
 *
 *   agents/application.schema.json   JSON Schema for local workspace information
 *   agents/openapi.json              OpenAPI 3.1 with no public submission operations
 *   for-ai-assistants/index.html     the question guide and prefill example,
 *                                    between their marker comments
 *
 * Generated files are committed. `--check` fails when any is stale, so a
 * question added to the form cannot leave assistants reading an old list.
 * The examples are built with the real functions, so they are always valid.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildApplicationJsonSchema,
  buildFieldGuide,
  buildPrefillLink,
  prepareAgentApplication
} from '../js/case_application/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE_FILE = path.join(ROOT, 'for-ai-assistants', 'index.html');
const checkOnly = process.argv.includes('--check');

// A made-up household, used only to show the format.
const EXAMPLE_APPLICATION = {
  topics: ['mortgage', 'retirement'],
  question: 'How would overpaying our mortgage compare with increasing pension contributions?',
  upcoming: 'Our fixed rate ends in June 2027.',
  household: { age: 41, partner: 'yes', partnerAge: 39, married: 'yes', children: 'yes' },
  children: [{ age: 9 }, { age: 6 }],
  income: {
    gross: 62000,
    work: 'employee',
    sector: 'private',
    partnerGross: 48000,
    partnerWork: 'employee',
    partnerSector: 'public',
    takeHome: 6100
  },
  spending: { pattern: 'save', saved: 700 },
  home: { status: 'mortgage', value: 420000 },
  mortgage: { balance: 240000, rate: 3.9, rateType: 'fixed', fixedEnds: '2027-06', yearsLeft: 23 },
  savings: { cash: 18000 },
  pensions: [
    { owner: 'you', type: 'company', value: 85000, youPay: 5, youPayUnit: 'pct', employerPays: 5, employerPaysUnit: 'pct', contributing: 'yes' },
    { owner: 'partner', type: 'public' }
  ],
  retirement: { age: 65, partnerAge: 63 },
  unsure: ['mortgage.repayment', 'pensions.1.dbPension']
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderFieldGuide() {
  return buildFieldGuide().map((section) => {
    const meta = [`Shown for ${section.shownFor}.`];
    if (section.intro) meta.push(section.intro);
    if (section.none) meta.push(`If none apply, put "${section.none}" in <code>none</code>.`);
    const rows = section.fields.filter((field) => field.path !== 'videoName').map((field) => {
      if (field.path === 'anythingElse') field = { ...field, question: 'Anything else you want to add?' };
      const notes = [escapeHtml(field.path === 'household.age' ? 'A whole number from 18 to 100.' : field.expects)];
      if (field.when) notes.push(`Only when ${escapeHtml(field.when)}.`);
      if (field.private) notes.push('Private workspace information.');
      return `                  <tr>
                    <td>${escapeHtml(field.question)}</td>
                    <td><code>${escapeHtml(field.path)}</code></td>
                    <td>${notes.join(' ')}</td>
                  </tr>`;
    }).join('\n');
    return `            <div class="guide-section">
              <h3>${escapeHtml(section.title)}</h3>
              <p class="guide-meta">${meta.map((part) => (part.includes('<code>') ? part : escapeHtml(part))).join(' ')}</p>
              <div class="guide-table-wrap">
                <table class="guide-table">
                  <thead>
                    <tr><th scope="col">Question</th><th scope="col">Field</th><th scope="col">Answer</th></tr>
                  </thead>
                  <tbody>
${rows}
                  </tbody>
                </table>
              </div>
            </div>`;
  }).join('\n');
}

function exampleApplication() {
  const prepared = prepareAgentApplication(EXAMPLE_APPLICATION);
  if (prepared.warnings.length > 0) {
    throw new Error(`The documentation example has warnings: ${JSON.stringify(prepared.warnings)}`);
  }
  return prepared.application;
}

function renderExampleLink() {
  const link = buildPrefillLink(exampleApplication());
  return `            <p>For example, for a made-up household:</p>
            <pre class="guide-code"><code>${escapeHtml(link)}</code></pre>`;
}

function replaceBlock(html, name, content) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const from = html.indexOf(start);
  const to = html.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`for-ai-assistants/index.html must contain ${start} and ${end}.`);
  }
  return `${html.slice(0, from)}${start}\n${content}\n            ${html.slice(to)}`;
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  const outputs = new Map();
  const informationSchema = { ...buildApplicationJsonSchema(), title: 'Planéir workspace information', description: 'Fields for a local workspace form preview. This schema does not grant permission or provide a submission endpoint.' };
  delete informationSchema.properties.videoName;
  informationSchema.properties.anythingElse.description = 'Anything else you want to add.';
  informationSchema.properties.mortgage.properties.lender.description = 'Lender. Optional; its name is not needed for the comparison.';
  informationSchema.properties.household.properties.age = { type: 'integer', minimum: 18, maximum: 100, description: 'Your age. A whole number from 18 to 100.' };
  outputs.set(path.join(ROOT, 'agents', 'application.schema.json'), `${JSON.stringify(informationSchema, null, 2)}\n`);
  outputs.set(path.join(ROOT, 'agents', 'openapi.json'), `${JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Planéir workspace preview', version: 'workspace-v1', description: 'No public API submission operations are available. Use the local form preview only with the user’s agreement.' },
    paths: {},
    components: { schemas: { WorkspaceInformation: informationSchema } }
  }, null, 2)}\n`);

  let guide = await readFile(GUIDE_FILE, 'utf8');
  guide = replaceBlock(guide, 'agent-field-guide', renderFieldGuide());
  guide = replaceBlock(guide, 'agent-example-link', renderExampleLink());
  outputs.set(GUIDE_FILE, guide);

  if (checkOnly) {
    const stale = [];
    for (const [file, content] of outputs) {
      if ((await readIfExists(file)) !== content) stale.push(path.relative(ROOT, file));
    }
    if (stale.length > 0) {
      console.error('Assistant documentation is out of date. Run: npm run generate:agent-docs');
      stale.forEach((file) => console.error(`  - ${file}`));
      process.exitCode = 1;
      return;
    }
    console.log('Assistant documentation is up to date.');
    return;
  }

  for (const [file, content] of outputs) {
    if ((await readIfExists(file)) === content) continue;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    console.log(`Wrote ${path.relative(ROOT, file)}`);
  }
  console.log('Assistant documentation generated.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
