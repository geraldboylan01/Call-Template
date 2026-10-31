import { estimateProviderUsageCostEurMicros, summarizeProviderBudget } from '../consumer/cost_budget.js';

export const ANALYST_MODELS = Object.freeze(['gpt-6.1-sol']);
const PRICING_VERSION = 'sol-standard-2026-10-30-eur-ceiling-v1';
const bounded = (value, fallback, max) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid analyst budget configuration.');
  return Math.min(n, max);
};
export function analystPolicy(env) {
  const model = env.ANALYST_MODEL || 'gpt-6.1-sol';
  if (!ANALYST_MODELS.includes(model)) throw new Error('Model is not allowed for analyst jobs.');
  const reasoningEffort = env.ANALYST_REASONING_EFFORT || 'high';
  if (!['high', 'xhigh'].includes(reasoningEffort)) throw new Error('Invalid analyst reasoning effort.');
  // Rates are reviewed EUR ceilings, not an implicit live FX conversion.
  // Fail closed when an operator supplies malformed/zero prices.
  const rates = {
    input: bounded(env.ANALYST_INPUT_EUR_MICROS_PER_MILLION, 2500000, 100000000),
    cached: bounded(env.ANALYST_CACHED_INPUT_EUR_MICROS_PER_MILLION, 100000, 100000000),
    output: bounded(env.ANALYST_OUTPUT_EUR_MICROS_PER_MILLION, 10000000, 500000000)
  };
  if (!Object.values(rates).every(n => n > 0)) throw new Error('Analyst pricing is unavailable.');
  return { model, reasoningEffort, rates, pricingVersion: PRICING_VERSION,
    runLimit: bounded(env.ANALYST_RUN_BUDGET_EUR_CENTS, 1500, 3000) * 10000,
    dailyLimit: bounded(env.ANALYST_DAILY_BUDGET_EUR_CENTS, 5000, 10000) * 10000,
    maxOutputTokens: bounded(env.ANALYST_MAX_OUTPUT_TOKENS, 24000, 32000), maxTurns: 60 };
}
export function usageCost(usage, policy) {
  const input = usage.input_tokens, cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const output = usage.output_tokens, reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
  if (![input, cached, output, reasoning].every(n => Number.isSafeInteger(n) && n >= 0) || cached > input || reasoning > output)
    throw Object.assign(new Error('Provider usage is missing or invalid.'), { code: 'provider_usage_invalid' });
  // Above 272K tokens the provider applies long-context surcharges. Reasoning
  // is already included in output tokens; never charge it twice.
  const long = input > 272000;
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningTokens: reasoning,
    costEurMicros: estimateProviderUsageCostEurMicros([
      { quantity: input - cached, rateEurMicrosPerMillionUnits: policy.rates.input * (long ? 2 : 1) },
      { quantity: cached, rateEurMicrosPerMillionUnits: policy.rates.cached * (long ? 2 : 1) },
      { quantity: output, rateEurMicrosPerMillionUnits: Math.ceil(policy.rates.output * (long ? 1.5 : 1)) }
    ]) };
}
export function reserveCost(body, policy) {
  // A UTF-8 byte is a conservative upper bound on an input token. Include the
  // entire wire body and framing margin, assume no cache hits and long-context
  // pricing when needed. Refuse a request larger than the model window.
  const input = new TextEncoder().encode(JSON.stringify(body)).length + 4096;
  if (input + policy.maxOutputTokens > 1050000) throw Object.assign(new Error('Analysis context limit reached.'), { code: 'context_limit' });
  return usageCost({ input_tokens: input, output_tokens: policy.maxOutputTokens }, {
    ...policy, rates: { ...policy.rates, input: Math.max(policy.rates.input, policy.rates.cached) }
  }).costEurMicros;
}
export function analystBudget(env) {
  const db = env.LEADS_DB;
  return {
    async reserve(runId, turn, amount, policy) {
      const key = `${runId}:${turn}`, old = await db.prepare('SELECT * FROM analyst_provider_costs WHERE id=?').bind(key).first();
      // An interrupted paid request is never silently retried. A saved receipt
      // is recovered by the runner before it calls reserve again.
      if (old) throw Object.assign(new Error('The previous provider outcome is uncertain; its reservation is retained.'), { code: 'provider_outcome_unknown' });
      try {
        await db.prepare(`INSERT INTO analyst_provider_costs
          (id,run_id,day_utc,status,reserved_cost_eur_micros,run_limit,daily_limit,pricing_version,created_at)
          VALUES (?,?,?,'reserved',?,?,?,?,?)`).bind(key, runId, new Date().toISOString().slice(0,10), amount,
          policy.runLimit, policy.dailyLimit, policy.pricingVersion, new Date().toISOString()).run();
      } catch (error) {
        if (/analyst_(run|daily)_budget/.test(error.message)) throw Object.assign(new Error('The analysis or daily spending cap has been reached.'), { code: 'budget_exhausted' });
        throw error;
      }
      return key;
    },
    async settle(runId, turn, usage, policy) {
      const row = usageCost(usage, policy);
      await db.prepare(`UPDATE analyst_provider_costs SET status='known',actual_cost_eur_micros=?,input_tokens=?,cached_input_tokens=?,output_tokens=?,reasoning_tokens=? WHERE id=?`)
        .bind(row.costEurMicros, row.inputTokens, row.cachedInputTokens, row.outputTokens, row.reasoningTokens, `${runId}:${turn}`).run();
      return row;
    },
    async summary(runId, policy) {
      const rows = (await db.prepare('SELECT * FROM analyst_provider_costs WHERE run_id=?').bind(runId).all()).results;
      return summarizeProviderBudget(policy.runLimit, rows);
    }
  };
}
