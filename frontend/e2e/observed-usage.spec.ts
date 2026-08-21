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
})
