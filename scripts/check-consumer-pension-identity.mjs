#!/usr/bin/env node

/**
 * IS THIS THE PENSION WE ALREADY HAVE, OR A SECOND ONE?
 *
 * On the first real live-model call the model said `primary` on one turn and
 * `primary_occupational` on another for the SAME pension, and the household
 * ended up holding two — each carrying the same 319,000. The analysis would
 * have been handed 638,000 for a client with 319,000: right arithmetic, wrong
 * canonical input, which is the worst shape a defect can take here.
 *
 * The cause was that the reuse check only ever compared a supplied string
 * against a CANONICAL id, and the live model is never shown canonical ids. It
 * could not reuse an identity it had never been told.
 *
 * IDENTITY IS MATCHED, NEVER INFERRED. Nothing below looks at the amount: a
 * coincidence of value is not evidence that two holdings are one, and two
 * people can hold identical pensions. Where identity cannot be established the
 * write is REFUSED rather than merged or duplicated, so the conversation can
 * ask which it is.
 */

import assert from 'node:assert/strict';

import { createHouseholdProfile, normalizeHouseholdProfile } from '../js/planning/profile.js';
import { mapRealtimeFact } from '../worker/src/consumer/realtime_fact_mapper.js';
import { partitionSupportedLiveFacts, pensionIdentityDirective } from '../worker/src/consumer/live/live_tools.js';
import { plannerReconciliationPreflight } from '../worker/src/consumer/live/live_session.js';
import { buildLiveCataloguePrompt } from '../worker/src/consumer/live/catalogue_prompt.js';

const pass = (message) => console.info(`[PensionIdentity] PASS: ${message}`);

function household() {
  let profile = normalizeHouseholdProfile(createHouseholdProfile({
    profileId: 'pension-identity',
    primaryPerson: { personId: 'primary', role: 'primary', age: 57 },
    partner: { personId: 'partner_realtime', role: 'partner', age: 59 }
  }));
  return {
    save(value) {
      const { __directive: identityDirective, ...rest } = value;
      const mapped = mapRealtimeFact(profile, {
        factId: 'pension_positions', value: rest, ...(identityDirective ? { identityDirective } : {})
      });
      profile = normalizeHouseholdProfile({ ...profile, pensions: mapped.canonicalValue });
      return profile.pensions;
    },
    refusalFrom(value) {
      try {
        this.save(value);
        return null;
      } catch (error) {
        return error?.code || 'threw';
      }
    },
    get pensions() { return profile.pensions; }
  };
}

const occupational = (over) => ({
  operation: 'upsert', type: 'occupational', owner: 'primary', ...over
});

/* 1. the same pension under two different model-invented ids.
 *
 * ONLY RESOLVABLE THROUGH SOMETHING SHARED. Two arbitrary ids with nothing in
 * common are indistinguishable from two real pensions, and merging them would
 * lose one. What makes this case resolvable is the name the client gave the
 * holding on the first turn — so that is what the second turn matches on. */
{
  const h = household();
  h.save(occupational({ entityId: 'occ1', label: 'Company scheme', currentValue: { amount: 319_000, currency: 'EUR' } }));
  h.save(occupational({ entityId: 'whatever', label: 'Company scheme', employeeContributionRate: 6 }));
  assert.equal(h.pensions.length, 1,
    `one pension referred to twice must stay one holding, found ${h.pensions.length}`);
  assert.equal(h.pensions[0].currentValue.amount, 319_000, 'and keep its value');
  assert.equal(h.pensions[0].employeeContributionRate, 0.06, 'and gain the new detail');
  pass('the same pension under two model ids stays one holding');
}

/* 2. the canonical id, handed back as the captured state now shows it */
{
  const h = household();
  h.save(occupational({ entityId: 'occ1', currentValue: { amount: 319_000, currency: 'EUR' } }));
  const canonicalId = h.pensions[0].pensionId;
  h.save(occupational({ entityId: canonicalId, contributionStatus: 'active' }));
  assert.equal(h.pensions.length, 1, 'the canonical id must resolve to the holding it names');
  assert.equal(h.pensions[0].contributionStatus, 'active');
  pass('a pension referred to again by its canonical id stays one holding');
}

