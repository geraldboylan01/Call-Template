/**
 * The scenario surface, taken from the Master Prompt Pack.
 *
 * THE PROMPT PACK IS THE AUTHORITY HERE, NOT THE CODE. Every entry below is
 * traceable to a line in docs/prompt-pack/, and the citation is kept beside it
 * on purpose. Where the pack defines a scenario and the plumbing did not carry
 * it, that was a wiring defect to fix, not a capability to invent — and
 * nothing may be added here that the pack does not authorise, however easy the
 * engine would make it.
 *
 * WHY A CATALOGUE RATHER THAN ONE OVERRIDE SHAPE. There is no single scenario
 * mechanism in this product; the pack gives each module its own, and they are
 * not interchangeable:
 *
 *   - net retirement cash flow takes whole scenario DEFINITIONS in its input
 *     and switches between them by id;
 *   - pension projection takes a list that varies exactly one field, rental
 *     income, and nothing else;
 *   - college funding takes per-child cost cases and is the only module where
 *     the pack makes scenarios MANDATORY;
 *   - house purchase is forbidden from persisting scenarios at all: its
 *     what-if is runtime-only and non-persisting.
 *
 * An earlier attempt modelled all of this as one flat `scenarioOverrides` bag
 * of levers. That produced a manifest declaring `retirement_age` on the pension
 * projection -- an assumption the pack never authorises and no engine
 * computes -- and a call where the figures silently came back as the base case.
 * Hence the shape below: per module, what the pack allows, and how it reaches
 * the engine.
 */

/**
 * @typedef {object} ScenarioLever
 * @property {string} id the key the pack names
 * @property {'money'|'rate'|'integer'|'enum'|'idList'} type
 * @property {number} [min]
 * @property {number} [max]
 * @property {string[]} [values] for `enum`
 * @property {string} means what it does, in a client's terms
 */

export const SCENARIO_CATALOGUE = Object.freeze({
  /**
   * 15_net_retirement_cashflow_playbook.md:109-139, 02_schema_capability_matrix.md:149.
   * "Use `scenarios[]` when Gerry wants a case button such as: keep rental
   * property versus sell rental property ... lower spending after children
   * finish college". The richest surface in the pack, and the one that answers
   * "can I afford to go part-time".
   */
  net_retirement_cashflow: Object.freeze({
    kind: 'input_scenarios',
    inputField: 'scenarios',
    source: '15_net_retirement_cashflow_playbook.md:117-139',
    levers: Object.freeze([
      { id: 'annualExpenditureToday', type: 'money', min: 0, max: 1_000_000,
        means: 'what the household spends each year in retirement' },
      { id: 'availableInvestmentFundToday', type: 'money', min: 0, max: 100_000_000,
        means: 'the fund available today to cover the shortfall' },
      { id: 'excludedIncomeSourceIds', type: 'idList',
        means: 'an income source that stops -- the pack\'s preferred way to model lost income' }
    ])
  }),

  /**
   * 11_retirement_playbook.md:159-175, 02_schema_capability_matrix.md:121.
   * ONE LEVER ONLY. The pack's scenario item schema is `{id, title,
   * rentalIncomeToday}` and nothing else; retirement age, growth and
   * contributions are single-valued inputs there, never scenario-adjustable.
   * "Treat `rentalIncomeToday` as gross annual rent in today's money."
   */
  pension_projection: Object.freeze({
    // VARIED IN PLACE, NOT MOVED TO THE PACK'S FIELD.
    //
    // The pack's pension what-if is rental income (11_retirement_playbook.md:
    // 159-175) and it expresses that as a top-level `rentalIncomeToday` varied
    // through `rentalIncomeScenarios`. That is the ADVISER PAYLOAD's shape. On
    // the consumer path the same fact already exists as an income source, and
    // the engine adds `rentalIncomeToday` ON TOP of `otherIncomeSources`
    // (pension_math.js:797-803) -- so writing the pack's field as well would
    // count the rent twice.
    //
    // Moving the source into the pack's field instead would avoid the double
    // count but silently discard three other things the client actually told
    // us: a stated sale age, a per-source inflation setting, and whether the
    // figure was net or gross (the pack's field is gross by instruction, :167).
    // So the scenario varies the AMOUNT where the rent already lives, and
    // everything else about it survives.
    kind: 'income_source_amount',
    incomeType: 'rental',
    inputField: 'otherIncomeSources',
    source: '11_retirement_playbook.md:172-175',
    levers: Object.freeze([
      { id: 'rentalIncomeToday', type: 'money', min: 0, max: 1_000_000,
        means: 'gross annual rent in today\'s money -- set 0 for a rent-lost case' }
    ])
  }),

  /**
   * 14_college_funding_playbook.md:99-135. The only module where the pack makes
   * `scenarios` a REQUIRED input, and the only one with no base selector --
   * all cases coexist as "separate scenario stacks" on the chart.
   */
  college_funding: Object.freeze({
    kind: 'input_scenarios',
    inputField: 'scenarios',
    perChild: true,
    source: '14_college_funding_playbook.md:113-135',
    levers: Object.freeze([
      { id: 'annualCostTodayPerChild', type: 'money', min: 0, max: 100_000,
        means: 'yearly cost per child -- living at home versus away from home' },
      { id: 'oneOffCostTodayPerChild', type: 'money', min: 0, max: 100_000,
        means: 'a one-off cost per child, which the pack uses for car support' }
    ])
  }),

  /**
   * 17_house_purchase_playbook.md:26, 02_schema_capability_matrix.md:261.
   * "What-if state is not part of the prompt payload ... do not add a base-case
   * or scenario selector to `housePurchaseInputs`." So this one is deliberately
   * RUNTIME-ONLY: the levers are applied to the calculation and never persisted.
   *
   * Two authorised groups: the four scheme cases, and the block at :215-237
   * the pack calls "editable educational assumptions". The engine additionally
   * applies targetPropertyPrice, plannedMonthlySavings, targetPurchaseDate,
   * applicantIncomeById and includeVariableIncome -- NOT listed here, because
   * the pack does not authorise them as what-ifs and this file does not get to
   * widen the pack.
   */
  house_purchase: Object.freeze({
    kind: 'runtime_overrides',
    source: '17_house_purchase_playbook.md:26 and :215-237',
    levers: Object.freeze([
      { id: 'supportCase', type: 'enum', values: ['none', 'htb_only', 'fhs_only', 'htb_and_fhs'],
        means: 'which buyer-support schemes are assumed to be in play' },
      { id: 'depositSavingsGrossAer', type: 'rate', min: 0, max: 1,
        means: 'the gross rate the deposit savings earn' },
      { id: 'mortgageIllustrationRate', type: 'rate', min: 0, max: 1,
        means: 'the rate the repayment is illustrated at' },
      { id: 'mortgageTermYears', type: 'integer', min: 1, max: 50,
        means: 'how long the mortgage is taken over' },
      { id: 'emergencyReserveTarget', type: 'money', min: 0, max: 1_000_000,
        means: 'cash kept back rather than put into the deposit' }
    ])
  })
});

