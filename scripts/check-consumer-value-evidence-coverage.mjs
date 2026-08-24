#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  boundedUncoveredValueEvidence,
  extractValueEvidence,
  groundPlannerExtraction,
  valueEvidenceCoverage
} from '../js/planning/value_evidence.js';
import { buildRepairRequest } from '../worker/src/consumer/planning_turn.js';
import { createHouseholdProfile } from '../js/planning/profile.js';
import { applyReconciliationPlan } from '../js/planning/reconciliation.js';

let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
};
const money = (amount, currency = 'EUR') => ({ amount, currency });

/* -------------------------- occurrence/multiset regression matrix */

const fixtures = [
  {
    label: 'reversed independent holdings',
    transcript: 'Shares are about €18,000; the workplace pension is roughly €73,000.',
    accepted: [money(18_000)],
    expected: [{ value: 73_000, currency: 'EUR' }]
  },
  {
    label: 'unrelated cash and business',
    transcript: 'There is €14,000 in the credit union and the bakery is worth about €120,000.',
    accepted: [money(14_000)],
    expected: [{ value: 120_000, currency: 'EUR' }]
  },
  {
    label: 'equal values remain separate occurrences',
    transcript: 'Alpha fund is €25,000 and Beta fund is also €25,000.',
    accepted: [money(25_000)],
    expected: [{ value: 25_000, currency: 'EUR' }]
  },
  {
    label: 'different currencies are retained',
    transcript: 'The UK holding is £35,000 and the US brokerage account is $12,000.',
    accepted: [money(35_000, 'GBP')],
    expected: [{ value: 12_000, currency: 'USD' }]
  },
  {
    label: 'equal normalized values use offsets not a Set',
    transcript: 'I have €80k in a fund and 0.08 million euro in cash.',
    accepted: [money(80_000)],
    expected: [{ value: 80_000, currency: 'EUR' }]
  },
  {
    label: 'compound written amounts',
    transcript: 'There is forty-five thousand euro in deposits and twenty-one thousand in Prize Bonds.',
    accepted: [money(45_000)],
    expected: [{ value: 21_000, currency: null }]
  },
  {
    label: 'currency before amounts written in words',
    transcript: 'The reserve holds sterling thirty-five thousand and euro twenty-two thousand.',
    accepted: [money(35_000, 'GBP')],
    expected: [{ value: 22_000, currency: 'EUR' }]
  },
  {
    label: 'empty first read is recoverable',
    transcript: 'The company shares are worth one hundred and twenty thousand euro.',
    accepted: [],
    expected: [{ value: 120_000, currency: 'EUR' }]
  },
  {
    label: 'salary plus independently stated bonus',
    transcript: 'I earn €72,000 plus a €9,000 annual bonus.',
    accepted: [money(72_000)],
    expected: [{ value: 9_000, currency: 'EUR' }]
  },
  {
    label: 'coupled property and secured debt',
    transcript: 'Our place would fetch around €480,000; we still owe €210,000 on the mortgage secured against it.',
    accepted: [money(480_000)],
    expected: [{ value: 210_000, currency: 'EUR' }]
  },
  {
    label: 'unrelated property and car debt',
    transcript: 'The rental flat is worth €240,000 and the car loan is €18,000.',
    accepted: [money(240_000)],
    expected: [{ value: 18_000, currency: 'EUR' }]
  }
];

for (const fixture of fixtures) {
  const coverage = valueEvidenceCoverage(fixture.transcript, fixture.accepted);
  check(`${fixture.label}: expected uncovered count`,
    coverage.uncovered.length === fixture.expected.length,
    JSON.stringify(coverage.uncovered));
  fixture.expected.forEach((expected, index) => {
    const actual = coverage.uncovered[index];
    check(`${fixture.label}: value ${index + 1}`, actual?.value === expected.value, JSON.stringify(actual));
    check(`${fixture.label}: currency ${index + 1}`, actual?.currency === expected.currency, JSON.stringify(actual));
    check(`${fixture.label}: stable offset identity`,
      actual?.evidenceId === `value:${actual?.start}:${actual?.end}`);
  });
  const repair = buildRepairRequest([], coverage);
  check(`${fixture.label}: exactly one bounded review request`,
    repair?.uncoveredEvidence.length === fixture.expected.length);
}

