// Turns a local analysis run into a session the app can open: a module for every compiled case the story can link
// to, and the story with its figures, links, "where this comes from" and explainers.
//
//   npm run --silent analyst:open -- private/analyses/<requestId>/<runId>
//
// Reads the run's case file (never changes it), compiles the pinned plan with the current position and every route
// the analyst submitted a story for, and writes `session.json` beside the case file. Nothing leaves this Mac.

import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLocalCase } from './analyst-local-store.mjs';
import { caseRefusal } from '../js/planning/analyst/case_file.js';
import { compileCaseStories } from '../js/planning/analyst/compilation.js';
import { buildSessionFromPlan } from '../js/plan_story_compiled.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// The engines write their own diagnostics; this command's output is its own.
console.info = console.warn = console.log = (...args) => console.error(...args);
const say = (text) => process.stdout.write(`${text}\n`);
const stop = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };

const [directory] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (!directory) stop('Use: npm run analyst:open -- private/analyses/<requestId>/<runId>');

let run;
try { run = await readLocalCase(directory); }
catch (error) { stop(`Cannot open that case: ${error.message}`); }
const { path, caseFile } = run;

const refusal = await caseRefusal(caseFile);
if (refusal) stop(`This case cannot be used: ${refusal.refusals[0].message}`);

const stories = caseFile.storyDrafts ?? {};
const routeIds = Object.keys(stories);
if (!routeIds.length) stop('No story has been submitted for this case yet. Submit one with submit_story, then run this again.');

const alternatives = routeIds.filter((id) => id !== 'current');
const missing = alternatives.filter((id) => !caseFile.routeDrafts?.[id]?.route);
if (missing.length) stop(`Route ${missing.join(', ')} has a story but no priced draft. Price it with price_route first.`);

let compiled;
try { ({ compilation: compiled } = await compileCaseStories(caseFile, stories)); }
catch (error) { stop(`The plan did not compile: ${JSON.stringify(error.diagnostics ?? error.message)}`); }

let session;
try { session = buildSessionFromPlan(compiled, stories, { clientName: caseFile.pinned.profile?.displayName ?? compiled.clientName }); }
catch (error) { stop(`The story cannot be shown: ${error.message}`); }

const file = join(path, 'session.json');
await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
const where = relative(root, file);
const figures = Object.values(session.planStory.registries).reduce((total, registry) => total + Object.values(registry).filter((fact) => fact.source.chapter).length, 0);

say(`Wrote ${where}`);
say(`  ${session.planStory.routes.length} route${session.planStory.routes.length === 1 ? '' : 's'} (${session.planStory.routes.map((route) => route.id).join(', ')}), stories for ${routeIds.join(', ')}; ${session.modules.length} modules.`);
say(`  ${figures} figures can link into a module.`);
say('');
say('To open it in the local app:');
say('  1. Serve this folder:   node scripts/dev-static-server.mjs      (http://localhost:8788)');
say('     and run the local worker from worker/ as the README describes, so you can sign in to the advisor app.');
say(`  2. Open:                http://localhost:8788/dev/plan-story-open.html?session=/${where}`);
say('');
say('That page puts the session into the local app’s browser storage and opens the app on the story.');
say('It replaces the session that is there now, and asks first if there is one.');
