#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compilePlanPack } from '../js/planning/plan_pack/compiler.js';

function args(argv) {
  const result = { file: '', json: false, output: null, ledger: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') result.json = true;
    else if (argv[i] === '--ledger') result.ledger = true;
    else if (argv[i] === '--output') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--output requires a new output path.');
      result.output = argv[++i];
    } else if (argv[i].startsWith('--')) throw new Error('Unknown option: ' + argv[i]);
    else if (result.file) throw new Error('Supply one plan-pack path.');
    else result.file = argv[i];
  }
  if (!result.file) throw new Error('Usage: npm run check:plan-pack -- <pack.json> [--ledger] [--json] [--output new-file.json]');
  if (result.output && resolve(result.output) === resolve(result.file)) throw new Error('The input file cannot be an output destination.');
  return result;
}
try {
  const options = args(process.argv.slice(2));
  const input = JSON.parse(await readFile(options.file, 'utf8'));
  // Renderer debug logs must not corrupt machine-readable stdout.
  const previousInfo = console.info;
  console.info = (...values) => console.error(...values);
  let result;
  try { result = await compilePlanPack(input, { resourceLedger: options.ledger }); } finally { console.info = previousInfo; }
  if (options.output) await writeFile(options.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else {
    console.log('Plan pack v' + (result.planPackVersion ?? input.planPackVersion) + ': ' + result.status);
    if (result.calculationDate) console.log('Calculation date: ' + result.calculationDate);
    if (result.versions) console.log('Versions: ' + JSON.stringify(result.versions));
    console.log(options.ledger ? 'Resource ledger: ' + (result.resourceLedger?.status ?? 'invalid') : 'B0 checks compilation only. Use --ledger for B1 resource checks.');
    for (const ledger of result.resourceLedger?.routes ?? []) {
      console.log(ledger.routeId + ': ' + (ledger.balanced ? 'funding balances' : 'funding does not balance') + '; reserve ' + ledger.reserve.protectedAmount.toFixed(2)
        + '; cash left ' + ledger.cashRemaining.toFixed(2));
      for (const row of ledger.years) console.log('  ' + row.year + ': available ' + row.available.toFixed(2) + ', planned ' + row.planned.toFixed(2) + ', left ' + row.remaining.toFixed(2));
      for (const goal of ledger.goals) {
        console.log('  ' + goal.goalId + ': ' + goal.stateWord);
        const retirementCosts = ledger.pricing.find(row => row.goalId === goal.goalId)?.priced.datedCostsAfterRetirement ?? [];
        for (const cost of retirementCosts) console.log('    ' + cost.title + ': '
          + cost.capitalNeededAtRetirement.toFixed(2) + ' capital needed in ' + cost.year);
      }
      for (const event of ledger.freedCash ?? []) console.log('  ' + (event.kind === 'loan_ends' ? 'Repayment ends' : 'Goal saving ends') + ': ' + (event.label ?? event.goalId) + ', '
        + event.annualAmount.toFixed(2) + ' a year ' + (event.fromYear === null ? 'has no contractual end' : 'from ' + event.fromYear));
      for (const person of ledger.earners ?? []) if (person.stopsFromYear !== null) console.log('  ' + person.personId + '\'s share of left over stops from ' + person.stopsFromYear);
      for (const disclosure of ledger.investmentSales.disclosures) console.log('  ' + (disclosure.text ?? disclosure));
      if (ledger.investments.potentialSale) {
        console.log('  Investment sale illustration (not added to cash): ' + ledger.investments.potentialSale.netProceeds.toFixed(2));
        for (const disclosure of ledger.investments.potentialSale.disclosures) console.log('  ' + disclosure.text);
      }
    }
    for (const route of result.routes) console.log(route.id + ': ' + route.status + ' ' + JSON.stringify(route.chapterCases));
    for (const chapter of result.chapters) {
      for (const entry of chapter.cases) {
        console.log(chapter.id + '/' + entry.id + ': ' + entry.basis + '; source ' + entry.provenance.householdSource + ' + ' + entry.provenance.transitionSource);
        for (const warning of entry.warnings) console.log('  Warning: ' + warning);
      }
    }
    for (const diagnostic of result.diagnostics) console.log((diagnostic.routeId ?? '') + ' ' + (diagnostic.chapter ?? '') + ' ' + diagnostic.code + ': ' + diagnostic.message);
  }
  process.exitCode = result.status === 'compiled' ? 0 : 1;
} catch (error) {
  process.stderr.write('Plan pack check failed: ' + error.message + '\n');
  process.exitCode = 1;
}