/* ---------------------------------------------- corrections and negatives */

const corrected = extractValueEvidence('The fund was €20,000 — sorry, it is €24,000; cash is €6,000.');
check('a superseded correction is not a repair obligation',
  corrected.map((item) => item.value).join(',') === '24000,6000', JSON.stringify(corrected));
const correctionAudit = extractValueEvidence(
  'The fund was €20,000 — sorry, it is €24,000; cash is €6,000.',
  { includeSuperseded: true }
);
check('a direct same-clause correction remains observable for audit',
  correctionAudit.map((item) => `${item.value}:${item.superseded}`).join(',')
    === '20000:true,24000:false,6000:false',
  JSON.stringify(correctionAudit));
const independentAfterApology = extractValueEvidence(
  'The home is €400,000. Sorry, the mortgage is €200,000.'
);
check('an apology before a different subject does not erase the first fact',
  independentAfterApology.map((item) => item.value).join(',') === '400000,200000',
  JSON.stringify(independentAfterApology));
const independentAfterActually = extractValueEvidence(
  'Cash is €20,000 and the pension is €30,000. Actually, we also receive a €5,000 bonus.'
);
check('actually introducing a new subject does not supersede the preceding holding',
  independentAfterActually.map((item) => item.value).join(',') === '20000,30000,5000',
  JSON.stringify(independentAfterActually));
const valueBeforeNewSubject = extractValueEvidence(
  'The pension is €20,000, actually €50,000 is my salary.'
);
check('a subject introduced after its value is not mistaken for a correction',
  valueBeforeNewSubject.map((item) => item.value).join(',') === '20000,50000',
  JSON.stringify(valueBeforeNewSubject));
check('a year, age and child count are not mistaken for financial values',
  extractValueEvidence('In 2026 I am 42 and have two children aged 8 and 11.').length === 0);
const lowValues = extractValueEvidence(
  'The rent is 950 each month, the loan payment is 450 per month, and there are 22 years left on the mortgage.'
);
check('low explicit money and a financial term are inventoried from context',
  lowValues.map((item) => `${item.value}:${item.kind}:${item.unit}`).join(',')
    === '950:money:month,450:money:month,22:number:year',
  JSON.stringify(lowValues));
check('large identifiers do not create paid financial repair obligations',
  extractValueEvidence(
    'My policy number is 123456 and the account ends in 9876; call me on 0871234567.'
  ).length === 0);
check('large non-financial spoken counts are not treated as money',
  extractValueEvidence('The survey included two thousand people and one hundred employees.').length === 0);
check('a low spoken scale without financial context is not treated as money',
  extractValueEvidence('The hall fits eight hundred guests.').length === 0);
const sentenceSeparatedWords = extractValueEvidence('Twenty. Five thousand euro is in savings.');
check('spoken-number parsing cannot cross a sentence boundary',
  sentenceSeparatedWords.length === 1 && sentenceSeparatedWords[0].value === 5_000,
  JSON.stringify(sentenceSeparatedWords));
const commaSeparatedWords = extractValueEvidence('One, two thousand euro is in savings.');
check('spoken-number parsing cannot add across comma-separated utterances',
  commaSeparatedWords.length === 1 && commaSeparatedWords[0].value === 2_000,
  JSON.stringify(commaSeparatedWords));
check('a hyphenated compound amount remains supported',
  extractValueEvidence('The deposit is forty-five thousand euro.')[0]?.value === 45_000);
check('a valueless holding causes no repair spend',
  extractValueEvidence('I have investments but need to look up the value.').length === 0);

