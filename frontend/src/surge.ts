import type { Workload } from './api'

// Rollout max surge has two interchangeable units in the editor, and the engine
// resolves them with different rules: an absolute `max_surge_pods` is used as-is,
// while `max_surge_percent` is scaled against the replica count the rollout
// surges at and rounded *up*. See `evaluate_workload` in `src/kcap/engine.py`,
// which mirrors kubernetes/kubernetes v1.33.0
// `pkg/controller/deployment/util/deployment_util.go` MaxSurge() ->
// ResolveFenceposts() -> intstr.GetScaledValueFromIntOrPercent(..., roundUp=true).
//
// The unit picker is only honest if both directions reproduce that ceil()
// exactly. Everything here is pure and UI-free so it can be tested directly and
// so the editor never has to re-derive the engine's arithmetic inline.

export type SurgeUnit = '%' | 'pods'

export const SURGE_UNITS: SurgeUnit[] = ['%', 'pods']

// The editor's own bounds, kept together because they are related: the percent
// bound is the percentage that expresses the largest absolute surge at a single
// replica (10000 pods / 1 replica * 100). Any smaller percent bound would let
// the field clamp a converted value on blur, which would silently re-model the
// rollout the unit picker is supposed to leave alone.
export const SURGE_PODS_MAX = 10000
export const SURGE_PERCENT_MAX = SURGE_PODS_MAX * 100

/**
 * The replica count the engine surges against: the HPA maximum when the
 * workload autoscales, otherwise its current replicas.
 */
export function surgeBaseReplicas(workload: Pick<Workload, 'hpa' | 'current_replicas'>): number {
  return workload.hpa?.max_replicas ?? workload.current_replicas
}

/**
 * The unit a stored rollout implies. Derived, never stored: `max_surge_pods`
 * carries the engine's own precedence rule (an absolute wins whenever it is set,
 * including 0), so a workload loaded from a scenario file or a cluster import
 * opens in the unit its data already means.
 */
export function surgeUnitOf(rollout: Workload['rollout']): SurgeUnit {
  return rollout.max_surge_pods !== null && rollout.max_surge_pods !== undefined ? 'pods' : '%'
}

/**
 * Pods a percentage resolves to, in exactly the engine's arithmetic and
 * operand order: `ceil(at * percent / 100)`.
 */
export function surgePodsFromPercent(percent: number, at: number): number {
  if (!Number.isFinite(percent) || !Number.isFinite(at) || percent <= 0 || at <= 0) return 0
  return Math.ceil((at * percent) / 100)
}

/**
 * The percentage that resolves back to exactly `pods` at `at` replicas, so that
 * `surgePodsFromPercent(surgePercentFromPods(n, at), at) === n`.
 *
 * Because the percent direction rounds up, the percentages that reproduce `n`
 * form the half-open window `((n - 1) / at * 100, n / at * 100]`. The exact
 * ratio sits at the top of that window, so it is the value to aim for:
 *
 *  - Rounding the percent to an integer is wrong for `at >= 100`, where the
 *    window is narrower than a whole percent (at=200, n=3 needs 1.5%; 1% gives
 *    2 pods and 2% gives 4).
 *  - Rounding *up* leaves the window entirely and adds a pod.
 *  - Flooring to two decimals stays inside the window while the window is wider
 *    than a hundredth of a percent, i.e. `at < 10000`, which covers everything
 *    the editor's replica bounds allow except the very top.
 *
 * So try the cleanest representative first and fall back only as far as needed,
 * verifying each candidate against the engine's own rounding:
 *
 *  1. the exact ratio floored to two decimals — nearly always exact and the
 *     nicest thing to show in the field;
 *  2. one hundredth lower, for the handful of ratios whose two-decimal form is
 *     not representable as a double and lands a hair above the window top
 *     (9999 pods at 1375 replicas is exactly 727.2%, but the nearest double to
 *     727.2 scales back to 10000 pods);
 *  3. the unrounded ratio, which is the only candidate left at `at = 10000`
 *     where the window is exactly one hundredth wide.
 *
 * A sweep of every `at` in 1..10000 against a wide range of pod counts shows
 * candidate 1 covering all but 22 pairs and no pair reaching the final return.
 */
export function surgePercentFromPods(pods: number, at: number): number {
  // At zero replicas a percentage always resolves to zero pods, so no percent
  // can express a non-zero absolute surge there. 0 is the truthful answer: it is
  // what percent mode will actually model, and it keeps a division by zero from
  // putting Infinity or NaN into a field the API validates as a `ge=0` float.
  if (!Number.isFinite(pods) || !Number.isFinite(at) || pods <= 0 || at <= 0) return 0
  const exact = (pods / at) * 100
  const hundredths = Math.floor(exact * 100)
  for (const candidate of [hundredths / 100, (hundredths - 1) / 100, exact]) {
    if (candidate > 0 && surgePodsFromPercent(candidate, at) === pods) return candidate
  }
  return exact
}

/**
 * The rollout patch for a unit switch, or null when nothing changes. Both
 * directions convert through the replica count the engine surges at, so the
 * modelled rollout is identical before and after — the picker changes the unit,
 * never the plan.
 */
export function surgeUnitPatch(
  workload: Pick<Workload, 'hpa' | 'current_replicas' | 'rollout'>,
  unit: string,
): Partial<Workload['rollout']> | null {
  if (unit !== 'pods' && unit !== '%') return null
  if (unit === surgeUnitOf(workload.rollout)) return null
  const at = surgeBaseReplicas(workload)
  if (unit === 'pods') {
    return { max_surge_pods: surgePodsFromPercent(workload.rollout.max_surge_percent, at) }
  }
  // Null, not undefined, so the percent unit survives a scenario JSON round-trip.
  // The stored percentage is *not* reusable here: an absolute import parks a
  // filler percentage next to the pod count (`rolloutFromMaxSurge` in
  // importers.ts), so leaving it in place is what made this toggle lossy.
  return {
    max_surge_percent: surgePercentFromPods(workload.rollout.max_surge_pods ?? 0, at),
    max_surge_pods: null,
  }
}
