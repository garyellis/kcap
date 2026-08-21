import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ClusterConfig } from './api'
import {
  applyClusterImport,
  buildExportScript,
  deriveNodePools,
  effectiveRequest,
  parseCpuQuantity,
  parseImport,
  parseMemoryQuantity,
  planClusterImport,
  rolloutFromMaxSurge,
  selectorKey,
  serializeScenario,
  transformClusterExport,
} from './importers'
import type { ClusterExport, ExportedContainer, ExportedNode, ExportedUsage, ExportedWorkload } from './importers'
// The surge unit the UI derives is real, shared code — importing it here keeps
// these save/load and import assertions pinned to what the editor actually does.
import { surgeUnitOf } from './surge'

function config(overrides: Partial<ClusterConfig> = {}): ClusterConfig {
  return {
    workloads: {
      api: {
        name: 'api',
        resources: { cpu_request_m: 500, memory_request_mib: 512, cpu_limit_m: null, memory_limit_mib: null },
        current_replicas: 2,
        observed_cpu_per_pod: null,
        observed_memory_per_pod: null,
        hpa: null,
        rollout: { max_surge_percent: 25 },
        pool: null,
      },
    },
    node_pools: {
      primary: {
        name: 'primary',
        machine: { cpu_m: 4000, memory_mib: 16384, reserved_cpu_m: 400, reserved_memory_mib: 1536, max_pods: 110 },
        min_nodes: 0,
        current_nodes: 3,
        max_nodes: 10,
      },
    },
    ...overrides,
  }
}

function deployment(overrides: Partial<ExportedWorkload> = {}): ExportedWorkload {
  return {
    kind: 'Deployment',
    namespace: 'demo',
    name: 'web',
    replicas: 4,
    maxSurge: '25%',
    containers: [{ resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '500m', memory: '512Mi' } } }],
    initContainers: [],
    nodeSelector: null,
    tolerations: null,
    nodeAffinity: null,
    ...overrides,
  }
}

function clusterExport(
  workloads: ClusterExport['workloads'],
  nodes: ExportedNode[] | null = null,
  usage: ExportedUsage | null = null,
): ClusterExport {
  return { kind: 'kcap-cluster-export', version: 1, workloads, nodes, usage }
}

describe('parseCpuQuantity', () => {
  it('parses millicores, cores, and fractions', () => {
    expect(parseCpuQuantity('500m')).toBe(500)
    expect(parseCpuQuantity('2')).toBe(2000)
    expect(parseCpuQuantity('0.5')).toBe(500)
    expect(parseCpuQuantity(2)).toBe(2000)
  })

  it('rounds up so a nonzero request never becomes zero', () => {
    expect(parseCpuQuantity('0.0001')).toBe(1)
    expect(parseCpuQuantity('1.5m')).toBe(2)
  })

  it('parses metrics-server nanocore and microcore quantities', () => {
    expect(parseCpuQuantity('123456789n')).toBe(124)
    expect(parseCpuQuantity('250000000n')).toBe(250)
    expect(parseCpuQuantity('1500u')).toBe(2)
    expect(parseCpuQuantity('250m')).toBe(250)
  })

  it('treats missing, zero, and garbage as zero', () => {
    expect(parseCpuQuantity(undefined)).toBe(0)
    expect(parseCpuQuantity('')).toBe(0)
    expect(parseCpuQuantity('0')).toBe(0)
    expect(parseCpuQuantity('lots')).toBe(0)
  })
})

describe('parseMemoryQuantity', () => {
  it('parses binary suffixes', () => {
    expect(parseMemoryQuantity('512Mi')).toBe(512)
    expect(parseMemoryQuantity('1Gi')).toBe(1024)
    expect(parseMemoryQuantity('2Ti')).toBe(2 * 1024 * 1024)
    expect(parseMemoryQuantity('1Pi')).toBe(1024 ** 3)
    expect(parseMemoryQuantity('1024Ki')).toBe(1)
  })

  it('parses decimal suffixes into MiB, rounding up', () => {
    expect(parseMemoryQuantity('1G')).toBe(954)
    expect(parseMemoryQuantity('500M')).toBe(477)
    expect(parseMemoryQuantity('1T')).toBe(953675)
    expect(parseMemoryQuantity('128k')).toBe(1)
  })

  it('parses bare bytes and exponents', () => {
    expect(parseMemoryQuantity('134217728')).toBe(128)
    expect(parseMemoryQuantity('129e6')).toBe(124)
    expect(parseMemoryQuantity(1048576)).toBe(1)
  })

  it('floors tiny nonzero values at 1 MiB and rejects zero', () => {
    expect(parseMemoryQuantity('1Ki')).toBe(1)
    expect(parseMemoryQuantity('0')).toBe(0)
    expect(parseMemoryQuantity(null)).toBe(0)
  })
})

describe('effectiveRequest', () => {
  const container = (cpu: string) => ({ resources: { requests: { cpu } } })

  it('sums regular containers', () => {
    expect(effectiveRequest([container('250m'), container('750m')], [], 'cpu')).toBe(1000)
  })

  it('lets a large init container dominate the sum', () => {
    expect(effectiveRequest([container('200m')], [container('900m')], 'cpu')).toBe(900)
    expect(effectiveRequest([container('200m')], [container('100m')], 'cpu')).toBe(200)
  })

  it('counts native sidecars into the sum instead', () => {
    const sidecar = { resources: { requests: { cpu: '300m' } }, restartPolicy: 'Always' }
    expect(effectiveRequest([container('200m')], [sidecar], 'cpu')).toBe(500)
    expect(effectiveRequest([container('200m')], [sidecar, container('600m')], 'cpu')).toBe(600)
  })

  it('defaults a missing request to the container limit, as Kubernetes does', () => {
    const limitOnly = { resources: { limits: { cpu: '400m' } } }
    expect(effectiveRequest([limitOnly], [], 'cpu')).toBe(400)
    expect(effectiveRequest([container('200m'), limitOnly], [], 'cpu')).toBe(600)
  })
})

