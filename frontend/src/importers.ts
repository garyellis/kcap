import type { ClusterConfig, Hpa, NodePool, Workload } from './api'

// Versioned import/export contract. A future in-cluster discovery endpoint
// will emit the same kcap-cluster-export document and reuse this transform,
// so everything in this module stays pure — no React, no fetch, no DOM.

export const SCENARIO_KIND = 'kcap-scenario'
export const SCENARIO_VERSION = 2
export const CLUSTER_EXPORT_KIND = 'kcap-cluster-export'
export const CLUSTER_EXPORT_VERSION = 1

export type ScenarioEnvelope = {
  kind: typeof SCENARIO_KIND
  version: typeof SCENARIO_VERSION
  exported_at: string
  config: ClusterConfig
}

type Quantity = string | number | null | undefined

type ResourceMap = { cpu?: Quantity; memory?: Quantity }

export type ExportedContainer = {
  resources?: { requests?: ResourceMap | null; limits?: ResourceMap | null } | null
  restartPolicy?: string | null
}

export type ExportedWorkload = {
  kind: string
  namespace: string
  name: string
  replicas?: number | null
  maxSurge?: string | number | null
  containers?: ExportedContainer[] | null
  initContainers?: ExportedContainer[] | null
  // .spec.selector.matchLabels — how the controller finds its pods, and how
  // the importer attributes pod metrics back to the workload.
  selector?: Record<string, string> | null
  nodeSelector?: Record<string, string> | null
  tolerations?: unknown
  nodeAffinity?: unknown
}

export type ExportedPod = {
  namespace: string
  name: string
  labels?: Record<string, string> | null
  phase?: string | null
}

export type ExportedPodUsage = {
  namespace: string
  name: string
  containers?: Array<{ usage?: ResourceMap | null }> | null
}

// PodMetrics carries no labels, so the export pairs it with a pod listing
// ({name, namespace, labels, phase}) that the importer joins on.
export type ExportedUsage = {
  pods?: ExportedPod[] | null
  metrics?: ExportedPodUsage[] | null
}

export type ExportedHpa = {
  kind: 'HorizontalPodAutoscaler'
  namespace: string
  name: string
  target?: { kind?: string | null; name?: string | null } | null
  min?: number | null
  max?: number | null
  metrics?: Array<{ resource?: string | null; target?: number | null }> | null
  targetCPUUtilizationPercentage?: number | null
}

export type ExportedNode = {
  labels?: Record<string, string> | null
  capacity?: ResourceMap & { pods?: Quantity } | null
  allocatable?: ResourceMap & { pods?: Quantity } | null
  taints?: unknown
}

export type ClusterExport = {
  kind: typeof CLUSTER_EXPORT_KIND
  version: typeof CLUSTER_EXPORT_VERSION
  workloads: Array<ExportedWorkload | ExportedHpa>
  nodes: ExportedNode[] | null
  // Added after version 1 shipped; optional so older exports still import.
  usage?: ExportedUsage | null
}

export type ParsedImport =
  | { kind: 'error'; message: string }
  | { kind: 'scenario'; config: ClusterConfig }
  | { kind: 'cluster'; data: ClusterExport }

// ---------------------------------------------------------------------------
// Scenario envelope
// ---------------------------------------------------------------------------

