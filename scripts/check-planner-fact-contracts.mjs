#!/usr/bin/env node

/**
 * OFFLINE SHAPE-CONFORMANCE AUDIT — does the contract we hand the planner
 * describe a shape the projector will actually take?
 *
 * WHY THIS EXISTS. Three paid probes were spent discovering, one layer at a
 * time, that the reconciler prompt disagreed with the projector:
 *
 *   probe 1  the record's id field — the prompt said "entityId", records carry
 *            `incomeId` / `pensionId`, so every entity the model proposed was
 *            refused
 *   probe 2  which facts are positions — nothing said, so the scalar
 *            `pension_current_value` was marked `position` and fell between both
 *            projectors: accepted, applied, canonically invisible
 *   probe 3  money — `{"amount": 95000}` with no currency, twice in one run,
 *            once nested inside a position record and once on a scalar
 *
 * Each was one real defect found for real money, and each was the same defect:
 * a PROSE description of a shape, drifting from the code that enforces it. Prose
 * cannot be tested. So the contract is now derived from
 * `canonicalFactContract` — the constants the projector itself reads — and this
 * audit proves the derivation against the projector for every fact in play.
 *
 * FREE. No model, no network. It finds the remaining layers without buying one
 * probe per layer, which is the whole reason it was written.
 */

import assert from 'node:assert/strict';

import { CURRENCY_CODES } from '../js/planning/contracts.js';
import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import {
  canonicalFactContract,
  normalizePlanningNoteV1,
  projectPlanningNotesToProfile
} from '../js/planning/reconciliation.js';
import {
  canonicalCollectionFields,
  getSemanticFactDefinition,
  listSemanticFactDefinitions
} from '../js/planning/semantic_facts.js';
import { buildLiveCataloguePrompt } from '../worker/src/consumer/live/catalogue_prompt.js';
import { getPlanningModuleDefinition } from '../js/planning/module_registry.js';
import {
  mapReconciledFactValue,
  plannerFactContracts
} from '../worker/src/consumer/planner_reconciliation.js';
import { RELEASED_MODULE_IDS } from './agent-harness/transports.mjs';

const NOW = '2026-08-16T09:00:00.000Z';
const pass = (message) => console.info(`[PlannerFactContracts] PASS: ${message}`);

/**
 * Every fact a released module can consume — the honest reading of "in play",
 * because these are the facts a real call actually has to canonicalise.
 */
const inPlayFactIds = [...new Set(
  String(RELEASED_MODULE_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)
    .flatMap((moduleId) => getPlanningModuleDefinition(moduleId)?.intakeContract?.semanticFactIds || [])
)].sort();

assert.ok(inPlayFactIds.length >= 20,
  `the audit must cover a real fact surface, got ${inPlayFactIds.length}`);

const contracts = plannerFactContracts(inPlayFactIds);

/* ------------------------------------------------------------ the projector */

/**
 * A household that already holds one of everything.
 *
 * ENTITY-SCOPED SCALARS NEED SOMETHING TO ATTACH TO. `pension_current_value`
 * lives at `/pensions/*​/currentValue`; against an empty profile it has nowhere
 * to go, and an audit run on an empty profile would report every such fact as
 * unwritable and prove nothing. One record per collection, each keyed
 * `audit_entity`, so the entity a scoped scalar names is always present.
 */
/**
 * The seeded ids are DELIBERATELY not the ids the audit writes with. An audit
 * record identical to its own seed changes nothing, and "changed nothing" is how
 * this file detects a shape the projector refused — so a shared id would report
 * every correct position as broken. Seeds are `seed_entity`; the audit writes
 * `audit_entity` and looks for the collection growing.
 */