/* 3. the short id, re-supplied — the round trip that was broken */
{
  const h = household();
  h.save(occupational({ entityId: 'occ1', currentValue: { amount: 319_000, currency: 'EUR' } }));
  h.save(occupational({ entityId: 'occ1', employerContributionRate: 8 }));
  assert.equal(h.pensions.length, 1, 'the same short id must resolve to the same holding');
  assert.equal(h.pensions[0].employerContributionRate, 0.08);
  pass('the same short id resolves through canonicalisation to one holding');
}

/* 4. a stable label, with no usable id at all */
{
  const h = household();
  h.save(occupational({ entityId: 'occ1', label: 'Zurich scheme', currentValue: { amount: 319_000, currency: 'EUR' } }));
  h.save(occupational({ entityId: 'freshly_invented', label: 'zurich scheme', contributionStatus: 'active' }));
  assert.equal(h.pensions.length, 1, 'a stable label must resolve to the holding that carries it');
  assert.equal(h.pensions[0].label, 'Zurich scheme', 'and the established label is preserved');
  pass('a pension referred to by its stable label stays one holding');
}

/* 5. two genuinely distinct pensions — different kinds, and a partner's */
{
  const h = household();
  h.save(occupational({ entityId: 'occ1', currentValue: { amount: 319_000, currency: 'EUR' } }));
  h.save({ operation: 'upsert', entityId: 'prsa1', type: 'prsa', owner: 'primary',
    currentValue: { amount: 319_000, currency: 'EUR' } });
  h.save({ operation: 'upsert', entityId: 'bob1', type: 'buyout_bond', owner: 'primary',
    currentValue: { amount: 319_000, currency: 'EUR' } });
  assert.equal(h.pensions.length, 3,
    `distinct kinds must stay distinct, found ${h.pensions.length}`);
  // Identical values throughout, and nothing was merged: value is not identity.
  assert.deepEqual([...new Set(h.pensions.map((item) => item.currentValue.amount))], [319_000]);
  pass('distinct pensions with identical values remain distinct holdings');
}

/* 6. an unmatched id is now HELD for a question, not minted.
 *
 * This case has been through both wrong answers. It first refused the write
 * outright, which rejected a client who genuinely held two occupational
 * pensions. It then minted freely, which let one pension become two holdings on
 * a real call. Neither is knowable from here — so the write is held, canonical
 * state is untouched, and the conversation asks. See cases C and D for the two
 * ways that question resolves. */
{
  const h = household();
  h.save(occupational({ entityId: 'occ1', currentValue: { amount: 319_000, currency: 'EUR' } }));
  const before = JSON.stringify(h.pensions);
  assert.equal(
    h.refusalFrom(occupational({ entityId: 'second_scheme', currentValue: { amount: 319_000, currency: 'EUR' } })),
    'realtime_pension_identity_ambiguous',
    'an unmatched same-owner same-type pension is held for a question'
  );
  assert.equal(h.pensions.length, 1, 'nothing is minted');
  assert.equal(JSON.stringify(h.pensions), before, 'and nothing is merged or altered');
  pass('an unmatched id is held for clarification rather than guessed at');
}

/* 7. the first pension of its kind is never ambiguous */
{
  const h = household();
  assert.equal(h.refusalFrom(occupational({ entityId: 'occ1', currentValue: { amount: 1, currency: 'EUR' } })), null,
    'with nothing to be confused with, a fresh identity is safe');
  pass('a first holding is minted without a question');
}


/* ================= the clarification backstop, cases A-E ================= */

