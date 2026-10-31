import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createLocalCase, storeNewCase } from './analyst-local-store.mjs';
import { REVIEWED_FIXTURES, createFixtureCase } from './fixtures/analyst-households.mjs';
import { refused } from '../js/planning/analyst/contracts.js';

const loadFixtures = async () => JSON.parse(await readFile(new URL('./fixtures/form-to-profile.households.json', import.meta.url), 'utf8'));

export async function listAnalystFixtures() {
  return { ok: true, status: 'ok', data: { fixtures: [...(await loadFixtures()).map(({ id, description }) => ({ name: id, description, reachesRoutes: false })), ...REVIEWED_FIXTURES] } };
}

export async function newFixtureCase(name) {
  const fixtures = await loadFixtures();
  const fixture = fixtures.find(row => row.id === name);
  const reviewed = REVIEWED_FIXTURES.find(row => row.name === name);
  if (!fixture && !reviewed) return { ...refused('unknown_fixture', '/fixture', 'Choose a fixture from analyst list-fixtures.'),
    data: { fixtures: [...fixtures.map(row => row.id), ...REVIEWED_FIXTURES.map(row => row.name)] } };
  // These dates/revisions describe invented confirmations, not today's form or
  // a real person. Every invocation makes a fresh run without resetting a case.
  const input = { requestId: 'fixture-' + name, runId: 'run-' + randomUUID(),
    revision: 7, confirmedRevision: 7, confirmedAt: '2026-10-20T12:00:00.000Z',
    information: (fixture ?? fixtures[2]).information, clientLabel: name };
  const result = reviewed ? await storeNewCase(await createFixtureCase(name, input.runId)) : await createLocalCase(input);
  return { ...result, fixture: name, reachesRoutes: Boolean(reviewed) };
}
