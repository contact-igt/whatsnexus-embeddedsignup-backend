/**
 * REVIEWED cached-input rates (USD per 1,000,000 tokens).
 *
 * OpenAI automatically discounts the portion of an input prompt served from its
 * prompt cache. This is the ONLY place those rates live. They are entered by a
 * human from OpenAI's published pricing and must be re-verified whenever OpenAI
 * changes pricing.
 *
 *   - `verified: true`  => the rate has been checked against OpenAI's public
 *                          pricing page and may be applied by the backfill.
 *   - `verified: false` => placeholder / unknown. The backfill will NOT apply it
 *                          and reports the model as blocked for cached-input
 *                          execution until an operator fills it in.
 *
 * Nothing here is fetched from the internet at runtime. Do not auto-populate.
 *
 * Source: https://openai.com/api/pricing/  (verify the date below on each edit)
 */
export const CACHED_INPUT_PRICING_REVIEWED_ON = "2026-01-01";

export const CACHED_INPUT_PRICING = {
  // GPT-4o family — cached input is 50% of standard input.
  "gpt-4o":        { cached_input_per_million: 1.25,   verified: true },
  "gpt-4o-mini":   { cached_input_per_million: 0.075,  verified: true },

  // GPT-4.1 family — cached input is 25% of standard input.
  "gpt-4.1":       { cached_input_per_million: 0.50,   verified: true },
  "gpt-4.1-mini":  { cached_input_per_million: 0.10,   verified: true },
  "gpt-4.1-nano":  { cached_input_per_million: 0.025,  verified: true },

  // o-series reasoning models.
  "o3":            { cached_input_per_million: 0.50,   verified: true },
  "o3-mini":       { cached_input_per_million: 0.55,   verified: true },
  "o4-mini":       { cached_input_per_million: 0.275,  verified: true },

  // gpt-5.4 family — not on OpenAI's public pricing at review time in this
  // project's config; leave unverified until an operator confirms the rate.
  "gpt-5.4":       { cached_input_per_million: null,   verified: false },
  "gpt-5.4-mini":  { cached_input_per_million: null,   verified: false },
  "gpt-5.4-nano":  { cached_input_per_million: null,   verified: false },
};

/** @returns {{ rate: number|null, verified: boolean, known: boolean }} */
export function reviewedCachedRate(model) {
  const row = CACHED_INPUT_PRICING[model];
  if (!row) return { rate: null, verified: false, known: false };
  return { rate: row.cached_input_per_million, verified: !!row.verified, known: true };
}