/**
 * WHEN THE LANE CANNOT TELL, IT ASKS — IT DOES NOT GUESS.
 *
 * An earlier version refused this collision outright and rejected a client who
 * genuinely held an old scheme and a current one. Refusing and merging are both
 * guesses; the answer exists only with the client, so the write is held, the
 * conversation carries on, and the analyses are blocked until they say which.
 */
{
  const directive = pensionIdentityDirective;

  /* A — the same pension under a new model id, resolvable without asking */
  {
    const h = household();
    h.save(occupational({ entityId: 'occ1', label: 'Company scheme', currentValue: { amount: 319_000, currency: 'EUR' } }));
    h.save(occupational({ entityId: 'a_new_id', label: 'Company scheme', contributionStatus: 'active' }));
    assert.equal(h.pensions.length, 1, 'strong identity evidence must reuse the holding');
    assert.equal(h.pensions[0].currentValue.amount, 319_000, 'and preserve its value');
    assert.equal(directive('That pension is still being paid into.', ''), null,
      'and no identity question is needed, so none is asked');
    pass('A — the same pension under a new id is reused without a question');
  }

  /* B — genuinely ambiguous: held, not minted, not merged */
  {
    const h = household();
    h.save(occupational({ entityId: 'occ1', currentValue: { amount: 319_000, currency: 'EUR' } }));
    const before = JSON.stringify(h.pensions);
    const refusal = h.refusalFrom(occupational({
      entityId: 'other_scheme', currentValue: { amount: 250_000, currency: 'EUR' }
    }));
    assert.equal(refusal, 'realtime_pension_identity_ambiguous',
      `an unresolvable second pension must be held for a question, got ${refusal}`);
    assert.equal(h.pensions.length, 1, 'no second holding may be minted');
    assert.equal(JSON.stringify(h.pensions), before, 'and canonical state is untouched');
    assert.equal(plannerReconciliationPreflight('apply', {}, [], [{ factId: 'pension_positions' }]).ready,
      false, 'and the analyses must not run while it is unresolved');
    pass('B — an ambiguous reference is held, and blocks execution, without duplicating');
  }

  /* C — the client says it is the same one */
  {
    const h = household();
    h.save(occupational({ entityId: 'occ1', currentValue: { amount: 319_000, currency: 'EUR' } }));
    assert.equal(directive("Yes, that's the same pension", ''), 'same');
    h.save({ ...occupational({ entityId: 'other_scheme', contributionStatus: 'active' }),
      __directive: 'same' });
    assert.equal(h.pensions.length, 1, 'a "same pension" answer must reuse the holding');
    assert.equal(h.pensions[0].currentValue.amount, 319_000, 'without losing its value');
    assert.equal(h.pensions[0].contributionStatus, 'active', 'and gaining the new detail');
    assert.equal(plannerReconciliationPreflight('apply', {}, [], []).ready, true,
      'and once resolved the gate opens again');
    pass('C — "the same pension" reuses the existing holding and clears the block');
  }

  /* D — the client says it is a separate one */
  {
    const h = household();
    h.save(occupational({ entityId: 'occ1', currentValue: { amount: 319_000, currency: 'EUR' } }));
    assert.equal(directive('No, that is a separate old occupational pension', ''), 'distinct');
    h.save({ ...occupational({ entityId: 'old_scheme', currentValue: { amount: 250_000, currency: 'EUR' } }),
      __directive: 'distinct' });
    assert.equal(h.pensions.length, 2, 'a "separate pension" answer must create the second holding');
    assert.deepEqual(h.pensions.map((item) => item.currentValue.amount).sort((a, b) => a - b),
      [250_000, 319_000], 'and both holdings keep their own value');
    pass('D — "a separate pension" creates the second holding, with no merge');
  }

  /* E — two real same-type same-value pensions, stated as separate */
  {
    const h = household();
    h.save(occupational({ entityId: 'occ1', currentValue: { amount: 319_000, currency: 'EUR' } }));
    h.save({ ...occupational({ entityId: 'old1', currentValue: { amount: 319_000, currency: 'EUR' } }),
      __directive: 'distinct' });
    assert.equal(h.pensions.length, 2, 'two genuinely separate pensions must both survive');
    assert.deepEqual(h.pensions.map((item) => item.currentValue.amount), [319_000, 319_000],
      'identical values are never evidence that two holdings are one');
    pass('E — two real same-type same-value pensions remain two holdings');
  }
}

