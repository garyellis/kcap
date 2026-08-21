import { test, expect } from './support/fixture'
import type { Kcap } from './support/kcap'

/**
 * Promoted from the "Rollout surge" group of `docs/ui-regression-scenarios.md`.
 * Each test's title is its scenario ID and heading, verbatim, so a failure names
 * the row in the checklist that just stopped being true.
 */
test.describe('Rollout surge', () => {
  /**
   * The shared opening of R3–R5 and R15: an absolute one-pod surge on `api`.
   *
   * The scenario tabs are cluster totals, so `worker`'s own 25% surge has to be
   * silenced first or it would be mixed into every reading.
   */
  async function pinApiToOneSurgePod(kcap: Kcap): Promise<void> {
    await kcap.open()

    await kcap.selectWorkload('worker')
    await kcap.setSurgeUnit('pods')
    await kcap.setField('Rollout max surge', 0)

    await kcap.selectWorkload('api')
    await kcap.setSurgeUnit('pods')
    await kcap.setField('Rollout max surge', 1)
  }

  /** `Rollout` minus `HPA max`: the extra pods the rollout actually asks for. */
  async function surgePods(kcap: Kcap): Promise<number> {
    return (await kcap.podCount('Rollout')) - (await kcap.podCount('HPA max'))
  }

  test('R3 — an absolute surge is one pod, at any replica count', async ({ kcap }) => {
    await pinApiToOneSurgePod(kcap)

    expect(await surgePods(kcap)).toBe(1)

    // The claim is "+1 at any replica count", not "30 → 31". Move the ceiling and
    // re-read: a surge that tracks the replica count is the bug this pins.
    const ceilingBefore = await kcap.podCount('HPA max')
    await kcap.setField('Replica ceiling', 40)
    expect(await kcap.podCount('HPA max')).toBeGreaterThan(ceilingBefore)

    expect(await surgePods(kcap)).toBe(1)
  })

  test('R4 — switching surge units round-trips', async ({ kcap }) => {
    await pinApiToOneSurgePod(kcap)

    await kcap.setSurgeUnit('%')
    await kcap.setSurgeUnit('pods')

    // The field reads `1 pods` again — the readout the P0.2 follow-up broke, when
    // `pods → %` nulled the pod count and left the importer's filler 25 behind, so
    // an imported `maxSurge: 1` came back as 5.
    await expect(kcap.surge).toHaveValue('1')
    await expect(kcap.surgeUnit).toHaveValue('pods')

    expect(await surgePods(kcap)).toBe(1)
  })

  test('R5 — a percent surge survives a focus-blur', async ({ kcap }) => {
    await pinApiToOneSurgePod(kcap)
    await kcap.setSurgeUnit('%')

    const converted = await kcap.surge.inputValue()
    // The pin is an integer-rounding rule re-rounding a converted percent, so the
    // test is only meaningful while the conversion produces a fraction. If this
    // ever fails, the premise has moved and the scenario needs rewriting — it has
    // not silently become a test that asserts nothing.
    expect(converted, 'the conversion should leave a fractional percent to re-round').toContain('.')

    await kcap.surge.focus()
    await kcap.surge.blur()

    await expect(kcap.surge).toHaveValue(converted)

    await kcap.setSurgeUnit('pods')
    await expect(kcap.surge).toHaveValue('1')
  })

  test('R15 — a no-op unit round-trip changes no result', async ({ kcap }) => {
    await pinApiToOneSurgePod(kcap)

    const projection = async () => ({
      hpaMax: await kcap.podCount('HPA max'),
      rollout: await kcap.podCount('Rollout'),
      caAction: await kcap.caAction(),
    })

    const before = await projection()

    await kcap.setSurgeUnit('%')
    expect(await projection()).toEqual(before)

    await kcap.setSurgeUnit('pods')
    expect(await projection()).toEqual(before)

    // Deliberately not asserted: the change chip. It counts *input* edits, and the
    // round-trip legitimately rewrites two fields, so its number moves. That
    // reflects the config, not the capacity answer.
  })
})