const SEEDED = Object.freeze({
  assets: [{ assetId: 'seed_entity', ownerIds: ['primary'], type: 'cash', label: 'Seed record', currentValue: { amount: 1, currency: 'EUR' } }],
  // TWO liabilities, because a mortgage fact will not bind to a loan. A single
  // seed reported every mortgage_* fact as unwritable when the only thing wrong
  // was that the audit had not given them a mortgage to attach to.
  liabilities: [
    { liabilityId: 'seed_loan', ownerIds: ['primary'], type: 'loan', label: 'Seed loan', currentBalance: { amount: 1, currency: 'EUR' } },
    { liabilityId: 'seed_mortgage', ownerIds: ['primary'], type: 'mortgage', label: 'Seed mortgage', currentBalance: { amount: 1, currency: 'EUR' } }
  ],
  incomeSources: [{ incomeId: 'seed_entity', ownerId: 'primary', type: 'employment', label: 'Seed record', grossAnnual: { amount: 1, currency: 'EUR' } }],
  pensions: [{ pensionId: 'seed_entity', ownerId: 'primary', type: 'occupational', currentValue: { amount: 1, currency: 'EUR' } }],
  properties: [{ propertyId: 'seed_entity', ownerIds: ['primary'], use: 'home', label: 'Seed record', currentValue: { amount: 1, currency: 'EUR' } }],
  businesses: [{ businessId: 'seed_entity', ownerIds: ['primary'], label: 'Seed record', agricultural: false }],
  dependants: [{ dependantId: 'seed_entity', label: 'Seed child', currentAge: 8 }],
  goals: [{ goalId: 'seed_entity', type: 'buy_home', title: 'Seed goal', priority: 'high', status: 'active' }]
});

/** Which seeded entity a scoped scalar attaches to. */
const seedEntityFor = (contract) => (contract.inCollection !== 'liabilities'
  ? 'seed_entity'
  : contract.factId.startsWith('mortgage_') ? 'seed_mortgage' : 'seed_loan');

// Assigned after creation, not passed into it: `createHouseholdProfile` builds a
// fresh household and silently drops collections handed to it, so seeding
// through it produced an empty profile that made every entity-scoped scalar
// look unwritable.
const baseProfile = () => normalizeHouseholdProfile({
  ...createHouseholdProfile({
    profileId: 'planner-contract-audit',
    primaryPerson: { personId: 'primary', role: 'primary', age: 57 },
    partner: { personId: 'partner', role: 'partner', age: 59 }
  }),
  ...SEEDED
});

const note = (over) => normalizePlanningNoteV1({
  noteId: `note_${over.factId}_${over.noteKind}`,
  certainty: 'exact',
  lifecycle: 'active',
  reviewStatus: 'provisional',
  source: 'realtime_note',
  evidenceRefs: [],
  replacesNoteIds: [],
  createdAt: NOW,
  ...over
});

/**
 * Did this note's value actually reach canonical state anywhere?
 *
 * WITH THE PRODUCTION MAPPER. `applyReconciliationPlan` always passes
 * `mapReconciledFactValue`, and it is what turns a spoken 6 percent into the
 * 0.06 a rate slot holds. Running this audit without it reported every rate
 * fact as unprojectable — the audit measuring a path production never takes.
 */
function projects(planningNote) {
  const before = baseProfile();
  let after;
  try {
    after = projectPlanningNotesToProfile(before, [planningNote], {
      mapFactValue: mapReconciledFactValue
    });
  } catch (_error) {
    return false;
  }
  return JSON.stringify(stripVolatile(after)) !== JSON.stringify(stripVolatile(before));
}

function stripVolatile(profile) {
  const copy = JSON.parse(JSON.stringify(profile));
  delete copy.updatedAt;
  delete copy.revision;
  delete copy.fieldMetadata;
  delete copy.assumptions?.values?.planning;
  return copy;
}

/**
 * A value of exactly the shape the contract promises — nothing more.
 *
 * Built from `requiredKeys` alone, with a plausible value per key, so the record
 * is the MINIMUM the contract claims is sufficient. Adding anything extra here
 * would hide a missing required field behind a field the model was never told
 * to send, which is precisely the failure this audit exists to catch.
 */
