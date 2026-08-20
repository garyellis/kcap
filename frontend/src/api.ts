import type {
  ClusterConfigSchema,
  ClusterResultSchema,
  CompareResponse as ApiCompareResponse,
  HpaSchema,
  MachineSpecSchema,
  NodePoolSchema,
  PoolScenarioResultSchema,
  ResourcesSchema,
  RolloutSchema,
  WorkloadResultSchema,
  WorkloadSchema,
} from './generated'

type WithDefaults<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>

export type Resources = WithDefaults<ResourcesSchema, 'cpu_limit_m' | 'memory_limit_mib'>
export type Hpa = WithDefaults<HpaSchema, 'cpu_target_percentage' | 'memory_target_percentage'>
type MachineSpec = WithDefaults<
  MachineSpecSchema,
  'max_pods' | 'reserved_cpu_m' | 'reserved_memory_mib'
>
type Rollout = WithDefaults<RolloutSchema, 'max_surge_percent'>
type WorkloadWithDefaults = WithDefaults<
  WorkloadSchema,
  'hpa' | 'observed_cpu_per_pod_m' | 'observed_memory_per_pod_mib' | 'pool' | 'rollout'
>

export type Workload = Omit<WorkloadWithDefaults, 'hpa' | 'resources' | 'rollout'> & {
  resources: Resources
  hpa: Hpa | null
  rollout: Rollout
}

export type NodePool = Omit<NodePoolSchema, 'machine'> & { machine: MachineSpec }
export type ClusterConfig = Omit<ClusterConfigSchema, 'node_pools' | 'workloads'> & {
  workloads: Record<string, Workload>
  node_pools: Record<string, NodePool>
}

export type WorkloadResult = WorkloadResultSchema
export type PoolScenarioResult = PoolScenarioResultSchema
export type ClusterResult = ClusterResultSchema
export type CompareResponse = ApiCompareResponse

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
