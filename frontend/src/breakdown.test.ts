import { describe, expect, it } from 'vitest'
import type { ContainerInfo, Workload } from './api'
import { withPodEdit } from './breakdown'

const IMPORTED: ContainerInfo[] = [
  {
    name: 'app',
    cpu_request_m: 250,
    memory_request_mib: 256,
    cpu_limit_m: null,
    memory_limit_mib: null,
    observed_cpu: { avg: 300, p95: null, peak: null },
    observed_memory: null,
  },
]

function workload(overrides: Partial<Workload> = {}): Workload {
  return {
    name: 'demo/web',
    resources: { cpu_request_m: 250, memory_request_mib: 256, cpu_limit_m: null, memory_limit_mib: null },
    current_replicas: 2,
    observed_cpu_per_pod: { avg: 510, p95: null, peak: null },
    observed_memory_per_pod: null,
    containers: IMPORTED,
    hpa: null,
    rollout: { max_surge_percent: 25, max_surge_pods: null },
    pool: 'primary',
    ...overrides,
  }
}

describe('withPodEdit', () => {
  it('applies the patch', () => {
    const edited = withPodEdit(workload(), {
      resources: { cpu_request_m: 500, memory_request_mib: 256, cpu_limit_m: null, memory_limit_mib: null },
    })

    expect(edited.resources.cpu_request_m).toBe(500)
  })

  it('drops a breakdown the edit has just contradicted', () => {
    // The defect this pins: the pod said 500m while its only container still
    // said 250m, and nothing downstream could tell which was current, because
    // a breakdown that does not sum to the pod totals is the normal case.
    const edited = withPodEdit(workload(), {
      resources: { cpu_request_m: 500, memory_request_mib: 256, cpu_limit_m: null, memory_limit_mib: null },
    })

    expect(edited.containers).toBeNull()
  })

  it('drops it on an observed-usage edit too', () => {
    // Per-container usage is a share of the pod figure, so editing the pod
    // figure by hand leaves the shares describing a measurement that no longer
    // matches what the workload claims.
    const edited = withPodEdit(workload(), { observed_cpu_per_pod: { avg: 900, p95: null, peak: null } })

    expect(edited.containers).toBeNull()
    expect(edited.observed_cpu_per_pod?.avg).toBe(900)
  })

  it('leaves every other field alone', () => {
    const before = workload()
    const edited = withPodEdit(before, { current_replicas: 7 })

    expect({ ...edited, containers: before.containers }).toEqual({ ...before, current_replicas: 7 })
  })

  it('is a no-op on a workload that never had a breakdown', () => {
    // Every hand-built workload is in this state — the editor is pod-level and
    // produces no breakdown — so the common path must not change shape.
    const plain = workload({ containers: null })

    expect(withPodEdit(plain, { current_replicas: 3 })).toEqual({ ...plain, current_replicas: 3 })
  })

  it('does not mutate the workload it was given', () => {
    const before = workload()

    withPodEdit(before, { current_replicas: 9 })

    expect(before.containers).toEqual(IMPORTED)
    expect(before.current_replicas).toBe(2)
  })
})
