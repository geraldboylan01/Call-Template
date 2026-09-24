#!/usr/bin/env node
// Local semantic discovery and packaging. Uses the same pipeline and compiler as
// the app, without a server, remote model, or hand-exported target list.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCasePack } from '../js/module_pipeline.js';
import { importSession } from '../js/state.js';
import { buildPresentationCatalogue, buildLivePresenterBrief, fingerprint } from '../js/presenter_catalogue.js';
import { compilePresentation, annotateScript, validateAnnotatedScript } from '../js/presenter_package.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window ??= { crypto: globalThis.crypto };
export function loadPresentationSession(raw) {
  if (!raw.casePackVersion && raw.modules?.every(m => m.id && m.generated)) {
    return importSession({ version: 1, sessionId: 'presenter-local', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...raw,
      order: raw.order || raw.modules.map(m => m.id), activeModuleId: raw.activeModuleId || raw.modules[0]?.id });
  }
  const checked = checkCasePack(raw);
  if (!checked.ok) throw new Error(JSON.stringify({ errors: checked.errors, modules: checked.modules.filter(m => !m.ok).map(m => ({ title: m.title, error: m.error })) }));
  const modules = checked.modules.map(m => m.module);
  return importSession({ version: 1, sessionId: 'presenter-local', clientName: checked.clientName, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', modules, order: modules.map(m => m.id), activeModuleId: modules[0]?.id });
}
const json = value => JSON.stringify(value, null, 2) + '\n';
export async function preparePreview(session, directory) {
  await mkdir(directory, { recursive: true });
  const html = (await readFile(path.join(root, 'app/index.html'), 'utf8'))
    .replaceAll('="../', '="/')
    .replace('<script type="module" src="/js/app_entry.js"></script>', '<script type="module" src="./preview.js"></script>');
  await writeFile(path.join(directory, 'index.html'), html);
  await writeFile(path.join(directory, 'session.json'), json(session));
  await writeFile(path.join(directory, 'preview.js'), `// Same application shell, renderer and production controller; local-only case bootstrap.\nwindow.__CALL_CANVAS_AUTO_INIT__ = false;\nconst { initApp } = await import('/js/app.js');\nconst read = async name => { const r = await fetch(new URL(name, import.meta.url)); if (!r.ok) throw new Error(name + ': ' + r.status); return r; };\ntry {\n await initApp({ initialSession: await (await read('session.json')).json(), readOnly: true, persistLocalSession: false, enablePresenter: true });\n window.planeirPresenter.load(await (await read('presentation.json')).json(), await (await read('script.md')).text());\n await window.planeirPresenter.start();\n} catch (e) { console.error(e); const p=document.createElement('pre'); p.textContent=e.message; document.body.prepend(p); }\n`);
}
async function main() {
  const [command, source, destination] = process.argv.slice(2);
  if (!['discover', 'prepare', 'validate'].includes(command) || !source) throw new Error('Usage: node scripts/presenter-package.mjs discover <case-pack-or-session.json> [output-directory]\n       node scripts/presenter-package.mjs prepare <case-pack-or-session.json> <output-directory>\n       node scripts/presenter-package.mjs validate <package-directory>');
  if (command === 'validate') {
    const [session, pkg, script] = await Promise.all(['session.json', 'presentation.json', 'script.md'].map(async name => {
      const s = await readFile(path.join(source, name), 'utf8'); return name.endsWith('.json') ? JSON.parse(s) : s;
    }));
    const catalogue = buildPresentationCatalogue(loadPresentationSession(session)), compiled = compilePresentation(pkg, catalogue, script);
    const annotated = annotateScript(script, compiled); validateAnnotatedScript(script, annotated, compiled);
    await writeFile(path.join(source, 'script-presenter.md'), annotated);
    const result = { version: 1, deterministic: { status: 'passed', caseFingerprint: catalogue.caseFingerprint, scriptHash: fingerprint(script), stepCount: compiled.steps.length, cueCount: compiled.cues.length }, narrative: compiled.narrative, live: { status: 'not-run', instruction: 'Run window.planeirPresenter.validateLive() in the loaded app and retain its returned evidence.' }, unmapped: compiled.unmapped };
    await writeFile(path.join(source, 'validation-structural.json'), json(result));
    console.log(json(result)); return;
  }
  const priorInfo = console.info; console.info = () => {};
  let session;
  try { session = loadPresentationSession(JSON.parse(await readFile(source, 'utf8'))); } finally { console.info = priorInfo; }
  const catalogue = buildPresentationCatalogue(session);
  if (catalogue.errors.length) throw new Error(catalogue.errors.join('\n'));
  if (destination) {
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'catalogue.json'), json(catalogue));
    await writeFile(path.join(destination, 'live-presenter-brief.json'), json(buildLivePresenterBrief(catalogue)));
    if (command === 'prepare') await preparePreview(session, destination);
    console.log(json({ status: 'discovered', modules: catalogue.modules.length, targets: catalogue.targets.length, caseFingerprint: catalogue.caseFingerprint, directory: path.resolve(destination) }));
  } else console.log(json(catalogue));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
