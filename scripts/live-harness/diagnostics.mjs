/**
 * WHAT HAPPENED, IN ORDER, KEPT AFTER THE PROCESS EXITS.
 *
 * The 15-run batch produced twelve k/5 scores and no evidence. Its runner wrote
 * each run's trace to a temp workspace and deleted it on exit, so "medium
 * captured module-critical facts 2 times in 5" was true, unactionable, and cost
 * €0.90 to learn. A run that fails has to be readable afterwards or the money
 * bought a number instead of a cause.
 *
 * So every run writes a directory that OUTLIVES the run:
 *
 *   diagnostics/phase4/<runId>/events.jsonl   every event, chronological
 *   diagnostics/phase4/<runId>/run.json       the measured summary
 *   diagnostics/phase4/<runId>/timeline.txt   readable, written when it fails
 *
 * `events.jsonl` is append-only and flushed as it goes, so a run that crashes
 * or is killed still leaves everything up to the moment it died — which is
 * exactly the run you most need to read.
 *
 * NO SECRETS. Only the harness's own synthetic conversation and the state it
 * produced. Keys never enter an event: `record` is given values by name.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Git-ignored, stable, and never cleaned up by the harness itself. */
export const DIAGNOSTICS_ROOT = 'diagnostics/phase4';

/** A run id that sorts chronologically and survives being read by a human. */
export function newRunId(personaId, attempt = 1) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}-${personaId}-${String(attempt).padStart(2, '0')}`;
}

export function createDiagnostics(runId, { enabled = true } = {}) {
  if (!enabled) {
    return {
      runId,
      dir: null,
      record: () => {},
      finish: () => null,
      events: () => []
    };
  }
  const dir = join(DIAGNOSTICS_ROOT, runId);
  mkdirSync(dir, { recursive: true });
  const eventsPath = join(dir, 'events.jsonl');
  const startedAt = Date.now();
  const events = [];

  /**
   * One thing that happened. Written through immediately: buffering would lose
   * precisely the tail of a run that died, which is the part worth having.
   */
  const record = (type, payload = {}) => {
    const event = { at: Date.now() - startedAt, type, ...payload };
    events.push(event);
    try {
      appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
    } catch (_error) {
      // Diagnostics must never be able to fail a run. A lost line is bad; a
      // conversation aborted because a disk write failed is worse.
    }
    return event;
  };

  const finish = (summary) => {
    try {
      writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId, ...summary }, null, 2));
      // A readable trail, but only where it is needed: writing one for every
      // healthy run buries the failures among them.
      if (summary?.failures?.length || summary?.criteriaFailed?.length) {
        writeFileSync(join(dir, 'timeline.txt'), renderTimeline(runId, summary, events));
      }
    } catch (_error) { /* see above */ }
    return dir;
  };

  return { runId, dir, record, finish, events: () => [...events] };
}

/* ------------------------------------------------------------- the timeline */

const money = (value) => (value && typeof value === 'object' && 'amount' in value
  ? `${value.amount} ${value.currency || ''}`.trim()
  : JSON.stringify(value));

const truncate = (text, length = 150) => {
  const value = String(text ?? '');
  return value.length > length ? `${value.slice(0, length)}…` : value;
};

/**
 * WHERE THE TRUTH DIVERGED FROM WHAT THE CLIENT SAID.
 *
 * Ordered as the call happened, so the first line that disagrees with the
 * transcript is the failure — everything after it is consequence.
 */
export function renderTimeline(runId, summary, events) {
  const out = [];
  const say = (text = '') => out.push(text);

  say(`RUN ${runId}   persona ${summary.persona || '?'} (${summary.level || '?'})`);
  say('='.repeat(78));
  if (summary.criteriaFailed?.length) say(`FAILED: ${summary.criteriaFailed.join(', ')}`);
  for (const failure of summary.failures || []) say(`  ✗ ${failure}`);
  say();
  say('GROUND TRUTH');
  for (const [key, value] of Object.entries(summary.groundTruth || {})) {
    say(`  ${key.padEnd(24)} ${value}`);
  }
  say();
  say('WHAT HAPPENED');
  say('-'.repeat(78));

  for (const event of events) {
    const stamp = `${String(Math.round(event.at / 100) / 10).padStart(6)}s`;
    switch (event.type) {
      case 'client':
        say(`${stamp}  CLIENT    ${truncate(event.text)}`);
        break;
      case 'assistant':
        say(`${stamp}  ASSISTANT ${truncate(event.text)}   (${event.replyLatencyMs}ms)`);
        break;
      case 'tool':
        say(`${stamp}    tool ${event.name}`);
        for (const fact of event.facts || []) {
          say(`             → ${fact.factId} = ${money(fact.value)}`);
        }
        for (const saved of event.saved || []) say(`             ✓ saved ${saved}`);
        for (const item of event.rejected || []) {
          say(`             ✗ REJECTED ${item.factId}: ${item.reason}${item.message ? ` — ${truncate(item.message, 90)}` : ''}`);
        }
        break;
      case 'canonical':
        say(`${stamp}    canonical rev ${event.revision}: ${truncate(event.summary, 120)}`);
        break;
      case 'readiness':
        say(`${stamp}    still needed: ${(event.stillNeeded || []).join(', ') || '(none)'}`);
        break;
      case 'reconciliation':
        say(`${stamp}    PLANNER ${event.trigger} → ${event.status}`
          + ` base=${event.baseRevision} applied=${event.appliedProfileRevision ?? '-'}`
          + ` (${event.latencyMs}ms)`);
        for (const id of event.accepted || []) say(`             ✓ accepted ${id}`);
        for (const item of event.rejected || []) say(`             ✗ refused ${item.groupId}: ${item.code}`);
        for (const id of event.unprojected || []) say(`             ⚠ accepted but not canonical: ${id}`);
        for (const id of event.clarifications || []) say(`             ? clarification ${id}`);
        break;
      case 'barrier':
        say(`${stamp}    barrier: ${event.unreviewedMaterialTurns} material turn(s), `
          + `${event.unresolvedIdentities} unresolved identity`);
        break;
      case 'confirmation':
        say(`${stamp}  CONFIRM   attempt ${event.attempt}: ok=${event.ok} code=${event.code || '-'}`);
        break;
      case 'module_input':
        say(`${stamp}  MODULE IN`);
        for (const [key, value] of Object.entries(event.canonical || {})) {
          say(`             ${key.padEnd(22)} ${truncate(JSON.stringify(value), 100)}`);
        }
        break;
      case 'module_output':
        say(`${stamp}  MODULE OUT ${event.moduleId} opening=${event.openingPot} `
          + `expected=${event.expectedOpeningPot} ${event.correct ? 'OK' : '*** WRONG ***'}`);
        break;
      default:
        say(`${stamp}    ${event.type} ${truncate(JSON.stringify(event), 110)}`);
    }
  }
  say('-'.repeat(78));
  say(`live reply ms: ${(summary.liveLatencies || []).join(', ') || '-'}`);
  say(`planner ms   : ${(summary.plannerLatencies || []).join(', ') || '-'}`);
  say(`planner spend: €${Number(summary.spendEur || 0).toFixed(4)}`);
  return out.join('\n');
}