export function serializeScenario(config: ClusterConfig): ScenarioEnvelope {
  return {
    kind: SCENARIO_KIND,
    version: SCENARIO_VERSION,
    exported_at: new Date().toISOString(),
    config: structuredClone(config),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeScenarioConfig(raw: unknown): { config: ClusterConfig } | { error: string } {
  if (!isRecord(raw)) return { error: 'Scenario config must be a JSON object.' }
  if (!isRecord(raw.workloads) || Object.keys(raw.workloads).length === 0) {
    return { error: 'Scenario config has no workloads.' }
  }
  const data = { ...raw }
  if ('node_pool' in data) {
    if ('node_pools' in data) return { error: 'Provide node_pools or the legacy node_pool, not both.' }
    const pool = data.node_pool
    const name = isRecord(pool) && typeof pool.name === 'string' ? pool.name : ''
    if (!name) return { error: 'Legacy node_pool.name is required.' }
    delete data.node_pool
    data.node_pools = { [name]: pool }
  }
  if (!isRecord(data.node_pools) || Object.keys(data.node_pools).length === 0) {
    return { error: 'Scenario config has no node pools.' }
  }
  return { config: data as unknown as ClusterConfig }
}

export function parseImport(text: string): ParsedImport {
  const trimmed = text.trim()
  if (!trimmed) {
    return { kind: 'error', message: 'Nothing to import — paste a kcap scenario or kcap-export.json.' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown parse error'
    return { kind: 'error', message: `Not valid JSON: ${detail}` }
  }
  if (!isRecord(raw)) return { kind: 'error', message: 'Expected a JSON object at the top level.' }

  if (raw.kind === SCENARIO_KIND) {
    const normalized = normalizeScenarioConfig(raw.config)
    if ('error' in normalized) return { kind: 'error', message: normalized.error }
    return { kind: 'scenario', config: normalized.config }
  }
  if (raw.kind === CLUSTER_EXPORT_KIND) {
    if (raw.version !== CLUSTER_EXPORT_VERSION) {
      return { kind: 'error', message: `Unsupported ${CLUSTER_EXPORT_KIND} version ${String(raw.version)} — expected ${CLUSTER_EXPORT_VERSION}.` }
    }
    if (!Array.isArray(raw.workloads)) {
      return { kind: 'error', message: 'Cluster export has no workloads array.' }
    }
    return { kind: 'cluster', data: raw as unknown as ClusterExport }
  }
  // A bare config (possibly pre-envelope, possibly legacy single-pool) is
  // accepted as a scenario.
  if ('workloads' in raw && ('node_pools' in raw || 'node_pool' in raw)) {
    const normalized = normalizeScenarioConfig(raw)
    if ('error' in normalized) return { kind: 'error', message: normalized.error }
    return { kind: 'scenario', config: normalized.config }
  }
  return {
    kind: 'error',
    message: `Unrecognized document — expected kind "${SCENARIO_KIND}", kind "${CLUSTER_EXPORT_KIND}", or a bare cluster config.`,
  }
}

// ---------------------------------------------------------------------------
// Kubernetes quantity parsing
// ---------------------------------------------------------------------------

// Millicores per unit of each CPU suffix. metrics-server reports usage in
// nanocores ("123456789n") or microcores; specs use "m" or bare cores.
const CPU_SUFFIXES: Record<string, number> = { n: 1e-6, u: 1e-3, m: 1 }

// "500m" | "123456789n" | "2" | "0.5" | 2 -> millicores. Rounded up so a
// nonzero request can never collapse to zero.
export function parseCpuQuantity(value: Quantity): number {
  if (value === null || value === undefined || value === '') return 0
  let amount: number
  if (typeof value === 'number') {
    amount = value * 1000
  } else {
    const match = value.trim().match(/^([0-9.eE+-]+)(n|u|m)?$/)
    if (!match) return 0
    const parsed = Number(match[1])
    if (!Number.isFinite(parsed)) return 0
    amount = parsed * (match[2] ? CPU_SUFFIXES[match[2]] : 1000)
  }
  if (amount <= 0) return 0
  return Math.ceil(amount)
}

const MEMORY_SUFFIXES: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
}

// "512Mi" | "1G" | "128974848" | "129e6" | number-of-bytes -> MiB. Rounded up
// with a floor of 1 so a nonzero request never collapses to zero.
export function parseMemoryQuantity(value: Quantity): number {
  if (value === null || value === undefined || value === '') return 0
  let bytes: number
  if (typeof value === 'number') {
    bytes = value
  } else {
    const match = value.trim().match(/^([0-9.eE+-]+)(Ki|Mi|Gi|Ti|Pi|k|M|G|T|P)?$/)
    if (!match) return 0
    const amount = Number(match[1])
    if (!Number.isFinite(amount)) return 0
    bytes = amount * (match[2] ? MEMORY_SUFFIXES[match[2]] : 1)
  }
  if (bytes <= 0) return 0
  return Math.max(1, Math.ceil(bytes / 1024 ** 2))
}

// ---------------------------------------------------------------------------
// Workload transform
// ---------------------------------------------------------------------------

function containerRequest(container: ExportedContainer, resource: 'cpu' | 'memory'): number {
  const parse = resource === 'cpu' ? parseCpuQuantity : parseMemoryQuantity
  // Kubernetes defaults a missing request to the container's limit.
  return parse(container.resources?.requests?.[resource]) || parse(container.resources?.limits?.[resource])
}

// Kubernetes effective request: regular containers run together and sum.
// Init containers run one at a time before them, so the largest one can still
// dominate — except native sidecars (restartPolicy Always), which keep running
// and therefore count into the sum instead.
export function effectiveRequest(
  containers: ExportedContainer[],
  initContainers: ExportedContainer[],
  resource: 'cpu' | 'memory',
): number {
  let sum = 0
  let initMax = 0
  for (const container of containers) sum += containerRequest(container, resource)
  for (const container of initContainers) {
    const request = containerRequest(container, resource)
    if (container.restartPolicy === 'Always') sum += request
    else initMax = Math.max(initMax, request)
  }
  return Math.max(sum, initMax)
}

// null renders as the limit toggle switched off. Any container without the
// limit leaves the pod unbounded at runtime, so partial limits are null too.
// The container set matches effectiveRequest — regular containers plus native
// sidecars — so a Guaranteed pod with a sidecar cannot import with its request
// (which counts the sidecar) above its limit (which used to skip it), and it
// takes the same max with plain init containers that effectiveRequest takes.
function summedLimit(
  containers: ExportedContainer[],
  initContainers: ExportedContainer[],
  resource: 'cpu' | 'memory',
): number | null {
  const parse = resource === 'cpu' ? parseCpuQuantity : parseMemoryQuantity
  let total = 0
  let initMax = 0
  for (const container of containers) {
    const parsed = parse(container.resources?.limits?.[resource])
    if (parsed <= 0) return null
    total += parsed
  }
  for (const container of initContainers) {
    const parsed = parse(container.resources?.limits?.[resource])
    if (container.restartPolicy === 'Always') {
      if (parsed <= 0) return null
      total += parsed
      continue
    }
    // A plain init container counts toward the pod limit exactly as far as it
    // counts toward the pod request, because a limit below the request imported
    // beside it is incoherent (the engine rejects the pair). So a declared
    // limit joins the max; a declared request with no limit is a genuinely
    // unbounded phase and nulls the limit; declaring neither leaves the pod's
    // limits alone, since such a container cannot dominate the request either.
    if (parsed > 0) initMax = Math.max(initMax, parsed)
    else if (containerRequest(container, resource) > 0) return null
  }
  const limit = Math.max(total, initMax)
  return limit > 0 ? limit : null
}

// The Kubernetes default for an unset RollingUpdate maxSurge.
const DEFAULT_MAX_SURGE_PERCENT = 25

export type ImportedRollout = { max_surge_percent: number; max_surge_pods: number | null }

// Kubernetes never rescales an absolute maxSurge, so neither does kcap.
// Verified at kubernetes/kubernetes v1.33.0:
//   pkg/controller/deployment/util/deployment_util.go — MaxSurge() calls
//   ResolveFenceposts(), which calls
//   intstrutil.GetScaledValueFromIntOrPercent(maxSurge, int(desired), true);
//   staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr.go — that function
//   returns an Int value unscaled, and only scales a "N%" string
//   (value * total / 100, rounded up).
// So an integer maxSurge imports as an absolute pod count (max_surge_pods) and a
// percent string imports as a percentage (max_surge_percent). Scaling the
// absolute against replicas here used to inflate it, because kcap applies the
// percentage at the HPA maximum rather than at the workload's current replicas.
export function rolloutFromMaxSurge(kind: string, maxSurge: string | number | null | undefined): ImportedRollout {
  // A StatefulSet RollingUpdate replaces pods in place — no surge. kcap keeps
  // expressing that as 0%, with max_surge_pods left null, so the workload still
  // imports in the UI's percent mode and existing scenario files are unchanged.
  if (kind === 'StatefulSet') return { max_surge_percent: 0, max_surge_pods: null }
  const fallback: ImportedRollout = { max_surge_percent: DEFAULT_MAX_SURGE_PERCENT, max_surge_pods: null }
  if (maxSurge === null || maxSurge === undefined || maxSurge === '') return fallback
  if (typeof maxSurge === 'string' && maxSurge.endsWith('%')) {
    const percent = Number(maxSurge.slice(0, -1))
    // Negative and non-numeric percentages are not valid Kubernetes values and
    // the schema rejects them (ge=0), so they fall back to the default.
    return Number.isFinite(percent) && percent >= 0 ? { max_surge_percent: percent, max_surge_pods: null } : fallback
  }
  const absolute = Number(maxSurge)
  if (!Number.isFinite(absolute) || absolute < 0) return fallback
  // The percentage stays at its default and inert: max_surge_pods takes
  // precedence in the engine, including at 0.
  return { max_surge_percent: DEFAULT_MAX_SURGE_PERCENT, max_surge_pods: Math.round(absolute) }
}

// Sum container usage per pod, then average across the running pods the
// workload's selector matches in its namespace. PodMetrics has no labels, so
// the pod listing carries the attribution. null when the export has no usage
// data (older script, metrics-server absent) or nothing matched.
export function observedUsage(
  item: ExportedWorkload,
  usage: ExportedUsage | null | undefined,
): { cpu_m: number; memory_mib: number } | null {
  const selector = item.selector
  if (!usage?.pods || !usage.metrics || !selector || Object.keys(selector).length === 0) return null
  const metricsByPod = new Map<string, ExportedPodUsage>()
  for (const metric of usage.metrics) metricsByPod.set(`${metric.namespace}/${metric.name}`, metric)
  let pods = 0
  let cpu = 0
  let memory = 0
  for (const pod of usage.pods) {
    if (pod.namespace !== item.namespace) continue
    if (pod.phase && pod.phase !== 'Running') continue
    const labels = pod.labels ?? {}
    if (!Object.entries(selector).every(([key, value]) => labels[key] === value)) continue
    const metric = metricsByPod.get(`${pod.namespace}/${pod.name}`)
    if (!metric) continue
    pods += 1
    for (const container of metric.containers ?? []) {
      cpu += parseCpuQuantity(container.usage?.cpu)
      memory += parseMemoryQuantity(container.usage?.memory)
    }
  }
  if (pods === 0) return null
  return { cpu_m: Math.round(cpu / pods), memory_mib: Math.round(memory / pods) }
}

export type SelectorGroup = {
  key: string
  selector: Record<string, string> | null
  workloads: string[]
}

export const UNPINNED_GROUP = 'unpinned'

export function selectorKey(selector: Record<string, string> | null | undefined): string {
  if (!selector || Object.keys(selector).length === 0) return UNPINNED_GROUP
  const entries = Object.entries(selector).sort(([a], [b]) => (a < b ? -1 : 1))
  return JSON.stringify(Object.fromEntries(entries))
}

export type TransformResult = {
  workloads: Record<string, Workload>
  groups: SelectorGroup[]
  // Workloads whose export carried no request for a resource, keyed by how
  // the gap was filled: values kept from the current config, or the
  // BestEffort floor (1m / 1 MiB — a pod slot with no reserved capacity).
  carried: string[]
  bestEffort: string[]
  warnings: string[]
  notes: string[]
}

function isExportedHpa(item: ExportedWorkload | ExportedHpa): item is ExportedHpa {
  return item.kind === 'HorizontalPodAutoscaler'
}

// namespace/name is unique per kind, not per namespace, so a Deployment and a
// StatefulSet of the same name would silently overwrite each other. Colliding
// names get the kind appended; every other key stays as it was, which keeps
// existing configs and the carry-forward lookup working.
function kindsByWorkloadKey(items: Array<ExportedWorkload | ExportedHpa>): Map<string, string[]> {
  const kinds = new Map<string, string[]>()
  for (const item of items) {
    if (isExportedHpa(item)) continue
    const key = `${item.namespace}/${item.name}`
    kinds.set(key, [...(kinds.get(key) ?? []), item.kind])
  }
  return kinds
}

function toHpa(hpa: ExportedHpa): Hpa {
  let cpu: number | null = null
  let memory: number | null = null
  for (const metric of hpa.metrics ?? []) {
    if (metric.target === null || metric.target === undefined || metric.target <= 0) continue
    if (metric.resource === 'cpu') cpu = metric.target
    if (metric.resource === 'memory') memory = metric.target
  }
  // autoscaling/v1 exposes only a CPU utilization target.
  const v1Target = hpa.targetCPUUtilizationPercentage
  if (cpu === null && v1Target !== null && v1Target !== undefined && v1Target > 0) cpu = v1Target
  const min = hpa.min ?? 1
  return {
    min_replicas: min,
    max_replicas: hpa.max ?? Math.max(1, min),
    cpu_target_percentage: cpu,
    memory_target_percentage: memory,
  }
}

export function transformClusterExport(
  data: ClusterExport,
  existing?: Record<string, Workload>,
): TransformResult {
  const workloads: Record<string, Workload> = {}
  const groups = new Map<string, SelectorGroup>()
  const carried: string[] = []
  const bestEffort: string[] = []
  const warnings: string[] = []
  const notes: string[] = []

  const hpas = data.workloads.filter(isExportedHpa)
  const hpaByTarget = new Map<string, ExportedHpa>()
  for (const hpa of hpas) {
    const target = hpa.target ?? {}
    hpaByTarget.set(`${hpa.namespace}/${(target.kind ?? '').toLowerCase()}/${target.name ?? ''}`, hpa)
  }
  const matchedHpas = new Set<ExportedHpa>()

  const kindsByKey = kindsByWorkloadKey(data.workloads)
  const collidingKeys = new Set<string>()
  for (const [key, kinds] of kindsByKey) {
    if (kinds.length < 2) continue
    collidingKeys.add(key)
    warnings.push(
      `${key} exists as ${kinds.join(' and ')} — imported as separate workloads with the kind appended.`,
    )
  }

  for (const item of data.workloads) {
    if (isExportedHpa(item)) continue
    const name = `${item.namespace}/${item.name}`
    const key = collidingKeys.has(name) ? `${name} (${item.kind.toLowerCase()})` : name
    const containers = item.containers ?? []
    const initContainers = item.initContainers ?? []
    // Request fallback chain, most real first: the export (requests, or limits
    // via the Kubernetes request := limit default) → the value already
    // configured in kcap for this name → the BestEffort floor. Kubernetes
    // schedules a requestless pod as if free; it still takes a pod slot.
    let wasCarried = false
    let wasFloored = false
    const request = (resource: 'cpu' | 'memory'): number => {
      const fromExport = effectiveRequest(containers, initContainers, resource)
      if (fromExport > 0) return fromExport
      const resources = existing?.[key]?.resources
      const current = resource === 'cpu' ? resources?.cpu_request_m : resources?.memory_request_mib
      if (current !== null && current !== undefined && current > 0) {
        wasCarried = true
        return current
      }
      wasFloored = true
      return 1
    }
    const cpu = request('cpu')
    const memory = request('memory')
    if (wasCarried) carried.push(key)
    if (wasFloored) bestEffort.push(key)
    const replicas = item.replicas ?? 1
    const hpa = hpaByTarget.get(`${item.namespace}/${item.kind.toLowerCase()}/${item.name}`)
    if (hpa) matchedHpas.add(hpa)
    const observed = observedUsage(item, data.usage)
    workloads[key] = {
      name: key,
      resources: {
        cpu_request_m: cpu,
        memory_request_mib: memory,
        cpu_limit_m: summedLimit(containers, initContainers, 'cpu'),
        memory_limit_mib: summedLimit(containers, initContainers, 'memory'),
      },
      current_replicas: replicas,
      observed_cpu_per_pod_m: observed?.cpu_m ?? null,
      observed_memory_per_pod_mib: observed?.memory_mib ?? null,
      hpa: hpa ? toHpa(hpa) : null,
      rollout: rolloutFromMaxSurge(item.kind, item.maxSurge),
      pool: null,
    }
    const selector = item.nodeSelector && Object.keys(item.nodeSelector).length > 0 ? item.nodeSelector : null
    const groupKey = selectorKey(selector)
    const group = groups.get(groupKey) ?? { key: groupKey, selector, workloads: [] }
    group.workloads.push(key)
    groups.set(groupKey, group)
  }

  for (const hpa of hpas) {
    if (!matchedHpas.has(hpa)) {
      const target = hpa.target ?? {}
      warnings.push(
        `HPA ${hpa.namespace}/${hpa.name} targets ${target.kind ?? '?'}/${target.name ?? '?'}, which is not in this export — dropped.`,
      )
    }
  }
  const blankHpaWorkloads = Object.values(workloads).filter(
    (workload) => workload.hpa !== null && workload.observed_cpu_per_pod_m === null && workload.observed_memory_per_pod_mib === null,
  )
  if (blankHpaWorkloads.length > 0) {
    notes.push(
      data.usage
        ? 'Some HPA workloads matched no pod metrics, so their scenarios hold current replicas until you fill in observed usage.'
        : 'This export carries no pod metrics (metrics-server unavailable, or an older export script), so HPA scenarios hold current replicas until you fill in observed usage.',
    )
  }
  if (Object.values(workloads).some((workload) => workload.observed_cpu_per_pod_m !== null || workload.observed_memory_per_pod_mib !== null)) {
    notes.push('Observed per-pod usage is a point-in-time average from pod metrics captured at export time.')
  }
  return { workloads, groups: [...groups.values()], carried, bestEffort, warnings, notes }
}

// ---------------------------------------------------------------------------
// Node pool derivation
// ---------------------------------------------------------------------------

export const POOL_LABELS = [
  'cloud.google.com/gke-nodepool',
  'eks.amazonaws.com/nodegroup',
  'kubernetes.azure.com/agentpool',
  'node.kubernetes.io/instance-type',
]

export type DerivedPools = {
  pools: Record<string, NodePool>
  labels: Record<string, Record<string, string>>
  warnings: string[]
  notes: string[]
}

function intersectLabels(maps: Array<Record<string, string>>): Record<string, string> {
  const [first, ...rest] = maps
  const shared: Record<string, string> = {}
  for (const [key, value] of Object.entries(first ?? {})) {
    if (rest.every((labels) => labels[key] === value)) shared[key] = value
  }
  return shared
}

export function deriveNodePools(nodes: ExportedNode[]): DerivedPools {
  const byPool = new Map<string, ExportedNode[]>()
  for (const node of nodes) {
    const nodeLabels = node.labels ?? {}
    const poolLabel = POOL_LABELS.find((label) => nodeLabels[label])
    const name = poolLabel ? nodeLabels[poolLabel] : 'imported'
    byPool.set(name, [...(byPool.get(name) ?? []), node])
  }

  const pools: Record<string, NodePool> = {}
  const labels: Record<string, Record<string, string>> = {}
  const warnings: string[] = []
  const notes: string[] = []
  for (const [name, members] of byPool) {
    const first = members[0]
    const cpu = parseCpuQuantity(first.capacity?.cpu)
    const memory = parseMemoryQuantity(first.capacity?.memory)
    if (cpu <= 0 || memory <= 0) {
      warnings.push(`Node pool ${name} reports no usable capacity — skipped.`)
      continue
    }
    const allocatableCpu = parseCpuQuantity(first.allocatable?.cpu)
    const allocatableMemory = parseMemoryQuantity(first.allocatable?.memory)
    const maxPods = Number(first.allocatable?.pods ?? 0) || 110
    pools[name] = {
      name,
      machine: {
        cpu_m: cpu,
        memory_mib: memory,
        reserved_cpu_m: Math.max(0, cpu - allocatableCpu),
        reserved_memory_mib: Math.max(0, memory - allocatableMemory),
        max_pods: maxPods,
      },
      min_nodes: 0,
      current_nodes: members.length,
      max_nodes: members.length * 2,
    }
    labels[name] = intersectLabels(members.map((member) => member.labels ?? {}))
  }
  if (Object.keys(pools).length > 0) {
    // capacity − allocatable covers system/kube reserve and eviction
    // thresholds, but DaemonSet pods are not part of allocatable math.
    notes.push('Reserved capacity is capacity − allocatable per node — a floor that does not include DaemonSet overhead.')
    warnings.push('max_nodes defaulted to 2× current nodes — set your cluster autoscaler bounds.')
  }
  return { pools, labels, warnings, notes }
}

export function matchSelectorToPools(
  selector: Record<string, string>,
  poolLabels: Record<string, Record<string, string>>,
): string[] {
  return Object.keys(poolLabels).filter((pool) =>
    Object.entries(selector).every(([key, value]) => poolLabels[pool][key] === value),
  )
}

// ---------------------------------------------------------------------------
// Merge / replace application
// ---------------------------------------------------------------------------

export type ApplyCounts = {
  adds: string[]
  updates: string[]
  removes: string[]
  poolsCreated: string[]
}

export function applyClusterImport(
  current: ClusterConfig,
  imported: { workloads: Record<string, Workload>; pools: Record<string, NodePool> },
  mode: 'merge' | 'replace',
): { config: ClusterConfig; counts: ApplyCounts } {
  const importedNames = Object.keys(imported.workloads)
  const adds = importedNames.filter((name) => !(name in current.workloads))
  const updates = importedNames.filter((name) => name in current.workloads)
  const poolsCreated = Object.keys(imported.pools).filter((name) => !(name in current.node_pools))

  if (mode === 'merge') {
    const node_pools = { ...current.node_pools, ...imported.pools }
    let workloads = { ...current.workloads, ...imported.workloads }
    // Implicit single-pool assignments become explicit before imported pools
    // make them ambiguous (mirrors adding a pool by hand).
    const soleName = Object.keys(current.node_pools).length === 1 ? Object.keys(current.node_pools)[0] : null
    if (soleName && Object.keys(node_pools).length > 1) {
      workloads = Object.fromEntries(
        Object.entries(workloads).map(([name, workload]) => [
          name,
          workload.pool === null ? { ...workload, pool: soleName } : workload,
        ]),
      )
    }
    return { config: { workloads, node_pools }, counts: { adds, updates, removes: [], poolsCreated } }
  }

  const removes = Object.keys(current.workloads).filter((name) => !(name in imported.workloads))
  let node_pools: Record<string, NodePool>
  if (Object.keys(imported.pools).length > 0) {
    // Swap to the created pools, but keep any existing pool an imported
    // workload was explicitly assigned to.
    node_pools = { ...imported.pools }
    for (const name of importedNames) {
      const pool = imported.workloads[name].pool
      if (pool !== null && !(pool in node_pools) && current.node_pools[pool]) {
        node_pools[pool] = current.node_pools[pool]
      }
    }
  } else {
    node_pools = current.node_pools
  }
  return {
    config: { workloads: { ...imported.workloads }, node_pools },
    counts: { adds, updates, removes, poolsCreated },
  }
}

export type ClusterImportOptions = {
  mode: 'merge' | 'replace'
  createPools: boolean
  assignments: Record<string, string>
}

export type ClusterImportPlan = {
  transform: TransformResult
  derived: DerivedPools | null
  groupPools: Record<string, string | null>
  unassigned: string[]
  poolChoices: string[]
  config: ClusterConfig | null
  counts: ApplyCounts | null
  warnings: string[]
  notes: string[]
}

export function planClusterImport(
  current: ClusterConfig,
  data: ClusterExport,
  options: ClusterImportOptions,
): ClusterImportPlan {
  const transform = transformClusterExport(data, current.workloads)
  const derived = options.createPools && data.nodes !== null && data.nodes.length > 0 ? deriveNodePools(data.nodes) : null
  const created = derived ? Object.keys(derived.pools) : []
  const existing = Object.keys(current.node_pools)
  const poolChoices = [...created, ...existing.filter((name) => !created.includes(name))]

  const groupPools: Record<string, string | null> = {}
  const unassigned: string[] = []
  for (const group of transform.groups) {
    const assigned = options.assignments[group.key]
    if (assigned && poolChoices.includes(assigned)) {
      groupPools[group.key] = assigned
      continue
    }
    if (derived && group.selector) {
      const matches = matchSelectorToPools(group.selector, derived.labels)
      if (matches.length === 1) {
        groupPools[group.key] = matches[0]
        continue
      }
    }
    if (poolChoices.length === 1) {
      groupPools[group.key] = poolChoices[0]
      continue
    }
    groupPools[group.key] = null
    unassigned.push(group.key)
  }

  const warnings = [...transform.warnings, ...(derived?.warnings ?? [])]
  const notes = [...transform.notes, ...(derived?.notes ?? [])]
  const base = { transform, derived, groupPools, unassigned, poolChoices, warnings, notes }
  if (Object.keys(transform.workloads).length === 0) {
    warnings.push('No importable workloads found in this export.')
    return { ...base, config: null, counts: null }
  }
  if (unassigned.length > 0) return { ...base, config: null, counts: null }

  const workloads: Record<string, Workload> = {}
  for (const group of transform.groups) {
    for (const name of group.workloads) {
      workloads[name] = { ...transform.workloads[name], pool: groupPools[group.key] }
    }
  }
  const { config, counts } = applyClusterImport(current, { workloads, pools: derived?.pools ?? {} }, options.mode)
  return { ...base, config, counts }
}

// ---------------------------------------------------------------------------
// Cluster export script
// ---------------------------------------------------------------------------

// jq builds the output object from named fields, so nothing outside this
// whitelist (env, images, annotations, secrets) can reach the export.
const WORKLOAD_PROJECTION = `[
    .items[]
    | if .kind == "HorizontalPodAutoscaler" then
        {
          kind,
          namespace: .metadata.namespace,
          name: .metadata.name,
          target: { kind: .spec.scaleTargetRef.kind, name: .spec.scaleTargetRef.name },
          min: .spec.minReplicas,
          max: .spec.maxReplicas,
          metrics: [
            (.spec.metrics // [])[]
            | select(.type == "Resource")
            | { resource: .resource.name, target: .resource.target.averageUtilization }
          ],
          targetCPUUtilizationPercentage: .spec.targetCPUUtilizationPercentage
        }
      else
        {
          kind,
          namespace: .metadata.namespace,
          name: .metadata.name,
          replicas: .spec.replicas,
          maxSurge: .spec.strategy.rollingUpdate.maxSurge,
          containers: [(.spec.template.spec.containers // [])[] | { resources }],
          initContainers: [(.spec.template.spec.initContainers // [])[] | { resources, restartPolicy }],
          selector: .spec.selector.matchLabels,
          nodeSelector: .spec.template.spec.nodeSelector,
          tolerations: .spec.template.spec.tolerations,
          nodeAffinity: .spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
        }
      end
  ]`

// Two-pass join over the projected workload array: pass 1 collects kept
// workload identities, pass 2 keeps workloads in that set plus HPAs whose
// scaleTargetRef resolves into it — the same namespace/kind-lowercased/name
// key the importer's hpaByTarget join uses (with // "" mirroring its
// target.kind ?? '' guards). NOTE: spec.replicas null means 1 in Kubernetes,
// and jq's \`null != 0\` is true, so null-replica workloads are deliberately
// KEPT — only an explicit 0 is filtered.
const ZERO_REPLICA_FILTER = `([
      .[]
      | select(.kind != "HorizontalPodAutoscaler" and .replicas != 0)
      | { key: "\\(.namespace)/\\(.kind | ascii_downcase)/\\(.name)", value: true }
    ] | from_entries) as $kept
    | map(select(
        if .kind == "HorizontalPodAutoscaler"
        then $kept["\\(.namespace)/\\((.target.kind // "") | ascii_downcase)/\\(.target.name // "")"] == true
        else .replicas != 0
        end
      ))`

const NODE_PROJECTION = `[
    .items[]
    | {
        labels: .metadata.labels,
        capacity: { cpu: .status.capacity.cpu, memory: .status.capacity.memory, pods: .status.capacity.pods },
        allocatable: { cpu: .status.allocatable.cpu, memory: .status.allocatable.memory, pods: .status.allocatable.pods },
        taints: .spec.taints
      }
  ]`

// PodMetrics carries no labels, so a parallel pod listing provides them for
// workload attribution. Both stay whitelist projections.
const POD_PROJECTION = `[
    .items[]
    | {
        namespace: .metadata.namespace,
        name: .metadata.name,
        labels: .metadata.labels,
        phase: .status.phase
      }
  ]`

const POD_METRICS_PROJECTION = `[
    .items[]
    | {
        namespace: .metadata.namespace,
        name: .metadata.name,
        containers: [(.containers // [])[] | { usage: { cpu: .usage.cpu, memory: .usage.memory } }]
      }
  ]`

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildExportScript(namespace: string, selector: string, skipZeroReplicas = true): string {
  return `#!/usr/bin/env bash
# kcap cluster export
#
# Reads only what kcap needs to model capacity:
#   - workload names, replica counts, container resource requests/limits
#   - HPA specs (targets, min/max replicas)
#   - scheduling constraints (nodeSelector, tolerations, required node affinity)
#   - node capacity, allocatable, labels, and taints (when permitted)
#   - pod names, labels, and CPU/memory usage from metrics-server (when available)
# It does NOT read env vars, images, annotations, or secrets.
# Zero-replica workloads and their HPAs are dropped when SKIP_ZERO_REPLICAS=1.
#
# Writes kcap-export.json for the kcap import dialog.
set -euo pipefail

NAMESPACE=${shellQuote(namespace.trim())}
SELECTOR=${shellQuote(selector.trim())}
# Deployments/StatefulSets at spec.replicas 0 (progressive-delivery shells like
# Flagger originals) and the HPAs targeting them are dropped from the export.
# Set to 0 to capture zero-replica workloads and their HPAs too.
SKIP_ZERO_REPLICAS=${skipZeroReplicas ? '1' : '0'}

echo "cluster context: $(kubectl config current-context)" >&2

scope=(--all-namespaces)
if [ -n "$NAMESPACE" ]; then
  scope=(--namespace "$NAMESPACE")
fi
if [ -n "$SELECTOR" ]; then
  scope+=(--selector "$SELECTOR")
fi

workloads=$(kubectl get deployments,statefulsets,horizontalpodautoscalers "\${scope[@]}" -o json | jq '${WORKLOAD_PROJECTION}')

# spec.replicas null means 1 in Kubernetes (and jq's null != 0 is true), so
# null-replica workloads survive this filter — only an explicit 0 is dropped.
if [ "$SKIP_ZERO_REPLICAS" = "1" ]; then
  before=$(jq 'length' <<<"$workloads")
  workloads=$(jq '${ZERO_REPLICA_FILTER}' <<<"$workloads")
  echo "skipped $((before - $(jq 'length' <<<"$workloads"))) zero-replica workload items (workloads at 0 and their HPAs; SKIP_ZERO_REPLICAS=0 keeps them)" >&2
fi

if kubectl auth can-i list nodes >/dev/null 2>&1; then
  nodes=$(kubectl get nodes -o json | jq '${NODE_PROJECTION}')
else
  echo "no node access — pools will not be auto-created" >&2
  nodes=null
fi

# Pods and their metrics attribute observed usage to workloads. The selector
# does not apply here: workloads are matched to pods by matchLabels on import.
podscope=(--all-namespaces)
if [ -n "$NAMESPACE" ]; then
  podscope=(--namespace "$NAMESPACE")
fi

usage=null
if kubectl auth can-i list pods "\${podscope[@]}" >/dev/null 2>&1 \\
  && kubectl auth can-i list pods.metrics.k8s.io "\${podscope[@]}" >/dev/null 2>&1 \\
  && metrics=$(kubectl get pods.metrics.k8s.io "\${podscope[@]}" -o json 2>/dev/null | jq '${POD_METRICS_PROJECTION}'); then
  pods=$(kubectl get pods "\${podscope[@]}" -o json | jq '${POD_PROJECTION}')
  usage=$(jq -n --argjson pods "$pods" --argjson metrics "$metrics" '{ pods: $pods, metrics: $metrics }')
else
  echo "no pod metrics (metrics-server missing or not permitted) — observed usage will be blank" >&2
fi

jq -n --argjson workloads "$workloads" --argjson nodes "$nodes" --argjson usage "$usage" \\
  '{ kind: "kcap-cluster-export", version: 1, workloads: $workloads, nodes: $nodes, usage: $usage }' \\
  > kcap-export.json

echo "wrote kcap-export.json: $(jq -r '.workloads | length' kcap-export.json) workload items, $(jq -r 'if .nodes == null then "no" else (.nodes | length) end' kcap-export.json) nodes, $(jq -r 'if .usage == null then "no" else (.usage.metrics | length) end' kcap-export.json) pod metrics" >&2
`
}
