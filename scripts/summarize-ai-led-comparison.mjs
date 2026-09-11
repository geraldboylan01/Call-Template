import { readFile, readdir, writeFile } from 'node:fs/promises';
const root = process.env.AI_LED_OUTPUT || 'diagnostics/ai-led-comparison-main-v1';
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
          ambiguity: outputs[index]?.unresolvedAmbiguities, scope: outputs[index]?.repairScope,
          unsupported: outputs[index]?.unsupportedPaths, omitted: outputs[index]?.omittedSupportedInformation,
          providerStatus: x.response?.status, httpStatus: x.httpStatus, error: x.error })),
        candidateValues: data.candidates?.map(x => ({ call: x.call, valuesPass: x.valuesPass,
          failures: x.valueChecks?.filter(c => !c.pass), error: x.error })),
        confirmation: data.result?.snapshot?.confirmationPrompt || '',
        initialReadback: data.candidates?.[0]?.authoredReadback || '',
        finalVerdict: data.result?.verification,
        inputTokens: data.providerCalls.reduce((n, c) => n + Number(c.response?.usage?.input_tokens || 0), 0),
        outputTokens: data.providerCalls.reduce((n, c) => n + Number(c.response?.usage?.output_tokens || 0), 0),
      });
    }
  }
}
const median = values => { const s = [...values].sort((a,b)=>a-b); return s.length ? s[Math.floor(s.length/2)] : null; };
const groups = Object.fromEntries([...new Set(rows.map(x => x.arm))].map(arm => {
  const cases = rows.filter(x => x.arm === arm);
  return [arm, { n: cases.length, pass: cases.filter(x => x.pass).length, under45: cases.filter(x => x.passUnder45s).length,
    certified: cases.filter(x => x.certified).length,
    medianMs: median(cases.map(x => x.elapsedMs)), totalCalls: cases.reduce((s,x)=>s+x.calls,0),
    paidCalls: cases.reduce((s,x)=>s+x.paidCalls,0), errors: cases.filter(x=>x.error).length,
    lastCandidateValuesCorrect: cases.filter(x=>x.candidateValues?.at(-1)?.valuesPass).length }];
}));
const pairs = [...new Set(rows.map(x=>`${x.rep}/${x.id}`))].map(key => {
  const group = rows.filter(x=>`${x.rep}/${x.id}`===key);
  return { key, n:group.length, pairedFirstRequest: new Set(group.map(x=>x.firstHash)).size === 1,
    pairedFirstResponse: new Set(group.map(x=>x.firstResponseId)).size === 1,
    results: Object.fromEntries(group.map(x=>[x.arm,{pass:x.pass,under45:x.passUnder45s,ms:x.elapsedMs,calls:x.calls}])) };
});
await writeFile(`${root}/analysis.json`, JSON.stringify({ groups, pairs, rows }, null, 2));
console.log(JSON.stringify({ groups, completePairs: pairs.filter(x=>x.n===4).length,
  unpaired: pairs.filter(x=>!x.pairedFirstRequest || !x.pairedFirstResponse).map(x=>x.key) }, null, 2));