const overflowTranscript = Array.from({ length: 14 }, (_, index) => (
  `Holding ${String.fromCharCode(65 + index)} is €${index + 1},000`
)).join('; ');
const overflow = boundedUncoveredValueEvidence(
  valueEvidenceCoverage(overflowTranscript, []),
  { limit: 8 }
);
check('one pathological turn is capped', overflow.items.length === 8);
check('overflow remains observable', overflow.overflowCount === 6);
const boundedWithSource = boundedUncoveredValueEvidence({
  uncovered: [{
    ...extractValueEvidence('Cash is €8,000.')[0],
    turnId: 'turn-source'
  }]
}, { limit: 1 });
check('bounded evidence preserves its turn and exact source offsets',
  boundedWithSource.items[0]?.turnId === 'turn-source'
    && boundedWithSource.items[0]?.start === 8
    && boundedWithSource.items[0]?.end === 14,
  JSON.stringify(boundedWithSource));
check('a zero repair budget adds no ninth item',
  boundedUncoveredValueEvidence(valueEvidenceCoverage(overflowTranscript, []), { limit: 0 }).items.length === 0);

/* ------------------------------------ strict candidate evidence grounding */

const transcript = 'The UK account is worth £35,000 and cash is €8,000.';
const extraction = (amount, currency, evidenceText = 'The UK account is worth £35,000') => ({
  schemaVersion: 'planner_extraction_v3',
  sourceTurnId: 'turn-grounding',
  goalCandidates: [],
  semanticFacts: [],
  positions: [{
    candidateId: 'position-1',
    kind: 'investment',
    label: 'UK account',
    amount: money(amount, currency),
    evidenceText
  }],
  sectionCompletions: [],
  invalidCandidates: []
});

const grounded = groundPlannerExtraction(extraction(35_000, 'GBP'), transcript);
check('an exact amount and currency reach ordinary mapping', grounded.positions.length === 1);
const fullTurnGrounded = groundPlannerExtraction(extraction(35_000, 'GBP', transcript), transcript);
check('a live candidate may cite the full finalized multi-value turn', fullTurnGrounded.positions.length === 1);
const wrongCurrency = groundPlannerExtraction(extraction(35_000, 'EUR'), transcript);
check('the same number in the wrong currency is refused',
  wrongCurrency.positions.length === 0
    && wrongCurrency.invalidCandidates[0]?.errorCode === 'realtime_planner_candidate_evidence_unsupported');
const invented = groundPlannerExtraction(extraction(36_000, 'GBP'), transcript);
check('an invented repair amount is refused', invented.positions.length === 0);
const unqualifiedSterling = groundPlannerExtraction(
  extraction(35_000, 'GBP', 'The account is worth 35,000'),
  'The account is worth 35,000.'
);
check('an unqualified amount cannot authorise a non-EUR currency',
  unqualifiedSterling.positions.length === 0
    && unqualifiedSterling.invalidCandidates[0]?.errorCode === 'realtime_planner_candidate_evidence_unsupported');
const explicitSterlingWords = groundPlannerExtraction(
  extraction(35_000, 'GBP', 'sterling thirty-five thousand'),
  'The account is worth sterling thirty-five thousand.'
);
check('a foreign currency written before a spoken amount remains grounded',
  explicitSterlingWords.positions.length === 1,
  JSON.stringify(explicitSterlingWords.invalidCandidates));
const cashEvidence = extractValueEvidence(transcript).find((item) => item.value === 8_000);
const unsolicited = groundPlannerExtraction(
  extraction(8_000, 'EUR', 'cash is €8,000'),
  transcript,
  { allowedEvidenceIds: [extractValueEvidence(transcript)[0].evidenceId] }
);
check('a repair candidate outside its requested occurrence is refused',
  unsolicited.positions.length === 0
    && unsolicited.invalidCandidates[0]?.errorCode === 'realtime_planner_candidate_unsolicited',
  cashEvidence?.evidenceId);
const nonFinancialNumber = groundPlannerExtraction({
  schemaVersion: 'planner_extraction_v3',
  sourceTurnId: 'turn-age',
  goalCandidates: [],
  semanticFacts: [{
    candidateId: 'age-1',
    factId: 'person_current_age',
    value: 42,
    evidenceText: 'I am 42'
  }],
  positions: [],
  sectionCompletions: [],
  invalidCandidates: []
}, 'I am 42 and earn €72,000.');
check('the financial inventory does not reject an ordinary age fact', nonFinancialNumber.semanticFacts.length === 1);

