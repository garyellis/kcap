from __future__ import annotations

from dataclasses import dataclass, field, fields, is_dataclass, replace
from math import ceil
from typing import Any, Optional


# Kubernetes does not act on a metric whose ratio to target sits inside this
# band. Mirrors --horizontal-pod-autoscaler-tolerance.
HPA_TOLERANCE = 0.1


# INPUT MODELS
# ------------
@dataclass(frozen=True)
class Resources:
    # millicores / MiB
    cpu_request_m: int
    memory_request_mib: int

    cpu_limit_m: Optional[int] = None
    memory_limit_mib: Optional[int] = None


@dataclass(frozen=True)
class HPA:
    min_replicas: int
    max_replicas: int

    cpu_target_percentage: Optional[float] = None
    memory_target_percentage: Optional[float] = None


@dataclass(frozen=True)
class Rollout:
    max_surge_percent: float = 25.0


@dataclass(frozen=True)
class Workload:
    name: str

    resources: Resources

    # current state
    current_replicas: int

    # simulated / observed usage per pod
    observed_cpu_per_pod_m: Optional[int] = None
    observed_memory_per_pod_mib: Optional[int] = None

    hpa: Optional[HPA] = None
    rollout: Rollout = field(default_factory=Rollout)


@dataclass(frozen=True)
class MachineSpec:
    # raw machine resources
    cpu_m: int
    memory_mib: int

    # resources Kubernetes cannot schedule to workloads
    reserved_cpu_m: int = 0
    reserved_memory_mib: int = 0

    max_pods: int = 110

    @property
    def allocatable_cpu_m(self) -> int:
        return self.cpu_m - self.reserved_cpu_m

    @property
    def allocatable_memory_mib(self) -> int:
        return self.memory_mib - self.reserved_memory_mib


@dataclass(frozen=True)
class NodePool:
    name: str
    machine: MachineSpec

    min_nodes: int
    current_nodes: int
    max_nodes: int

@dataclass(frozen=True)
class ClusterConfig:
    workloads: dict[str, Workload]
    node_pool: NodePool



# RESULT MODELS
# -------------
@dataclass(frozen=True)
class WorkloadResult:
    name: str

    cpu_utilization_percent: Optional[float]
    memory_utilization_percent: Optional[float]

    current_replicas: int

    # raw_desired_replicas is the metric recommendation before the HPA range is
    # applied. Reporting both makes a saturated HPA visible: when they differ,
    # the recommendation is being clamped and the metric inputs no longer move
    # the result.
    raw_desired_replicas: int
    desired_replicas: int

    max_replicas: int

    rollout_replicas_at_max: int

    @property
    def hpa_saturated(self) -> bool:
        return self.raw_desired_replicas != self.desired_replicas

@dataclass(frozen=True)
class ScenarioResult:
    name: str
    replicas: dict[str, int]
    pod_count: int

    cpu_requested_m: int
    memory_requested_mib: int

    # Schedulable capacity of the effective node target. Derived here so the
    # numerator and denominator of a saturation readout always come from the
    # same evaluation.
    capacity_cpu_m: int
    capacity_memory_mib: int

    # nodes_required is the workload requirement. effective_nodes_required also
    # observes the autoscaler's minimum node count.
    nodes_required: int
    effective_nodes_required: int

    current_nodes: int
    nodes_to_add: int
    nodes_to_remove: int
    node_headroom: int

    limiting_resource: str
    schedulable: bool

    # Pods that cannot fit on an empty node. No node count resolves these, so
    # they are excluded from the node math and reported on their own.
    oversized_pod_count: int

    # Per-node density of the tightest pod shape in this scenario, and the
    # resource that produces it. Explains a fragmentation verdict.
    pods_per_node: Optional[int]
    fragmentation_resource: Optional[str]

    @property
    def stranded_cpu_m(self) -> int:
        return max(0, self.capacity_cpu_m - self.cpu_requested_m)

    @property
    def stranded_memory_mib(self) -> int:
        return max(0, self.capacity_memory_mib - self.memory_requested_mib)


