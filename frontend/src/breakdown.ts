import type { Workload } from './api'

// A workload's per-container breakdown is a record of what one export said the
// pod's containers asked for. kcap's own editor is pod-level: it can neither
// show nor edit a container, so once a pod-level number is edited by hand there
// is nothing to update the breakdown *to*, and the two descriptions of the same
// pod disagree.
//
// The disagreement cannot be detected after the fact. Pod-level numbers carry
// Kubernetes' effective-request semantics — a dominating init container can set
// them — so a breakdown that does not sum to the pod totals is the normal case,
// not the edited one. That is why the proposal excludes any cross-check, and it
// is why staleness has to be caught here, at the edit, or not at all.
//
// So a pod-level edit drops the breakdown. Analysis falls back to pod-level,
// which is the degraded mode the design already specifies for a workload with
// no breakdown at all — the same state every hand-built workload is in. The
// alternative, keeping a list that contradicts the pod, would have the runtime
// risk analysis flag a container against a request the operator has since
// changed.
export function withPodEdit(workload: Workload, patch: Partial<Workload>): Workload {
  return { ...workload, ...patch, containers: null }
}
