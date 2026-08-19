import { describe, expect, it } from 'vitest'
import type { ClusterConfig } from './api'
import {
  applyClusterImport,
  buildExportScript,
  deriveNodePools,
  effectiveRequest,
  maxSurgePercent,
  parseCpuQuantity,
  parseImport,
  parseMemoryQuantity,
  planClusterImport,
  selectorKey,
  serializeScenario,
  transformClusterExport,
} from './importers'
import type { ClusterExport, ExportedNode, ExportedUsage, ExportedWorkload } from './importers'

function config(overrides: Partial<ClusterConfig> = {}): ClusterConfig {
  return {
    workloads: {
      api: {
        name: 'api',
        resources: { cpu_request_m: 500, memory_request_mib: 512, cpu_limit_m: null, memory_limit_mib: null },
        current_replicas: 2,
        observed_cpu_per_pod_m: null,
        observed_memory_per_pod_mib: null,
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

describe('maxSurgePercent', () => {
  it('passes percentages through and converts absolutes', () => {
    expect(maxSurgePercent('Deployment', '25%', 4)).toBe(25)
    expect(maxSurgePercent('Deployment', 1, 4)).toBe(25)
    expect(maxSurgePercent('Deployment', '2', 3)).toBe(67)
  })

  it('defaults missing to 25 and StatefulSets to 0', () => {
    expect(maxSurgePercent('Deployment', null, 4)).toBe(25)
    expect(maxSurgePercent('StatefulSet', '50%', 4)).toBe(0)
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
    expect(workload.observed_cpu_per_pod_m).toBeNull()
    expect(workload.observed_memory_per_pod_mib).toBeNull()
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
      metrics: [
        {
          namespace: 'demo',
          name: 'web-1',
          containers: [{ usage: { cpu: '100m', memory: '131072Ki' } }, { usage: { cpu: '50000000n', memory: '64Mi' } }],
        },
        { namespace: 'demo', name: 'web-2', containers: [{ usage: { cpu: '250000000n', memory: '1Gi' } }] },
      ],
    }
    const data = clusterExport([deployment({ selector: { app: 'web' } })], null, usage)
    const workload = transformClusterExport(data).workloads['demo/web']
    // web-1 sums to 150m / 192Mi, web-2 to 250m / 1024Mi -> averages below.
    expect(workload.observed_cpu_per_pod_m).toBe(200)
    expect(workload.observed_memory_per_pod_mib).toBe(608)
    expect(transformClusterExport(data).notes.join(' ')).not.toContain('hold current replicas')
  })

  it('attributes pods by selector and namespace, skipping non-running pods', () => {
    const usage: ExportedUsage = {
      pods: [
        { namespace: 'demo', name: 'web-1', labels: { app: 'web' }, phase: 'Running' },
        { namespace: 'demo', name: 'web-2', labels: { app: 'web' }, phase: 'Pending' },
        { namespace: 'demo', name: 'other-1', labels: { app: 'other' }, phase: 'Running' },
        { namespace: 'prod', name: 'web-1', labels: { app: 'web' }, phase: 'Running' },
      ],
      metrics: [
        { namespace: 'demo', name: 'web-1', containers: [{ usage: { cpu: '100m', memory: '128Mi' } }] },
        { namespace: 'demo', name: 'web-2', containers: [{ usage: { cpu: '900m', memory: '900Mi' } }] },
        { namespace: 'demo', name: 'other-1', containers: [{ usage: { cpu: '300m', memory: '256Mi' } }] },
        { namespace: 'prod', name: 'web-1', containers: [{ usage: { cpu: '900m', memory: '900Mi' } }] },
      ],
    }
    const items = [
      deployment({ selector: { app: 'web' } }),
      deployment({ name: 'other', selector: { app: 'other' } }),
    ]
    const result = transformClusterExport(clusterExport(items, null, usage))
    expect(result.workloads['demo/web'].observed_cpu_per_pod_m).toBe(100)
    expect(result.workloads['demo/web'].observed_memory_per_pod_mib).toBe(128)
    expect(result.workloads['demo/other'].observed_cpu_per_pod_m).toBe(300)
    expect(result.workloads['demo/other'].observed_memory_per_pod_mib).toBe(256)
  })

  it('keeps observed usage null when no pod matches or the selector is absent', () => {
    const usage: ExportedUsage = {
      pods: [{ namespace: 'demo', name: 'other-1', labels: { app: 'other' }, phase: 'Running' }],
      metrics: [{ namespace: 'demo', name: 'other-1', containers: [{ usage: { cpu: '300m', memory: '256Mi' } }] }],
    }
    const items = [deployment({ selector: { app: 'web' } }), deployment({ name: 'bare', selector: null })]
    const result = transformClusterExport(clusterExport(items, null, usage))
    for (const name of ['demo/web', 'demo/bare']) {
      expect(result.workloads[name].observed_cpu_per_pod_m).toBeNull()
      expect(result.workloads[name].observed_memory_per_pod_mib).toBeNull()
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
    expect(result.workloads['demo/web'].observed_cpu_per_pod_m).toBeNull()
    expect(result.workloads['demo/web'].observed_memory_per_pod_mib).toBeNull()
    const notes = result.notes.join(' ')
    expect(notes).toContain('hold current replicas')
    expect(notes).not.toContain('not part of a cluster export')
  })

  it('imports an old export without the usage field cleanly, with nulls', () => {
    const old = { kind: 'kcap-cluster-export', version: 1, workloads: [deployment()], nodes: null }
    const parsed = parseImport(JSON.stringify(old))
    expect(parsed.kind).toBe('cluster')
    if (parsed.kind !== 'cluster') return
    const workload = transformClusterExport(parsed.data).workloads['demo/web']
    expect(workload.observed_cpu_per_pod_m).toBeNull()
    expect(workload.observed_memory_per_pod_mib).toBeNull()
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

  it('accepts a bare config with the legacy node_pool key', () => {
    const legacy = {
      workloads: config().workloads,
      node_pool: config().node_pools.primary,
    }
    const parsed = parseImport(JSON.stringify(legacy))
    expect(parsed.kind).toBe('scenario')
    if (parsed.kind === 'scenario') {
      expect(Object.keys(parsed.config.node_pools)).toEqual(['primary'])
    }
  })

  it('rejects a config carrying both pool keys', () => {
    const both = { workloads: config().workloads, node_pool: config().node_pools.primary, node_pools: config().node_pools }
    const parsed = parseImport(JSON.stringify(both))
    expect(parsed).toEqual({ kind: 'error', message: 'Provide node_pools or the legacy node_pool, not both.' })
  })

  it('detects cluster exports and rejects unknown versions', () => {
    const parsed = parseImport(JSON.stringify(clusterExport([deployment()])))
    expect(parsed.kind).toBe('cluster')
    const wrong = parseImport(JSON.stringify({ ...clusterExport([]), version: 9 }))
    expect(wrong.kind).toBe('error')
    if (wrong.kind === 'error') expect(wrong.message).toContain('version 9')
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
})