@dataclass(frozen=True)
class PodRequest:
    workload_name: str
    cpu_m: int
    memory_mib: int


@dataclass
class NodeAllocation:
    cpu_remaining_m: int
    memory_remaining_mib: int
    pods_remaining: int

    def fits(self, pod: PodRequest) -> bool:
        return (
            pod.cpu_m <= self.cpu_remaining_m
            and pod.memory_mib <= self.memory_remaining_mib
            and self.pods_remaining > 0
        )

    def place(self, pod: PodRequest) -> None:
        if not self.fits(pod):
            raise ValueError("Pod does not fit on this node")
        self.cpu_remaining_m -= pod.cpu_m
        self.memory_remaining_mib -= pod.memory_mib
        self.pods_remaining -= 1


@dataclass(frozen=True)
class ClusterResult:
    workloads: dict[str, WorkloadResult]

    scenarios: dict[str, ScenarioResult]



# CONFIG OPERATIONS
# -----------------
def add_workload(
    cluster: ClusterConfig,
    workload: Workload,
    ) -> ClusterConfig:

    if workload.name in cluster.workloads:
        raise ValueError(
            f"Workload {workload.name!r} already exists"
        )

    return replace(
        cluster,
        workloads={
            **cluster.workloads,
            workload.name: workload,
        },
    )

def remove_workload(
    cluster: ClusterConfig,
    workload_name: str,
    ) -> ClusterConfig:

    workloads = dict(cluster.workloads)

    workloads.pop(workload_name)

    return replace(
        cluster,
        workloads=workloads,
    )

def update_workload(
    cluster: ClusterConfig,
    workload_name: str,
    workload: Workload,
    ) -> ClusterConfig:

    return replace(
        cluster,
        workloads={
            **cluster.workloads,
            workload_name: workload,
        },
    )

def update_current_replicas(
    cluster: ClusterConfig,
    workload_name: str,
    current_replicas: int,
    ) -> ClusterConfig:
    workload = cluster.workloads[workload_name]

    return update_workload(
        cluster,
        workload_name,
        replace(
            workload,
            current_replicas=current_replicas,
        ),
    )

def update_rollout_max_surge(
    cluster: ClusterConfig,
    workload_name: str,
    max_surge_percent: float,
    ) -> ClusterConfig:
    workload = cluster.workloads[workload_name]

    return update_workload(
        cluster,
        workload_name,
        replace(
            workload,
            rollout=replace(
                workload.rollout,
                max_surge_percent=max_surge_percent,
            ),
        ),
    )


def update_cpu_request(
    cluster: ClusterConfig,
    workload_name: str,
    cpu_request_m: int,
    ) -> ClusterConfig:
    
    workload = cluster.workloads[workload_name]

    updated_resources = replace(
        workload.resources,
        cpu_request_m=cpu_request_m,
    )

    updated_workload = replace(
        workload,
        resources=updated_resources,
    )
    
    return update_workload(
        cluster,
        workload_name,
        updated_workload,
    )

def update_memory_request(
    cluster: ClusterConfig,
    workload_name: str,
    memory_request_mib: int,
    ) -> ClusterConfig:

    workload = cluster.workloads[workload_name]

    updated_workload = replace(
        workload,
        resources=replace(
            workload.resources,
            memory_request_mib=memory_request_mib,
        ),
    )

    return update_workload(
        cluster,
        workload_name,
        updated_workload,
    )

def update_cpu_limit(
    cluster: ClusterConfig,
    workload_name: str,
    cpu_limit_m: Optional[int],
    ) -> ClusterConfig:

    workload = cluster.workloads[workload_name]

    updated_workload = replace(
        workload,
        resources=replace(
            workload.resources,
            cpu_limit_m=cpu_limit_m,
        ),
    )

    return update_workload(
        cluster,
        workload_name,
        updated_workload,
    )