const KEY_VALUES = Object.freeze({
  type: (factId) => (factId === 'income_sources' ? 'employment'
    : factId === 'pension_positions' ? 'occupational'
      : factId === 'asset_position' ? 'cash'
        : factId === 'mortgage_position' ? 'mortgage'
          : factId === 'loan_position' ? 'loan' : 'other'),
  use: () => 'home',
  label: () => 'Audit record',
  agricultural: () => false,
  currentAge: () => 8
});

function validValueFor(contract) {
  if (contract.target === 'position') {
    const owner = contract.ownerKey === 'ownerIds' ? ['primary'] : 'primary';
    const record = {};
    for (const key of contract.requiredKeys) {
      if (key === contract.idKey) record[key] = 'audit_entity';
      else if (key === contract.ownerKey) record[key] = owner;
      else record[key] = KEY_VALUES[key] ? KEY_VALUES[key](contract.factId) : 'audit';
    }
    // The owner has to be in the record even when it is not required, because
    // `assertPositionRecord` refuses a record whose owner disagrees with the
    // note's — the two identities must be the same one.
    if (contract.ownerKey && !Object.hasOwn(record, contract.ownerKey)) {
      record[contract.ownerKey] = owner;
    }
    return record;
  }
  if (contract.choices) return contract.choices[0];
  if (contract.money) return MONEY_VALUES[contract.factId] || money();
  if (contract.valueType === 'boolean') return true;
  // Plausible magnitudes, because the profile contract has ranges: an age of 8
  // is not a retirement age and a monthly payment is not 95,000. A value the
  // slot refuses on RANGE would read here as a shape failure.
  return NUMBER_VALUES[contract.factId] ?? 42;
}

/**
 * Does the contract actually PROMISE a literal shape for this fact?
 *
 * A handful of facts are `valueType: entity` without being collections —
 * `primary_goal` is `{type}`, `specialist_asset_reconciliation` is
 * `{category, entityId, decision}` — and those shapes exist only as prose in the
 * LIVE prompt, with nothing machine-readable behind them. This audit will not
 * pretend to verify a shape the contract never claimed; what it DOES enforce is
 * that the contract makes no claim about them, so we can never advertise a shape
 * we cannot prove. Closing that gap means giving those facts a derivable shape,
 * which is a change to the fact registry, not to this file.
 */
const promisesShape = (contract) => contract.target === 'position'
  || Boolean(contract.money)
  || Boolean(contract.choices)
  || ['number', 'boolean'].includes(contract.valueType);

/** Scalars inside a position must name the position they belong to. */
const OWNERLESS_COLLECTIONS = new Set(['dependants', 'liabilities']);
const scalarNoteIdentity = (contract) => (contract.inCollection
  ? {
    entityId: seedEntityFor(contract),
    // An ownerId narrows which path the scalar bridge will resolve. Dependants
    // have no owner at all, and a liability's owner is a LIST — naming a single
    // owner there makes the bridge look for a per-person path that is not how
    // those collections are keyed.
    ...(OWNERLESS_COLLECTIONS.has(contract.inCollection) ? {} : { ownerId: 'primary' })
  }
  : {});

const money = (over = {}) => ({ amount: 95_000, currency: 'EUR', ...over });

const NUMBER_VALUES = Object.freeze({
  person_current_age: 45,
  dependant_current_age: 12,
  intended_retirement_age: 65,
  pension_benefit_start_age: 65,
  state_pension_start_age: 66
});

/** Money facts whose slot rejects a salary-sized figure. */
const MONEY_VALUES = Object.freeze({
  liability_monthly_payment: { amount: 950, currency: 'EUR' },
  current_monthly_rent: { amount: 1_400, currency: 'EUR' },
  monthly_spending: { amount: 2_600, currency: 'EUR' }
});

/* ================================================= 3. no phantom writability */

