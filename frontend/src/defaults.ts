import type { ClusterConfig, NodePool, Workload } from './api'

export const BASELINE: ClusterConfig = {
  workloads: {
    api: {
      name: 'api',
      resources: {
        cpu_request_m: 750,
        memory_request_mib: 1024,
        cpu_limit_m: 2000,
        memory_limit_mib: 2048,
      },
      current_replicas: 6,
      observed_cpu_per_pod_m: 620,
      observed_memory_per_pod_mib: 780,
      hpa: {
        min_replicas: 3,
        max_replicas: 18,
        cpu_target_percentage: 70,
        memory_target_percentage: 75,
      },
      rollout: { max_surge_percent: 25 },
      pool: 'primary',
    },
    worker: {
      name: 'worker',
      resources: {
        cpu_request_m: 500,
        memory_request_mib: 768,
        cpu_limit_m: 1500,
        memory_limit_mib: 1536,
      },
      current_replicas: 4,
      observed_cpu_per_pod_m: 310,
      observed_memory_per_pod_mib: 520,
      hpa: {
        min_replicas: 2,
        max_replicas: 12,
        cpu_target_percentage: 70,
        memory_target_percentage: null,
      },
      rollout: { max_surge_percent: 25 },
      pool: 'primary',
    },
  },
  node_pools: {
    primary: {
      name: 'primary',
      machine: {
        cpu_m: 4000,
        memory_mib: 16384,
        reserved_cpu_m: 400,
        reserved_memory_mib: 1536,
        max_pods: 110,
      },
      min_nodes: 3,
      current_nodes: 6,
      max_nodes: 20,
    },
  },
}

export function cloneBaseline(): ClusterConfig {
  return structuredClone(BASELINE)
}

export function createWorkload(name: string, pool: string): Workload {
  return {
    name,
    resources: {
      cpu_request_m: 250,
      memory_request_mib: 256,
      cpu_limit_m: 500,
      memory_limit_mib: 512,
    },
    current_replicas: 2,
    observed_cpu_per_pod_m: 150,
    observed_memory_per_pod_mib: 192,
    hpa: {
      min_replicas: 1,
      max_replicas: 8,
      cpu_target_percentage: 70,
      memory_target_percentage: null,
    },
    rollout: { max_surge_percent: 25 },
    pool,
  }
}

export function createPool(name: string): NodePool {
  return {
    name,
    machine: {
      cpu_m: 4000,
      memory_mib: 16384,
      reserved_cpu_m: 400,
      reserved_memory_mib: 1536,
      max_pods: 110,
    },
    min_nodes: 0,
    current_nodes: 0,
    max_nodes: 10,
  }
}

export function nextWorkloadName(workloads: ClusterConfig['workloads']): string {
  let index = Object.keys(workloads).length + 1
  let name = `service-${index}`
  while (name in workloads) {
    index += 1
    name = `service-${index}`
  }
  return name
}

export function nextPoolName(pools: ClusterConfig['node_pools']): string {
  let index = Object.keys(pools).length + 1
  let name = `pool-${index}`
  while (name in pools) {
    index += 1
    name = `pool-${index}`
  }
  return name
}