const equalTranscript = 'Alpha fund is €25,000 and Beta fund is also €25,000.';
const equalExtraction = {
  schemaVersion: 'planner_extraction_v3',
  sourceTurnId: 'turn-equal-grounding',
  goalCandidates: [],
  semanticFacts: [],
  positions: ['Alpha fund', 'Beta fund'].map((label, index) => ({
    candidateId: `equal-${index + 1}`,
    kind: 'investment',
    label,
    amount: money(25_000),
    evidenceText: equalTranscript
  })),
  sectionCompletions: [],
  invalidCandidates: []
};
const equalGrounded = groundPlannerExtraction(equalExtraction, equalTranscript);
check('equal-valued full-turn candidates require narrower subject-bearing evidence',
  equalGrounded.positions.length === 0
    && equalGrounded.invalidCandidates.length === 2,
  JSON.stringify(equalGrounded));
const narrowlyGroundedEquals = groundPlannerExtraction({
  ...equalExtraction,
  positions: equalExtraction.positions.map((position) => ({
    ...position,
    evidenceText: `${position.label} is${position.label === 'Beta fund' ? ' also' : ''} €25,000`
  }))
}, equalTranscript);
check('equal-valued siblings are accepted when each cites its own subject-bearing occurrence',
  narrowlyGroundedEquals.positions.length === 2,
  JSON.stringify(narrowlyGroundedEquals.invalidCandidates));
const equalEvidence = extractValueEvidence(equalTranscript);
const secondOnly = groundPlannerExtraction({
  ...equalExtraction,
  positions: [{
    ...equalExtraction.positions[1],
    evidenceText: 'Beta fund is also €25,000'
  }]
}, equalTranscript, { allowedEvidenceIds: [equalEvidence[1].evidenceId] });
check('a narrow equal-value repair binds to the requested second occurrence', secondOnly.positions.length === 1);
const wrongEqualOccurrence = groundPlannerExtraction({
  ...equalExtraction,
  positions: [{
    ...equalExtraction.positions[1],
    evidenceText: 'Beta fund is also €25,000'
  }]
}, equalTranscript, { allowedEvidenceIds: [equalEvidence[0].evidenceId] });
check('an equal-value repair cannot claim its sibling occurrence', wrongEqualOccurrence.positions.length === 0);

/* -------------------------------- sibling outcome identity is occurrence-safe */

const siblingRepair = buildRepairRequest([], valueEvidenceCoverage(
  'Cash is €10,000 and the fund is also €10,000.',
  [money(10_000)]
));
check('one equal-value sibling remains explicitly uncovered', siblingRepair.uncoveredEvidence.length === 1);

const equalProvenanceTranscript = 'Alpha fund is €25,000 and Beta fund is also €25,000.';
const equalProvenanceEvidence = extractValueEvidence(equalProvenanceTranscript);
const secondSavedCoverage = valueEvidenceCoverage(equalProvenanceTranscript, [{
  evidenceId: equalProvenanceEvidence[1].evidenceId,
  candidateId: 'saved-beta'
}]);
check('accepted provenance can cover the second equal-valued occurrence exactly',
  secondSavedCoverage.covered[0]?.start === equalProvenanceEvidence[1].start
    && secondSavedCoverage.uncovered[0]?.start === equalProvenanceEvidence[0].start,
  JSON.stringify(secondSavedCoverage));
const firstSavedCoverage = valueEvidenceCoverage(equalProvenanceTranscript, [{
  evidenceId: equalProvenanceEvidence[0].evidenceId,
  candidateId: 'saved-alpha'
}]);
check('accepted provenance works in the opposite equal-valued direction',
  firstSavedCoverage.covered[0]?.start === equalProvenanceEvidence[0].start
    && firstSavedCoverage.uncovered[0]?.start === equalProvenanceEvidence[1].start,
  JSON.stringify(firstSavedCoverage));
const mixedProvenanceCoverage = valueEvidenceCoverage(
  'Alpha fund is €25,000 and cash is €9,000.',
  [{ evidenceId: extractValueEvidence('Alpha fund is €25,000 and cash is €9,000.')[0].evidenceId }, money(9_000)]
);
check('provenance records and legacy money arrays remain composable',
  mixedProvenanceCoverage.uncovered.length === 0,
  JSON.stringify(mixedProvenanceCoverage));