def update_memory_limit(
    cluster: ClusterConfig,
    workload_name: str,
    memory_limit_mib: Optional[int],
    ) -> ClusterConfig:

    workload = cluster.workloads[workload_name]

    updated_workload = replace(
        workload,
        resources=replace(
            workload.resources,
            memory_limit_mib=memory_limit_mib,
        ),
    )

    return update_workload(
        cluster,
        workload_name,
        updated_workload,
    )

def _require_hpa(workload: Workload) -> HPA:
    if workload.hpa is None:
        raise ValueError(
            f"Workload {workload.name!r} does not have an HPA"
        )

    return workload.hpa

def update_hpa_cpu_target(
    cluster: ClusterConfig,
    workload_name: str,
    target_percentage: Optional[float],
    ) -> ClusterConfig:

    workload = cluster.workloads[workload_name]
    hpa = _require_hpa(workload)

    updated_workload = replace(
        workload,
        hpa=replace(
            hpa,
            cpu_target_percentage=target_percentage,
        ),
    )

    return update_workload(
        cluster,
        workload_name,
        updated_workload,
    )

def update_hpa_memory_target(
    cluster: ClusterConfig,
    workload_name: str,
    target_percentage: Optional[float],
    ) -> ClusterConfig:

    workload = cluster.workloads[workload_name]
    hpa = _require_hpa(workload)

    updated_workload = replace(
        workload,
        hpa=replace(
            hpa,
            memory_target_percentage=target_percentage,
        ),
    )

    return update_workload(
        cluster,
        workload_name,
        updated_workload,
    )

def update_hpa_min(
    cluster: ClusterConfig,
    workload_name: str,
    min_replicas: int,
    ) -> ClusterConfig:
    workload = cluster.workloads[workload_name]
    hpa = _require_hpa(workload)

    if min_replicas > hpa.max_replicas:
        raise ValueError(
            "HPA min_replicas cannot exceed max_replicas"
        )

    updated_workload = replace(
        workload,
        hpa=replace(
            hpa,
            min_replicas=min_replicas,
        ),
    )

    return update_workload(
        cluster,
        workload_name,
        updated_workload,
    )

def update_hpa_max(
    cluster: ClusterConfig,
    workload_name: str,
    max_replicas: int,
    ) -> ClusterConfig:
    workload = cluster.workloads[workload_name]
    hpa = _require_hpa(workload)

    if max_replicas < hpa.min_replicas:
        raise ValueError(
            "HPA max_replicas cannot be less than min_replicas"
        )

    updated_workload = replace(
        workload,
        hpa=replace(
            hpa,
            max_replicas=max_replicas,
        ),
    )

    return update_workload(
        cluster,
        workload_name,
        updated_workload,
    )


def update_machine_cpu(
        cluster: ClusterConfig,
        cpu_m: int,
    ) -> ClusterConfig:

    updated_machine = replace(
        cluster.node_pool.machine,
        cpu_m=cpu_m,
    )

    updated_node_pool = replace(
        cluster.node_pool,
        machine=updated_machine,
    )

    return replace(
        cluster,
        node_pool=updated_node_pool,
    )

def update_machine_memory(
    cluster: ClusterConfig,
    memory_mib: int,
    ) -> ClusterConfig:
    updated_machine = replace(
        cluster.node_pool.machine,
        memory_mib=memory_mib,
    )

    updated_node_pool = replace(
        cluster.node_pool,
        machine=updated_machine,
    )

    return replace(
        cluster,
        node_pool=updated_node_pool,
    )

def update_ca_max(
    cluster: ClusterConfig,
    max_nodes: int,
    ) -> ClusterConfig:
    if max_nodes < cluster.node_pool.min_nodes:
        raise ValueError(
            "CA max_nodes cannot be less than min_nodes"
        )

    return replace(
        cluster,
        node_pool=replace(
            cluster.node_pool,
            max_nodes=max_nodes,
        ),
    )


