import { test, expect } from './support/fixture'
import type { Kcap } from './support/kcap'

/**
 * Promoted from the "Cluster-autoscaler action readout" group of
 * `docs/ui-regression-scenarios.md`.
 *
 * R22 and R25 are one question asked of two sections. A pool can hold two pod
 * populations at once — the pods no node can take, and the rest — and the
 * engine sizes every node number from the rest alone. Every number is right
 * about the pods it is about; what goes wrong is a panel narrating both
 * without saying which is which. So each reading names its population, and
 * only while there are two to tell apart: the trap in both rows is the
 * ordinary pool, where nothing may change because there is nothing to
 * distinguish.
 *
 * The group's other rows (R6–R10) are manual only, because they turn on whether
 * the panel picked the right sentence out of four near-synonyms — a judgement no
 * assertion makes. These two are not like that: R22 claims a fixed clause
 * against a named state, and R25 claims a relationship between figures printed
 * beside each other. Both are things a test can hold still.
 */
test.describe('Oversized pool', () => {
  /**
   * Push `api`'s pods past what an empty node can hold, leaving `worker`'s
   * placeable. The CPU limit follows the request up on its own: the engine
   * rejects a limit below its request, and typing the limit back down 422s the
   * run and leaves the panel stale.
   */
  async function makeApiPodsOversized(kcap: Kcap): Promise<void> {
    await kcap.selectWorkload('api')
    await kcap.setField('CPU request', 8000)
    await expect(kcap.oversizedVerdict, 'the request should exceed one whole node').toBeVisible()
  }

  /** The pod count the verdict names — the population every scoped note excludes. */
  async function excludedPodCount(kcap: Kcap): Promise<number> {
    const verdict = (await kcap.oversizedVerdict.innerText()).replace(/\s+/g, ' ')
    const match = /^(\d+) pods? requests? more than one whole node\./.exec(verdict)
    expect(match, `the verdict read "${verdict}", which names no count`).not.toBeNull()
    return Number(match?.[1])
  }

  /** One saturation bar, split into the figures that are only right as a set. */
  function readBar(line: string): { capacity: string; requested: number; stranded: number } {
    const match = /^(?<value>.+?) \/ (?<capacity>.+?) (?<requested>\d+)% requested(?: · (?<stranded>\d+)%)?/.exec(line)
    expect(match, `a saturation bar read "${line}", which is not "value / capacity N% requested"`).not.toBeNull()
    const groups = match?.groups ?? {}
    return {
      capacity: groups.capacity ?? '',
      requested: Number(groups.requested),
      // The stranded clause is printed only when something is stranded, so its
      // absence is a reading of zero rather than a parse failure.
      stranded: groups.stranded === undefined ? 0 : Number(groups.stranded),
    }
  }

  async function bars(kcap: Kcap) {
    return {
      cpu: readBar(await kcap.requestBarReading('CPU')),
      memory: readBar(await kcap.requestBarReading('Memory')),
    }
  }

  /**
   * A bar and the stranded figure beside it divide by the same capacity, so
   * between them they account for all of it. A numerator scoped to one
   * population beside a stranded figure scoped to the other is the
   * contradiction R25 exists to prevent, and it surfaces here as shares that do
   * not add up. Each is rounded to a whole percent on its own, so one point of
   * slack is the rounding and not a second population.
   */
  function expectSharesToAccountForCapacity(reading: Record<string, { requested: number; stranded: number }>): void {
    for (const [resource, bar] of Object.entries(reading)) {
      const share = bar.requested + bar.stranded
      expect(
        Math.abs(share - 100),
        `the ${resource} bar reads ${bar.requested}% requested beside ${bar.stranded}% stranded`,
      ).toBeLessThanOrEqual(1)
    }
  }

  test('R22 — an oversized pool says which pods each node number is about', async ({ kcap }) => {
    await kcap.open()

    // One population, so no reading is qualified and the density paragraph
    // ends where it always did.
    expect(await kcap.tileReading('Placement')).toMatch(/^\d+ nodes to hold the pods$/)
    expect(await kcap.tileReading('Effective target')).toMatch(/^\d+ after CA minimum \d+$/)
    await expect(kcap.densityNote).toHaveText(/without changing requests or node size\.$/)

    await makeApiPodsOversized(kcap)
    const excluded = await excludedPodCount(kcap)

    // Both node numbers now name the population they size, and name the same
    // one: `Effective target` sits beside `Placement`, which has just said it.
    expect(await kcap.tileReading('Placement')).toMatch(/^\d+ nodes for the pods that fit$/)
    expect(await kcap.tileReading('Effective target')).toMatch(/^\d+ same pods, after CA minimum \d+$/)

    // The density sentence gains a second one naming the pods it leaves out,
    // and it must be the same count the verdict above reports — two readings
    // of one population that disagreed would be worse than neither.
    await expect(kcap.densityNote).toContainText(
      `That per-node figure counts only the pods that fit, not the ${excluded} requesting more than one whole node.`,
    )

    // Back to one population: an ordinary pool gains no extra words, because a
    // qualifier on every pool trains a reader to ignore it on the pool that
    // needs it.
    await kcap.reset()
    await expect(kcap.oversizedVerdict).toHaveCount(0)
    expect(await kcap.tileReading('Placement')).toMatch(/^\d+ nodes to hold the pods$/)
    expect(await kcap.tileReading('Effective target')).toMatch(/^\d+ after CA minimum \d+$/)
    await expect(kcap.densityNote).toHaveText(/without changing requests or node size\.$/)
  })

  test('R25a — the request bars are about the pods their capacity was sized for', async ({ kcap }) => {
    await kcap.open()

    // An ordinary pool: no scoping clause, and these are the figures the reset
    // at the end has to come back to.
    await expect(kcap.saturationSubhead).toHaveText(/^\d+ × node allocatable$/)
    const ordinary = await bars(kcap)
    expectSharesToAccountForCapacity(ordinary)

    await makeApiPodsOversized(kcap)

    // The subhead is where the section says whose demand it is showing.
    await expect(kcap.saturationSubhead).toHaveText(/^the pods that fit · \d+ × node allocatable$/)

    const scoped = await bars(kcap)

    // Same capacity, smaller numerators: the bars were re-scoped, not re-sized.
    // Both moved — the memory bar was never over 100%, so it is the one that
    // shows this is a change of population rather than a clamp, and scoping
    // only the CPU bar is the regression it exists to catch.
    expect(scoped.cpu.capacity).toBe(ordinary.cpu.capacity)
    expect(scoped.memory.capacity).toBe(ordinary.memory.capacity)
    expect(scoped.cpu.requested).toBeLessThan(ordinary.cpu.requested)
    expect(scoped.memory.requested).toBeLessThan(ordinary.memory.requested)

    // Neither ratio is above 100%. This is the reading that was `463%
    // requested` — a figure no node count in the pool's envelope could bring
    // under 100, for a pool with no failing placement left to fix.
    expect(scoped.cpu.requested).toBeLessThanOrEqual(100)
    expect(scoped.memory.requested).toBeLessThanOrEqual(100)

    // The stranded readout is measured against the same capacity and is scoped
    // with it. Left unscoped it was `capacity − everything requested`, which
    // floors to nothing stranded here: a whole node reported as spoken for by
    // pods that will never occupy it, one line under a bar that already knows
    // better.
    expect(scoped.cpu.stranded).toBeGreaterThan(ordinary.cpu.stranded)
    expect(scoped.memory.stranded).toBeGreaterThan(ordinary.memory.stranded)
    // Which is the check that holds each bar to its own stranded figure, and
    // so catches scoping one bar and not the other.
    expectSharesToAccountForCapacity(scoped)

    // Reset and re-read: an ordinary pool has nothing to scope away, so every
    // figure is the one that was on screen before the edit. Read as a
    // comparison against what was captured first, not as a recomputation.
    await kcap.reset()
    await expect(kcap.saturationSubhead).toHaveText(/^\d+ × node allocatable$/)
    expect(await bars(kcap)).toEqual(ordinary)
  })

  test('R25b — a pool with nothing placeable reads as empty, not as spoken for', async ({ kcap }) => {
    await kcap.open()

    await makeApiPodsOversized(kcap)
    await kcap.selectWorkload('worker')
    await kcap.setField('CPU request', 8000)

    // Nothing fits, so the subhead carries the scoping on its own: there is no
    // per-node figure left to qualify, and the density paragraph is gone.
    await expect(kcap.saturationSubhead).toHaveText(/^the pods that fit · \d+ × node allocatable$/)
    await expect(kcap.densityNote).toHaveCount(0)
    expect(await kcap.tileReading('Placement')).toMatch(/^0 nodes for the pods that fit$/)

    // The pool sits at its CA minimum and no pod claims any of it, so every
    // provisioned core is stranded. The old formula got this exactly
    // backwards and reported a pool holding no pod at all as fully spoken for.
    const empty = await bars(kcap)
    expect(empty.cpu).toMatchObject({ requested: 0, stranded: 100 })
    expect(empty.memory).toMatchObject({ requested: 0, stranded: 100 })
  })
})