// Behavioral authority, verified at kubernetes/kubernetes v1.33.0:
// pkg/controller/deployment/util/deployment_util.go MaxSurge() → ResolveFenceposts()
// → intstr.GetScaledValueFromIntOrPercent(maxSurge, int(desired), true) in
// staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr.go, where an Int value is
// returned unscaled and only a "N%" string is scaled (value * total / 100, rounded
// up). An absolute maxSurge therefore stays absolute on import.
describe('rolloutFromMaxSurge', () => {
  it('keeps percentages as percentages, with no absolute', () => {
    expect(rolloutFromMaxSurge('Deployment', '25%')).toEqual({ max_surge_percent: 25, max_surge_pods: null })
    expect(rolloutFromMaxSurge('Deployment', '50%')).toEqual({ max_surge_percent: 50, max_surge_pods: null })
  })

  it('keeps absolutes absolute, leaving the percentage at its inert default', () => {
    expect(rolloutFromMaxSurge('Deployment', 1)).toEqual({ max_surge_percent: 25, max_surge_pods: 1 })
    expect(rolloutFromMaxSurge('Deployment', '2')).toEqual({ max_surge_percent: 25, max_surge_pods: 2 })
    // 0 is a real Kubernetes maxSurge and must survive as an absolute, since the
    // engine gives max_surge_pods precedence even at 0.
    expect(rolloutFromMaxSurge('Deployment', 0)).toEqual({ max_surge_percent: 25, max_surge_pods: 0 })
  })

  it('defaults missing to 25% and gives StatefulSets no surge', () => {
    expect(rolloutFromMaxSurge('Deployment', null)).toEqual({ max_surge_percent: 25, max_surge_pods: null })
    expect(rolloutFromMaxSurge('Deployment', undefined)).toEqual({ max_surge_percent: 25, max_surge_pods: null })
    expect(rolloutFromMaxSurge('Deployment', '')).toEqual({ max_surge_percent: 25, max_surge_pods: null })
    expect(rolloutFromMaxSurge('StatefulSet', '50%')).toEqual({ max_surge_percent: 0, max_surge_pods: null })
    expect(rolloutFromMaxSurge('StatefulSet', 3)).toEqual({ max_surge_percent: 0, max_surge_pods: null })
  })

  it('falls back to the default for values the schema would reject', () => {
    // max_surge_pods and max_surge_percent are both ge=0 on the API, so a
    // negative or unparseable value must never be emitted.
    expect(rolloutFromMaxSurge('Deployment', -1)).toEqual({ max_surge_percent: 25, max_surge_pods: null })
    expect(rolloutFromMaxSurge('Deployment', '-10%')).toEqual({ max_surge_percent: 25, max_surge_pods: null })
    expect(rolloutFromMaxSurge('Deployment', 'lots')).toEqual({ max_surge_percent: 25, max_surge_pods: null })
    expect(rolloutFromMaxSurge('Deployment', 'many%')).toEqual({ max_surge_percent: 25, max_surge_pods: null })
  })

  it('does not scale an absolute by the replica count', () => {
    // The old bug converted an absolute into a percentage of current replicas,
    // which the engine then applied at max_replicas: maxSurge 1 at 2 replicas
    // became 50%, i.e. 10 surge pods at an HPA maximum of 20.
    for (const replicas of [2, 40]) {
      const workload = deployment({ maxSurge: 1, replicas })
      const imported = transformClusterExport(clusterExport([workload])).workloads['demo/web']
      expect(imported.current_replicas).toBe(replicas)
      expect(imported.rollout).toEqual({ max_surge_percent: 25, max_surge_pods: 1 })
    }
  })

  it('leaves a workload with no maxSurge exactly as existing scenario files have it', () => {
    const workload = deployment({ maxSurge: null })
    const imported = transformClusterExport(clusterExport([workload])).workloads['demo/web']
    expect(imported.rollout).toEqual({ max_surge_percent: 25, max_surge_pods: null })
  })
})

