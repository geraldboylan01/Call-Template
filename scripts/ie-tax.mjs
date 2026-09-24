#!/usr/bin/env node

/**
 * The Irish tax engine on the command line.
 *
 * The same functions the app calls, for scripts in any language: Python, a
 * Report script or a shell pipeline pass JSON in and read JSON out, and none of
 * them keeps its own copy of a tax rule. Nothing here calculates tax itself.
 *
 *   node scripts/ie-tax.mjs year [file]       { "state"?, "input" } or a bare input
 *   node scripts/ie-tax.mjs marginal [file]   { "state"?, "input", "delta" }
 *   node scripts/ie-tax.mjs solve [file]      { "state"?, "input", "targetNet", "adjustable", "maxAmount"? }
 *   node scripts/ie-tax.mjs rules <year>
 *
 * With no file, or "-", the JSON is read from stdin. `adjustable` for `solve`
 * is declarative, because a function cannot travel as JSON:
 *
 *   { "split": [ { "personId": "mary", "type": "arfDistribution", "share": 1 } ] }
 *
 * shares the solved amount across those items in proportion to `share`.
 * Bad input exits 1 with the validation message on stderr.
 */

import { readFileSync } from 'node:fs';

import {
  computeTaxYear,
  marginalTax,
  solveForNet
} from '../js/planning/tax/engine.js';
import { resolveTaxRules } from '../js/planning/tax/resolve.js';
import { IE_TAX_SOURCES } from '../js/planning/tax/rules_ie.js';
import {
  TAX_NOT_INCLUDED,
  renderTaxDisclosures
} from '../js/planning/tax/disclosures.js';

const USAGE = [
  'Usage:',
  '  node scripts/ie-tax.mjs year [file]',
  '  node scripts/ie-tax.mjs marginal [file]',
  '  node scripts/ie-tax.mjs solve [file]',
  '  node scripts/ie-tax.mjs rules <year>'
].join('\n');

function readJson(pathArgument) {
  const text = !pathArgument || pathArgument === '-'
    ? readFileSync(0, 'utf8')
    : readFileSync(pathArgument, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The input is not valid JSON: ${error.message}`);
  }
}

function withDisclosureText(result) {
  return {
    disclosures: renderTaxDisclosures(result.disclosures, { rules: resolveTaxRules(result.year) }),
    notIncluded: TAX_NOT_INCLUDED.map((entry) => entry.text)
  };
}

/** `{ input }` or a bare input: a bare input has a `year` and no `input` key. */
function splitRequest(request) {
  if (request && typeof request === 'object' && 'input' in request) {
    return request;
  }
  return { input: request };
}

function adjustableFromSplit(spec) {
  const split = spec?.split;
  if (!Array.isArray(split) || split.length === 0) {
    throw new Error('adjustable.split must be a non-empty array of { personId, type, share }.');
  }
  const totalShare = split.reduce((total, entry, index) => {
    if (typeof entry?.share !== 'number' || !Number.isFinite(entry.share) || entry.share <= 0) {
      throw new Error(`adjustable.split[${index}].share must be a positive number.`);
    }
    return total + entry.share;
  }, 0);
  return (amount) => split.map((entry) => ({
    personId: entry.personId,
    type: entry.type,
    amount: amount * (entry.share / totalShare)
  }));
}

function run(command, argument) {
  switch (command) {
    case 'year': {
      const { state = null, input } = splitRequest(readJson(argument));
      const { result, nextState } = computeTaxYear({ state, input });
      return { command, result, nextState, ...withDisclosureText(result) };
    }
    case 'marginal': {
      const { state = null, input, delta } = readJson(argument);
      const outcome = marginalTax({ state, input, delta });
      return {
        command,
        byHead: outcome.byHead,
        total: outcome.total,
        netIncomeChange: outcome.netIncomeChange,
        base: outcome.base,
        withDelta: outcome.withDelta,
        nextState: outcome.nextState,
        ...withDisclosureText(outcome.withDelta)
      };
    }
    case 'solve': {
      const request = readJson(argument);
      const outcome = solveForNet({
        state: request.state ?? null,
        input: request.input,
        adjustable: adjustableFromSplit(request.adjustable),
        targetNet: request.targetNet,
        maxAmount: request.maxAmount ?? null
      });
      return {
        command,
        amount: outcome.amount,
        netIncome: outcome.netIncome,
        met: outcome.met,
        gap: outcome.gap,
        surplus: outcome.surplus,
        iterations: outcome.iterations,
        result: outcome.result,
        nextState: outcome.nextState,
        ...withDisclosureText(outcome.result)
      };
    }
    case 'rules': {
      const year = Number(argument);
      if (!argument || !Number.isInteger(year)) {
        throw new Error('rules needs a tax year, for example: node scripts/ie-tax.mjs rules 2026');
      }
      return { command, rules: resolveTaxRules(year), sources: IE_TAX_SOURCES };
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}".\n${USAGE}`);
  }
}

const [command, argument] = process.argv.slice(2);

try {
  process.stdout.write(`${JSON.stringify(run(command, argument), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exit(1);
}
