import type { PoolScenarioResult } from './api'

// Reading the engine's limit-exposure block for one pool and scenario.
//
// The block answers the incompressible question the packing does not: if every
// pod on a node grew to the ceiling it declared, would the node survive it? The
// panel asks three things of it that its own shape does not answer:
//
// 1. *Was exposure even evaluated?* `limit_exposure` is null when the packer
//    opened no nodes — the same condition that nulls `cpu_contention`, and the
//    same trap. Nothing was examined, so rendering an all-clear would claim
//    kcap checked something it never looked at. An empty `flags` list on a
//    non-null block is the all-clear.
// 2. *Did anything fire?* From the flags, never from the exhaustible node
//    count: a pod with no memory limit is flagged even where it sits alone on
//    its node, which puts the node exactly at its allocatable rather than over
//    it. Reading the count would hide exactly that flag.
// 3. *What does the chip say?* Which is the same question, from the other side
//    — see `exhaustibleNodeCount` below.

type LimitExposure = NonNullable<PoolScenarioResult['limit_exposure']>

export interface ExposureReadout {
  /**
   * `not-evaluated` — no nodes were packed, so nothing was examined;
   * `clear` — nodes were examined and none can be exhausted;
   * `exhaustible` — pods behaving within their limits can exhaust a node.
   */
  kind: 'not-evaluated' | 'clear' | 'exhaustible'
  /**
   * Nodes whose ceilings outrun their allocatable memory. Zero is possible on
   * an `exhaustible` readout — an unlimited pod alone on its node claims
   * exactly the node and no more — which is why the chip names the pods
   * instead of the nodes there.
   */
  exhaustibleNodeCount: number
  nodesEvaluated: number
  unlimitedPodCount: number
  /** The worst node's memory ceilings as a percentage of its allocatable. */
  memoryMaxLimitPercent: number
  /** The same ratio for CPU, or null when no placed pod declares a limit. */
  cpuMaxLimitPercent: number | null
  /** The engine's sentences, untouched and in the order it emitted them. */
  flags: readonly string[]
}

/** What the Runtime risk section renders for one pool's exposure block. */
export function exposureReadout(exposure: LimitExposure | null): ExposureReadout {
  if (exposure === null) {
    return {
      kind: 'not-evaluated',
      exhaustibleNodeCount: 0,
      nodesEvaluated: 0,
      unlimitedPodCount: 0,
      memoryMaxLimitPercent: 0,
      cpuMaxLimitPercent: null,
      flags: [],
    }
  }
  return {
    kind: exposure.flags.length === 0 ? 'clear' : 'exhaustible',
    exhaustibleNodeCount: exposure.memory_exhaustible_node_count,
    nodesEvaluated: exposure.nodes_evaluated,
    unlimitedPodCount: exposure.memory_unlimited_pod_count,
    memoryMaxLimitPercent: exposure.memory_max_limit_percent,
    cpuMaxLimitPercent: exposure.cpu_max_limit_percent,
    flags: exposure.flags,
  }
}