/**
 * Modules the pack defines a scenario for, but whose engine cannot compute it.
 *
 * PBS is here rather than above because the pack assigns its scenarios to the
 * AI AUTHOR, not to an engine: 10_pbs_playbook.md:88-95 requires each scenario
 * to carry "the same six PBS sections ... fully recalculated", and states
 * plainly that `movements` are "optional animation metadata only. Do not use
 * movements instead of recalculating the scenario sections."
 * js/personal_balance_sheet.js has no scenario concept at all and
 * computePersonalBalanceSheet(input) takes no options, so there is nothing to
 * wire a lever to. Running a PBS what-if means recomputing the sheet from a
 * TRANSFORMED POSITION -- sell the rental, clear the debt, move the proceeds --
 * and no such transformation layer exists anywhere.
 *
 * Recorded rather than silently omitted: this is an architectural discrepancy
 * to raise, not a gap to paper over with an invented lever.
 */
export const SCENARIO_ARCHITECTURAL_GAPS = Object.freeze({
  personal_balance_sheet: Object.freeze({
    // NOT "unsupported". The capability is authorised by the Prompt Pack and
    // the product is expected to have it; what is missing is the deterministic
    // transformation layer that would let an engine construct it. Describing it
    // as unsupported would quietly demote an approved capability to a
    // non-existent one.
    status: 'authorised_missing_execution_layer',
    packDefines: '10_pbs_playbook.md:85-115 "Optional PBS Alternatives"',
    packMechanism: 'the AI writes fully recalculated sections into generated.outputsBucketed.scenarios[]',
    engineReality: 'computePersonalBalanceSheet(input) takes no options; the engine has no scenario concept',
    whatWouldBeNeeded: 'a layer that applies a movement (from-bucket -> to-buckets) to the profile '
      + 'and recomputes, which is new capability rather than wiring'
  })
});

const TYPE_RULES = {
  money: { check: (value) => Number.isFinite(value), describe: 'an amount in euro' },
  rate: { check: (value) => Number.isFinite(value), describe: 'a rate as a decimal (0.05 = 5%)' },
  integer: { check: (value) => Number.isInteger(value), describe: 'a whole number' }
};