describe('transformClusterExport', () => {
  it('builds workloads keyed namespace/name with effective requests and limits', () => {
    const result = transformClusterExport(clusterExport([deployment()]))
    const workload = result.workloads['demo/web']
    expect(workload).toBeDefined()
    expect(workload.name).toBe('demo/web')
    expect(workload.resources).toEqual({ cpu_request_m: 250, memory_request_mib: 256, cpu_limit_m: 500, memory_limit_mib: 512 })
    expect(workload.current_replicas).toBe(4)
    expect(workload.observed_cpu_per_pod).toBeNull()
    expect(workload.observed_memory_per_pod).toBeNull()
  })

  it('nullifies a limit when any container lacks it', () => {
    const item = deployment({
      containers: [
        { resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '200m' } } },
        { resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '200m', memory: '256Mi' } } },
      ],
    })
    const workload = transformClusterExport(clusterExport([item])).workloads['demo/web']
    expect(workload.resources.cpu_limit_m).toBe(400)
    expect(workload.resources.memory_limit_mib).toBeNull()
  })

  // A Guaranteed pod with a native sidecar (restartPolicy Always): the sidecar
  // keeps running, so it counts into the effective request. The pod limit has
  // to count it too, or the import lands with request > limit and the engine
  // rejects the config with a 422 the import dialog cannot fix.
  const guaranteedWithSidecar = (sidecar: ExportedContainer) =>
    deployment({
      containers: [{ resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '250m', memory: '256Mi' } } }],
      initContainers: [sidecar],
    })

  it('counts native sidecar limits into the pod limit', () => {
    const item = guaranteedWithSidecar({
      resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '50m', memory: '64Mi' } },
      restartPolicy: 'Always',
    })
    const workload = transformClusterExport(clusterExport([item])).workloads['demo/web']
    expect(workload.resources).toEqual({ cpu_request_m: 300, memory_request_mib: 320, cpu_limit_m: 300, memory_limit_mib: 320 })
  })

  it('nullifies the pod limit when a native sidecar declares none', () => {
    const item = guaranteedWithSidecar({
      resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '50m' } },
      restartPolicy: 'Always',
    })
    const workload = transformClusterExport(clusterExport([item])).workloads['demo/web']
    expect(workload.resources.cpu_limit_m).toBe(300)
    expect(workload.resources.memory_limit_mib).toBeNull()
  })

  it('imports a guaranteed pod with a sidecar without a request above its limit', () => {
    const item = guaranteedWithSidecar({
      resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '50m', memory: '64Mi' } },
      restartPolicy: 'Always',
    })
    const { resources } = transformClusterExport(clusterExport([item])).workloads['demo/web']
    expect(resources.cpu_request_m <= (resources.cpu_limit_m ?? Infinity)).toBe(true)
    expect(resources.memory_request_mib <= (resources.memory_limit_mib ?? Infinity)).toBe(true)
  })

  it('ignores plain init containers when summing limits', () => {
    // A plain init container has exited before the pod's steady state, so its
    // limit is neither summed in nor able to make the pod unbounded. The 100m
    // CPU limit only joins the max, which the 500m sum already dominates, and
    // the container claims no memory at all — no memory request, so it cannot
    // dominate the pod's memory request, and therefore no memory limit either.
    const item = deployment({
      initContainers: [{ resources: { requests: { cpu: '100m' }, limits: { cpu: '100m' } } }],
    })
    const workload = transformClusterExport(clusterExport([item])).workloads['demo/web']
    expect(workload.resources).toEqual({ cpu_request_m: 250, memory_request_mib: 256, cpu_limit_m: 500, memory_limit_mib: 512 })
  })

  // Upstream applies the same init-container max to limits that it applies to
  // requests: kubernetes/kubernetes v1.33.0,
  // staging/src/k8s.io/component-helpers/resource/helpers.go,
  // AggregateContainerLimits (called by PodLimits; AggregateContainerRequests is
  // the identical twin). restartPolicy Always init containers add into the
  // running sum; plain ones only raise the running max, then
  // `maxResourceList(limits, initContainerLimits)` folds that peak in. See the
  // tag's helpers_test.go cases "restartable-init, init and regular" and
  // "one limited and one unlimited init container ...".
  //
  // Two deliberate kcap divergences:
  //  - Upstream sums declared limits, so an undeclared limit contributes zero
  //    ("one limited and one unlimited container ..." expects the limited
  //    container's numbers, not unbounded). kcap's single pod limit is a runtime
  //    ceiling rather than an API projection, so a container with no limit makes
  //    the pod unbounded (null). For plain init containers that rule is scoped
  //    to what the pod request already accounts for — see summedLimit.
  //  - Upstream's init peak is `own + sum(sidecars declared before it)`;
  //    effectiveRequest takes the plain init container alone, and summedLimit
  //    matches it so the two stay comparable.
  const dominatingPlainInit = (init: ExportedContainer) =>
    deployment({
      containers: [{ resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '200m', memory: '256Mi' } } }],
      initContainers: [init],
    })

  it('raises the pod limit to a dominating plain init container', () => {
    const item = dominatingPlainInit({
      resources: { requests: { cpu: '900m', memory: '1Gi' }, limits: { cpu: '900m', memory: '1Gi' } },
    })
    const workload = transformClusterExport(clusterExport([item])).workloads['demo/web']
    expect(workload.resources).toEqual({ cpu_request_m: 900, memory_request_mib: 1024, cpu_limit_m: 900, memory_limit_mib: 1024 })
  })

  it('nullifies the pod limit when a dominating plain init container declares none', () => {
    const item = dominatingPlainInit({ resources: { requests: { cpu: '900m' } } })
    const workload = transformClusterExport(clusterExport([item])).workloads['demo/web']
    expect(workload.resources.cpu_request_m).toBe(900)
    expect(workload.resources.cpu_limit_m).toBeNull()
    // Memory is untouched: the init container claims none, so it neither
    // raises the memory request nor clouds the memory ceiling.
    expect(workload.resources.memory_request_mib).toBe(128)
    expect(workload.resources.memory_limit_mib).toBe(256)
  })

  it('takes the max across a plain init container and the sidecar-inclusive sum', () => {
    const item = deployment({
      containers: [{ resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '250m', memory: '256Mi' } } }],
      initContainers: [
        { resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '50m', memory: '64Mi' } }, restartPolicy: 'Always' },
        { resources: { requests: { cpu: '400m', memory: '128Mi' }, limits: { cpu: '400m', memory: '128Mi' } } },
      ],
    })
    const workload = transformClusterExport(clusterExport([item])).workloads['demo/web']
    // CPU: the plain init container (400m) beats the 300m running sum.
    // Memory: the 320Mi running sum beats the plain init container (128Mi).
    expect(workload.resources).toEqual({ cpu_request_m: 400, memory_request_mib: 320, cpu_limit_m: 400, memory_limit_mib: 320 })
  })

  it('never imports a request above a non-null limit', () => {
    const initContainers: ExportedContainer[][] = [
      [],
      [{ resources: { requests: { cpu: '900m', memory: '1Gi' }, limits: { cpu: '900m', memory: '1Gi' } } }],
      [{ resources: { requests: { cpu: '900m' } } }],
      [{ resources: { limits: { cpu: '900m', memory: '1Gi' } } }],
      [{ resources: {} }],
      [
        { resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '50m', memory: '64Mi' } }, restartPolicy: 'Always' },
        { resources: { requests: { cpu: '900m', memory: '1Gi' } } },
      ],
    ]
    for (const set of initContainers) {
      const item = deployment({
        containers: [{ resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '200m', memory: '256Mi' } } }],
        initContainers: set,
      })
      const { resources } = transformClusterExport(clusterExport([item])).workloads['demo/web']
      expect(resources.cpu_request_m <= (resources.cpu_limit_m ?? Infinity)).toBe(true)
      expect(resources.memory_request_mib <= (resources.memory_limit_mib ?? Infinity)).toBe(true)
    }
  })

  it('appends the kind when workloads of different kinds share a namespace and name', () => {
    const hpa = {
      kind: 'HorizontalPodAutoscaler' as const,
      namespace: 'demo',
      name: 'web-hpa',
      target: { kind: 'StatefulSet', name: 'web' },
      min: 2,
      max: 12,
      metrics: [{ resource: 'cpu', target: 70 }],
      targetCPUUtilizationPercentage: null,
    }
    const result = transformClusterExport(clusterExport([deployment(), deployment({ kind: 'StatefulSet', maxSurge: null }), hpa]))

    expect(Object.keys(result.workloads).sort()).toEqual(['demo/web (deployment)', 'demo/web (statefulset)'])
    expect(result.workloads['demo/web (deployment)'].name).toBe('demo/web (deployment)')
    expect(result.warnings).toEqual(['demo/web exists as Deployment and StatefulSet — imported as separate workloads with the kind appended.'])
    // The HPA join key already carried the kind, so it still lands on one side.
    expect(result.workloads['demo/web (statefulset)'].hpa).not.toBeNull()
    expect(result.workloads['demo/web (deployment)'].hpa).toBeNull()
    expect(result.groups[0].workloads.sort()).toEqual(['demo/web (deployment)', 'demo/web (statefulset)'])
  })

  it('leaves non-colliding keys untouched', () => {
    const result = transformClusterExport(clusterExport([deployment(), deployment({ kind: 'StatefulSet', name: 'db', maxSurge: null })]))

    expect(Object.keys(result.workloads).sort()).toEqual(['demo/db', 'demo/web'])
    expect(result.warnings).toEqual([])
  })

  it('imports requestless workloads at the BestEffort floor and lists them', () => {
    const bare = deployment({ name: 'bare', containers: [{ resources: null }] })
    const result = transformClusterExport(clusterExport([deployment(), bare]))
    expect(result.bestEffort).toEqual(['demo/bare'])
    expect(result.carried).toEqual([])
    expect(result.workloads['demo/bare'].resources).toEqual({
      cpu_request_m: 1,
      memory_request_mib: 1,
      cpu_limit_m: null,
      memory_limit_mib: null,
    })
  })

  it('carries requests forward from the current config for a same-named workload', () => {
    const bare = deployment({ name: 'web', containers: [{ resources: null }] })
    const result = transformClusterExport(clusterExport([bare]), config().workloads)
    expect(result.carried).toEqual([])
    expect(result.bestEffort).toEqual(['demo/web'])
    const existing = { 'demo/web': { ...config().workloads.api, name: 'demo/web' } }
    const matched = transformClusterExport(clusterExport([bare]), existing)
    expect(matched.carried).toEqual(['demo/web'])
    expect(matched.bestEffort).toEqual([])
    expect(matched.workloads['demo/web'].resources.cpu_request_m).toBe(500)
    expect(matched.workloads['demo/web'].resources.memory_request_mib).toBe(512)
  })

  it('leaves limits and HPA toggled off when the export has none', () => {
    const plain = deployment({ containers: [{ resources: { requests: { cpu: '100m', memory: '128Mi' } } }] })
    const workload = transformClusterExport(clusterExport([plain])).workloads['demo/web']
    expect(workload.resources.cpu_limit_m).toBeNull()
    expect(workload.resources.memory_limit_mib).toBeNull()
    expect(workload.hpa).toBeNull()
  })

  it('joins HPAs on namespace and target, with v1 fallback', () => {
    const hpa = {
      kind: 'HorizontalPodAutoscaler' as const,
      namespace: 'demo',
      name: 'web-hpa',
      target: { kind: 'Deployment', name: 'web' },
      min: 2,
      max: 12,
      metrics: [{ resource: 'cpu', target: 70 }, { resource: 'memory', target: 80 }],
      targetCPUUtilizationPercentage: null,
    }
    const v1 = {
      ...hpa,
      name: 'db-hpa',
      target: { kind: 'StatefulSet', name: 'db' },
      metrics: [],
      targetCPUUtilizationPercentage: 60,
    }
    const db = deployment({ kind: 'StatefulSet', name: 'db', maxSurge: null })
    const result = transformClusterExport(clusterExport([deployment(), db, hpa, v1]))
    expect(result.workloads['demo/web'].hpa).toEqual({ min_replicas: 2, max_replicas: 12, cpu_target_percentage: 70, memory_target_percentage: 80 })
    expect(result.workloads['demo/db'].hpa).toEqual({ min_replicas: 2, max_replicas: 12, cpu_target_percentage: 60, memory_target_percentage: null })
    expect(result.workloads['demo/db'].rollout.max_surge_percent).toBe(0)
    expect(result.notes.join(' ')).toContain('hold current replicas')
  })

  it('warns on HPAs whose target is not in the export', () => {
    const orphan = {
      kind: 'HorizontalPodAutoscaler' as const,
      namespace: 'demo',
      name: 'ghost',
      target: { kind: 'Deployment', name: 'missing' },
      min: 1,
      max: 5,
      metrics: [],
      targetCPUUtilizationPercentage: null,
    }
    const result = transformClusterExport(clusterExport([deployment(), orphan]))
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('demo/ghost')
  })

  it('averages summed per-pod container usage onto the matching workload', () => {
    const usage: ExportedUsage = {
      pods: [
        { namespace: 'demo', name: 'web-1', labels: { app: 'web', 'pod-template-hash': 'abc' }, phase: 'Running' },
        { namespace: 'demo', name: 'web-2', labels: { app: 'web', 'pod-template-hash': 'abc' }, phase: 'Running' },
      ],
      samples: [[
        {
          namespace: 'demo',
          name: 'web-1',
          containers: [{ usage: { cpu: '100m', memory: '131072Ki' } }, { usage: { cpu: '50000000n', memory: '64Mi' } }],
        },
        { namespace: 'demo', name: 'web-2', containers: [{ usage: { cpu: '250000000n', memory: '1Gi' } }] },
      ]],
    }
    const data = clusterExport([deployment({ selector: { app: 'web' } })], null, usage)
    const workload = transformClusterExport(data).workloads['demo/web']
    // web-1 sums to 150m / 192Mi, web-2 to 250m / 1024Mi -> averages below.
    // One capture, so there is no peak and the window is a point in time.
    expect(workload.observed_cpu_per_pod).toEqual({ avg: 200, p95: null, peak: null })
    expect(workload.observed_memory_per_pod).toEqual({ avg: 608, p95: null, peak: null })
    expect(workload.usage_source).toBe('metrics-server-snapshot')
    expect(workload.usage_window_seconds).toBe(0)
    expect(transformClusterExport(data).notes.join(' ')).not.toContain('hold current replicas')
  })

  it('summarizes a sampled export as an average and a peak across samples', () => {
    // Two pods whose busiest moments are different samples. That is what
    // separates the two candidate readings of "peak":
    //   max over samples of the per-pod average  -> 400m / 704 MiB (kcap's)
    //   average of each pod's own maximum        -> 650m / 1152 MiB
    // The first is a number the fleet actually showed at one instant; the
    // second assumes both pods peaked together and describes no real moment.
    const sample = (web1: string, web2: string, memory1: string, memory2: string) => [
      { namespace: 'demo', name: 'web-1', containers: [{ usage: { cpu: web1, memory: memory1 } }] },
      { namespace: 'demo', name: 'web-2', containers: [{ usage: { cpu: web2, memory: memory2 } }] },
    ]
    const usage: ExportedUsage = {
      pods: [
        { namespace: 'demo', name: 'web-1', labels: { app: 'web' }, phase: 'Running' },
        { namespace: 'demo', name: 'web-2', labels: { app: 'web' }, phase: 'Running' },
      ],
      samples: [
        sample('100m', '200m', '128Mi', '256Mi'), // per-pod average 150m / 192 MiB
        sample('600m', '100m', '1024Mi', '128Mi'), // 350m / 576 MiB
        sample('100m', '700m', '128Mi', '1280Mi'), // 400m / 704 MiB
      ],
      window_seconds: 60,
    }
    const data = clusterExport([deployment({ selector: { app: 'web' } })], null, usage)
    const result = transformClusterExport(data)
    const workload = result.workloads['demo/web']
    expect(workload.observed_cpu_per_pod).toEqual({ avg: 300, p95: null, peak: 400 })
    expect(workload.observed_memory_per_pod).toEqual({ avg: 491, p95: null, peak: 704 })
    expect(workload.usage_source).toBe('metrics-server-samples')
    expect(workload.usage_window_seconds).toBe(60)
    expect(result.notes.join(' ')).toContain('3 samples over 60s')
  })

  it('attributes pods by selector and namespace, skipping non-running pods', () => {
    const usage: ExportedUsage = {
      pods: [
        { namespace: 'demo', name: 'web-1', labels: { app: 'web' }, phase: 'Running' },
        { namespace: 'demo', name: 'web-2', labels: { app: 'web' }, phase: 'Pending' },
        { namespace: 'demo', name: 'other-1', labels: { app: 'other' }, phase: 'Running' },
        { namespace: 'prod', name: 'web-1', labels: { app: 'web' }, phase: 'Running' },
      ],
      samples: [[
        { namespace: 'demo', name: 'web-1', containers: [{ usage: { cpu: '100m', memory: '128Mi' } }] },
        { namespace: 'demo', name: 'web-2', containers: [{ usage: { cpu: '900m', memory: '900Mi' } }] },
        { namespace: 'demo', name: 'other-1', containers: [{ usage: { cpu: '300m', memory: '256Mi' } }] },
        { namespace: 'prod', name: 'web-1', containers: [{ usage: { cpu: '900m', memory: '900Mi' } }] },
      ]],
    }
    const items = [
      deployment({ selector: { app: 'web' } }),
      deployment({ name: 'other', selector: { app: 'other' } }),
    ]
    const result = transformClusterExport(clusterExport(items, null, usage))
    expect(result.workloads['demo/web'].observed_cpu_per_pod?.avg).toBe(100)
    expect(result.workloads['demo/web'].observed_memory_per_pod?.avg).toBe(128)
    expect(result.workloads['demo/other'].observed_cpu_per_pod?.avg).toBe(300)
    expect(result.workloads['demo/other'].observed_memory_per_pod?.avg).toBe(256)
  })

  it('keeps observed usage null when no pod matches or the selector is absent', () => {
    const usage: ExportedUsage = {
      pods: [{ namespace: 'demo', name: 'other-1', labels: { app: 'other' }, phase: 'Running' }],
      samples: [[{ namespace: 'demo', name: 'other-1', containers: [{ usage: { cpu: '300m', memory: '256Mi' } }] }]],
    }
    const items = [deployment({ selector: { app: 'web' } }), deployment({ name: 'bare', selector: null })]
    const result = transformClusterExport(clusterExport(items, null, usage))
    for (const name of ['demo/web', 'demo/bare']) {
      expect(result.workloads[name].observed_cpu_per_pod).toBeNull()
      expect(result.workloads[name].observed_memory_per_pod).toBeNull()
      expect(result.workloads[name].usage_source).toBeNull()
    }
  })

  it('notes missing metrics without claiming usage cannot be exported', () => {
    const hpa = {
      kind: 'HorizontalPodAutoscaler' as const,
      namespace: 'demo',
      name: 'web-hpa',
      target: { kind: 'Deployment', name: 'web' },
      min: 2,
      max: 12,
      metrics: [{ resource: 'cpu', target: 70 }],
      targetCPUUtilizationPercentage: null,
    }
    const result = transformClusterExport(clusterExport([deployment({ selector: { app: 'web' } }), hpa]))
    expect(result.workloads['demo/web'].observed_cpu_per_pod).toBeNull()
    expect(result.workloads['demo/web'].observed_memory_per_pod).toBeNull()
    const notes = result.notes.join(' ')
    expect(notes).toContain('hold current replicas')
    expect(notes).not.toContain('not part of a cluster export')
  })

  it('imports an export with no usage block cleanly, with nulls', () => {
    // A cluster with no metrics-server, or an exporter without permission.
    const unmetered = { kind: 'kcap-cluster-export', version: 1, workloads: [deployment()], nodes: null }
    const parsed = parseImport(JSON.stringify(unmetered))
    expect(parsed.kind).toBe('cluster')
    if (parsed.kind !== 'cluster') return
    const workload = transformClusterExport(parsed.data).workloads['demo/web']
    expect(workload.observed_cpu_per_pod).toBeNull()
    expect(workload.observed_memory_per_pod).toBeNull()
  })

  it('groups workloads by identical nodeSelector with a stable key', () => {
    const pinnedA = deployment({ name: 'a', nodeSelector: { tier: 'fast', zone: 'a' } })
    const pinnedB = deployment({ name: 'b', nodeSelector: { zone: 'a', tier: 'fast' } })
    const loose = deployment({ name: 'c' })
    const result = transformClusterExport(clusterExport([pinnedA, pinnedB, loose]))
    expect(result.groups).toHaveLength(2)
    const pinned = result.groups.find((group) => group.key !== 'unpinned')
    expect(pinned?.workloads).toEqual(['demo/a', 'demo/b'])
    expect(selectorKey({ zone: 'a', tier: 'fast' })).toBe(selectorKey({ tier: 'fast', zone: 'a' }))
    expect(selectorKey(null)).toBe('unpinned')
  })
})