# VALIDATION
# ----------
def validate(cluster: ClusterConfig) -> None:
    """Validate a cluster configuration before simulation."""
    pool = cluster.node_pool
    machine = pool.machine

    if machine.cpu_m <= 0:
        raise ValueError("Machine CPU must be greater than zero")
    if machine.memory_mib <= 0:
        raise ValueError("Machine memory must be greater than zero")
    if machine.reserved_cpu_m < 0:
        raise ValueError("Reserved CPU cannot be negative")
    if machine.reserved_cpu_m >= machine.cpu_m:
        raise ValueError("Reserved CPU must be less than machine CPU")
    if machine.reserved_memory_mib < 0:
        raise ValueError("Reserved memory cannot be negative")
    if machine.reserved_memory_mib >= machine.memory_mib:
        raise ValueError("Reserved memory must be less than machine memory")
    if machine.max_pods <= 0:
        raise ValueError("max_pods must be greater than zero")
    if not 0 <= pool.min_nodes <= pool.current_nodes <= pool.max_nodes:
        raise ValueError("Expected min_nodes <= current_nodes <= max_nodes")

    for name, workload in cluster.workloads.items():
        if name != workload.name:
            raise ValueError(
                f"Workload key {name!r} does not match workload.name "
                f"{workload.name!r}"
            )

        resources = workload.resources
        if resources.cpu_request_m <= 0:
            raise ValueError(f"{name}: CPU request must be greater than zero")
        if resources.memory_request_mib <= 0:
            raise ValueError(f"{name}: memory request must be greater than zero")
        if resources.cpu_limit_m is not None:
            if resources.cpu_limit_m <= 0:
                raise ValueError(f"{name}: CPU limit must be greater than zero")
            if resources.cpu_limit_m < resources.cpu_request_m:
                raise ValueError(f"{name}: CPU limit must be >= CPU request")
        if resources.memory_limit_mib is not None:
            if resources.memory_limit_mib <= 0:
                raise ValueError(f"{name}: memory limit must be greater than zero")
            if resources.memory_limit_mib < resources.memory_request_mib:
                raise ValueError(f"{name}: memory limit must be >= memory request")

        if workload.current_replicas < 0:
            raise ValueError(f"{name}: replicas cannot be negative")
        if (
            workload.observed_cpu_per_pod_m is not None
            and workload.observed_cpu_per_pod_m < 0
        ):
            raise ValueError(f"{name}: observed CPU cannot be negative")
        if (
            workload.observed_memory_per_pod_mib is not None
            and workload.observed_memory_per_pod_mib < 0
        ):
            raise ValueError(f"{name}: observed memory cannot be negative")
        if workload.rollout.max_surge_percent < 0:
            raise ValueError(f"{name}: rollout max surge cannot be negative")

        if workload.hpa is not None:
            hpa = workload.hpa
            if hpa.min_replicas < 0:
                raise ValueError(f"{name}: HPA min cannot be negative")
            if hpa.max_replicas < hpa.min_replicas:
                raise ValueError(f"{name}: HPA max must be >= HPA min")
            for target in (
                hpa.cpu_target_percentage,
                hpa.memory_target_percentage,
            ):
                if target is not None and target <= 0:
                    raise ValueError(f"{name}: HPA target must be > 0")


def _validate_replicas(
    cluster: ClusterConfig,
    replicas: dict[str, int],
) -> None:
    unknown = replicas.keys() - cluster.workloads.keys()
    missing = cluster.workloads.keys() - replicas.keys()
    if unknown:
        raise ValueError(f"Unknown workloads in scenario: {sorted(unknown)!r}")
    if missing:
        raise ValueError(f"Missing workloads in scenario: {sorted(missing)!r}")
    for name, count in replicas.items():
        if count < 0:
            raise ValueError(f"{name}: scenario replicas cannot be negative")


# ENGINE
# ------
def _metric_recommendation(
    current_replicas: int,
    utilization_percent: float,
    target_percentage: float,
) -> int:
    """Replica recommendation for one metric, observing the tolerance band."""
    ratio = utilization_percent / target_percentage

    if abs(ratio - 1) <= HPA_TOLERANCE:
        return current_replicas

    return ceil(current_replicas * ratio)


