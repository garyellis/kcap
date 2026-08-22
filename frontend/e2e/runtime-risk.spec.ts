import { test, expect } from './support/fixture'
import { checklistFixture } from './support/checklist'
import type { Kcap } from './support/kcap'

/**
 * Promoted from the "Runtime risk" group of `docs/ui-regression-scenarios.md`.
 *
 * The claim under all four is one claim: the section must say what was
 * *examined*, not only what was found. The engine's block is null when the
 * packer opened no nodes and an empty flag list when it opened some and cleared
 * them all, and a readout that only ever renders flags shows the same thing for
 * both.
 */
test.describe('Runtime risk', () => {
  /** Everything the section may not move, read as one line each. */
  async function projection(kcap: Kcap) {
    return {
      desired: await kcap.podCount('Desired'),
      hpaMax: await kcap.podCount('HPA max'),
      caAction: await kcap.caAction(),
    }
  }

  test('R20a — an examined packing with nothing to report says so', async ({ kcap }) => {
    await kcap.open()

    await expect(kcap.runtimeRisk).toContainText('No contention or exhaustion detected on this packing.')
    // The engine's own basis note, rendered verbatim: the defaults carry no peak,
    // so the reading is an average and the flags below would be a lower bound.
    await expect(kcap.runtimeRisk).toContainText('Peak unavailable for 2 workloads')
    await expect(kcap.riskChip('Borrowed CPU')).toHaveCount(0)
  })

  test('R20b — a borrowing workload raises a chip and no node number', async ({ kcap }) => {
    await kcap.open()
    await kcap.selectWorkload('api')

    const before = await projection(kcap)

    await kcap.setField('Peak CPU usage / pod', 2000)

    await expect(kcap.riskChip('Borrowed CPU')).toHaveText('Borrowed CPU · 1 workload')
    // Both numbers, in that order: `0 of 3` and `3 of 3` are exactly the
    // regressions this line exists to catch, and either would satisfy a match
    // that dropped the leading count.
    await expect(kcap.runtimeRisk).toContainText('2 of 3 packed nodes contended')

    // The whole design rule, read off the screen: runtime risk is additive
    // context, so a flag moves no scenario, no verdict, and no CA instruction.
    expect(await projection(kcap)).toEqual(before)

    await kcap.expandRisk('Borrowed CPU')
    // The column heading is quoted exactly because the word "bound" is the claim:
    // the number is an entitlement floor, never a prediction of usage.
    await expect(kcap.runtimeRisk).toContainText('worst case (bound)')
    const row = kcap.contentionRow('api')
    await expect(row).toContainText('750m')
    await expect(row).toContainText('2000m')
    await expect(row).toContainText('peak')
    await expect(row).toContainText('8 of 8')
    await expect(row).toContainText('771m')
    // The Container cell reads `whole pod` for a pod-level flag, and is
    // deliberately not asserted: that wording is one session old, and a test
    // guards a settled decision rather than a fresh one. The row's identity and
    // its numbers are what this scenario is about.
  })

  test('R20c — a pool that packed nothing is not an all-clear', async ({ kcap }) => {
    await kcap.open()

    // Nothing fits an empty node at 8000m, so every pod is oversized and the
    // packer opens no node at all.
    await kcap.selectWorkload('api')
    await kcap.setField('CPU request', 8000)
    await kcap.selectWorkload('worker')
    await kcap.setField('CPU request', 8000)

    await expect(kcap.runtimeRisk).toContainText(
      'No nodes were packed for this pool, so runtime risk was not evaluated.',
    )
    // Not the all-clear sentence, which would claim kcap checked something it
    // never looked at. Mutating the readout to treat null as clear turns this red.
    await expect(kcap.runtimeRisk).not.toContainText('No contention or exhaustion detected')
    // And no basis note: a pool that packed nothing has no reading to disclose a
    // basis for.
    await expect(kcap.runtimeRisk).not.toContainText('Peak unavailable')
  })

  test('R20d — the chip counts workloads while the table counts flags', async ({ kcap }) => {
    await kcap.open()

    await kcap.openImport()
    await kcap.pasteImport(checklistFixture('F5'))
    await kcap.commitImport('Replace configuration')

    // One workload borrowing through two containers: two rows, one chip.
    await expect(kcap.riskChip('Borrowed CPU')).toHaveText('Borrowed CPU · 1 workload')

    await kcap.expandRisk('Borrowed CPU')
    await expect(kcap.contentionRow('app')).toContainText('500m')
    await expect(kcap.contentionRow('app')).toContainText('1700m')
    await expect(kcap.contentionRow('istio-proxy')).toContainText('19m')
    await expect(kcap.contentionRow('istio-proxy')).toContainText('300m')

    // The caveat the owner chose over a pod-level row: the breakdown names only
    // the containers the import listed, so a pod may be borrowing more than its
    // rows account for. It appears exactly when a row names a container.
    await expect(kcap.runtimeRisk).toContainText('Container rows name only the containers the import listed')
  })
})