describe('deriveNodePools', () => {
  const node = (pool: string, extra: Partial<ExportedNode> = {}): ExportedNode => ({
    labels: { 'cloud.google.com/gke-nodepool': pool, zone: 'a' },
    capacity: { cpu: '4', memory: '16Gi', pods: '110' },
    allocatable: { cpu: '3920m', memory: '14Gi', pods: '100' },
    taints: null,
    ...extra,
  })

  it('groups by well-known pool labels and derives machine specs', () => {
    const derived = deriveNodePools([node('main'), node('main'), node('big', { capacity: { cpu: '8', memory: '32Gi', pods: '110' }, allocatable: { cpu: '7910m', memory: '28Gi', pods: '110' } })])
    expect(Object.keys(derived.pools).sort()).toEqual(['big', 'main'])
    const main = derived.pools.main
    expect(main.machine.cpu_m).toBe(4000)
    expect(main.machine.memory_mib).toBe(16384)
    expect(main.machine.reserved_cpu_m).toBe(80)
    expect(main.machine.reserved_memory_mib).toBe(2048)
    expect(main.machine.max_pods).toBe(100)
    expect(main.current_nodes).toBe(2)
    expect(main.min_nodes).toBe(0)
    expect(main.max_nodes).toBe(4)
    expect(derived.warnings.join(' ')).toContain('autoscaler bounds')
  })

  it('falls back through the label list and then to one imported group', () => {
    const eks = node('x', { labels: { 'eks.amazonaws.com/nodegroup': 'workers' } })
    const plain = node('x', { labels: { hostname: 'n1' } })
    const derived = deriveNodePools([eks, plain])
    expect(Object.keys(derived.pools).sort()).toEqual(['imported', 'workers'])
  })
})

