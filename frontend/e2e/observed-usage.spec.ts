import { test, expect } from './support/fixture'

/** Promoted from the "Baseline" group of `docs/ui-regression-scenarios.md`. */
test.describe('Baseline', () => {
  test('R2 — observed usage moves the HPA recommendation', async ({ kcap }) => {
    await kcap.open()
    await kcap.selectWorkload('api')

    const desiredBefore = await kcap.podCount('Desired')

    await kcap.setField('Average CPU usage / pod', 900)

    // The claim is the direction — more CPU burned per pod, more pods
    // recommended — not the shipped defaults' 12 → 15. The scenario has been
    // walked at other usage values (Session E, at 1200 mCPU: 12 → 18) and the
    // pin held; an equality here would have failed that walk for no reason.
    expect(await kcap.podCount('Desired')).toBeGreaterThan(desiredBefore)

    await expect(kcap.changeChip).toHaveText('1 change')

    // "No 422 in the console or the server log" is enforced for every test by the
    // guard in support/traffic.ts, which is the whole reason R2 exists: the editor
    // posts the `observed_cpu_per_pod` summary, and since the Session E cleanup
    // that is the only form the API accepts at all.
  })

  test('R16 — a peak can be entered, and cannot be entered below the average', async ({ kcap }) => {
    await kcap.open()
    await kcap.selectWorkload('api')

    const peak = kcap.field('Peak CPU usage / pod')
    const average = Number(await kcap.field('Average CPU usage / pod').inputValue())
    // Read off the screen rather than hard-coded: the claim is the ordering the
    // engine enforces, not the shipped default's 620.
    expect(average, 'the fixture should carry an average to order the peak against').toBeGreaterThan(0)

    const projection = async () => ({
      desired: await kcap.podCount('Desired'),
      caAction: await kcap.caAction(),
    })
    const before = await projection()

    // Below the average, the peak snaps up to it. A maximum cannot sit under its
    // own mean, and the engine returns that violation as a message-only 422 — so
    // a UI that let it through would show an unexplained error banner.
    await kcap.setField('Peak CPU usage / pod', Math.round(average / 2))
    await expect(peak).toHaveValue(String(average))

    // Above it, held exactly.
    await kcap.setField('Peak CPU usage / pod', average * 2)
    await expect(peak).toHaveValue(String(average * 2))

    // Neither edit is a sizing input: the HPA reads the average and nothing else.
    expect(await projection()).toEqual(before)

    // An average that overtakes the peak carries the peak up with it, rather than
    // stranding a measurement below its own mean.
    await kcap.setField('Average CPU usage / pod', average * 3)
    await expect(peak).toHaveValue(String(average * 3))
  })
})
