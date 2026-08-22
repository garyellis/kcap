import { describe, expect, it } from 'vitest'
import { exposureReadout } from './exposure'

function block(overrides: Partial<Parameters<typeof exposureReadout>[0]> = {}) {
  return exposureReadout({
    nodes_evaluated: 7,
    memory_exhaustible_node_count: 2,
    memory_max_limit_percent: 148.5,
    memory_unlimited_pod_count: 0,
    cpu_max_limit_percent: 175,
    flags: [],
    ...overrides,
  })
}

// Null and empty-flags are the two states most easily confused, and confusing
// them is the one error that makes the panel lie: null means the packer opened
// no nodes, so nothing was examined at all.
describe('exposureReadout, on what was examined', () => {
  it('reports no evaluation when the pool packed no nodes', () => {
    expect(exposureReadout(null).kind).toBe('not-evaluated')
  })

  it('reports all clear only when nodes were examined and none was flagged', () => {
    expect(block().kind).toBe('clear')
  })

  it('reports exhaustible as soon as one flag fires', () => {
    expect(block({ flags: ['a node can be exhausted'] }).kind).toBe('exhaustible')
  })

  // The engine flags a pod with no memory limit wherever it is placed, but a
  // node holding one such pod and nothing else sits at exactly its allocatable,
  // so the exhaustible count stays 0. Deriving the state from that count would
  // drop the flag on the floor.
  it('reports exhaustible on a flag even when no node count backs it', () => {
    const readout = block({
      memory_exhaustible_node_count: 0,
      memory_unlimited_pod_count: 4,
      flags: ['4 pods carry no memory limit'],
    })
    expect(readout.kind).toBe('exhaustible')
    expect(readout.exhaustibleNodeCount).toBe(0)
    expect(readout.unlimitedPodCount).toBe(4)
  })
})

describe('exposureReadout, on what the chip reads', () => {
  // A chip only renders on a flag, so these read a block that has one — the
  // all-clear fixture above would be asserting a summary line nothing draws.
  const flagged = (overrides: Partial<Parameters<typeof exposureReadout>[0]> = {}) =>
    block({ flags: ['a node can be exhausted'], ...overrides })

  it('carries the two node counts the summary line reads, in that order', () => {
    // Swapping these renders "7 of 2 nodes", which nothing else would catch.
    expect([flagged().exhaustibleNodeCount, flagged().nodesEvaluated]).toEqual([2, 7])
  })

  it('carries the worst node percentage the engine measured', () => {
    expect(flagged().memoryMaxLimitPercent).toBe(148.5)
  })

  it('leaves the engine sentences in the order and wording it emitted them', () => {
    const flags = ['a node can be exhausted', '4 pods carry no memory limit']
    expect(flagged({ flags }).flags).toEqual(flags)
  })
})

describe('exposureReadout, on the CPU ratio', () => {
  it('carries the ratio when a placed pod declares a CPU limit', () => {
    expect(block().cpuMaxLimitPercent).toBe(175)
  })

  it('reports no ratio when nothing declares one', () => {
    expect(block({ cpu_max_limit_percent: null }).cpuMaxLimitPercent).toBeNull()
  })

  it('has no ratio to report when nothing was evaluated', () => {
    expect(exposureReadout(null).cpuMaxLimitPercent).toBeNull()
  })
})