export class ScenarioLeverError extends Error {
  constructor(message, { moduleId, leverId } = {}) {
    super(message);
    this.name = 'ScenarioLeverError';
    this.code = 'scenario_lever_invalid';
    this.moduleId = moduleId || null;
    this.leverId = leverId || null;
  }
}

/** Modules that can take a what-if today. */
export function scenarioCapableModuleIds() {
  return Object.keys(SCENARIO_CATALOGUE);
}

/** The pack-authorised levers for a module. */
export function scenarioLeversFor(moduleId) {
  return SCENARIO_CATALOGUE[moduleId]?.levers || [];
}

export function scenarioMechanismFor(moduleId) {
  return SCENARIO_CATALOGUE[moduleId] || null;
}

/**
 * Validate a what-if request against what the pack authorises.
 *
 * Strict by default and loud about it. An adviser who sets a lever the engine
 * will ignore, and is told nothing, reads base-case figures as a scenario --
 * which is exactly the failure that made this catalogue necessary.
 */
export function sanitizeScenarioRequest(moduleId, request, { strict = true } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return {};
  const mechanism = SCENARIO_CATALOGUE[moduleId];
  if (!mechanism) {
    if (!strict) return {};
    const gap = SCENARIO_ARCHITECTURAL_GAPS[moduleId];
    throw new ScenarioLeverError(
      gap
        ? `${moduleId} scenarios ARE authorised by the Prompt Pack (${gap.packDefines}), but the `
          + `deterministic execution layer for them does not exist yet: ${gap.engineReality}. `
          + `This is a known capability gap, not an unsupported module.`
        : `${moduleId} has no scenario defined in the Prompt Pack. `
          + `Modules that do: ${scenarioCapableModuleIds().join(', ')}.`,
      { moduleId }
    );
  }
  const byId = new Map(mechanism.levers.map((lever) => [lever.id, lever]));
  const accepted = {};
  for (const [key, raw] of Object.entries(request)) {
    const lever = byId.get(key);
    if (!lever) {
      if (strict) {
        throw new ScenarioLeverError(
          `The Prompt Pack does not give ${moduleId} a "${key}" to vary. It allows: `
          + `${mechanism.levers.map((item) => item.id).join(', ')}.`,
          { moduleId, leverId: key }
        );
      }
      continue;
    }
    if (lever.type === 'idList') {
      const list = Array.isArray(raw) ? raw : String(raw).split(',').map((item) => item.trim());
      const clean = list.filter(Boolean);
      if (clean.length) accepted[key] = clean;
      else if (strict) {
        throw new ScenarioLeverError(`${moduleId} "${key}" needs at least one id.`, { moduleId, leverId: key });
      }
      continue;
    }
    if (lever.type === 'enum') {
      const value = String(raw);
      if (!lever.values.includes(value)) {
        if (strict) {
          throw new ScenarioLeverError(
            `${moduleId} "${key}" must be one of: ${lever.values.join(', ')} — got ${JSON.stringify(raw)}.`,
            { moduleId, leverId: key }
          );
        }
        continue;
      }
      accepted[key] = value;
      continue;
    }
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    const rule = TYPE_RULES[lever.type] || TYPE_RULES.money;
    const inRange = Number.isFinite(value)
      && value >= (Number.isFinite(lever.min) ? lever.min : -Infinity)
      && value <= (Number.isFinite(lever.max) ? lever.max : Infinity);
    if (!rule.check(value) || !inRange) {
      if (strict) {
        throw new ScenarioLeverError(
          `${moduleId} "${key}" must be ${rule.describe} between ${lever.min} and ${lever.max}`
          + ` — got ${JSON.stringify(raw)}.`,
          { moduleId, leverId: key }
        );
      }
      continue;
    }
    accepted[key] = value;
  }
  return accepted;
}

export const APPRENTICE_SCENARIO_ID = 'apprentice-what-if';

/**
 * Put an accepted what-if where the module's own engine will find it.
 *
 * Each module is handled the way the pack describes it, which is why this is a
 * switch rather than one assignment. Returns the input to compute with and the
 * scenario id to select, leaving the caller's input untouched.
 *
 * @returns {{input: object, scenarioId: string}}
 */
