export type FieldBounds = {
  min?: number
  max?: number
  step: number
  // Opts a field out of the integer rounding below. `step` describes how the
  // spinner and slider move, which is not the same question as whether the
  // value is an integer, and deriving one from the other silently rounded the
  // rollout surge percent to a different pod count.
  fractional?: boolean
}

/**
 * What NumberField commits on blur, kept out of the component so the contract
 * is testable without a DOM (and so Fields.tsx exports only components).
 *
 * Almost every numeric field on the form maps to an integer on the API, and
 * rounding here keeps a typed "2.5" from failing validation for the whole
 * config. `fractional` is the opt-out for the fields whose API type really is a
 * float and whose exact value is load-bearing — the rollout surge percent,
 * which has to reproduce an exact pod count and so cannot be nudged to the
 * nearest whole percent by a focus and a blur.
 */
export function normalizeFieldValue(parsed: number, { min, max, step, fractional }: FieldBounds): number {
  const rounded = fractional || !Number.isInteger(step) ? parsed : Math.round(parsed)
  return Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, rounded))
}
