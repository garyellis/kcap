export type Resources = {
  cpu_request_m: number
  memory_request_mib: number
  cpu_limit_m: number | null
  memory_limit_mib: number | null
}

export type Hpa = {
  min_replicas: number
  max_replicas: number
  cpu_target_percentage: number | null
  memory_target_percentage: number | null
}

export type Workload = {
  name: string
  resources: Resources
  current_replicas: number
  observed_cpu_per_pod_m: number | null
  observed_memory_per_pod_mib: number | null
  hpa: Hpa | null
  rollout: { max_surge_percent: number }
  pool: string | null
}

export type NodePool = {
  name: string
  machine: {
    cpu_m: number
    memory_mib: number
    reserved_cpu_m: number
    reserved_memory_mib: number
    max_pods: number
  }
  min_nodes: number
  current_nodes: number
  max_nodes: number
}

export type ClusterConfig = {
  workloads: Record<string, Workload>
  node_pools: Record<string, NodePool>
}

export type WorkloadResult = {
  name: string
  cpu_utilization_percent: number | null
  memory_utilization_percent: number | null
  current_replicas: number
  raw_desired_replicas: number
  desired_replicas: number
  hpa_saturated: boolean
  max_replicas: number
  rollout_replicas_at_max: number
}

export type PoolScenarioResult = {
  pool: string
  pod_count: number
  cpu_requested_m: number
  memory_requested_mib: number
  capacity_cpu_m: number
  capacity_memory_mib: number
  stranded_cpu_m: number
  stranded_memory_mib: number
  nodes_required: number
  effective_nodes_required: number
  current_nodes: number
  nodes_to_add: number
  nodes_to_remove: number
  node_headroom: number
  limiting_resource: string
  schedulable: boolean
  oversized_pod_count: number
  pods_per_node: number | null
  fragmentation_resource: string | null
}

export type ScenarioResult = {
  name: string
  replicas: Record<string, number>
  pod_count: number
  cpu_requested_m: number
  memory_requested_mib: number
  nodes_required: number
  effective_nodes_required: number
  current_nodes: number
  nodes_to_add: number
  nodes_to_remove: number
  schedulable: boolean
  oversized_pod_count: number
  pools: Record<string, PoolScenarioResult>
}

export type ClusterResult = {
  workloads: Record<string, WorkloadResult>
  scenarios: Record<string, ScenarioResult>
}

export type ValueChange = {
  before: number
  after: number
  delta: number
}

export type ScenarioDiff = {
  pod_count: ValueChange
  cpu_requested_m: ValueChange
  memory_requested_mib: ValueChange
  nodes_required: ValueChange
  effective_nodes_required: ValueChange
  current_nodes: ValueChange
  nodes_to_add: ValueChange
  nodes_to_remove: ValueChange
  schedulable_before: boolean
  schedulable_after: boolean
}

export type CompareResponse = {
  baseline_result: ClusterResult
  candidate_result: ClusterResult
  configuration_diff: {
    changes: Record<string, { before: unknown; after: unknown }>
    workloads_added: string[]
    workloads_removed: string[]
    node_pools_added: string[]
    node_pools_removed: string[]
  }
  impact_diff: {
    workloads: Record<string, Record<string, ValueChange>>
    scenarios: Record<string, ScenarioDiff>
  }
}

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

type ApiError = {
  detail?: string | Array<{ msg: string; loc?: Array<string | number> }>
}

async function errorMessage(response: Response): Promise<string> {
  const error = (await response.json().catch(() => null)) as ApiError | null
  if (Array.isArray(error?.detail)) {
    return error.detail
      .map((item) => `${item.loc?.slice(1).join('.') ?? 'request'}: ${item.msg}`)
      .join(' · ')
  }
  return error?.detail || `API request failed (${response.status})`
}

async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(await errorMessage(response))
  }

  return response.json() as Promise<T>
}

export function compareClusters(
  baseline: ClusterConfig,
  candidate: ClusterConfig,
  signal?: AbortSignal,
): Promise<CompareResponse> {
  return fetch(`${API_BASE}/v1/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseline, candidate }),
    signal,
  }).then(async (response) => {
    if (!response.ok) throw new Error(await errorMessage(response))
    return response.json() as Promise<CompareResponse>
  })
}

export function evaluateCluster(config: ClusterConfig): Promise<ClusterResult> {
  return request('/v1/evaluate', config)
}
