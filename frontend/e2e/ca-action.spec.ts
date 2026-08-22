import { test, expect } from './support/fixture'

/**
 * Promoted from the "Cluster-autoscaler action readout" group of
 * `docs/ui-regression-scenarios.md`.
 *
 * Most of that group is manual only: those rows turn on whether the tile chose
 * the right sentence out of four near-synonyms, which a test can compare but
 * cannot judge. R23 is not one of them. It names three states and the reading
 * each must produce, and the readings differ arithmetically rather than
 * rhetorically — a drain to the floor, a withheld removal, and a pool already
 * at rest.
 */
test.describe('Cluster-autoscaler action readout', () => {
  test('R23 — an idle pool with a floor drains to it', async ({ kcap }) => {
    await kcap.open()

    await kcap.selectWorkload('api')
    await kcap.setField('Current replicas', 0)
    await kcap.selectWorkload('worker')
    await kcap.setField('Current replicas', 0)

    await kcap.selectNodePool('primary')
    await kcap.setField('Current nodes', 8)
    // The app opens on `Desired`, where the HPA minimum keeps the pods above
    // zero. `Current` is the scenario in which this pool is genuinely idle.
    await kcap.selectScenario('Current')

    const floor = Number(await kcap.field('Minimum nodes').inputValue())
    const running = Number(await kcap.field('Current nodes').inputValue())
    expect(running, 'the pool needs nodes above its floor to have anything to drain').toBeGreaterThan(floor)

    // Drained *to the floor*, which is what a real autoscaler does — the claim
    // is `running − floor`, read off the two fields rather than asserted as the
    // shipped 8 and 3. Reading `None · no demand` here understated a safe
    // instruction.
    expect(await kcap.caAction()).toBe(`−${running - floor} nodes`)
    // And the pool is idle at the same time. Both statements are true of it and
    // both belong on screen; the constraint chip is where the idleness goes.
    // The chip's own text is `None` — chips are uppercased in CSS, and this
    // reads the tile the way it renders.
    expect(await kcap.tileReading('Constraint')).toBe('NONE no pods in scenario')

    // Take the floor away and the same idle pool has nothing left to drain to:
    // the removal would strip it bare, so it is withheld. That one field is the
    // whole of the difference between this reading and the one above.
    await kcap.setField('Minimum nodes', 0)
    expect(await kcap.caAction()).toBe('None no demand')

    // A pool already sitting at its floor has no removal to withhold, so it
    // reads as the steady state it is — with the idleness still carried by the
    // chip rather than by the instruction.
    await kcap.setField('Minimum nodes', floor)
    await kcap.setField('Current nodes', floor)
    expect(await kcap.caAction()).toBe('Hold steady')
    expect(await kcap.tileReading('Constraint')).toBe('NONE no pods in scenario')
  })
})