describe('applyClusterImport', () => {
  const importedWorkloads = () => {
    const result = transformClusterExport(clusterExport([deployment()]))
    return Object.fromEntries(
      Object.entries(result.workloads).map(([name, workload]) => [name, { ...workload, pool: 'primary' }]),
    )
  }

  it('merge upserts workloads and keeps existing ones', () => {
    const { config: next, counts } = applyClusterImport(config(), { workloads: importedWorkloads(), pools: {} }, 'merge')
    expect(Object.keys(next.workloads).sort()).toEqual(['api', 'demo/web'])
    expect(counts.adds).toEqual(['demo/web'])
    expect(counts.updates).toEqual([])
    expect(counts.removes).toEqual([])
  })

  it('merge pins implicit single-pool workloads once imported pools arrive', () => {
    const pools = deriveNodePools([{ labels: { 'cloud.google.com/gke-nodepool': 'main' }, capacity: { cpu: '4', memory: '16Gi', pods: '110' }, allocatable: { cpu: '4', memory: '16Gi', pods: '110' } }]).pools
    const workloads = Object.fromEntries(
      Object.entries(importedWorkloads()).map(([name, workload]) => [name, { ...workload, pool: 'main' }]),
    )
    const { config: next, counts } = applyClusterImport(config(), { workloads, pools }, 'merge')
    expect(next.workloads.api.pool).toBe('primary')
    expect(counts.poolsCreated).toEqual(['main'])
  })

  it('replace swaps the workload map and reports removals', () => {
    const { config: next, counts } = applyClusterImport(config(), { workloads: importedWorkloads(), pools: {} }, 'replace')
    expect(Object.keys(next.workloads)).toEqual(['demo/web'])
    expect(counts.removes).toEqual(['api'])
    // without created pools the pool map stays untouched
    expect(Object.keys(next.node_pools)).toEqual(['primary'])
  })

  it('carries an absolute maxSurge through the whole import path unscaled', () => {
    const absolute = transformClusterExport(clusterExport([deployment({ maxSurge: 2, replicas: 12 })])).workloads
    for (const mode of ['merge', 'replace'] as const) {
      const { config: next } = applyClusterImport(config(), { workloads: absolute, pools: {} }, mode)
      expect(next.workloads['demo/web'].rollout).toEqual({ max_surge_percent: 25, max_surge_pods: 2 })
      expect(surgeUnitOf(next.workloads['demo/web'].rollout)).toBe('pods')
    }
  })

  it('replace with created pools keeps existing pools still referenced', () => {
    const pools = deriveNodePools([{ labels: { 'cloud.google.com/gke-nodepool': 'main' }, capacity: { cpu: '4', memory: '16Gi', pods: '110' }, allocatable: { cpu: '4', memory: '16Gi', pods: '110' } }]).pools
    const { config: next } = applyClusterImport(config(), { workloads: importedWorkloads(), pools }, 'replace')
    expect(Object.keys(next.node_pools).sort()).toEqual(['main', 'primary'])
  })
})