def evaluate_hpa(
    workload: Workload,
    ) -> tuple[
        Optional[float],
        Optional[float],
        int,
        int,
        ]:
    """
    Returns:
        cpu_utilization_percent
        memory_utilization_percent
        raw_desired_replicas (before the HPA range is applied)
        desired_replicas
    """

    if workload.hpa is None:
        return (
            None,
            None,
            workload.current_replicas,
            workload.current_replicas,
        )

    cpu_utilization = None
    memory_utilization = None

    # Recommendations come only from usable metrics. If no metric is usable,
    # preserving current state is safer than pretending the HPA will scale.
    desired_candidates: list[int] = []

    # CPU HPA
    if (
        workload.hpa.cpu_target_percentage is not None
        and workload.observed_cpu_per_pod_m is not None
        and workload.resources.cpu_request_m > 0
    ):
        cpu_utilization = (
            workload.observed_cpu_per_pod_m
            / workload.resources.cpu_request_m
            * 100
        )

        desired_candidates.append(
            _metric_recommendation(
                workload.current_replicas,
                cpu_utilization,
                workload.hpa.cpu_target_percentage,
            )
        )

    # Memory HPA
    if (
        workload.hpa.memory_target_percentage is not None
        and workload.observed_memory_per_pod_mib is not None
        and workload.resources.memory_request_mib > 0
    ):
        memory_utilization = (
            workload.observed_memory_per_pod_mib
            / workload.resources.memory_request_mib
            * 100
        )

        desired_candidates.append(
            _metric_recommendation(
                workload.current_replicas,
                memory_utilization,
                workload.hpa.memory_target_percentage,
            )
        )

    raw_desired_replicas = (
        max(desired_candidates)
        if desired_candidates
        else workload.current_replicas
    )

    desired_replicas = max(
        workload.hpa.min_replicas,
        min(
            raw_desired_replicas,
            workload.hpa.max_replicas,
        ),
    )

    return (
        cpu_utilization,
        memory_utilization,
        raw_desired_replicas,
        desired_replicas,
    )

def evaluate_workload(workload: Workload) -> WorkloadResult:
    (
        cpu_utilization,
        memory_utilization,
        raw_desired_replicas,
        desired_replicas,
    ) = evaluate_hpa(workload)

    if workload.hpa is None:
        max_replicas = workload.current_replicas
    else:
        max_replicas = workload.hpa.max_replicas

    surge = ceil(
        max_replicas
        * workload.rollout.max_surge_percent
        / 100
    )

    rollout_replicas_at_max = (
        max_replicas + surge
    )

    return WorkloadResult(
        name=workload.name,

        cpu_utilization_percent=cpu_utilization,
        memory_utilization_percent=memory_utilization,

        current_replicas=workload.current_replicas,
        raw_desired_replicas=raw_desired_replicas,
        desired_replicas=desired_replicas,
        max_replicas=max_replicas,

        rollout_replicas_at_max=(
            rollout_replicas_at_max
        ),
    )

def build_pods(
    cluster: ClusterConfig,
    replicas: dict[str, int],
) -> list[PodRequest]:
    """Expand workload replica counts into discrete pod requests."""
    _validate_replicas(cluster, replicas)
    return [
        PodRequest(
            workload_name=name,
            cpu_m=cluster.workloads[name].resources.cpu_request_m,
            memory_mib=cluster.workloads[name].resources.memory_request_mib,
        )
        for name, replica_count in replicas.items()
        for _ in range(replica_count)
    ]


