import { describe, expect, it } from 'vitest'
import type { Workload } from './api'
import { rolloutFromMaxSurge } from './importers'
import {
  SURGE_PERCENT_MAX,
  SURGE_PODS_MAX,
  surgeBaseReplicas,
  surgePercentFromPods,
  surgePodsFromPercent,
  surgeUnitOf,
  surgeUnitPatch,
} from './surge'

function workload(overrides: Partial<Workload> = {}): Workload {
  return {
    name: 'web',
    resources: { cpu_request_m: 250, memory_request_mib: 256, cpu_limit_m: null, memory_limit_mib: null },
    current_replicas: 4,
    observed_cpu_per_pod_m: null,
    observed_memory_per_pod_mib: null,
    hpa: null,
    rollout: { max_surge_percent: 25, max_surge_pods: null },
    pool: null,
    ...overrides,
  }
}

const hpa = (max_replicas: number): Workload['hpa'] => ({
  min_replicas: 1,
  max_replicas,
  cpu_target_percentage: 70,
  memory_target_percentage: null,
})

describe('surgeBaseReplicas', () => {
  it('surges at the HPA maximum when the workload autoscales', () => {
    expect(surgeBaseReplicas(workload({ current_replicas: 4, hpa: hpa(20) }))).toBe(20)
  })

  it('falls back to current replicas without an HPA', () => {
    expect(surgeBaseReplicas(workload({ current_replicas: 4, hpa: null }))).toBe(4)
  })
})

describe('surgeUnitOf', () => {
  it('reads the unit off the engine precedence rule, including an absolute 0', () => {
    expect(surgeUnitOf({ max_surge_percent: 25, max_surge_pods: 3 })).toBe('pods')
    expect(surgeUnitOf({ max_surge_percent: 25, max_surge_pods: 0 })).toBe('pods')
    expect(surgeUnitOf({ max_surge_percent: 25, max_surge_pods: null })).toBe('%')
    expect(surgeUnitOf({ max_surge_percent: 25 })).toBe('%')
  })
})

// Mirrors `evaluate_workload` in src/kcap/engine.py, which is itself pinned to
// kubernetes/kubernetes v1.33.0 pkg/controller/deployment/util/deployment_util.go
// MaxSurge() -> ResolveFenceposts() -> intstr.GetScaledValueFromIntOrPercent with
// roundUp=true: a percent scales against the replica count and rounds up.
describe('surgePodsFromPercent', () => {
  it('scales against the replica count and rounds up', () => {
    expect(surgePodsFromPercent(25, 20)).toBe(5)
    expect(surgePodsFromPercent(25, 3)).toBe(1)
    expect(surgePodsFromPercent(10, 25)).toBe(3)
    expect(surgePodsFromPercent(100, 7)).toBe(7)
  })

  it('is zero for a zero percent or a zero replica count', () => {
    expect(surgePodsFromPercent(0, 20)).toBe(0)
    expect(surgePodsFromPercent(25, 0)).toBe(0)
  })
})

describe('surgePercentFromPods', () => {
  it('returns the true equivalent, not whatever filler the import parked', () => {
    // The reported defect: an absolute import stores max_surge_percent: 25
    // alongside the pod count, and the old switch shipped that 25 verbatim.
    expect(surgePercentFromPods(1, 20)).toBe(5)
  })

  it('keeps an even division exact, with no float dust', () => {
    expect(surgePercentFromPods(1, 20)).toBe(5)
    expect(surgePercentFromPods(20, 20)).toBe(100)
    expect(surgePercentFromPods(3, 200)).toBe(1.5)
    expect(surgePercentFromPods(1, 4)).toBe(25)
    // …and displays as the plain number the field will render.
    expect(String(surgePercentFromPods(1, 20))).toBe('5')
    expect(String(surgePercentFromPods(3, 200))).toBe('1.5')
  })

  it('is zero pods at zero percent', () => {
    expect(surgePercentFromPods(0, 20)).toBe(0)
  })

  // A percent that is rounded to a whole number cannot express the surge once
  // the replica count reaches 100, where the window of percentages that resolve
  // to a given pod count is narrower than one percent.
  it('needs sub-integer precision above 100 replicas', () => {
    expect(surgePodsFromPercent(Math.floor(surgePercentFromPods(3, 200)), 200)).toBe(2)
    expect(surgePodsFromPercent(Math.round(surgePercentFromPods(3, 7)), 7)).toBe(4)
    // The real conversion still round-trips both.
    expect(surgePodsFromPercent(surgePercentFromPods(3, 200), 200)).toBe(3)
    expect(surgePodsFromPercent(surgePercentFromPods(3, 7), 7)).toBe(3)
  })

  it('guards a zero or negative replica count instead of dividing by it', () => {
    // No percentage can express a non-zero surge on zero replicas — the engine
    // resolves ceil(0 * p / 100) to 0 pods for every p — so 0 is the truthful
    // answer, and it keeps Infinity/NaN out of a `ge=0` float on the API.
    expect(surgePercentFromPods(3, 0)).toBe(0)
    expect(surgePercentFromPods(0, 0)).toBe(0)
    expect(surgePercentFromPods(3, -5)).toBe(0)
    for (const at of [0, -1, -10000]) {
      const percent = surgePercentFromPods(7, at)
      expect(Number.isFinite(percent)).toBe(true)
      expect(percent).toBeGreaterThanOrEqual(0)
    }
  })

  it('never exceeds the percent bound the editor field enforces', () => {
    // Otherwise the field would clamp a converted value on blur and re-model the
    // rollout. The worst case is the whole pods range at a single replica.
    expect(surgePercentFromPods(SURGE_PODS_MAX, 1)).toBe(SURGE_PERCENT_MAX)
    expect(surgePercentFromPods(SURGE_PODS_MAX, 1)).toBeLessThanOrEqual(SURGE_PERCENT_MAX)
  })
})