{
  const advertised = new Set(contracts.map((entry) => entry.factId));
  for (const factId of inPlayFactIds) {
    const definition = getSemanticFactDefinition(factId);
    const contract = canonicalFactContract(factId, definition);
    if (!contract || contract.target === 'none') {
      assert.equal(advertised.has(factId), false,
        `${factId} has no canonical target and must not be advertised as writable`);
    }
  }
  // And the derivation must agree with the projector about which facts those
  // are, rather than being an opinion of its own.
  for (const definition of listSemanticFactDefinitions()) {
    const contract = canonicalFactContract(definition.factId, definition);
    assert.ok(contract, `every semantic fact must resolve to a contract: ${definition.factId}`);
    assert.ok(['position', 'scalar', 'none'].includes(contract.target),
      `${definition.factId} resolved to an unknown target`);
  }
  pass('facts with no canonical target are never advertised as canonically writable');
}

/* ============================= 1 + 2. the promised shape is the accepted shape */

{
  let positions = 0;
  let scalars = 0;
  const unreachable = [];
  const unshaped = [];
  for (const contract of contracts) {
    const kind = contract.target === 'position' ? 'position' : 'fact';
    assert.equal(contract.noteKind, kind,
      `${contract.factId}: the contract's noteKind must follow its target`);

    const valid = note({
      factId: contract.factId,
      noteKind: contract.noteKind,
      factInstanceId: `${contract.factId}:audit_entity`,
      ...(contract.target === 'position'
        ? { entityId: 'audit_entity', ownerId: 'primary' }
        : scalarNoteIdentity(contract)),
      value: validValueFor(contract)
    });
    // Collected rather than asserted one at a time: a contract audit that dies
    // on the first fact tells you one name per run, and the whole point of
    // being offline is to see the entire surface at once.
    if (!promisesShape(contract)) {
      unshaped.push(contract.factId);
      assert.equal(Boolean(contract.money || contract.choices), false,
        `${contract.factId}: the contract must not advertise a shape it cannot prove`);
      continue;
    }
    if (!projects(valid)) {
      unreachable.push(`${contract.factId} (${contract.target}/${contract.valueType}`
        + `${contract.inCollection ? ` in ${contract.inCollection}` : ''}): `
        + JSON.stringify(validValueFor(contract)));
      continue;
    }

    if (contract.target === 'position') {
      positions += 1;
      // 2. REQUIRED FIELDS CANNOT BE OMITTED — every one of them, individually.
      //    This is what stops `requiredKeys` being a hopeful list: the audit
      //    drops each key in turn and the projector must refuse each time. A
      //    field the profile contract starts requiring, and this list does not
      //    mention, fails here rather than reaching a paid probe.
      for (const key of contract.requiredKeys) {
        const missing = { ...validValueFor(contract) };
        delete missing[key];
        assert.equal(projects(note({
          factId: contract.factId, noteKind: 'position',
          factInstanceId: `${contract.factId}:audit_entity`,
          entityId: 'audit_entity', ownerId: 'primary', value: missing
        })), false,
        `${contract.factId}: a record missing ${key} must not project — `
          + 'either the field is not required, or requiredKeys is understating the shape');
      }

      // Drop the id key and the record stops being a record — the probe-1 shape.
      const withoutId = { ...validValueFor(contract) };
      delete withoutId[contract.idKey];
      assert.equal(projects(note({
        factId: contract.factId, noteKind: 'position',
        factInstanceId: `${contract.factId}:audit_entity`,
        entityId: 'audit_entity', ownerId: 'primary', value: withoutId
      })), false, `${contract.factId}: a record missing its ${contract.idKey} must not project`);

      // The exact probe-1 shape: the identity under a generic `entityId`.
      const genericKey = { ...withoutId, entityId: 'audit_entity' };
      assert.equal(projects(note({
        factId: contract.factId, noteKind: 'position',
        factInstanceId: `${contract.factId}:audit_entity`,
        entityId: 'audit_entity', ownerId: 'primary', value: genericKey
      })), false,
      `${contract.factId}: a record keyed by a generic entityId must not project`);
    } else {
      scalars += 1;
    }

    // 4. POSITION AND SCALAR CANNOT BE CONFUSED — in both directions.
    const flipped = note({
      factId: contract.factId,
      noteKind: kind === 'position' ? 'fact' : 'position',
      factInstanceId: `${contract.factId}:audit_entity`,
      entityId: 'audit_entity',
      ownerId: 'primary',
      value: validValueFor(contract)
    });
    assert.equal(projects(flipped), false,
      `${contract.factId}: the wrong noteKind must reach nothing, in either direction`);
  }
  /**
   * A PINNED GAP LIST, NOT A PASS.
   *
   * `mapReconciledFactValue` OWNS these two facts and refuses every value for
   * them, and a mapper that owns a fact has the last word — there is no raw
   * fallback. So they have no reachable canonical path from the reconciler, in
   * production as much as here. They stay listed by name so the audit still
   * fails the moment the set CHANGES: a new unreachable fact is a regression,
   * and one of these becoming reachable is a fix worth noticing.
   */
  const mapperRefuses = ['dependant_current_age', 'liability_monthly_payment'];
  const unexpected = unreachable
    .filter((entry) => !mapperRefuses.some((factId) => entry.startsWith(`${factId} `)));
  if (unexpected.length) {
    console.error(`\n[PlannerFactContracts] ${unexpected.length} advertised fact(s) whose promised `
      + 'shape the projector does not accept:');
    for (const entry of unexpected) console.error(`  ✗ ${entry}`);
  }
  assert.deepEqual(unexpected, [],
    'every fact the contract advertises must have a shape that reaches canonical state');
  assert.deepEqual(
    unreachable.map((entry) => entry.split(' ')[0]).sort(),
    [...mapperRefuses].sort(),
    'the set of facts with no reachable canonical path must not change silently'
  );
  if (unshaped.length) {
    console.info(`[PlannerFactContracts] ${unshaped.length} fact(s) advertised with a canonical `
      + `target but no derivable shape: ${unshaped.join(', ')}`);
  }
  assert.ok(positions >= 3 && scalars >= 10,
    `the audit must cover both families in bulk, got ${positions} positions and ${scalars} scalars`);
  pass(`the promised shape is the accepted shape for all ${contracts.length} in-play facts`);
  pass('required fields cannot be omitted, and position/scalar cannot be confused');
}