/* -------------------------- strict atomic property/debt reconciliation */

const profile = createHouseholdProfile({
  profileId: 'coverage-relationship',
  primaryPersonId: 'primary',
  nowIso: '2026-08-23T10:00:00.000Z',
  calculationDateIso: '2026-08-23'
});
const relationshipTurn = {
  turnId: 'turn-property-debt',
  role: 'user',
  finalized: true,
  sequence: 1,
  text: 'Our home is worth €480,000; the mortgage secured against it is €210,000.'
};
const propertyId = 'property_new_1';
const liabilityId = 'liability_new_1';
const ownerId = profile.primaryPerson.personId;
const entities = [
  {
    entityId: propertyId,
    factIds: ['property_position'],
    ownerIds: [ownerId],
    aliases: ['home', 'house', 'property'],
    label: 'home',
    collection: 'properties',
    newEntitySlot: true
  },
  {
    entityId: liabilityId,
    factIds: ['liability_position', 'mortgage_position'],
    ownerIds: [ownerId],
    aliases: ['mortgage'],
    label: 'mortgage',
    collection: 'liabilities',
    newEntitySlot: true
  }
];
const relationPlan = (atomic = true) => ({
  schemaVersion: 1,
  verdict: 'changes_proposed',
  reviewedNoteIds: [],
  operationGroups: [{
    groupId: 'group-home-mortgage',
    atomic,
    operations: [
      {
        operationId: 'op-home',
        op: 'upsert_note',
        factId: 'property_position',
        factInstanceId: `property_position:${propertyId}`,
        entityId: propertyId,
        ownerId,
        noteKind: 'position',
        certainty: 'approximate',
        reasonCode: 'missing_note',
        evidence: [{ turnId: relationshipTurn.turnId, quote: relationshipTurn.text }],
        value: {
          use: 'home',
          label: 'home',
          currentValue: money(480_000),
          associatedLiabilityIds: [liabilityId]
        }
      },
      {
        operationId: 'op-mortgage',
        op: 'upsert_note',
        factId: 'mortgage_position',
        factInstanceId: `mortgage_position:${liabilityId}`,
        entityId: liabilityId,
        ownerId,
        noteKind: 'position',
        certainty: 'exact',
        reasonCode: 'missing_note',
        evidence: [{ turnId: relationshipTurn.turnId, quote: relationshipTurn.text }],
        value: {
          type: 'mortgage',
          label: 'mortgage',
          currentBalance: money(210_000)
        }
      }
    ]
  }]
});

const linked = await applyReconciliationPlan({
  profile,
  notes: [],
  plan: relationPlan(true),
  transcriptTurns: [relationshipTurn],
  sessionId: 'session-relationship',
  transcriptWatermark: relationshipTurn.turnId,
  baseProfileRevision: profile.revision,
  entities
});
check('an evidenced atomic home/mortgage pair passes strict reconciliation',
  ['applied', 'needs_profile_projection'].includes(linked.status),
  JSON.stringify(linked.rejectedGroups));
check('the canonical property retains the mortgage relationship',
  linked.profile.properties[0]?.associatedLiabilityIds?.includes(linked.profile.liabilities[0]?.liabilityId),
  JSON.stringify({ properties: linked.profile.properties, liabilities: linked.profile.liabilities }));

const nonAtomic = await applyReconciliationPlan({
  profile,
  notes: [],
  plan: relationPlan(false),
  transcriptTurns: [relationshipTurn],
  sessionId: 'session-relationship-non-atomic',
  transcriptWatermark: relationshipTurn.turnId,
  baseProfileRevision: profile.revision,
  entities
});
check('a new linked pair is rejected when the group is not atomic',
  nonAtomic.rejectedGroups.some((group) => group.code === 'property_liability_relationship_not_atomic'),
  JSON.stringify(nonAtomic.rejectedGroups));

console.info(`[ValueEvidenceCoverage] ${checks} checks passed across ${fixtures.length} materially varied omission families.`);
