import type { PoolScenarioResult } from './api'

// Reading the engine's CPU-contention block for one pool and scenario.
//
// The panel asks three questions of it that the block does not answer in its
// own shape, so they are answered here, once, where they can be tested:
//
// 1. *Was contention even evaluated?* `cpu_contention` is null when the packer
//    opened no nodes — a pool with nothing placeable has no node that could be
//    contended. That is not an all-clear, and rendering one would claim kcap
//    checked something it never looked at. An empty `flags` list on a non-null
//    block is the all-clear.
// 2. *How many workloads?* Flags are per (workload, container), so one workload
//    with three borrowing containers is three rows and one workload. The chip
//    counts workloads; the table shows the rows.
// 3. *Do the rows name containers?* When the import carried a breakdown, only
//    the containers it listed are flagged, and a pod borrowing through a
//    container the spec never declared has that excess attributed to no row.
//    The expansion says so — but only when there is a container row to qualify.

type CpuContention = NonNullable<PoolScenarioResult['cpu_contention']>

export type ContentionFlag = CpuContention['flags'][number]

export interface ContentionReadout {
  /**
   * `not-evaluated` — no nodes were packed, so nothing was examined;
   * `clear` — nodes were examined and none was contended;
   * `borrowed-cpu` — at least one unit is living above its CPU request.
   */
  kind: 'not-evaluated' | 'clear' | 'borrowed-cpu'
  /** Distinct workloads named by the flags, which is what the chip counts. */
  workloadCount: number
  contendedNodeCount: number
  nodesEvaluated: number
  /** The engine's flags, untouched and in the order it emitted them. */
  flags: readonly ContentionFlag[]
  /** True when at least one flag names a container, so the caveat line applies. */
  namesContainers: boolean
  /**
   * The engine's `basis_notes` as one muted line, or null when it attached
   * none. The notes are already worded for display; they are joined, never
   * rewritten.
   */
  basisNote: string | null
}

/** What the Runtime risk section renders for one pool's contention block. */
export function contentionReadout(contention: CpuContention | null): ContentionReadout {
  if (contention === null) {
    return {
      kind: 'not-evaluated',
      workloadCount: 0,
      contendedNodeCount: 0,
      nodesEvaluated: 0,
      flags: [],
      namesContainers: false,
      basisNote: null,
    }
  }
  const workloads = new Set(contention.flags.map((flag) => flag.workload))
  return {
    kind: contention.flags.length === 0 ? 'clear' : 'borrowed-cpu',
    workloadCount: workloads.size,
    contendedNodeCount: contention.contended_node_count,
    nodesEvaluated: contention.nodes_evaluated,
    flags: contention.flags,
    namesContainers: contention.flags.some((flag) => flag.container !== null),
    basisNote: contention.basis_notes.length > 0 ? contention.basis_notes.join(' ') : null,
  }
}