// The stability requirement: the picker is a unit change, so pods -> % -> pods
// must land on the pod count it started from. Because the % -> pods direction
// rounds up, the percentages that reproduce n sit in ((n-1)/at*100, n/at*100];
// a percent rounded down can fall out of the bottom and one rounded up adds a
// pod, so the conversion has to verify itself against the engine's arithmetic.
describe('pods -> percent -> pods stability', () => {
  const named: Array<[number, number]> = [
    [3, 7],
    [1, 3],
    [2, 3],
    [3, 200],
    [1, 20],
    [20, 20],
    [0, 20],
  ]

  it.each(named)('round-trips %i pods at %i replicas', (pods, at) => {
    expect(surgePodsFromPercent(surgePercentFromPods(pods, at), at)).toBe(pods)
  })

  it('round-trips across a broad sweep of replica counts', () => {
    const failures: Array<{ pods: number; at: number; percent: number; back: number }> = []
    let checked = 0
    for (let at = 1; at <= 1000; at += 1) {
      const podCounts = new Set<number>()
      for (let pods = 0; pods <= 50; pods += 1) podCounts.add(pods)
      for (const pods of [at - 1, at, at + 1, Math.floor(at / 2), Math.ceil(at / 7), at * 2, at * 3 + 1]) {
        if (pods >= 0 && pods <= SURGE_PODS_MAX) podCounts.add(pods)
      }
      for (const pods of podCounts) {
        checked += 1
        const percent = surgePercentFromPods(pods, at)
        const back = surgePodsFromPercent(percent, at)
        if (back !== pods || !Number.isFinite(percent) || percent < 0) {
          failures.push({ pods, at, percent, back })
        }
      }
    }
    expect(checked).toBeGreaterThan(50000)
    expect(failures.slice(0, 10)).toEqual([])
  })

  // Flooring the percent to two decimals only stays inside the window while the
  // window is wider than a hundredth of a percent, i.e. at < 10000. Both the
  // pods field and the replicas fields cap at 10000, so the boundary is
  // reachable and the conversion falls back to the unrounded ratio there.
  it('round-trips at the 10000-replica boundary the fields allow', () => {
    const failures: Array<{ pods: number; at: number; percent: number; back: number }> = []
    for (let at = 9990; at <= SURGE_PODS_MAX; at += 1) {
      for (const pods of [0, 1, 2, 3, 7, 14, 17, 28, 39, 100, 999, 5000, at - 1, at, SURGE_PODS_MAX]) {
        const percent = surgePercentFromPods(pods, at)
        const back = surgePodsFromPercent(percent, at)
        if (back !== pods || !Number.isFinite(percent)) failures.push({ pods, at, percent, back })
      }
    }
    expect(failures.slice(0, 10)).toEqual([])
    // 1 pod in 10000 is exactly the narrowest window the editor can produce.
    expect(surgePercentFromPods(1, SURGE_PODS_MAX)).toBe(0.01)
    expect(surgePodsFromPercent(0.01, SURGE_PODS_MAX)).toBe(1)
  })

  it('is stable across repeated toggling, not just one round trip', () => {
    for (const [pods, at] of [[3, 7], [9999, 1375], [17, 625], [7, 10000]] as Array<[number, number]>) {
      let current = pods
      let percent = 0
      for (let toggle = 0; toggle < 5; toggle += 1) {
        percent = surgePercentFromPods(current, at)
        current = surgePodsFromPercent(percent, at)
      }
      expect(current).toBe(pods)
    }
  })

  // The percent direction is many-to-one by design (26% and 30% both surge 6
  // pods at 20 replicas), so a % -> pods -> % cycle need not preserve the
  // literal percent — but it must preserve the modelled surge.
  it('preserves the modelled surge when starting from a percentage', () => {
    for (const at of [3, 7, 20, 200, 1000]) {
      for (const percent of [0, 5, 25, 26, 30, 33.33, 50, 100, 150]) {
        const pods = surgePodsFromPercent(percent, at)
        expect(surgePodsFromPercent(surgePercentFromPods(pods, at), at)).toBe(pods)
      }
    }
  })
})