def _pack_pods(
    machine: MachineSpec,
    pods: list[PodRequest],
) -> tuple[list[NodeAllocation], list[PodRequest]]:
    """Pack pods using deterministic first-fit decreasing.

    This is an approximation rather than a Kubernetes scheduler, but unlike
    aggregate division it preserves pod shape and resource fragmentation.
    """
    oversized: list[PodRequest] = []
    candidates: list[PodRequest] = []
    for pod in pods:
        if (
            pod.cpu_m > machine.allocatable_cpu_m
            or pod.memory_mib > machine.allocatable_memory_mib
        ):
            oversized.append(pod)
        else:
            candidates.append(pod)
    candidates.sort(
        key=lambda pod: (
            max(
                pod.cpu_m / machine.allocatable_cpu_m,
                pod.memory_mib / machine.allocatable_memory_mib,
            ),
            pod.cpu_m / machine.allocatable_cpu_m
            + pod.memory_mib / machine.allocatable_memory_mib,
            pod.cpu_m,
            pod.memory_mib,
            pod.workload_name,
        ),
        reverse=True,
    )

    nodes: list[NodeAllocation] = []
    for pod in candidates:
        for node in nodes:
            if node.fits(pod):
                node.place(pod)
                break
        else:
            node = NodeAllocation(
                cpu_remaining_m=machine.allocatable_cpu_m,
                memory_remaining_mib=machine.allocatable_memory_mib,
                pods_remaining=machine.max_pods,
            )
            node.place(pod)
            nodes.append(node)

    return nodes, oversized