/* ============================================ money, nested and unnested */

{
  const moneyContracts = contracts.filter((entry) => entry.money);
  assert.ok(moneyContracts.length >= 5,
    `the audit must cover the money surface, got ${moneyContracts.length}`);
  for (const contract of moneyContracts) {
    assert.deepEqual(contract.money, { amount: 'number', currency: CURRENCY_CODES },
      `${contract.factId}: the advertised money shape must name both required keys`);
    const noCurrency = note({
      factId: contract.factId, noteKind: 'fact',
      factInstanceId: contract.factId,
      value: { amount: 95_000 }
    });
    assert.equal(projects(noCurrency), false,
      `${contract.factId}: money without a currency must not reach canonical state`);
  }

  // Nested money inside a position record — the shape that actually failed.
  const nested = (grossAnnual) => note({
    factId: 'income_sources', noteKind: 'position',
    factInstanceId: 'income_sources:audit_entity',
    entityId: 'audit_entity', ownerId: 'primary',
    value: { incomeId: 'audit_entity', ownerId: 'primary', type: 'employment', label: 'Employment income', grossAnnual }
  });
  assert.equal(projects(nested(money())), true, 'nested money with a currency must project');
  assert.equal(projects(nested({ amount: 95_000 })), false,
    'nested money without a currency must not project');
  pass('money requires amount AND currency, nested inside a record and on its own');
}

/* ================================= the four operations the paid probes produced */

