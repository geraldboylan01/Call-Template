# AI-led baseline evidence — 11 September 2026

The measured baseline handed to Astra. Recorded from a **fresh detached worktree at `40deb248`** with no `diagnostics/` directory and no `.env.local`; only the provider API key was supplied, through the environment.

## What is here

| file | what it is |
| --- | --- |
| `manifest.json` | candidate and benchmark commits, both source hashes, provider config, corpus-integrity counts, headline totals, gate and safety results |
| `paired-analysis.json` | the full 34 case-repetition paired comparison: per-row pass/fail, timings, call counts, per-stage verdicts, scopes and explanations, candidate values, read-backs, token counts |
| `seeded-analysis.json` | the same shape for the 4 adversarial probes × 2 repetitions, plus each probe's injected manifest |

## What was deliberately not kept

The raw provider request/response envelopes, about **31MB** across both suites. They contain **no secrets** — the harness records request bodies, never headers, and a scan for the key, `Authorization`, `Bearer` and `sk-` patterns across all 31MB returned nothing — but they are the same long prompts repeated per call, and every fact an auditor needs from them (verdict, revision scope, explanation, latency, reuse, tokens) is retained above. Regenerate them by re-running the commands below.

## Reproducing this baseline

```bash
git worktree add /tmp/baseline 40deb248 --detach
cd /tmp/baseline && npm ci
export OPENAI_API_KEY=…            # your own key; nothing in this repo carries one
npm run evals:ai-led-simplified                        # 34 paired case-repetitions
AI_LED_REPETITION=1 npm run evals:ai-led-simplified-seeded
AI_LED_REPETITION=2 npm run evals:ai-led-simplified-seeded
npm run evals:ai-led-simplified-report                 # writes analysis.json
npm run check:consumer                                 # full gate, 74 targets
```

The benchmark arm is pinned to `30eab9e` and read from git, so it cannot drift with the working tree; override with `AI_LED_BENCHMARK_REF`.

**Check the corpus was not silently shrunk.** `manifest.json → corpusIntegrity` should read 17 cases, 5 holdouts, 68 paired rows, 34 complete pairs, `everyPairSharedFirstResponse: true`, 4 seeded fixtures, 16 seeded rows. The holdouts are a hard import, so a missing fixture stops a run rather than quietly reducing it — but the counts are the check that this actually held.

## Headline

| | pass/34 | <45s/34 | ready certified/22 | blocked/12 | max calls | mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Option 2 | 28 | 27 | 16 | 12/12 | 6 | 25.3s |
| Simplified | 29 | 29 | 17 | 12/12 | 4 | 20.5s |

Seeded adversarial: Option 2 **5/8**, simplified **7/8**.

**Zero incorrectly certified or executed outcomes in either arm, in either suite, across 84 measured rows.**

Read the paired margin as noise: across four runs of this harness Option 2 has scored 25–28/34 and the candidate 26–29/34 on byte-identical benchmark code, and the sign of the difference has flipped three times.
