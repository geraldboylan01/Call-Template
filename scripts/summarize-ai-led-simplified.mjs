import { readFile, readdir, writeFile } from 'node:fs/promises';
import { FIRST20_SEMANTIC_CORPUS } from './first20-semantic-corpus.mjs';
import { AI_LED_HOLDOUTS } from './ai-led-holdouts.mjs';
// Twelve of the 34 case-repetitions are expected to remain UNAVAILABLE: an open
// collection, a hedged answer, a withdrawn certainty, an unresolved competing
// correction. Blocking them is the correct outcome, but it is not a financial
// analysis, so a headline total is never reported as plans produced.
const expectsReady = new Map([...FIRST20_SEMANTIC_CORPUS, ...AI_LED_HOLDOUTS].map(t => [t.id, t.ready !== false]));
const root = process.env.AI_LED_OUTPUT || 'diagnostics/ai-led-simplified-v1';
const read = path => readFile(path, 'utf8').then(JSON.parse);
const rows = [];
for (const rep of (await readdir(root)).filter(x => /^r\d+$/.test(x))) {
  for (const name of await readdir(`${root}/${rep}`)) {
    let summary; try { summary = await read(`${root}/${rep}/${name}/summary.json`); } catch { continue; }
    for (const item of summary.arms) {
      const data = await read(`${root}/${rep}/${name}/${item.arm}.json`);
      const outputs = data.providerCalls.map(call => {
        try { return JSON.parse(call.response.output.flatMap(x => x.content || []).find(x => x.type === 'output_text').text); } catch { return null; }
      });
      rows.push({ rep, id: name, ...item, firstHash: data.providerCalls[0]?.requestHash,
        firstResponseId: data.providerCalls[0]?.response?.id || null,
        stages: data.providerCalls.map((x, index) => ({ stage: x.stage, ms: x.elapsedMs, reused: x.reusedExactPrefix,
          verdict: outputs[index]?.verdict, explanation: outputs[index]?.explanation,
          ambiguity: outputs[index]?.unresolvedAmbiguities,
          // Both vocabularies, so one summary reads across the two arms.
          scope: outputs[index]?.revisionScope ?? outputs[index]?.repairScope,
          unsupported: outputs[index]?.unsupportedPaths, omitted: outputs[index]?.omittedSupportedInformation,
          providerStatus: x.response?.status, httpStatus: x.httpStatus, error: x.error })),
        candidateValues: data.candidates?.map(x => ({ call: x.call, valuesPass: x.valuesPass,
          failures: x.valueChecks?.filter(c => !c.pass), error: x.error })),
        confirmation: data.result?.snapshot?.confirmationPrompt || '',
        initialReadback: data.candidates?.[0]?.authoredReadback || '',
        finalVerdict: data.result?.verification,
        // Expected-to-remain-unavailable cases are correct outcomes but are not
        // financial analyses. Reported separately so a headline total is never
        // read as "31 plans produced".
        expectedUnavailable: expectsReady.get(name) === false,
        inputTokens: data.providerCalls.reduce((n, c) => n + Number(c.response?.usage?.input_tokens || 0), 0),
        outputTokens: data.providerCalls.reduce((n, c) => n + Number(c.response?.usage?.output_tokens || 0), 0)
      });
    }
  }
}
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
const groups = Object.fromEntries([...new Set(rows.map(x => x.arm))].map(arm => {
  const cases = rows.filter(x => x.arm === arm);
  const ready = cases.filter(x => !x.expectedUnavailable);
  return [arm, {
    n: cases.length,
    pass: cases.filter(x => x.pass).length,
    under45: cases.filter(x => x.passUnder45s).length,
    readyCases: ready.length,
    readyCertified: ready.filter(x => x.certified && x.pass).length,
    readyUnder45: ready.filter(x => x.passUnder45s).length,
    blockedCases: cases.length - ready.length,
    blockedCorrect: cases.filter(x => x.expectedUnavailable && x.pass).length,
    medianMs: median(cases.map(x => x.elapsedMs)), meanMs: mean(cases.map(x => x.elapsedMs)),
    maxCalls: Math.max(...cases.map(x => x.calls)),
    totalCalls: cases.reduce((s, x) => s + x.calls, 0),
    paidCalls: cases.reduce((s, x) => s + x.paidCalls, 0),
    errors: cases.filter(x => x.error).length,
    // A certified candidate that the strict oracle says carries wrong values is
    // the one outcome that is worse than a refusal.
    certifiedButWrong: cases.filter(x => x.certified && !x.pass).length,
    lastCandidateValuesCorrect: cases.filter(x => x.candidateValues?.at(-1)?.valuesPass).length
  }];
}));
const pairs = [...new Set(rows.map(x => `${x.rep}/${x.id}`))].map(key => {
  const group = rows.filter(x => `${x.rep}/${x.id}` === key);
  return { key, n: group.length,
    pairedFirstResponse: new Set(group.map(x => x.firstResponseId)).size === 1,
    results: Object.fromEntries(group.map(x => [x.arm, { pass: x.pass, under45: x.passUnder45s, ms: x.elapsedMs, calls: x.calls }])) };
});
// Where the two arms actually disagree: the only rows that carry information
// about which recovery strategy is better.
const divergent = pairs.filter(x => x.n === 2
  && x.results.option2?.pass !== x.results.simplified?.pass)
  .map(x => ({ key: x.key, option2: x.results.option2?.pass, simplified: x.results.simplified?.pass }));
const perRepetition = [...new Set(rows.map(x => x.rep))].sort().map(rep => ({
  rep, ...Object.fromEntries([...new Set(rows.map(x => x.arm))].map(arm => [arm,
    `${rows.filter(x => x.rep === rep && x.arm === arm && x.pass).length}/${rows.filter(x => x.rep === rep && x.arm === arm).length}`]))
}));
await writeFile(`${root}/analysis.json`, JSON.stringify({ groups, perRepetition, divergent, pairs, rows }, null, 2));
console.log(JSON.stringify({ groups, perRepetition, divergent,
  completePairs: pairs.filter(x => x.n === 2).length,
  unpairedFirstResponse: pairs.filter(x => x.n === 2 && !x.pairedFirstResponse).map(x => x.key) }, null, 2));