def _shape_density(
    machine: MachineSpec,
    pods: list[PodRequest],
) -> tuple[Optional[int], Optional[str]]:
    """How many of the tightest pod fit on one node, and what limits it.

    Aggregate division hides the cost of pod shape: a pod requesting more than
    half a node strands the remainder. This reports that density directly, and
    names the resource responsible.
    """
    placeable = [
        pod
        for pod in pods
        if pod.cpu_m <= machine.allocatable_cpu_m
        and pod.memory_mib <= machine.allocatable_memory_mib
    ]
    if not placeable:
        return None, None

    cpu_fit = min(machine.allocatable_cpu_m // pod.cpu_m for pod in placeable)
    memory_fit = min(
        machine.allocatable_memory_mib // pod.memory_mib for pod in placeable
    )

    tightest_resource = "cpu" if cpu_fit <= memory_fit else "memory"
    pods_per_node = min(cpu_fit, memory_fit, machine.max_pods)
    if pods_per_node == machine.max_pods < min(cpu_fit, memory_fit):
        tightest_resource = "pod_count"

    return pods_per_node, tightest_resource


def evaluate_scenario(
    name: str,
    cluster: ClusterConfig,
    replicas: dict[str, int],
) -> ScenarioResult:
    validate(cluster)
    machine = cluster.node_pool.machine
    pods = build_pods(cluster, replicas)

    pod_count = len(pods)
    cpu_requested_m = sum(pod.cpu_m for pod in pods)
    memory_requested_mib = sum(pod.memory_mib for pod in pods)

    packed_nodes, oversized_pods = _pack_pods(machine, pods)

    # Oversized pods never schedule, so no node count resolves them. Excluding
    # them keeps nodes_required an honest instruction to the autoscaler;
    # schedulable and oversized_pod_count carry the impossibility.
    placeable_cpu_m = cpu_requested_m - sum(pod.cpu_m for pod in oversized_pods)
    placeable_memory_mib = memory_requested_mib - sum(
        pod.memory_mib for pod in oversized_pods
    )
    placeable_pod_count = pod_count - len(oversized_pods)

    # Fractional demand breaks ties between resources that round to the same
    # node count, so the reported constraint is the genuinely tighter one.
    pressure = {
        "cpu": placeable_cpu_m / machine.allocatable_cpu_m,
        "memory": placeable_memory_mib / machine.allocatable_memory_mib,
        "pod_count": placeable_pod_count / machine.max_pods,
    }
    requirements = {key: ceil(value) for key, value in pressure.items()}
    aggregate_nodes_required = max(requirements.values())

    nodes_required = max(aggregate_nodes_required, len(packed_nodes))

    pods_per_node, tightest_resource = _shape_density(machine, pods)

    fragmentation_resource = None
    if oversized_pods:
        limiting_resource = "pod_too_large"
    elif nodes_required > aggregate_nodes_required:
        limiting_resource = "fragmentation"
        fragmentation_resource = tightest_resource
    elif placeable_pod_count == 0:
        limiting_resource = "none"
    else:
        limiting_resource = max(
            requirements,
            key=lambda key: (requirements[key], pressure[key]),
        )

    pool = cluster.node_pool
    effective_nodes_required = max(nodes_required, pool.min_nodes)
    nodes_to_add = max(0, effective_nodes_required - pool.current_nodes)
    nodes_to_remove = max(0, pool.current_nodes - effective_nodes_required)
    node_headroom = pool.max_nodes - effective_nodes_required
    schedulable = not oversized_pods and effective_nodes_required <= pool.max_nodes

    return ScenarioResult(
        name=name,
        replicas=dict(replicas),
        pod_count=pod_count,
        cpu_requested_m=cpu_requested_m,
        memory_requested_mib=memory_requested_mib,
        capacity_cpu_m=effective_nodes_required * machine.allocatable_cpu_m,
        capacity_memory_mib=(
            effective_nodes_required * machine.allocatable_memory_mib
        ),
        nodes_required=nodes_required,
        effective_nodes_required=effective_nodes_required,
        current_nodes=pool.current_nodes,
        nodes_to_add=nodes_to_add,
        nodes_to_remove=nodes_to_remove,
        node_headroom=node_headroom,
        limiting_resource=limiting_resource,
        schedulable=schedulable,
        oversized_pod_count=len(oversized_pods),
        pods_per_node=pods_per_node,
        fragmentation_resource=fragmentation_resource,
    )

def min_replicas_for(
    workload: Workload,
) -> int:
    if workload.hpa is None:
        return workload.current_replicas

    return workload.hpa.min_replicas

def evaluate(cluster: ClusterConfig) -> ClusterResult:
    validate(cluster)

    workload_results = {
        name: evaluate_workload(workload)
        for name, workload
        in cluster.workloads.items()
    }

    current_replicas = {
        name: result.current_replicas
        for name, result
        in workload_results.items()
    }

    desired_replicas = {
        name: result.desired_replicas
        for name, result
        in workload_results.items()
    }

    max_replicas = {
        name: result.max_replicas
        for name, result
        in workload_results.items()
    }

    rollout_replicas = {
        name: result.rollout_replicas_at_max
        for name, result
        in workload_results.items()
    }

    min_replicas = {
        name: min_replicas_for(
            cluster.workloads[name]
        )
        for name in workload_results
    }

    scenarios = {
        "hpa_min": evaluate_scenario(
            "hpa_min",
            cluster,
            min_replicas,
        ),

        "current": evaluate_scenario(
            "current",
            cluster,
            current_replicas,
        ),

        "hpa_desired": evaluate_scenario(
            "hpa_desired",
            cluster,
            desired_replicas,
        ),

        "hpa_max": evaluate_scenario(
            "hpa_max",
            cluster,
            max_replicas,
        ),

        "hpa_max_rollout": evaluate_scenario(
            "hpa_max_rollout",
            cluster,
            rollout_replicas,
        ),
    }

    return ClusterResult(
        workloads=workload_results,
        scenarios=scenarios,
    )


# DIFF
# ----
@dataclass(frozen=True)
class ValueChange:
    before: int | float
    after: int | float

    @property
    def delta(self) -> int | float:
        return self.after - self.before


@dataclass(frozen=True)
class ConfigValueChange:
    before: Any
    after: Any


@dataclass(frozen=True)
class ConfigDiff:
    """Configuration changes, separate from their calculated impact."""
    changes: dict[str, ConfigValueChange]
    workloads_added: tuple[str, ...]
    workloads_removed: tuple[str, ...]


@dataclass(frozen=True)
class WorkloadDiff:
    raw_desired_replicas: ValueChange
    desired_replicas: ValueChange
    max_replicas: ValueChange
    rollout_replicas_at_max: ValueChange


@dataclass(frozen=True)
class ScenarioDiff:
    pod_count: ValueChange
    cpu_requested_m: ValueChange
    memory_requested_mib: ValueChange
    nodes_required: ValueChange
    effective_nodes_required: ValueChange
    current_nodes: ValueChange
    nodes_to_add: ValueChange
    nodes_to_remove: ValueChange
    node_headroom: ValueChange
    limiting_resource_before: str
    limiting_resource_after: str
    schedulable_before: bool
    schedulable_after: bool


@dataclass(frozen=True)
class ClusterDiff:
    workloads: dict[str, WorkloadDiff]
    scenarios: dict[str, ScenarioDiff]


def _compare_config_values(
    before: Any,
    after: Any,
    prefix: str,
) -> dict[str, ConfigValueChange]:
    if (
        is_dataclass(before)
        and not isinstance(before, type)
        and type(before) is type(after)
    ):
        changes: dict[str, ConfigValueChange] = {}
        for item in fields(before):
            path = f"{prefix}.{item.name}" if prefix else item.name
            changes.update(
                _compare_config_values(
                    getattr(before, item.name),
                    getattr(after, item.name),
                    path,
                )
            )
        return changes
    if before != after:
        return {prefix: ConfigValueChange(before=before, after=after)}
    return {}


def compare_config(
    baseline: ClusterConfig,
    candidate: ClusterConfig,
) -> ConfigDiff:
    """Return the exact inputs changed between two configurations."""
    old_names = baseline.workloads.keys()
    new_names = candidate.workloads.keys()
    added = tuple(sorted(new_names - old_names))
    removed = tuple(sorted(old_names - new_names))

    changes = _compare_config_values(
        baseline.node_pool,
        candidate.node_pool,
        "node_pool",
    )
    for name in sorted(old_names & new_names):
        changes.update(
            _compare_config_values(
                baseline.workloads[name],
                candidate.workloads[name],
                f"workloads.{name}",
            )
        )
    changes = dict(sorted(changes.items()))
    return ConfigDiff(
        changes=changes,
        workloads_added=added,
        workloads_removed=removed,
    )


def compare_results(
    before: ClusterResult,
    after: ClusterResult,
) -> ClusterDiff:
    """Return calculated impact changes between two evaluated results."""
    workload_diffs: dict[str, WorkloadDiff] = {}
    for name in sorted(before.workloads.keys() & after.workloads.keys()):
        old = before.workloads[name]
        new = after.workloads[name]
        workload_diffs[name] = WorkloadDiff(
            raw_desired_replicas=ValueChange(
                old.raw_desired_replicas,
                new.raw_desired_replicas,
            ),
            desired_replicas=ValueChange(old.desired_replicas, new.desired_replicas),
            max_replicas=ValueChange(old.max_replicas, new.max_replicas),
            rollout_replicas_at_max=ValueChange(
                old.rollout_replicas_at_max,
                new.rollout_replicas_at_max,
            ),
        )

    scenario_diffs: dict[str, ScenarioDiff] = {}
    for name in sorted(before.scenarios.keys() & after.scenarios.keys()):
        old = before.scenarios[name]
        new = after.scenarios[name]
        scenario_diffs[name] = ScenarioDiff(
            pod_count=ValueChange(old.pod_count, new.pod_count),
            cpu_requested_m=ValueChange(old.cpu_requested_m, new.cpu_requested_m),
            memory_requested_mib=ValueChange(
                old.memory_requested_mib,
                new.memory_requested_mib,
            ),
            nodes_required=ValueChange(old.nodes_required, new.nodes_required),
            effective_nodes_required=ValueChange(
                old.effective_nodes_required,
                new.effective_nodes_required,
            ),
            current_nodes=ValueChange(old.current_nodes, new.current_nodes),
            nodes_to_add=ValueChange(old.nodes_to_add, new.nodes_to_add),
            nodes_to_remove=ValueChange(old.nodes_to_remove, new.nodes_to_remove),
            node_headroom=ValueChange(old.node_headroom, new.node_headroom),
            limiting_resource_before=old.limiting_resource,
            limiting_resource_after=new.limiting_resource,
            schedulable_before=old.schedulable,
            schedulable_after=new.schedulable,
        )

    return ClusterDiff(workloads=workload_diffs, scenarios=scenario_diffs)


def compare(before: ClusterResult, after: ClusterResult) -> ClusterDiff:
    """Backward-compatible alias for compare_results."""
    return compare_results(before, after)
