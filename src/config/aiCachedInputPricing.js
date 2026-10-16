/**
 * REVIEWED AI model rates (USD per 1,000,000 tokens).
 *
 * This is the ONLY place cached-input rates live. They are entered by a human
 * from OpenAI's published pricing and re-verified whenever OpenAI changes it.
 *
 * `standard_input_per_million` / `standard_output_per_million` are REFERENCE
 * values only — the backfill never writes them, but it cross-checks them against
 * the live pricing row and reports a conflict if they differ, so a rate typo in
 * the DB or here is caught before cached billing is enabled.
 *
 *   verified: true  => checked against OpenAI's public pricing; the backfill may
 *                      apply the cached rate.
 *   verified: false => placeholder. The backfill will NOT apply it and reports
 *                      the model as blocked for cached-input execution.
 *
 * Only standard-processing rates. Do NOT add long-context, regional uplift,
 * cache-write, batch, flex/priority, tool-call, audio, realtime, image or video
 * pricing here — the runtime guards block those tariffs on purpose.
 *
 * Source: https://openai.com/api/pricing/  (re-verify on the date below each edit)
 */
export const CACHED_INPUT_PRICING_REVIEWED_ON = "2026-09-09";

export const CACHED_INPUT_PRICING = {
  // GPT-4o family — cached input is 50% of standard input.
  "gpt-4o":        { standard_input_per_million: 2.50, standard_output_per_million: 10.00, cached_input_per_million: 1.25,   verified: true },
  "gpt-4o-mini":   { standard_input_per_million: 0.15, standard_output_per_million: 0.60,  cached_input_per_million: 0.075,  verified: true },

  // GPT-4.1 family — cached input is 25% of standard input.
  "gpt-4.1":       { standard_input_per_million: 2.00, standard_output_per_million: 8.00,  cached_input_per_million: 0.50,   verified: true },
  "gpt-4.1-mini":  { standard_input_per_million: 0.40, standard_output_per_million: 1.60,  cached_input_per_million: 0.10,   verified: true },
  "gpt-4.1-nano":  { standard_input_per_million: 0.10, standard_output_per_million: 0.40,  cached_input_per_million: 0.025,  verified: true },

  // o-series reasoning models.
  "o3":            { standard_input_per_million: 2.00, standard_output_per_million: 8.00,  cached_input_per_million: 0.50,   verified: true },
  "o3-mini":       { standard_input_per_million: 1.10, standard_output_per_million: 4.40,  cached_input_per_million: 0.55,   verified: true },
  "o4-mini":       { standard_input_per_million: 1.10, standard_output_per_million: 4.40,  cached_input_per_million: 0.275,  verified: true },

  // GPT-5.4 family — standard-processing rates, verified 2026-09-09.
  // cached input is 10% of standard input.
  "gpt-5.4":       { standard_input_per_million: 2.50, standard_output_per_million: 15.00, cached_input_per_million: 0.25,   verified: true },
  "gpt-5.4-mini":  { standard_input_per_million: 0.75, standard_output_per_million: 4.50,  cached_input_per_million: 0.075,  verified: true },
  "gpt-5.4-nano":  { standard_input_per_million: 0.20, standard_output_per_million: 1.25,  cached_input_per_million: 0.02,   verified: true },
};

/**
 * @returns {{ rate: number|null, verified: boolean, known: boolean,
 *             referenceInput: number|null, referenceOutput: number|null }}
 */
export function reviewedCachedRate(model) {
  const row = CACHED_INPUT_PRICING[model];
  if (!row) return { rate: null, verified: false, known: false, referenceInput: null, referenceOutput: null };
  return {
    rate: row.cached_input_per_million,
    verified: !!row.verified,
    known: true,
    referenceInput: row.standard_input_per_million ?? null,
    referenceOutput: row.standard_output_per_million ?? null,
  };
}