describe('planClusterImport', () => {
  const nodes: ExportedNode[] = [{
    labels: { 'cloud.google.com/gke-nodepool': 'main', tier: 'fast' },
    capacity: { cpu: '4', memory: '16Gi', pods: '110' },
    allocatable: { cpu: '3920m', memory: '14Gi', pods: '100' },
    taints: null,
  }]

  it('auto-maps selector groups onto matching derived pools', () => {
    const data = clusterExport([deployment({ nodeSelector: { tier: 'fast' } })], nodes)
    const plan = planClusterImport(config(), data, { mode: 'merge', createPools: true, assignments: {} })
    expect(plan.groupPools[selectorKey({ tier: 'fast' })]).toBe('main')
    expect(plan.unassigned).toEqual([])
    expect(plan.config?.workloads['demo/web'].pool).toBe('main')
    expect(plan.counts?.poolsCreated).toEqual(['main'])
  })

  it('leaves unmatched groups for a dropdown and resolves via assignment', () => {
    const data = clusterExport([deployment({ nodeSelector: { tier: 'slow' } })], nodes)
    const open = planClusterImport(config(), data, { mode: 'merge', createPools: true, assignments: {} })
    expect(open.unassigned).toEqual([selectorKey({ tier: 'slow' })])
    expect(open.config).toBeNull()
    const assigned = planClusterImport(config(), data, {
      mode: 'merge',
      createPools: true,
      assignments: { [selectorKey({ tier: 'slow' })]: 'primary' },
    })
    expect(assigned.config?.workloads['demo/web'].pool).toBe('primary')
  })

  it('assigns silently to a sole existing pool when nodes are absent or the toggle is off', () => {
    const data = clusterExport([deployment()], nodes)
    const plan = planClusterImport(config(), data, { mode: 'merge', createPools: false, assignments: {} })
    expect(plan.unassigned).toEqual([])
    expect(plan.config?.workloads['demo/web'].pool).toBe('primary')
    expect(plan.counts?.poolsCreated).toEqual([])
  })

  it('returns no config when the export holds no workloads at all', () => {
    const plan = planClusterImport(config(), clusterExport([]), { mode: 'replace', createPools: true, assignments: {} })
    expect(plan.config).toBeNull()
    expect(plan.warnings.join(' ')).toContain('No importable workloads')
  })
})

describe('parseImport', () => {
  it('round-trips a serialized scenario', () => {
    const original = config()
    const parsed = parseImport(JSON.stringify(serializeScenario(original)))
    expect(parsed).toEqual({ kind: 'scenario', config: original })
  })

  it('rejects a bare config that carries no kind', () => {
    // A document must declare what it is; there is no pre-envelope form.
    const bare = { workloads: config().workloads, node_pools: config().node_pools }
    const parsed = parseImport(JSON.stringify(bare))
    expect(parsed.kind).toBe('error')
    if (parsed.kind !== 'error') return
    expect(parsed.message).toContain('Unrecognized document')
    expect(parsed.message).toContain('kcap-scenario')
    expect(parsed.message).toContain('kcap-cluster-export')
  })

  it('detects cluster exports and rejects unknown versions', () => {
    const parsed = parseImport(JSON.stringify(clusterExport([deployment()])))
    expect(parsed.kind).toBe('cluster')
    const wrong = parseImport(JSON.stringify({ ...clusterExport([]), version: 9 }))
    expect(wrong.kind).toBe('error')
    if (wrong.kind === 'error') expect(wrong.message).toContain('version 9')
  })

  // The rollout surge mode is derived (max_surge_pods != null), never stored, so
  // save/load has to preserve an absolute AND an explicit null verbatim — a
  // dropped or undefined null would silently flip a pods-mode workload back to
  // percent mode.
  it('round-trips both rollout surge modes through save and load', () => {
    const base = config().workloads.api
    const original = config({
      workloads: {
        absolute: { ...base, name: 'absolute', rollout: { max_surge_percent: 25, max_surge_pods: 3 } },
        percentage: { ...base, name: 'percentage', rollout: { max_surge_percent: 40, max_surge_pods: null } },
      },
    })
    const parsed = parseImport(JSON.stringify(serializeScenario(original)))
    expect(parsed.kind).toBe('scenario')
    if (parsed.kind !== 'scenario') return
    const absolute = parsed.config.workloads.absolute.rollout
    const percentage = parsed.config.workloads.percentage.rollout
    expect(absolute).toEqual({ max_surge_percent: 25, max_surge_pods: 3 })
    expect(surgeUnitOf(absolute)).toBe('pods')
    expect(percentage).toEqual({ max_surge_percent: 40, max_surge_pods: null })
    expect('max_surge_pods' in percentage).toBe(true)
    expect(percentage.max_surge_pods).toBeNull()
    expect(surgeUnitOf(percentage)).toBe('%')
    expect(parsed.config).toEqual(original)
  })

  it('reads an omitted max_surge_pods as percent mode', () => {
    // max_surge_pods is optional, and the shipped defaults omit it, so a file
    // saved right now can legitimately arrive without the key.
    const saved = parseImport(JSON.stringify(serializeScenario(config())))
    expect(saved.kind).toBe('scenario')
    if (saved.kind !== 'scenario') return
    const rollout = saved.config.workloads.api.rollout
    expect(rollout.max_surge_percent).toBe(25)
    expect(rollout.max_surge_pods).toBeUndefined()
    expect(surgeUnitOf(rollout)).toBe('%')
  })

  it('rejects every scenario version but the current one (E26)', () => {
    // This branch used to accept any version, so a file from a later kcap was
    // read with today's rules instead of refused. v2 — the scalar observed-usage
    // shape — is now refused too rather than upgraded on load.
    for (const version of [999, 2, 1, 'three', undefined]) {
      const parsed = parseImport(JSON.stringify({ kind: 'kcap-scenario', version, config: config() }))
      expect(parsed.kind).toBe('error')
      if (parsed.kind === 'error') expect(parsed.message).toContain('expected 3')
    }
    expect(parseImport(JSON.stringify(serializeScenario(config()))).kind).toBe('scenario')
    expect(serializeScenario(config()).version).toBe(3)
  })

  it('rejects a scenario envelope whose config has no node pools', () => {
    const envelope = { ...serializeScenario(config()), config: { workloads: config().workloads } }
    expect(parseImport(JSON.stringify(envelope))).toEqual({
      kind: 'error',
      message: 'Scenario config has no node pools.',
    })
  })

  it('produces specific errors for empty, invalid, and unrecognized input', () => {
    expect(parseImport('  ')).toMatchObject({ kind: 'error', message: expect.stringContaining('Nothing to import') })
    expect(parseImport('{nope')).toMatchObject({ kind: 'error', message: expect.stringContaining('Not valid JSON') })
    expect(parseImport('[1, 2]')).toMatchObject({ kind: 'error', message: expect.stringContaining('JSON object') })
    expect(parseImport('{"kind": "mystery"}')).toMatchObject({ kind: 'error', message: expect.stringContaining('Unrecognized document') })
  })
})

