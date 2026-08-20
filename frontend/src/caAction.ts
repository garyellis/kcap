import type { PoolScenarioResult } from './api'

// The Cluster Autoscaler action the results panel reads out: what the engine's
// node arithmetic instructs, in one place. Two call sites share it — the
// per-pool verdict and the cluster-total tile — and both have been wrong in the
// same way before, so the mapping lives here as pure, testable logic rather than
// inline in the panel.
//
// The engine already zeroed a scale-down it could not stand behind
// (`_evaluate_pool_scenario` in `src/kcap/engine.py`), so a blocked pool names
// the withheld instruction rather than falling back to "Hold", which would read
// as a steady state the autoscaler had settled on.
//
// An addition is *never* suppressed. Oversized pods block the removal, not the
// growth: with one oversized pod beside ninety placeable ones, `nodes_to_add`
// is a real instruction for the demand that can be placed, and the verdict
// paragraph beside it already carries "no node count places them" for the pod
// that cannot. The fully-oversized pool still reads `None` without a special
// case, because it cannot produce an addition: `validate` enforces
// `min_nodes <= current_nodes`, and with every pod excluded from the sizing
// `nodes_required` is 0, so `effective_nodes_required` is `min_nodes`, which
// cannot exceed `current_nodes`.

export type ScaleDownBlockedReason = NonNullable<PoolScenarioResult['scale_down_blocked_reason']>

export interface CaActionInput {
  /** Nodes the engine instructs adding; 0 when none are needed. */
  nodesToAdd: number
  /** Nodes the engine instructs removing, already gated by `blockedReason`. */
  nodesToRemove: number
  /**
   * Why a removal is withheld, or null. Per-pool this is the pool's own
   * `scale_down_blocked_reason`; the cluster totals carry no reason of their
   * own and read it off the pools they sum.
   */
  blockedReason: ScaleDownBlockedReason | null
}

export interface CaAction {
  /** `+N`, `−N` (U+2212), `None`, or `Hold`. */
  label: string
  className: 'is-add' | 'is-remove' | 'is-hold'
  note: 'nodes' | 'steady' | 'no fix' | 'no demand'
}

/** The rendered CA action for one pool's — or the cluster's — node deltas. */
export function caAction({ nodesToAdd, nodesToRemove, blockedReason }: CaActionInput): CaAction {
  if (nodesToAdd > 0) return { label: `+${nodesToAdd}`, className: 'is-add', note: 'nodes' }
  if (nodesToRemove > 0) return { label: `−${nodesToRemove}`, className: 'is-remove', note: 'nodes' }
  if (blockedReason !== null) {
    return {
      label: 'None',
      className: 'is-hold',
      note: blockedReason === 'oversized_pods' ? 'no fix' : 'no demand',
    }
  }
  return { label: 'Hold', className: 'is-hold', note: 'steady' }
}
