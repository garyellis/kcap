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
  /**
   * Everything the section may not move, read as one line each: the five
   * scenario tabs, the instruction beside the verdict, and the two node numbers
   * under it. Runtime risk is additive context — usage and declared limits
   * describe how the packing behaves, and requests alone decide it.
   */
  async function projection(kcap: Kcap) {
    return {
      hpaMin: await kcap.podCount('HPA min'),
      current: await kcap.podCount('Current'),
      desired: await kcap.podCount('Desired'),
      hpaMax: await kcap.podCount('HPA max'),
      rollout: await kcap.podCount('Rollout'),
      caAction: await kcap.caAction(),
      placement: await kcap.tileReading('Placement'),
      headroom: await kcap.tileReading('Headroom'),
    }
  }

  /**
   * The memory ceiling ratio the exposure chip prints, as a number. R21 is
   * about which side of 100% it falls on — above means a node's ceilings
   * outrun the memory it has, exactly 100% means a pod can claim its whole
   * node and no more — so the number is read rather than quoted.
   */
  async function memoryCeilingPercent(kcap: Kcap): Promise<number> {
    const section = (await kcap.runtimeRisk.innerText()).replace(/\s+/g, ' ')
    const match = /memory ceilings reach ([\d.]+)% of allocatable on the most exposed node/.exec(section)
    expect(match, 'the exposure chip printed no memory ceiling ratio').not.toBeNull()
    return Number(match?.[1])
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

  test('R21a — a declared memory ceiling flags an exhaustible node and moves no node number', async ({ kcap }) => {
    await kcap.open()
    await kcap.selectWorkload('api')

    // The control the edit is read against: exhaustion is something kcap
    // examined and cleared here, which is why the neutral line says
    // "contention or exhaustion" rather than contention alone.
    await expect(kcap.runtimeRisk).toContainText('No contention or exhaustion detected on this packing.')
    await expect(kcap.riskChip('Node exhaustible')).toHaveCount(0)

    const before = await projection(kcap)
    const memoryLimitTotalBefore = await kcap.tileReading('Memory runtime limit')

    await kcap.setField('Memory limit value', 4096)

    // Nodes are named because nodes are what fired: their declared ceilings
    // outrun the memory those nodes actually have.
    await expect(kcap.riskChip('Node exhaustible')).toHaveText(/^Node exhaustible · \d+ of \d+ nodes?$/)
    expect(await memoryCeilingPercent(kcap), 'an exhaustible node is one whose ceilings exceed it').toBeGreaterThan(100)

    // Not one node number moves: a ceiling is not a request, and requests are
    // what the packing is decided on.
    expect(await projection(kcap)).toEqual(before)
    // The one figure a limit is allowed to move is the sum of the limits.
    expect(await kcap.tileReading('Memory runtime limit')).not.toBe(memoryLimitTotalBefore)

    await kcap.expandRisk('Node exhaustible')
    // Prose, composed by the engine so that every consumer of the API reports
    // exhaustion in the same words. The clause quoted is the finding itself.
    await expect(kcap.runtimeRisk).toContainText('can be exhausted by pods behaving within their limits')
    // The CPU ratio never earns a chip of its own, because an overcommitted node
    // throttles rather than dies. It is printed as a plain line wherever the
    // engine measured one — including on the all-clear read above, which is the
    // point: it is a reading, not a consequence of the memory finding.
    await expect(kcap.runtimeRisk).toContainText(
      'CPU is compressible, so a node over 100% throttles rather than runs out.',
    )
  })

  test('R21b — an unlimited pod is flagged where no node is over its allocatable', async ({ kcap }) => {
    await kcap.open()

    // At 3000m one pod holds a node by itself, so a pod with no memory limit
    // claims exactly its node and no more. The exhaustible *node* count is 0
    // while the finding is entirely real — read the count and the chip would
    // say `0 of 6 nodes`, which is why the finding is read off the flags and
    // the chip names the pods instead.
    await kcap.selectWorkload('api')
    await kcap.setToggle('Memory limit', false)
    await kcap.setField('CPU request', 3000)
    await kcap.selectWorkload('worker')
    await kcap.setField('Current replicas', 0)
    // `Desired` holds pods above zero through the HPA minimum; `Current` is
    // where `worker` is actually absent.
    await kcap.selectScenario('Current')

    await expect(kcap.riskChip('Unlimited memory')).toHaveText(/^Unlimited memory · \d+ pods?$/)
    await expect(kcap.riskChip('Node exhaustible')).toHaveCount(0)
    expect(await memoryCeilingPercent(kcap), 'no node here is over its allocatable').toBe(100)

    await kcap.expandRisk('Unlimited memory')
    await expect(kcap.runtimeRisk).toContainText('carry no memory limit; each can claim its whole node')

    // With a ceiling missing there is no total to print, and the tile says so
    // rather than summing the ones that remain.
    expect(await kcap.tileReading('Memory runtime limit')).toBe('Unbounded all pools')
  })
})