describe('buildExportScript', () => {
  it('bakes namespace and selector into the script', () => {
    const script = buildExportScript('payments', 'team=payments')
    expect(script).toContain("NAMESPACE='payments'")
    expect(script).toContain("SELECTOR='team=payments'")
    expect(script).toContain('set -euo pipefail')
    expect(script).toContain('kubectl auth can-i list nodes')
    expect(script).toContain('kcap-export.json')
  })

  it('collects pod metrics behind a graceful guard', () => {
    const script = buildExportScript('', '')
    expect(script).toContain('pods.metrics.k8s.io')
    expect(script).toContain('kubectl auth can-i list pods')
    expect(script).toContain('selector: .spec.selector.matchLabels')
    expect(script).toContain('observed usage will be blank')
  })

  it('defaults to all namespaces and quotes shell metacharacters', () => {
    const script = buildExportScript('', "it's")
    expect(script).toContain("NAMESPACE=''")
    expect(script).toContain('--all-namespaces')
    expect(script).toContain("SELECTOR='it'\\''s'")
  })

  it('bakes the zero-replica policy with a flippable default', () => {
    const on = buildExportScript('', '')
    const off = buildExportScript('', '', false)
    expect(on).toContain('SKIP_ZERO_REPLICAS=1')
    expect(off).toContain('SKIP_ZERO_REPLICAS=0')
    // The gated filter stage and the null-semantics comment ship either way,
    // so a downloaded script flips behavior by editing one variable.
    for (const script of [on, off]) {
      expect(script).toContain('if [ "$SKIP_ZERO_REPLICAS" = "1" ]; then')
      expect(script).toContain('null-replica workloads survive this filter')
      expect(script).toContain('ascii_downcase')
      expect(script).toContain('SKIP_ZERO_REPLICAS=0 keeps them')
    }
  })

  it('bakes the sampling variables, off by default', () => {
    // Gate G3: sampling is opt-in, so a default export takes exactly as long as
    // it did before and carries no peak.
    const script = buildExportScript('', '')
    expect(script).toContain('\nUSAGE_SAMPLES=1\n')
    expect(script).toContain('\nUSAGE_INTERVAL_SECONDS=30\n')
    expect(script).toContain('while [ "$captured" -lt "$USAGE_SAMPLES" ]; do')
    // The version stays 1 — the usage block gains optional keys instead.
    expect(script).toContain('version: 1')
  })
})

// ---------------------------------------------------------------------------
// Export script execution against a stub kubectl. The shim serves raw
// Kubernetes-shaped JSON (the projections run on it). Without KCAP_METRICS_DIR
// it denies every auth can-i, so the node and pod-metrics branches stay quiet;
// with it, pod access is allowed (node access never is) and each
// pods.metrics.k8s.io call is served the next sample file in order, which is
// how a multi-sample capture is exercised without a cluster. Requires bash and
// jq, exactly as the script itself does.
// ---------------------------------------------------------------------------

const KUBECTL_SHIM = `#!/usr/bin/env bash
case "$1" in
  config) echo "stub-context" ;;
  auth)
    if [ -z "\${KCAP_METRICS_DIR:-}" ]; then exit 1; fi
    # "kubectl auth can-i list <resource>": $4 is the resource.
    case "$4" in nodes) exit 1 ;; *) exit 0 ;; esac
    ;;
  get)
    case "$2" in
      pods.metrics.k8s.io)
        served=$(cat "$KCAP_METRICS_DIR/served")
        served=$((served + 1))
        echo "$served" > "$KCAP_METRICS_DIR/served"
        cat "$KCAP_METRICS_DIR/sample-$served.json"
        ;;
      pods) cat "$KCAP_METRICS_DIR/pods.json" ;;
      *) cat "$KCAP_FIXTURE" ;;
    esac
    ;;
  *) exit 1 ;;
esac
`

type ScriptRun = { doc: ClusterExport; stderr: string }
// Raw Kubernetes-shaped metrics: one PodMetrics list per sample, plus the pod
// listing the importer joins them to.
type MetricsFixture = { samples: unknown[][]; pods: unknown[] }