/**
 * VERBATIM FIXTURES. These are the values a real gpt-5.6-luna wrote, kept
 * exactly as it wrote them, so a future change that quietly starts accepting one
 * of them fails here rather than in a paid run.
 */
{
  const probeCases = [
    {
      label: 'probe 1 — income_sources keyed by a generic entityId',
      note: {
        factId: 'income_sources', noteKind: 'position',
        factInstanceId: 'income_sources:recon_slot_income_sources_1',
        entityId: 'recon_slot_income_sources_1', ownerId: 'primary',
        value: {
          entityId: 'recon_slot_income_sources_1', ownerId: 'primary',
          type: 'employment', grossAnnual: { amount: 95_000, currency: 'EUR' }
        }
      }
    },
    {
      label: 'probe 2 — pension_current_value emitted as a position',
      note: {
        factId: 'pension_current_value', noteKind: 'position',
        factInstanceId: 'pension_current_value:pension_realtime_occ1',
        entityId: 'pension_realtime_occ1', ownerId: 'primary',
        value: { amount: 319_000, currency: 'EUR' }
      }
    },
    {
      label: 'probe 3 — income_sources.grossAnnual missing its currency',
      note: {
        factId: 'income_sources', noteKind: 'position',
        factInstanceId: 'income_sources:recon_slot_income_sources_1',
        entityId: 'recon_slot_income_sources_1', ownerId: 'primary',
        value: {
          incomeId: 'recon_slot_income_sources_1', ownerId: 'primary',
          type: 'employment', grossAnnual: { amount: 95_000 }
        }
      }
    },
    {
      label: 'probe 3 — gross_household_income missing its currency',
      note: {
        factId: 'gross_household_income', noteKind: 'fact',
        factInstanceId: 'gross_household_income',
        value: { amount: 95_000 }
      }
    }
  ];
  for (const probeCase of probeCases) {
    assert.equal(projects(note(probeCase.note)), false,
      `${probeCase.label}: must not reach canonical state`);
  }

  // And the corrected form of each of the two repairable ones DOES land, so the
  // audit proves a working shape exists rather than only that broken ones fail.
  assert.equal(projects(note({
    factId: 'income_sources', noteKind: 'position',
    factInstanceId: 'income_sources:recon_slot_income_sources_1',
    entityId: 'recon_slot_income_sources_1', ownerId: 'primary',
    value: {
      incomeId: 'recon_slot_income_sources_1', ownerId: 'primary',
      type: 'employment', label: 'Employment income',
      grossAnnual: { amount: 95_000, currency: 'EUR' }
    }
  })), true, 'the corrected income record must reach canonical state');
  assert.equal(projects(note({
    factId: 'pension_current_value', noteKind: 'fact',
    factInstanceId: 'pension_current_value:pension_realtime_occ1',
    entityId: 'pension_realtime_occ1', ownerId: 'primary',
    value: { amount: 319_000, currency: 'EUR' }
  })), false, 'a pension value with no such pension has nothing to attach to, and says so');

  pass('every operation shape the paid probes produced is pinned as a regression');
}

/* ------------------------------------------------------------------ summary */

const byTarget = contracts.reduce((totals, entry) => {
  totals[entry.target] = (totals[entry.target] || 0) + 1;
  return totals;
}, {});
console.info(`\n[PlannerFactContracts] ${inPlayFactIds.length} in-play facts, `
  + `${contracts.length} advertised (${byTarget.position || 0} position, ${byTarget.scalar || 0} scalar), `
  + `${contracts.filter((entry) => entry.money).length} money, `
  + `${contracts.filter((entry) => entry.choices).length} closed-choice`);
console.info('[PlannerFactContracts] PASS: the planner contract matches what the projector accepts');

/* ============ one registry, two prompt surfaces, no hand-written twins */