export function applyScenarioToInput(moduleId, input, accepted) {
  const mechanism = SCENARIO_CATALOGUE[moduleId];
  if (!mechanism || !accepted || Object.keys(accepted).length === 0) {
    return { input, scenarioId: '' };
  }
  // Runtime-only by design: house purchase must not gain a persisted selector.
  if (mechanism.kind === 'runtime_overrides') {
    return { input, scenarioId: '' };
  }
  const next = { ...input };
  const field = mechanism.inputField;
  const existing = Array.isArray(next[field]) ? next[field] : [];

  // Vary the amount of the income sources that already carry this money,
  // scaling them proportionally so a household with two rented properties keeps
  // its shape, and every source keeps its own start year, end year and
  // inflation treatment. Where there is none yet -- a client considering buying
  // an investment property -- the what-if adds one, because "what if I had
  // rental income" is the same question asked from a base of zero.
  if (mechanism.kind === 'income_source_amount') {
    const target = Number(accepted[mechanism.levers[0].id]);
    if (!Number.isFinite(target)) return { input, scenarioId: '' };
    const sources = Array.isArray(next[field]) ? next[field] : [];
    const matching = sources.filter((source) => source?.type === mechanism.incomeType);
    const currentTotal = matching.reduce((sum, source) => sum + (Number(source.annualAmountToday) || 0), 0);
    if (currentTotal > 0) {
      const factor = target / currentTotal;
      next[field] = sources
        .map((source) => (source?.type === mechanism.incomeType
          ? { ...source, annualAmountToday: source.annualAmountToday * factor }
          : source))
        // A source scaled to nothing is removed rather than kept at zero: the
        // engine's own builder drops zero-amount sources, so keeping one here
        // would put a record through the calculation that a real run never has.
        .filter((source) => source?.type !== mechanism.incomeType || source.annualAmountToday > 0);
      return { input: next, scenarioId: APPRENTICE_SCENARIO_ID };
    }
    if (target <= 0) return { input, scenarioId: '' };
    // The engine refuses an income source with no start, and a pension member
    // carries retirementAge rather than a year -- so derive it, the same way
    // the adapter derives startYear for the sources it builds itself.
    const member = (input?.pensions || [])[0];
    const startYear = Number.isFinite(input?.incomeStartYear)
      ? input.incomeStartYear
      : (Number.isFinite(input?.currentYear)
        && Number.isFinite(member?.retirementAge)
        && Number.isFinite(member?.currentAge)
        ? input.currentYear + (member.retirementAge - member.currentAge)
        : null);
    next[field] = [...sources, {
      id: `${APPRENTICE_SCENARIO_ID}-${mechanism.incomeType}`,
      title: 'What-if rental income',
      type: mechanism.incomeType,
      ownerId: member?.id,
      annualAmountToday: target,
      ...(Number.isFinite(startYear) ? { startYear } : {}),
      inflationIndexed: true
    }];
    return { input: next, scenarioId: APPRENTICE_SCENARIO_ID };
  }

  if (mechanism.perChild) {
    // College funding has no base selector -- every case coexists -- so the
    // what-if is an additional case, and each child is pointed at it.
    next[field] = [
      ...existing,
      { id: APPRENTICE_SCENARIO_ID, title: 'What-if', category: 'living_away', ...accepted }
    ];
    next.children = (next.children || []).map((child) => ({ ...child, scenarioId: APPRENTICE_SCENARIO_ID }));
    return { input: next, scenarioId: APPRENTICE_SCENARIO_ID };
  }

  const base = existing.length ? existing : [{ id: 'base', title: 'Current position' }];
  next[field] = [...base, { id: APPRENTICE_SCENARIO_ID, title: 'What-if', ...accepted }];
  if (typeof next.baseScenarioId === 'undefined') next.baseScenarioId = base[0].id;
  return { input: next, scenarioId: APPRENTICE_SCENARIO_ID };
}

/**
 * The what-if section of the live prompt, generated from the catalogue above.
 *
 * NOT WIRED INTO THE LIVE PROMPT. LIVE_PROMPT_VERSION stays at v9 deliberately:
 * apprentice mode is for teaching how an expert uses these scenarios before the
 * live model is told they exist. Kept here, generated rather than hand-written,
 * so that when it is switched on it cannot name an assumption the pack does not
 * authorise or an engine would refuse.
 */
export function scenarioPromptSection() {
  const ids = scenarioCapableModuleIds();
  if (ids.length === 0) return '';
  const lines = [
    'WHAT-IF ANALYSES. When someone asks what would happen if something were different,',
    'that is not a new analysis. It is the same one re-run on a changed assumption. Run',
    'the base case first so there is something to compare against, then re-run with the',
    'change. Only these analyses can vary, and only these assumptions:'
  ];
  for (const moduleId of ids) {
    for (const lever of scenarioLeversFor(moduleId)) {
      const range = lever.type === 'enum'
        ? lever.values.join(' | ')
        : `${lever.min} to ${lever.max}`;
      lines.push(`- ${moduleId}.${lever.id}: ${lever.means} (${range})`);
    }
  }
  return lines.join('\n');
}
