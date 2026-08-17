#!/usr/bin/env node

/**
 * ONE RUN, TOLD AS THE STORY OF EACH FACT.
 *
 * The batch reports k/N and the timeline reports chronology. Neither answers
 * the question that actually matters after a paid run: for a figure the client
 * plainly said, WHERE did it stop? The fast lane, the planner, or nowhere?
 *
 * Six lines per turn, in the order the architecture is supposed to work:
 *
 *   WHAT CLIENT SAID → WHAT LIVE LANE SAVED/REJECTED → WHAT THE PLANNER SAW
 *   → WHAT THE PLANNER DID → FINAL CANONICAL STATE → WHY READINESS DID OR DID NOT CLOSE
 *
 * Reads only the artifacts a run leaves behind, so it can be pointed at any run
 * after the fact — including runs from an earlier batch.
 *
 *   node ./scripts/report-phase4-run.mjs diagnostics/phase4/<run-id>
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dirs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (!dirs.length) {
  console.error('Usage: node ./scripts/report-phase4-run.mjs <run-dir> [<run-dir> …]');
  process.exit(2);
}

const line = (text = '') => console.info(text);
const truncate = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/**
 * Money and ages out of a canonical summary, in a form worth reading.
 *
 * The summary is written as a JSON STRING in some events and an object in
 * others, and the two carry different pension shapes — so both are handled
 * here rather than at each call site.
 */
function describeCanonical(input) {
  let summary = input;
  if (typeof summary === 'string') {
    try { summary = JSON.parse(summary); } catch (_error) { return truncate(input, 160); }
  }
  if (!summary || typeof summary !== 'object') return '(nothing)';
  const parts = [];
  const pensions = summary.pensions || [];
  if (pensions.length) {
    parts.push(`pensions[${pensions.length}]: ` + pensions.map((item) => {
      const value = item?.currentValue?.amount ?? item?.projectedAnnualIncome?.amount ?? item?.value;
      const owner = item?.ownerId || item?.owner || '?';
      // NO VALUE is the thing worth seeing at a glance: a pension carrying no
      // figure is what leaves a permanent need and stops readiness closing.
      return `${item?.type || '?'}/${owner}=${value ?? 'NO VALUE'}`;
    }).join(', '));
  } else if (Object.hasOwn(summary, 'pensions')) {
    parts.push('pensions[0]');
  }
  const incomes = summary.incomeSources || summary.incomes;
  if (Array.isArray(incomes)) {
    parts.push(incomes.length
      ? `incomes[${incomes.length}]: ${incomes.map((item) =>
        item?.grossAnnual?.amount ?? item?.netAnnual?.amount ?? item?.amount ?? '?').join(', ')}`
      : 'incomes[0]');
  }
  for (const [label, key] of [['age', 'primaryAge'], ['age', 'age'], ['partnerAge', 'partnerAge'],
    ['retireAt', 'intendedRetirementAge'], ['targetIncome', 'targetRetirementIncome']]) {
    if (summary[key] !== null && typeof summary[key] !== 'undefined') parts.push(`${label}=${summary[key]}`);
  }
  return parts.length ? parts.join(' · ') : truncate(JSON.stringify(summary), 160);
}