describe('surgeUnitPatch', () => {
  it('does nothing when the unit is unchanged or unknown', () => {
    const percentMode = workload()
    expect(surgeUnitPatch(percentMode, '%')).toBeNull()
    expect(surgeUnitPatch(percentMode, 'replicas')).toBeNull()
    const podsMode = workload({ rollout: { max_surge_percent: 25, max_surge_pods: 2 } })
    expect(surgeUnitPatch(podsMode, 'pods')).toBeNull()
  })

  it('seeds pods from what the percentage resolves to at the HPA maximum', () => {
    const target = workload({ hpa: hpa(20), rollout: { max_surge_percent: 25, max_surge_pods: null } })
    expect(surgeUnitPatch(target, 'pods')).toEqual({ max_surge_pods: 5 })
  })

  it('nulls the absolute explicitly so the unit survives a scenario round-trip', () => {
    const target = workload({ hpa: hpa(20), rollout: { max_surge_percent: 25, max_surge_pods: 1 } })
    const patch = surgeUnitPatch(target, '%')
    expect(patch).toEqual({ max_surge_percent: 5, max_surge_pods: null })
    expect(patch && 'max_surge_pods' in patch).toBe(true)
    expect(patch?.max_surge_pods).toBeNull()
  })

  // The reported repro, end to end through the real importer: a Deployment with
  // maxSurge: 1 behind an HPA whose maximum is 20. The importer parks an inert
  // max_surge_percent: 25 next to the absolute, and the old switch handed that
  // 25 straight to the engine — a silent 5x on the modelled rollout.
  it('leaves an imported absolute maxSurge unchanged across a % round trip', () => {
    const imported = workload({
      hpa: hpa(20),
      rollout: rolloutFromMaxSurge('Deployment', 1),
    })
    expect(imported.rollout).toEqual({ max_surge_percent: 25, max_surge_pods: 1 })
    expect(surgeUnitOf(imported.rollout)).toBe('pods')

    const toPercent = { ...imported.rollout, ...surgeUnitPatch(imported, '%') }
    expect(surgeUnitOf(toPercent)).toBe('%')
    expect(toPercent.max_surge_percent).toBe(5)
    expect(toPercent.max_surge_percent).not.toBe(25)
    expect(surgePodsFromPercent(toPercent.max_surge_percent, 20)).toBe(1)

    const backToPods = { ...toPercent, ...surgeUnitPatch({ ...imported, rollout: toPercent }, 'pods') }
    expect(surgeUnitOf(backToPods)).toBe('pods')
    expect(backToPods.max_surge_pods).toBe(1)
  })

  it('keeps an absolute 0 at 0 in both units', () => {
    const target = workload({ hpa: hpa(20), rollout: { max_surge_percent: 25, max_surge_pods: 0 } })
    const toPercent = { ...target.rollout, ...surgeUnitPatch(target, '%') }
    expect(toPercent).toEqual({ max_surge_percent: 0, max_surge_pods: null })
    expect(surgePodsFromPercent(toPercent.max_surge_percent, 20)).toBe(0)
  })

  it('converts against current replicas when there is no HPA', () => {
    const target = workload({ current_replicas: 8, hpa: null, rollout: { max_surge_percent: 25, max_surge_pods: 3 } })
    const toPercent = { ...target.rollout, ...surgeUnitPatch(target, '%') }
    expect(toPercent.max_surge_percent).toBe(37.5)
    expect(surgePodsFromPercent(toPercent.max_surge_percent, 8)).toBe(3)
  })

  it('degrades honestly at zero replicas rather than emitting Infinity', () => {
    const target = workload({ current_replicas: 0, hpa: null, rollout: { max_surge_percent: 25, max_surge_pods: 3 } })
    const toPercent = { ...target.rollout, ...surgeUnitPatch(target, '%') }
    expect(toPercent.max_surge_percent).toBe(0)
    expect(Number.isFinite(toPercent.max_surge_percent)).toBe(true)
    // Both units model zero surge on zero replicas, so switching back stays at 0.
    const backToPods = { ...toPercent, ...surgeUnitPatch({ ...target, rollout: toPercent }, 'pods') }
    expect(backToPods.max_surge_pods).toBe(0)
  })
})
