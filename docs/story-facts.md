# Story facts from a compiled plan

`readPlanPosition(compiled)` in `js/planning/plan_pack/story_facts.js` is the single entry point for the future `read_position` executor. It accepts a successfully compiled plan with its normalized source and returns JSON. It does not write a story, construct routes, dispatch tools or check story text.

```js
import { readPlanPosition } from '../js/planning/plan_pack/story_facts.js';
const position = readPlanPosition(compiled);
const current = position.routes.find(route => route.routeId === 'current');
const netWorth = current.facts['position.netWorth'];
```

Each route returns `facts`, `goalWalk`, `steps`, `freedCash`, `issues` and `unavailableIssues`. Facts use the B1.5 section 1 keys. Protection cases also register `protection.<caseId>.moneyIn`, `.gap` and `.months`, with `vsCurrent.protection.<caseId>.months` and its direction word for finite comparisons. `cashAfterGoals` is total remaining cash; the last walk step's `cashAfter` is spare cash above the reserve. `pension.disclosures` retains the priced retirement goal's relief-limit disclosures.

An available fact has `key`, `value`, `unit`, `display`, `status: "available"`, `source` and `basis`. Values keep the compiled precision. Units distinguish `EUR`, `EUR/year`, `EUR/month`, `ratio`, `months`, calendar `year`, ISO `date`, `text` and `list`. A ratio's display is a percentage. Existing catalogue metric formatting is retained when that exact target supplies it.

Sources retain the route, chapter, compiled `caseId`, native case, exact JSON pointer and versions. Focus targets come from the compiled case's presenter catalogue. A metric without a precise focus target keeps its chapter and case with a null target. Plan-owned totals, orderings, ratios and differences use `panel: "plan_facts"`, a calculation identifier and references to their inputs. Current aliases retain the current route's source.

`readPlanPosition` also registers code-produced `limitations.<id>` text for missing results and what-ifs, with the actual missing-fact paths and the affected result. These keys reach the checker and screen through the same registry.

Every fact, including missing and not-applicable results, carries `basis` for the story screen's hover. The fact contract is `story-facts-1.1.1`. The basis has one of four kinds:

- `stated`: the exact input path and `formQuestions` (each question's recorded form path, schema label and type), with the form schema, mapping version, confirmed revision and confirmation date. B1's adviser-authored inputs have no form question; they retain their stated input path and an explicit `no_form_provenance` reason instead of invented wording.
- `calculated`: the engine, calculation identifier and input references. Form-to-profile conversions name `application_to_profile` and retain the stated question as evidence. A balance changed by a route names `resource_ledger` and retains the original stated input as evidence. A code-produced missing-result explanation names `story_facts`.
- `assumption`: the central `assumptionId`, version and plain `description`, plus the policy version or register figure where relevant. The reserve months use the matching working/retired policy's own basis.
- `official`: the figures register's `registerId`, source, `checkedOn`, value and catalogue version. A mixed calculation can retain component bases in `evidence`: the cash rate after DIRT names the tax engine, with the central cash assumption and the dated official DIRT rate as evidence. The compiled date and versions govern this lookup; incompatible versions never acquire current evidence.

An optional `explainerId` is passed through when a producer supplies one. No explainer content or hover screen is built here. Current aliases preserve their original basis. Question wording is taken from the matching form schema version; an unavailable schema retains the recorded path with a reason instead of guessing its label.

A missing result has null value and unit, `status: "missing"` and a code-chosen `reason`. A fact that cannot apply has `status: "not_applicable"` and a separate available `<key>.notApplicable` sentence. Neither is numeric zero. A protection case with no income gap has no finite savings-duration comparison. #102 current-position plans retain `not_priced` goal funding; no goal coverage, yearly funding or post-goal surplus is invented. A card without a contractual end has no freed-cash entry.

`goalWalk` records the ways already chosen by the compiled route in its ledger's order, including cash and yearly commitments. It does not explore possible ways. Each step registers running spare cash and first-year surplus, using the ledger's actual earning shares. Cash and yearly commitments remain separate. Home equity uses explicitly bound mortgages and known balances; an unidentified mortgage is a missing result.

The issue list uses the five IDs in B1.5 section 2, with fixed neutral headlines and fact keys for each item. Loans and cards with known rates sort dearest first; unknown rates remain visibly unknown at the end. `yearlyCost` is annual interest at the stated balance (`balance × rate`), with that basis attached; it is not total repayments. Idle-cash comparisons use the central cash rate after DIRT. Disposal losses come from the tax engine's result after stated sale costs, and require a stated base cost. Mortgage dates come from native amortisation. These calculations use the plan's explicit calculation date and refuse incompatible rule or assumption versions.

Tax due requires the optional binding `planningInputs.taxDue: [{liabilityId, dueDate}]`. The balance comes from that liability; a label cannot establish tax due. Unknown references, duplicate bindings, invalid dates and extra fields fail normalization. Alternatives retain current issues, flag items changed by their explicit changes, and retain current facts for items no longer present. Missing facts keep an issue's disposition unknown.

`npm run check:story-facts` compiles the B1 fixture and #102's made-up form households, compares every direct fact with its compiled source, and checks every basis, the derived arithmetic, ordering, native issue calculations, missing facts and route sources. It runs in `check:consumer`. The [story checker](story-checker.md) now adds the completeness floor and matching check for links.
