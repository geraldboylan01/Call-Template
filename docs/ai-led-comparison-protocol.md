# AI-led recovery comparison protocol

10 September 2026; production source `30eab9e`. No production implementation or deployment. Only synthetic conversations use the already-approved project API credential. This protocol was frozen after one infrastructure/harness pilot, before the main comparison.

## Question and scope

Does preserving and patching an existing proposal outperform a simpler complete AI reconsideration? The target is the current live direct-module interpreter. Legacy interpretation is excluded. Transport, approval interpretation and deployment are source-reviewed separately; this experiment cannot validate real ASR, playback or end-to-end user latency.

Four arms share the same first model response within each case and repetition. Exact common request prefixes reuse their actual response and measured latency, including an error. A fresh *second* interpretation always makes a new provider request. Requests and raw responses are retained without credentials. Cache keys canonicalize JSON object ordering; the fresh request is identical in content to the initial extraction but receives a new independent response.

| Arm | Recovery policy |
| --- | --- |
| `full_repair` | Current contracts, prompts and guards; disable the two narrow semantic repair branches, leaving the full representation-repair fallback. This isolates the pre-Option-2 recovery strategy without conflating historical prompt changes. It is not a byte-for-byte replay of an old release. |
| `option2` | Exact current interpreter, including structural repair, verifier-chosen narrow repair and full fallback. |
| `rethink` | At most two complete proposals. The second receives full conversation, profile, policy, rejected proposal, latest independent criticism and structural diagnostics. Explicitly permits reconsidering meaning; no preservation or patch restriction. Each ready/structurally defective proposal receives independent verification. |
| `fresh` | Same two-proposal control flow, but the second interpretation receives the original evidence envelope without the rejected proposal or criticism. Its independent verifier receives the preceding findings for review. |

All arms keep the current native schemas, policy values, normalization/provenance checks, material-assumption floor, independent verifier prompt/schema and certificate authentication. This deliberately isolates recovery strategy. It does **not** establish that these retained interfaces are ideal, or experimentally measure removing every deterministic semantic shortcut.

Both simple arms return an AI-declared collecting/clarification proposal without certification when there is no structural support defect. They do not repeatedly sample until one model agrees. A structural defect is given to the verifier as diagnostics before the second interpretation. The second verifier is authoritative: no earlier pass or rejected candidate can authorize the new proposal. A candidate certifies only when all relevant modules are ready, confirmation exists, and the final verdict is a consistent pass with no findings.

## Sampling and grading

Two repetitions of all twelve existing scenarios plus five independent holdouts: unchanged-value owner swap, withdrawn rate certainty, reopened collection, competing unconfirmed corrections, changed selected borrower. Expected results and holdout rubrics never enter provider requests. Reverse arm order in repetition two. No prompt tuning between the two main repetitions.

Use `gpt-5.6-luna`, low reasoning, 30-second per-call ceiling, shared 90-second operation deadline. Option 2 and full repair inherit the current seven-call allowance (the latter's ordinary graph is at most five); simple arms allow four calls. The current adaptive repair floor remains in the current arms; the simple arms use the hard operation deadline. Differences in scheduling are part of the strategies being compared and must be reported.

Report separately:

- Strict corpus correctness, certificate decision and native-engine completion.
- Success below 45 seconds; counts at or above 45 seconds are not practically ready.
- Raw candidate values, owners, unknowns and collections, independently of certification/read-back failure.
- Unsupported or stale facts in a certified candidate; safe clarification versus avoidable refusal.
- All model calls, paid versus reused prefixes, measured/simulated pipeline latency, provider errors and timeouts.
- Cases where a repair changes correct meaning or loses established information.

The paired arms are dependent observations, not four independent samples. Two repetitions cannot establish a production reliability percentage. Existing ambiguous fixture wording remains visible; strict corpus scoring and independent semantic review are reported separately. A conservative refusal is not automatically a semantic failure, and a verifier pass is not ground truth. Historical pre-Option-2/narrow/Option-2 runs supplement, but do not replace, the controlled comparison.

## Artifacts and limits

`scripts/compare-ai-led-recovery.mjs` loads unchanged production source into an audit module exposing private helpers. Its full-repair variant disables narrow dispatch only in memory. `scripts/run-ai-led-comparison.mjs` runs three cases concurrently. Main evidence is under `diagnostics/ai-led-comparison-main-v1`. The earlier `ai-led-comparison` and `ai-led-comparison-paid` directories are sandbox/instrumentation pilots, excluded from the main sample.

No new semantic compiler, financial parser, assumption values, materiality relaxation, or House-specific prompt is introduced. Any broader architectural recommendation remains a design decision to validate after this comparison, not a claimed implementation result.

## Secondary diagnostic: criticism without the rejected proposal

After the first repetition, full reconsideration had produced two revision errors by echoing the rejected snapshot's revision rather than the original request's base revision. This also exposed a distinction in the user's question: full conversation plus criticism need not include the complete rejected proposal. A separately reported secondary arm, `criticism_only`, uses exactly the simple rethink loop but omits `rejectedProposal` from its second-author request. It keeps the latest criticism, structural diagnostics and policy assumptions. It reuses the main study's first interpretation and initial verifier response/latency where the request prefix is identical, then makes real new recovery calls. The same 34 cases, oracles, four-call/90-second limit and unchanged independent verifier apply. This is a post-main-protocol diagnostic and is labelled accordingly; the original four-arm results are not tuned or overwritten.