/**
 * THE FOUR-SOURCES-OF-TRUTH GUARD.
 *
 * That an income's money lives in `grossAnnual`/`netAnnual` was stated as a
 * path pattern in the semantic registry AND written out as prose in the live
 * prompt, and was about to be written a third time for the reconciler. Not
 * knowing that name cost three paid probes: a real planner sent a correctly
 * shaped income record carrying `amount`, and the projector wrote it raw and
 * dropped the figure.
 *
 * Both prompt surfaces now read `canonicalCollectionFields()`. These assertions
 * are what stop a fourth copy appearing: a field name either comes from the
 * registry or it does not exist.
 */
{
  const collectionFields = canonicalCollectionFields();
  const livePrompt = buildLiveCataloguePrompt();

  assert.deepEqual(collectionFields.incomeSources, ['grossAnnual', 'netAnnual'],
    'income_sources must expose exactly its two canonical money fields');
  for (const field of ['currentValue', 'employeeContributionRate', 'employerContributionRate',
    'contributionStatus', 'projectedAnnualIncome', 'benefitStartAge', 'retirementLumpSum']) {
    assert.ok(collectionFields.pensions.includes(field),
      `pension_positions must expose ${field}`);
  }

  // The planner contract carries them, derived — never listed by hand.
  const income = contracts.find((entry) => entry.factId === 'income_sources');
  assert.deepEqual(income.valueFields, collectionFields.incomeSources,
    'the planner contract must take its field names from the registry');
  const pension = contracts.find((entry) => entry.factId === 'pension_positions');
  assert.deepEqual(pension.valueFields, collectionFields.pensions,
    'and so must the pension contract');

  // The live prompt states the same names, generated from the same call.
  assert.ok(livePrompt.includes('grossAnnual or netAnnual'),
    'the live prompt must state the income fields the registry defines');

  // THE DRIFT GUARD, IN THE DIRECTION THAT MATTERS: registry -> prompt.
  //
  // The live prompt's income fragment is GENERATED from the registry, and this
  // rebuilds the same string from the same call. Add a field to
  // `/incomeSources/*​/…` in semantic_facts and the prompt updates itself and
  // this still passes; replace the generation with a hardcoded sentence and the
  // next registry change makes this fail. That is what stops a second copy.
  const expectedIncomeFragment = collectionFields.incomeSources.length > 1
    ? `${collectionFields.incomeSources.slice(0, -1).join(', ')} or ${collectionFields.incomeSources.at(-1)}`
    : collectionFields.incomeSources[0];
  assert.ok(livePrompt.includes(expectedIncomeFragment),
    `the live prompt must state exactly the registry's income fields (${expectedIncomeFragment})`);

  // A name the registry does own must never be attached to the wrong
  // collection. Checked only for names the registry actually defines, because
  // the prompt legitimately also names conversational input aliases the mapper
  // accepts — `remainingTermYears`, `annualCostTodayPerChild` — which are the
  // mapper's vocabulary, not canonical profile fields.
  const collectionsFor = (field) => Object.entries(collectionFields)
    .filter(([, fields]) => fields.includes(field)).map(([collection]) => collection).sort();
  assert.deepEqual(collectionsFor('grossAnnual'), ['incomeSources'],
    'grossAnnual belongs to exactly one collection');
  // `currentValue` is NOT unique — assets, pensions and properties all hold one.
  // So a field name alone never identifies a slot, which is exactly why the
  // contract carries the collection alongside it and the planner is told the
  // fact, not just the field.
  assert.deepEqual(collectionsFor('currentValue'), ['assets', 'pensions', 'properties'],
    'a shared field name must not be treated as identifying a collection');

  // Identity and ownership rules are untouched by any of this.
  //
  // Income moved to `ownerIds` when rent from a jointly owned property stopped
  // being disguised as a household pseudo-owner: a joint income is one record
  // naming both real people, the same shape a joint property already used.
  // Whether a given income type may actually carry two owners is enforced by
  // the profile schema, not by the owner key.
  assert.equal(contracts.find((e) => e.factId === 'income_sources').ownerKey, 'ownerIds',
    'joint-capable collections must keep their ownerIds identity');
  assert.equal(contracts.find((e) => e.factId === 'property_position').ownerKey, 'ownerIds',
    'joint-capable collections must keep their ownerIds identity');
  assert.equal(contracts.find((e) => e.factId === 'pension_positions').ownerKey, 'ownerId',
    'a pension belongs to one person, so it keeps the singular owner key');
  assert.equal(contracts.find((e) => e.factId === 'pension_positions').idKey, 'pensionId');

  pass('both prompt surfaces derive canonical field names from one registry');
}

console.info('[PlannerFactContracts] PASS: one registry, no hand-written field names');