/* ------------------------------------------------------------------------ *
 * F — A PENSION VALUE IS EVIDENCED BY THE FIGURE, NOT BY ADVISER VOCABULARY
 *
 * A valued `pension_positions` write resolves to slot `pension_value:<type>`,
 * and the subtype rule used to demand the TRANSCRIPT contain "occupational" or
 * "workplace". Clients do not speak that way. "My pension is worth €319,000"
 * was refused `live_numeric_fact_unsupported` purely because the model had
 * correctly typed the company scheme — the same sentence with no type was
 * accepted.
 *
 * Two paid runs lost their pension entirely to this: the position was refused,
 * the `pension_current_value` that followed had nothing to attach to
 * (`realtime_pension_entity_unresolved`), readiness never closed and no module
 * ever ran. The subtype now DISAMBIGUATES between competing types rather than
 * gating the figure.
 * ------------------------------------------------------------------------ */
{
  const admits = (type, said) => {
    const { accepted } = partitionSupportedLiveFacts([{
      factId: 'pension_positions', certainty: 'exact',
      value: { operation: 'upsert', owner: 'primary', entityId: 'p1', type, amount: 319_000, currency: 'EUR' }
    }], said, {});
    return accepted.length === 1;
  };

  // What a client actually says, with the model classifying correctly.
  for (const [type, said] of [
    ['occupational', 'My pension is worth €319,000.'],
    ['prsa', 'My pension is worth €319,000.'],
    ['defined_benefit', 'I have about €319,000 in my pot.']
  ]) {
    assert.equal(admits(type, said), true,
      `plain speech must evidence a ${type} pension value without adviser vocabulary`);
  }
  pass('F — a stated pension value is admitted whatever type the model assigns it');

  // The cue, when the client does use it, still works.
  assert.equal(admits('occupational', 'My workplace pension is worth €319,000.'), true,
    'an explicit matching cue must still be accepted');
  assert.equal(admits('prsa', 'My PRSA is worth €319,000.'), true,
    'as must a PRSA named as one');
  pass('F — an explicit type cue is still accepted');

  // THE PROTECTION THAT MUST NOT BE LOST: a COMPETING type in the same breath
  // means the figure could land on the wrong pension, so it fails closed.
  for (const [type, said] of [
    ['occupational', 'My PRSA is worth €319,000.'],
    ['prsa', 'My final salary pension is worth €319,000.'],
    ['personal', 'My workplace pension is worth €319,000.']
  ]) {
    assert.equal(admits(type, said), false,
      `a competing pension type in the same breath must still fail closed (${type})`);
  }
  pass('F — a figure named as a DIFFERENT kind of pension still fails closed');

  // And the base evidence rule is untouched.
  assert.equal(admits('occupational', 'I paid €319,000 for the house.'), false,
    'a figure with no pension cue at all is still not a pension value');
  assert.equal(admits('occupational', 'I put 5% into my pension.'), false,
    'a contribution percentage is still not a pot value');
  pass('F — a figure with no pension evidence, or a rate, is still refused');
}

/* ------------------------------------------------------------------------ *
 * G — "BETWEEN US" IS HOUSEHOLD LANGUAGE, NOT OWNERSHIP EVIDENCE
 *
 * The same call read "only the one pension between us" as a PARTNER pension and
 * invented a holding nobody has. Collective phrasing describes the household;
 * it is not evidence about whose the pension is.
 * ------------------------------------------------------------------------ */
{
  const prompt = buildLiveCataloguePrompt({ recommendations: [], profile: null });
  const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
  assert.match(text, /between us/i,
    'the prompt must name the collective phrasing that caused the invented holding');
  assert.match(text, /NOT evidence that a holding/i,
    'and must say plainly that it is not evidence of partner ownership');
  assert.match(text, /pension with no value is not a holding/i,
    'and must tell the model to ask for a value rather than save an empty pension');
  pass('G — the live prompt treats "we"/"between us" as household language, not ownership');
}

console.info('\n[PensionIdentity] PASS: one pension stays one, two stay two, and the unclear case asks');
