import { mkdir, readFile, writeFile, rename, unlink, lstat, open } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCaseFile, caseRefusal } from '../js/planning/analyst/case_file.js';
import { executeTool } from '../js/planning/analyst/executors.js';
import { refused } from '../js/planning/analyst/contracts.js';
import { toolReply } from '../js/planning/analyst/replies.js';

export const ANALYSES_ROOT = fileURLToPath(new URL('../private/analyses/', import.meta.url));

function directoryPath(directory) {
  const path = resolve(directory);
  const parts = relative(ANALYSES_ROOT, path).split(/[\\/]/);
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(part))) {
    throw Object.assign(new Error('Use private/analyses/<requestId>/<runId>/ in this checkout.'), { path: '/case' });
  }
  return path;
}

async function noSymlinks(directory) {
  for (const path of [ANALYSES_ROOT, join(directory, '..'), directory]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('Case directories must be local directories, without symlinks.'), { path: '/case' });
  }
}

async function save(directory, caseFile) {
  const temporary = join(directory, 'case.json.next');
  await writeFile(temporary, JSON.stringify(caseFile, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, join(directory, 'case.json')); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function createLocalCase(input) {
  return storeNewCase(await createCaseFile(input));
}

export async function storeNewCase(caseFile) {
  const refusal = await caseRefusal(caseFile);
  if (refusal) throw new Error(refusal.refusals[0].message);
  const directory = directoryPath(join(ANALYSES_ROOT, caseFile.pinned.requestId, caseFile.pinned.runId));
  await mkdir(join(directory, '..'), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 }); // Exclusive: an existing run can never be reset.
  await noSymlinks(directory);
  await save(directory, caseFile);
  return { ok: true, status: 'ok', directory, pinHash: caseFile.pinHash };
}

export async function callLocalTool(directory, name, input) {
  const path = directoryPath(directory);
  await noSymlinks(path);
  let lock;
  try { lock = await open(join(path, '.lock'), 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') return refused('case_busy', '/case', 'Another caller is updating this case; retry after it finishes.');
    throw error;
  }
  try {
    const caseFile = JSON.parse(await readFile(join(path, 'case.json'), 'utf8'));
    if (path !== directoryPath(join(ANALYSES_ROOT, caseFile.pinned.requestId, caseFile.pinned.runId))) {
      return refused('case_path_mismatch', '/case', 'The directory must match the case’s request and run IDs.');
    }
    const output = await executeTool(caseFile, name, input);
    await save(path, output.caseFile);
    return toolReply(name, output.result, input);
  } finally {
    await lock.close();
    await unlink(join(path, '.lock'));
  }
}

/** Read a run's case file without changing it (no lock: a save is an atomic rename, so a read is never half-written). */
export async function readLocalCase(directory) {
  const path = directoryPath(directory);
  await noSymlinks(path);
  const caseFile = JSON.parse(await readFile(join(path, 'case.json'), 'utf8'));
  if (path !== directoryPath(join(ANALYSES_ROOT, caseFile.pinned.requestId, caseFile.pinned.runId))) {
    throw Object.assign(new Error('The directory must match the case’s request and run IDs.'), { path: '/case' });
  }
  return { path, caseFile };
}