function runExportScript(script: string, items: unknown[], metrics?: MetricsFixture): ScriptRun {
  const dir = mkdtempSync(join(tmpdir(), 'kcap-script-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'kubectl'), KUBECTL_SHIM)
    chmodSync(join(bin, 'kubectl'), 0o755)
    const fixture = join(dir, 'fixture.json')
    writeFileSync(fixture, JSON.stringify({ items }))
    writeFileSync(join(dir, 'export.sh'), script)
    const metricsEnv: Record<string, string> = {}
    if (metrics) {
      const metricsDir = join(dir, 'metrics')
      mkdirSync(metricsDir)
      writeFileSync(join(metricsDir, 'served'), '0')
      writeFileSync(join(metricsDir, 'pods.json'), JSON.stringify({ items: metrics.pods }))
      metrics.samples.forEach((sample, index) => {
        writeFileSync(join(metricsDir, `sample-${index + 1}.json`), JSON.stringify({ items: sample }))
      })
      metricsEnv.KCAP_METRICS_DIR = metricsDir
    }
    const result = spawnSync('bash', ['export.sh'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, PATH: `${bin}:${env.PATH ?? ''}`, KCAP_FIXTURE: fixture, ...metricsEnv },
    })
    if (result.status !== 0) throw new Error(`export script failed (${String(result.status)}): ${result.stderr}`)
    return { doc: JSON.parse(readFileSync(join(dir, 'kcap-export.json'), 'utf8')) as ClusterExport, stderr: result.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function rawWorkload(kind: 'Deployment' | 'StatefulSet', name: string, replicas: number | null): unknown {
  return {
    kind,
    metadata: { namespace: 'default', name },
    spec: {
      ...(replicas === null ? {} : { replicas }),
      selector: { matchLabels: { app: name } },
      template: { spec: { containers: [{ name, resources: { requests: { cpu: '100m', memory: '128Mi' } } }] } },
    },
  }
}

function rawHpa(name: string, targetKind: string, targetName: string): unknown {
  return {
    kind: 'HorizontalPodAutoscaler',
    metadata: { namespace: 'default', name },
    spec: { scaleTargetRef: { kind: targetKind, name: targetName }, minReplicas: 1, maxReplicas: 5 },
  }
}

// Flagger shape plus the edge cases: the original parked at 0 with its stale
// HPA, the generated -primary at 3 whose HPA names a case-differing target
// kind ("deployment" — only the lowercased join can keep it), a null-replicas
// deployment (Kubernetes defaults it to 1 — must survive), and a zero-replica
// StatefulSet with its HPA.
const FLAGGER_FIXTURE = [
  rawWorkload('Deployment', 'myapp', 0),
  rawHpa('myapp', 'Deployment', 'myapp'),
  rawWorkload('Deployment', 'myapp-primary', 3),
  rawHpa('myapp-primary', 'deployment', 'myapp-primary'),
  rawWorkload('Deployment', 'webapp', null),
  rawWorkload('StatefulSet', 'cache', 0),
  rawHpa('cache', 'StatefulSet', 'cache'),
]

function rawPodMetrics(name: string, cpu: string, memory: string): unknown {
  return { metadata: { namespace: 'default', name }, containers: [{ name: 'app', usage: { cpu, memory } }] }
}

// Two pods of `web` whose busiest moments fall in different samples, so the
// per-pod averages (150m, 350m, 400m) separate kcap's peak — the highest of
// them — from the average of each pod's own maximum, which would be 650m.
const METRICS_FIXTURE: MetricsFixture = {
  pods: [
    { metadata: { namespace: 'default', name: 'web-1', labels: { app: 'web' } }, status: { phase: 'Running' } },
    { metadata: { namespace: 'default', name: 'web-2', labels: { app: 'web' } }, status: { phase: 'Running' } },
  ],
  samples: [
    [rawPodMetrics('web-1', '100m', '128Mi'), rawPodMetrics('web-2', '200m', '256Mi')],
    [rawPodMetrics('web-1', '600m', '1024Mi'), rawPodMetrics('web-2', '100m', '128Mi')],
    [rawPodMetrics('web-1', '100m', '128Mi'), rawPodMetrics('web-2', '700m', '1280Mi')],
  ],
}

// Mimics an operator editing the two sampling variables at the top of the
// downloaded script, the way the SKIP_ZERO_REPLICAS test does.
function sampledScript(samples: number, intervalSeconds: number): string {
  return buildExportScript('', '')
    .replace('\nUSAGE_SAMPLES=1\n', `\nUSAGE_SAMPLES=${samples}\n`)
    .replace('\nUSAGE_INTERVAL_SECONDS=30\n', `\nUSAGE_INTERVAL_SECONDS=${intervalSeconds}\n`)
}

describe('export script execution (stub kubectl)', () => {
  let filtered: ScriptRun

  beforeAll(() => {
    filtered = runExportScript(buildExportScript('', ''), FLAGGER_FIXTURE)
  })

  const keptKeys = (run: ScriptRun) => run.doc.workloads.map((item) => `${item.kind}/${item.name}`).sort()

  it('keeps only the Flagger primary pair and reports the skip on stderr', () => {
    expect(filtered.doc.kind).toBe('kcap-cluster-export')
    const kept = keptKeys(filtered)
    expect(kept).toContain('Deployment/myapp-primary')
    expect(kept).toContain('HorizontalPodAutoscaler/myapp-primary')
    expect(kept).not.toContain('Deployment/myapp')
    expect(kept).not.toContain('HorizontalPodAutoscaler/myapp')
    expect(filtered.stderr).toContain('skipped 4 zero-replica workload items')
  })

  it('keeps a null-replicas workload — Kubernetes defaults it to 1', () => {
    expect(keptKeys(filtered)).toContain('Deployment/webapp')
  })

  it('drops a zero StatefulSet and its HPA, joining HPAs on lowercased kind', () => {
    const kept = keptKeys(filtered)
    expect(kept).not.toContain('StatefulSet/cache')
    expect(kept).not.toContain('HorizontalPodAutoscaler/cache')
    // The surviving primary HPA declared its target kind as "deployment":
    // only the ascii_downcase join can have matched it to the Deployment.
    expect(kept).toContain('HorizontalPodAutoscaler/myapp-primary')
  })

  it('captures everything when SKIP_ZERO_REPLICAS is flipped to 0 in the script text', () => {
    // Anchor to the assignment line — the header comment also mentions the
    // variable, and this rewrite mimics an operator editing that one line.
    const script = buildExportScript('', '').replace('\nSKIP_ZERO_REPLICAS=1\n', '\nSKIP_ZERO_REPLICAS=0\n')
    const run = runExportScript(script, FLAGGER_FIXTURE)
    expect(run.doc.workloads).toHaveLength(FLAGGER_FIXTURE.length)
    expect(run.stderr).not.toContain('skipped')
  })

  it('captures one sample by default, as a one-element samples array', () => {
    const run = runExportScript(buildExportScript('', ''), [rawWorkload('Deployment', 'web', 2)], METRICS_FIXTURE)
    // `samples` is the only place usage lives, so a point-in-time capture is a
    // single sample with a zero window. Gate G3 approved sampling off by default.
    expect(Object.keys(run.doc.usage ?? {}).sort()).toEqual(['pods', 'samples', 'window_seconds'])
    expect(run.doc.usage?.samples).toHaveLength(1)
    expect(run.doc.usage?.samples?.[0]).toHaveLength(METRICS_FIXTURE.samples[0].length)
    expect(run.doc.usage?.window_seconds).toBe(0)
    expect(run.stderr).not.toContain('captured usage sample')
    expect(run.stderr).toContain('2 pod metrics in 1 sample(s)')

    // One capture still reads as a snapshot with no peak.
    const workload = transformClusterExport(run.doc).workloads['default/web']
    expect(workload.usage_source).toBe('metrics-server-snapshot')
    expect(workload.observed_cpu_per_pod).toEqual({ avg: 150, p95: null, peak: null })
  })

  it('captures N samples when USAGE_SAMPLES is raised, and each peak clears its average', () => {
    const script = sampledScript(3, 1)
    const run = runExportScript(script, [rawWorkload('Deployment', 'web', 2)], METRICS_FIXTURE)
    expect(run.doc.usage?.samples).toHaveLength(3)
    // Measured, not nominal: two 1-second intervals actually elapsed.
    expect(run.doc.usage?.window_seconds).toBeGreaterThanOrEqual(2)
    expect(run.stderr).toContain('captured usage sample 3 of 3')
    expect(run.stderr).toContain('2 pod metrics in 3 sample(s)')

    const parsed = parseImport(JSON.stringify(run.doc))
    expect(parsed.kind).toBe('cluster')
    if (parsed.kind !== 'cluster') return
    const result = transformClusterExport(parsed.data)
    expect(result.warnings).toEqual([])
    for (const workload of Object.values(result.workloads)) {
      for (const stat of [workload.observed_cpu_per_pod, workload.observed_memory_per_pod]) {
        expect(stat?.peak).not.toBeNull()
        // The engine rejects peak < avg; the same rounding on both is what
        // guarantees this survives the arithmetic.
        expect(stat?.peak ?? 0).toBeGreaterThanOrEqual(stat?.avg ?? 0)
      }
      expect(workload.usage_source).toBe('metrics-server-samples')
    }
    // Per-pod averages of 150m, 350m, 400m across the three samples.
    expect(result.workloads['default/web'].observed_cpu_per_pod).toEqual({ avg: 300, p95: null, peak: 400 })
  }, 20_000)

  it('round-trips the filtered export through the importer with zero warnings', () => {
    const parsed = parseImport(JSON.stringify(filtered.doc))
    expect(parsed.kind).toBe('cluster')
    if (parsed.kind !== 'cluster') return
    const result = transformClusterExport(parsed.data)
    expect(result.warnings).toEqual([])
    expect(Object.keys(result.workloads).sort()).toEqual(['default/myapp-primary', 'default/webapp'])
    expect(result.workloads['default/myapp-primary'].hpa).not.toBeNull()
    expect(result.workloads['default/webapp'].current_replicas).toBe(1)
  })
})
