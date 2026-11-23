import catalog from '../config/model-pricing.json';
export type Usage = Record<string, number>;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
export function parseUsage(value: unknown): Usage {
  const usage: Usage = {};
  if (!record(value)) return usage;
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (count(value[key])) usage[key] = value[key];
  if (record(value.prompt_tokens_details) && count(value.prompt_tokens_details.cached_tokens)) usage.cached_input_tokens = value.prompt_tokens_details.cached_tokens;
  if (record(value.completion_tokens_details) && count(value.completion_tokens_details.reasoning_tokens)) usage.reasoning_tokens = value.completion_tokens_details.reasoning_tokens;
  return usage;
}
export function costEstimate(model: string, usage: Usage) {
  const prices: Record<string, { input: number; output: number; cached_input: number | null; source: string }> = catalog.models;
  const rate = Object.hasOwn(prices, model) ? prices[model] : null;
  const common = {
    currency: catalog.currency, is_estimate: true, actual_billed_usd: null,
    pricing: rate ? { unit: catalog.unit, input: rate.input, output: rate.output, cached_input: rate.cached_input, verified_at: catalog.verified_at, source: rate.source } : null,
    note: '公开单价快照估算，非实际账单；未抵扣免费额度，不含Worker运行、存储、税费及其他请求费用。',
  };
  if (!rate) return { ...common, status: 'unavailable', reason: 'unknown_model_price', estimated_usd: null };
  if (!count(usage.prompt_tokens) || !count(usage.completion_tokens)) return { ...common, status: 'unavailable', reason: 'missing_usage', estimated_usd: null };
  const cached = usage.cached_input_tokens;
  if ((cached !== undefined && (!count(cached) || cached > usage.prompt_tokens))
    || (usage.total_tokens !== undefined && (!count(usage.total_tokens) || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens))) {
    return { ...common, status: 'unavailable', reason: 'inconsistent_usage', estimated_usd: null };
  }
  const cacheKnown = cached !== undefined && (cached === 0 || rate.cached_input !== null);
  const appliedCache = cacheKnown ? cached! : 0;
  const input = ((usage.prompt_tokens - appliedCache) * rate.input + appliedCache * (rate.cached_input ?? 0)) / 1e6;
  const output = usage.completion_tokens * rate.output / 1e6;
  // reasoning_tokens 已计入completion_tokens，不再次收费；total_tokens不是额外一项。
  const round = (x: number) => Number(x.toFixed(10));
  return { ...common, status: 'estimated', reason: null,
    basis: cacheKnown ? 'reported_cache_usage' : 'all_input_at_standard_rate',
    cache_discount_applied: appliedCache > 0, input_usd: round(input), output_usd: round(output), estimated_usd: round(input + output) };
}