for (const dir of dirs) {
  const eventsPath = join(dir, 'events.jsonl');
  if (!existsSync(eventsPath)) {
    line(`\n${dir}: no events.jsonl — the run crashed before writing artifacts`);
    continue;
  }
  const events = readFileSync(eventsPath, 'utf8').trim().split('\n')
    .map((text) => { try { return JSON.parse(text); } catch (_error) { return null; } })
    .filter(Boolean);
  const run = existsSync(join(dir, 'run.json'))
    ? JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    : {};

  line(`\n${'='.repeat(78)}`);
  line(dir.split('/').at(-1));
  line('='.repeat(78));

  const turns = [...new Set(events.filter((event) => typeof event.turn === 'number')
    .map((event) => event.turn))].sort((a, b) => a - b);
  const at = (type, turn) => events.filter((event) => event.type === type && event.turn === turn);
  // Reconciliations carry no turn, so they are attributed by position in time.
  const reconciliations = events.filter((event) => event.type === 'reconciliation');

  for (const turn of turns) {
    const client = at('client', turn)[0];
    if (!client) continue;
    line(`\n── turn ${turn} ${'─'.repeat(60)}`);
    line(`WHAT CLIENT SAID       ${truncate(client.text, 200)}`);

    const tools = at('tool', turn);
    if (!tools.length) {
      line('WHAT LIVE LANE DID     (no tool call on this turn)');
    } else {
      for (const tool of tools) {
        const saved = (tool.saved || []).join(', ') || '(nothing)';
        line(`WHAT LIVE LANE SAVED   ${tool.name}: ${saved}`);
        for (const item of tool.rejected || []) {
          line(`         REJECTED      ${item.factId} — ${item.reason}${item.message ? ` (${item.message})` : ''}`);
        }
        for (const item of tool.identityAmbiguities || []) {
          line(`         AMBIGUOUS     ${JSON.stringify(item)}`);
        }
      }
    }

    const canonical = at('canonical', turn).at(-1);
    if (canonical) line(`CANONICAL AFTER TURN   rev ${canonical.revision} · ${describeCanonical(canonical.summary)}`);

    const readiness = at('readiness', turn).at(-1);
    if (readiness) {
      const needs = readiness.stillNeeded || [];
      line(`READINESS              ${needs.length ? `still needs ${needs.join(', ')}` : 'CLOSED — nothing outstanding'}`);
    }
    const barrier = at('barrier', turn).at(-1);
    if (barrier && (barrier.unreviewedMaterialTurns || barrier.unresolvedIdentities)) {
      line(`BARRIER                unreviewed=${barrier.unreviewedMaterialTurns} unresolvedIdentities=${barrier.unresolvedIdentities}`);
    }
  }

  line(`\n── the planner ${'─'.repeat(56)}`);
  if (!reconciliations.length) line('WHAT THE PLANNER DID   never ran');
  for (const [index, item] of reconciliations.entries()) {
    line(`\nplanner pass ${index + 1}  (${item.trigger})`);
    line(`  WHAT IT SAW          base revision ${item.baseRevision}`
      + (item.rebasedFromRevisions?.length ? ` · rebased from ${item.rebasedFromRevisions.join(',')}` : ''));
    const accepted = Array.isArray(item.accepted) ? item.accepted : [];
    const rejected = Array.isArray(item.rejected) ? item.rejected : [];
    line(`  WHAT IT DID          ${item.status} in ${item.latencyMs}ms`
      + ` · accepted ${accepted.length} · rejected ${rejected.length}`
      + (item.unprojected?.length ? ` · unprojected ${item.unprojected}` : '')
      + (item.clarifications?.length ? ` · clarifications ${item.clarifications}` : ''));
    // The operation, what it was for, and — when refused — the reason, which is
    // the only part that explains why a fact did or did not survive.
    const reasonFor = (operationId) => rejected
      .find((entry) => entry?.groupId === operationId || entry?.operationId === operationId);
    for (const operation of item.operations || []) {
      const id = operation.operationId || operation.groupId || '?';
      const refusal = reasonFor(id);
      line(`      ${accepted.includes(id) ? 'APPLIED ' : refusal ? 'REFUSED ' : '        '}`
        + `${operation.op || '?'} ${operation.factId || operation.path || ''}`
        + `${operation.entityId ? ` [${operation.entityId}]` : ''}`
        + `${operation.reasonCode ? ` · ${operation.reasonCode}` : ''}`);
      if (refusal) line(`                ↳ ${refusal.code}: ${truncate(refusal.message, 110)}`);
    }
    // Refusals that never matched an operation would otherwise vanish.
    for (const entry of rejected) {
      const id = entry?.groupId || entry?.operationId;
      if ((item.operations || []).some((operation) =>
        (operation.operationId || operation.groupId) === id)) continue;
      line(`      REFUSED  ${id || '(group)'} · ${entry.code}: ${truncate(entry.message, 110)}`);
    }
  }

  line(`\n── the end ${'─'.repeat(60)}`);
  const moduleIn = events.filter((event) => event.type === 'module_input').at(-1);
  const moduleOut = events.filter((event) => event.type === 'module_output').at(-1);
  line(`FINAL CANONICAL STATE  ${moduleIn
    ? describeCanonical(moduleIn.canonical)
    : describeCanonical(events.filter((event) => event.type === 'canonical').at(-1)?.summary)}`);

  if (moduleOut) {
    line(`MODULE                 ${moduleOut.moduleId}: opening pot ${moduleOut.openingPot}`
      + ` (expected ${moduleOut.expectedOpeningPot}) — ${moduleOut.correct ? 'CORRECT' : 'WRONG'}`);
  } else {
    line('MODULE                 never ran');
  }

  const finalNeeds = events.filter((event) => event.type === 'readiness').at(-1)?.stillNeeded || [];
  line(`WHY READINESS ${finalNeeds.length ? 'DID NOT CLOSE' : 'CLOSED     '}  ${finalNeeds.length
    ? `outstanding: ${finalNeeds.join(', ')}`
    : 'every required input was present'}`);
  if (run.criteriaFailed?.length) line(`CRITERIA FAILED        ${run.criteriaFailed.join(', ')}`);
  if (typeof run.spendEur === 'number') line(`SPEND                  €${run.spendEur.toFixed(4)}`);
}
