import { describe, expect, it } from 'vitest'
import { normalizeFieldValue } from './fieldValue'
import { surgePercentFromPods, surgePodsFromPercent } from '../surge'

// NumberField commits on blur, so this is what a user gets from focusing a field
// and leaving it again without typing anything. It has to be a no-op.
describe('normalizeFieldValue', () => {
  it('rounds to an integer for the fields whose API type is an integer', () => {
    // Unchanged behavior: every other numeric field on the form maps to an
    // integer on the API, so a typed "2.5" must not fail validation for the
    // whole config. All of these carry an integer step.
    expect(normalizeFieldValue(2.5, { step: 1 })).toBe(3)
    expect(normalizeFieldValue(2.4, { step: 1 })).toBe(2)
    expect(normalizeFieldValue(-2.5, { step: 1 })).toBe(-2)
    expect(normalizeFieldValue(517.6, { step: 50 })).toBe(518)
    expect(normalizeFieldValue(1024.25, { step: 64 })).toBe(1024)
    expect(normalizeFieldValue(3, { step: 5 })).toBe(3)
  })

  it('still rounds when a field opts out explicitly with fractional: false', () => {
    expect(normalizeFieldValue(2.5, { step: 5, fractional: false })).toBe(3)
  })

  it('keeps decimals for a fractional field', () => {
    expect(normalizeFieldValue(42.85, { step: 5, fractional: true })).toBe(42.85)
    expect(normalizeFieldValue(1.5, { step: 5, fractional: true })).toBe(1.5)
    expect(normalizeFieldValue(0.01, { step: 5, fractional: true })).toBe(0.01)
  })

  it('clamps to min and max in both modes', () => {
    expect(normalizeFieldValue(-5, { min: 0, step: 1 })).toBe(0)
    expect(normalizeFieldValue(999, { max: 500, step: 1 })).toBe(500)
    expect(normalizeFieldValue(-5, { min: 0, step: 5, fractional: true })).toBe(0)
    expect(normalizeFieldValue(1.5e6, { max: 1e6, step: 5, fractional: true })).toBe(1e6)
  })

  it('leaves an unbounded value alone when no min or max is given', () => {
    expect(normalizeFieldValue(7, { step: 1 })).toBe(7)
    expect(normalizeFieldValue(7.25, { step: 5, fractional: true })).toBe(7.25)
  })

  // The reason the opt-out exists: the rollout surge percent is a float on the
  // API and carries an exact pod count. Committing it through the integer
  // rounding — which an integer `step` used to imply on its own — converts back
  // to a different pod count, so a focus and a blur would silently re-model the
  // rollout the unit picker just converted.
  it('does not re-model a converted rollout surge on focus and blur', () => {
    const percentField = { min: 0, max: 1_000_000, step: 5, fractional: true }
    for (const [pods, at] of [[3, 7], [1, 20], [3, 200], [1, 3], [2, 3]] as Array<[number, number]>) {
      const percent = surgePercentFromPods(pods, at)
      const committed = normalizeFieldValue(percent, percentField)
      expect(committed).toBe(percent)
      expect(surgePodsFromPercent(committed, at)).toBe(pods)
    }
  })

  it('shows what the old integer-step rounding would have done to that value', () => {
    const percent = surgePercentFromPods(3, 7)
    expect(normalizeFieldValue(percent, { min: 0, max: 500, step: 5 })).toBe(43)
    expect(surgePodsFromPercent(43, 7)).toBe(4)
  })
})
