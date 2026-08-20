from __future__ import annotations

from dataclasses import dataclass, field, fields, is_dataclass, replace
from math import ceil
from typing import Any, Literal

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

    cpu_limit_m: int | None = None
    memory_limit_mib: int | None = None


UsageBasis = Literal["peak", "p95", "avg"]


@dataclass(frozen=True)
class UsageStat:
    """A summary of one workload's observed per-pod usage in one dimension.

    Units follow the dimension: millicores for CPU, MiB for memory. Which
    statistic a caller reads is a convention, not a preference — see the
    accessors below and the field comments on `Workload`.
    """

    avg: int
    p95: int | None = None
    peak: int | None = None

    def exposure(self) -> tuple[int, UsageBasis]:
        """Value for exposure/entitlement math and the basis that produced it.

        Exposure asks what a pod does at its busiest, so it reads the highest
        statistic available and names the one it fell back to; a caller that
        reports an exposure number must report the basis with it.
        """
        if self.peak is not None:
            return self.peak, "peak"
        if self.p95 is not None:
            return self.p95, "p95"
        return self.avg, "avg"

    def sizing(self) -> int:
        """Value for request-sizing suggestions.

        Sizing reads p95: a request set from the average under-serves the pod
        most of the time it matters, and one set from the peak buys idle
        capacity for a spike the scheduler cannot pack around.
        """
        return self.p95 if self.p95 is not None else self.avg


@dataclass(frozen=True)
class HPA:
    min_replicas: int
    max_replicas: int

    cpu_target_percentage: float | None = None
    memory_target_percentage: float | None = None


@dataclass(frozen=True)
class Rollout:
    max_surge_percent: float = 25.0

    # Absolute surge, mirroring a Deployment's integer `maxSurge`. Takes
    # precedence over max_surge_percent whenever it is set, including 0.
    max_surge_pods: int | None = None


@dataclass(frozen=True)
class Workload:
    name: str

    resources: Resources

    # current state
    current_replicas: int

    # Simulated / observed usage per pod. HPA math reads `avg`, because that is
    # what the real HPA averages; the other statistics exist for the exposure
    # and sizing questions and never move a replica count.
    observed_cpu_per_pod: UsageStat | None = None
    observed_memory_per_pod: UsageStat | None = None

    # Capture window behind the statistics above. None or 0 means a
    # point-in-time snapshot, which cannot honestly supply a peak; that is
    # reported alongside the outputs it weakens, never refused.
    usage_window_seconds: int | None = None
    # Where the statistics came from, e.g. "metrics-server-snapshot", "manual".
    usage_source: str | None = None

    hpa: HPA | None = None
    rollout: Rollout = field(default_factory=Rollout)

    # Node pool this workload is pinned to. None resolves to the only pool;
    # with several pools the assignment must be explicit.
    pool: str | None = None


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
    node_pools: dict[str, NodePool]


# RESULT MODELS
# -------------
@dataclass(frozen=True)
class WorkloadResult:
    name: str

    cpu_utilization_percent: float | None
    memory_utilization_percent: float | None

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

    @property
    def clamped_by(self) -> Literal["min", "max"] | None:
        """Which end of the HPA range held the recommendation, if either.

        `hpa_saturated` says only that a clamp happened; the direction decides
        whether the operator raises a ceiling or lowers a floor.
        """
        if self.raw_desired_replicas < self.desired_replicas:
            return "min"
        if self.raw_desired_replicas > self.desired_replicas:
            return "max"
        return None


ScaleDownBlockedReason = Literal["oversized_pods", "no_placeable_demand"]


@dataclass(frozen=True)
class PoolScenarioResult:
    pool: str
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

    # nodes_to_remove is an instruction, so it is 0 whenever removing nodes
    # cannot be instructed safely; scale_down_blocked_reason then says why. The
    # ungated arithmetic stays derivable from current_nodes and
    # effective_nodes_required.
    nodes_to_remove: int
    scale_down_blocked_reason: ScaleDownBlockedReason | None

    node_headroom: int

    limiting_resource: str
    schedulable: bool

    # Pods that cannot fit on an empty node. No node count resolves these, so
    # they are excluded from the node math and reported on their own.
    oversized_pod_count: int

    # Per-node density of the tightest pod shape in this scenario, and the
    # resource that produces it. Explains a fragmentation verdict.
    pods_per_node: int | None
    fragmentation_resource: str | None

    @property
    def stranded_cpu_m(self) -> int:
        return max(0, self.capacity_cpu_m - self.cpu_requested_m)

    @property
    def stranded_memory_mib(self) -> int:
        return max(0, self.capacity_memory_mib - self.memory_requested_mib)


@dataclass(frozen=True)
class ScenarioResult:
    """Cluster-wide totals plus the per-pool evaluations they sum from.

    Fields that only make sense against one machine shape (limiting resource,
    headroom, density, capacity) stay on PoolScenarioResult; aggregating them
    across differently-shaped pools would fabricate a number nobody configured.
    """

    name: str
    replicas: dict[str, int]
    pod_count: int

    cpu_requested_m: int
    memory_requested_mib: int

    nodes_required: int
    effective_nodes_required: int

    current_nodes: int
    nodes_to_add: int
    nodes_to_remove: int

    schedulable: bool
    oversized_pod_count: int

    pools: dict[str, PoolScenarioResult]


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
        raise ValueError(f"Workload {workload.name!r} already exists")

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
    cpu_limit_m: int | None,
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
    memory_limit_mib: int | None,
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
        raise ValueError(f"Workload {workload.name!r} does not have an HPA")

    return workload.hpa


def update_hpa_cpu_target(
    cluster: ClusterConfig,
    workload_name: str,
    target_percentage: float | None,
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
    target_percentage: float | None,
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
        raise ValueError("HPA min_replicas cannot exceed max_replicas")

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
        raise ValueError("HPA max_replicas cannot be less than min_replicas")

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


def _update_node_pool(
    cluster: ClusterConfig,
    pool_name: str,
    pool: NodePool,
) -> ClusterConfig:
    if pool_name not in cluster.node_pools:
        raise ValueError(f"Node pool {pool_name!r} does not exist")

    return replace(
        cluster,
        node_pools={
            **cluster.node_pools,
            pool_name: pool,
        },
    )


def update_machine_cpu(
    cluster: ClusterConfig,
    pool_name: str,
    cpu_m: int,
) -> ClusterConfig:

    pool = cluster.node_pools[pool_name]

    return _update_node_pool(
        cluster,
        pool_name,
        replace(
            pool,
            machine=replace(pool.machine, cpu_m=cpu_m),
        ),
    )


def update_machine_memory(
    cluster: ClusterConfig,
    pool_name: str,
    memory_mib: int,
) -> ClusterConfig:

    pool = cluster.node_pools[pool_name]

    return _update_node_pool(
        cluster,
        pool_name,
        replace(
            pool,
            machine=replace(pool.machine, memory_mib=memory_mib),
        ),
    )


def update_ca_max(
    cluster: ClusterConfig,
    pool_name: str,
    max_nodes: int,
) -> ClusterConfig:
    pool = cluster.node_pools[pool_name]

    if max_nodes < pool.min_nodes:
        raise ValueError("CA max_nodes cannot be less than min_nodes")

    return _update_node_pool(
        cluster,
        pool_name,
        replace(pool, max_nodes=max_nodes),
    )


# VALIDATION
# ----------
def resolve_pool_name(cluster: ClusterConfig, workload: Workload) -> str:
    """Node pool a workload packs onto.

    An unset pool is a convenience only a single-pool cluster can honor;
    guessing among several pools would silently reroute capacity.
    """
    if workload.pool is not None:
        return workload.pool
    if len(cluster.node_pools) == 1:
        return next(iter(cluster.node_pools))
    raise ValueError(
        f"{workload.name}: workload must name a node pool when multiple pools exist"
    )


def _validate_machine(pool_name: str, machine: MachineSpec) -> None:
    if machine.cpu_m <= 0:
        raise ValueError(f"{pool_name}: machine CPU must be greater than zero")
    if machine.memory_mib <= 0:
        raise ValueError(f"{pool_name}: machine memory must be greater than zero")
    if machine.reserved_cpu_m < 0:
        raise ValueError(f"{pool_name}: reserved CPU cannot be negative")
    if machine.reserved_cpu_m >= machine.cpu_m:
        raise ValueError(f"{pool_name}: reserved CPU must be less than machine CPU")
    if machine.reserved_memory_mib < 0:
        raise ValueError(f"{pool_name}: reserved memory cannot be negative")
    if machine.reserved_memory_mib >= machine.memory_mib:
        raise ValueError(
            f"{pool_name}: reserved memory must be less than machine memory"
        )
    if machine.max_pods <= 0:
        raise ValueError(f"{pool_name}: max_pods must be greater than zero")


def _validate_node_pool(pool_name: str, pool: NodePool) -> None:
    if pool_name != pool.name:
        raise ValueError(
            f"Node pool key {pool_name!r} does not match pool.name {pool.name!r}"
        )

    _validate_machine(pool_name, pool.machine)

    if not 0 <= pool.min_nodes <= pool.current_nodes <= pool.max_nodes:
        raise ValueError(
            f"{pool_name}: expected min_nodes <= current_nodes <= max_nodes"
        )


def _validate_resources(name: str, resources: Resources) -> None:
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


def _validate_hpa(name: str, hpa: HPA) -> None:
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


def _validate_pool_assignment(
    cluster: ClusterConfig,
    name: str,
    workload: Workload,
) -> None:
    if workload.pool is not None and workload.pool not in cluster.node_pools:
        raise ValueError(f"{name}: unknown node pool {workload.pool!r}")
    # Raises when the assignment is ambiguous (no pool named, several exist).
    resolve_pool_name(cluster, workload)


def _validate_usage_stat(
    name: str,
    dimension: str,
    stat: UsageStat | None,
) -> None:
    """Check one usage summary for negative values and impossible ordering.

    `peak` is a maximum, so it cannot sit below the mean or the 95th
    percentile. `avg` and `p95` are deliberately left unordered: a distribution
    with a long enough tail puts the mean above its own p95. Messages name the
    statistic as the field spells it, so a rejected client can find it.
    """
    if stat is None:
        return

    for statistic, value in (("avg", stat.avg), ("p95", stat.p95), ("peak", stat.peak)):
        if value is not None and value < 0:
            raise ValueError(
                f"{name}: observed {dimension} {statistic} cannot be negative"
            )

    if stat.peak is None:
        return
    if stat.peak < stat.avg:
        raise ValueError(f"{name}: observed {dimension} peak cannot be below avg")
    if stat.p95 is not None and stat.peak < stat.p95:
        raise ValueError(f"{name}: observed {dimension} peak cannot be below p95")


def _validate_workload(
    cluster: ClusterConfig,
    name: str,
    workload: Workload,
) -> None:
    if name != workload.name:
        raise ValueError(
            f"Workload key {name!r} does not match workload.name {workload.name!r}"
        )

    _validate_resources(name, workload.resources)

    if workload.current_replicas < 0:
        raise ValueError(f"{name}: replicas cannot be negative")
    _validate_usage_stat(name, "CPU", workload.observed_cpu_per_pod)
    _validate_usage_stat(name, "memory", workload.observed_memory_per_pod)
    if workload.usage_window_seconds is not None and workload.usage_window_seconds < 0:
        raise ValueError(f"{name}: usage window cannot be negative")
    if workload.rollout.max_surge_percent < 0:
        raise ValueError(f"{name}: rollout max surge cannot be negative")
    if (
        workload.rollout.max_surge_pods is not None
        and workload.rollout.max_surge_pods < 0
    ):
        raise ValueError(f"{name}: rollout max surge pods cannot be negative")
    if workload.hpa is not None:
        _validate_hpa(name, workload.hpa)

    _validate_pool_assignment(cluster, name, workload)


def validate(cluster: ClusterConfig) -> None:
    """Validate a cluster configuration before simulation."""
    if not cluster.node_pools:
        raise ValueError("At least one node pool is required")

    for pool_name, pool in cluster.node_pools.items():
        _validate_node_pool(pool_name, pool)

    for name, workload in cluster.workloads.items():
        _validate_workload(cluster, name, workload)


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
    float | None,
    float | None,
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

    # Both metrics read `avg` and nothing else: the HPA controller compares the
    # target against the current average utilization across the pod population,
    # so a peak or p95 here would be a different controller.
    observed_cpu = workload.observed_cpu_per_pod
    observed_memory = workload.observed_memory_per_pod

    # Recommendations come only from usable metrics. If no metric is usable,
    # preserving current state is safer than pretending the HPA will scale.
    desired_candidates: list[int] = []

    # CPU HPA
    if (
        workload.hpa.cpu_target_percentage is not None
        and observed_cpu is not None
        and workload.resources.cpu_request_m > 0
    ):
        cpu_utilization = observed_cpu.avg / workload.resources.cpu_request_m * 100

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
        and observed_memory is not None
        and workload.resources.memory_request_mib > 0
    ):
        memory_utilization = (
            observed_memory.avg / workload.resources.memory_request_mib * 100
        )

        desired_candidates.append(
            _metric_recommendation(
                workload.current_replicas,
                memory_utilization,
                workload.hpa.memory_target_percentage,
            )
        )

    raw_desired_replicas = (
        max(desired_candidates) if desired_candidates else workload.current_replicas
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

    # An absolute maxSurge is a pod count, not a ratio; only a percent string
    # scales with the replica count. Upstream: kubernetes/kubernetes v1.33.0
    # pkg/controller/deployment/util/deployment_util.go MaxSurge() ->
    # ResolveFenceposts() -> intstr.GetScaledValueFromIntOrPercent(..., roundUp=true):
    # an Int value returns unscaled, a percent String scales against the replica
    # count and rounds up.
    if workload.rollout.max_surge_pods is not None:
        surge = workload.rollout.max_surge_pods
    else:
        surge = ceil(max_replicas * workload.rollout.max_surge_percent / 100)

    rollout_replicas_at_max = max_replicas + surge

    return WorkloadResult(
        name=workload.name,
        cpu_utilization_percent=cpu_utilization,
        memory_utilization_percent=memory_utilization,
        current_replicas=workload.current_replicas,
        raw_desired_replicas=raw_desired_replicas,
        desired_replicas=desired_replicas,
        max_replicas=max_replicas,
        rollout_replicas_at_max=(rollout_replicas_at_max),
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
) -> tuple[int | None, str | None]:
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


def _evaluate_pool_scenario(
    pool: NodePool,
    pods: list[PodRequest],
) -> PoolScenarioResult:
    """Pack one pool's pods onto its machine shape and size the pool."""
    machine = pool.machine

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

    effective_nodes_required = max(nodes_required, pool.min_nodes)
    nodes_to_add = max(0, effective_nodes_required - pool.current_nodes)

    # A removal only instructs when the sizing placed every pod behind it:
    # oversized pods were excluded above, and a pool with nothing placeable at
    # all would be told to remove every node it runs on.
    scale_down_blocked_reason: ScaleDownBlockedReason | None = None
    if oversized_pods:
        scale_down_blocked_reason = "oversized_pods"
    elif placeable_pod_count == 0 and pool.current_nodes > 0:
        scale_down_blocked_reason = "no_placeable_demand"

    nodes_to_remove = (
        0
        if scale_down_blocked_reason is not None
        else max(0, pool.current_nodes - effective_nodes_required)
    )
    node_headroom = pool.max_nodes - effective_nodes_required
    schedulable = not oversized_pods and effective_nodes_required <= pool.max_nodes

    return PoolScenarioResult(
        pool=pool.name,
        pod_count=pod_count,
        cpu_requested_m=cpu_requested_m,
        memory_requested_mib=memory_requested_mib,
        capacity_cpu_m=effective_nodes_required * machine.allocatable_cpu_m,
        capacity_memory_mib=(effective_nodes_required * machine.allocatable_memory_mib),
        nodes_required=nodes_required,
        effective_nodes_required=effective_nodes_required,
        current_nodes=pool.current_nodes,
        nodes_to_add=nodes_to_add,
        nodes_to_remove=nodes_to_remove,
        scale_down_blocked_reason=scale_down_blocked_reason,
        node_headroom=node_headroom,
        limiting_resource=limiting_resource,
        schedulable=schedulable,
        oversized_pod_count=len(oversized_pods),
        pods_per_node=pods_per_node,
        fragmentation_resource=fragmentation_resource,
    )


def evaluate_scenario(
    name: str,
    cluster: ClusterConfig,
    replicas: dict[str, int],
) -> ScenarioResult:
    validate(cluster)
    pods = build_pods(cluster, replicas)

    # Static partition: each workload packs onto exactly one pool. There is no
    # spillover between pools, matching a nodeSelector-pinned deployment.
    pods_by_pool: dict[str, list[PodRequest]] = {
        pool_name: [] for pool_name in cluster.node_pools
    }
    for pod in pods:
        workload = cluster.workloads[pod.workload_name]
        pods_by_pool[resolve_pool_name(cluster, workload)].append(pod)

    pool_results = {
        pool_name: _evaluate_pool_scenario(pool, pods_by_pool[pool_name])
        for pool_name, pool in cluster.node_pools.items()
    }

    return ScenarioResult(
        name=name,
        replicas=dict(replicas),
        pod_count=len(pods),
        cpu_requested_m=sum(result.cpu_requested_m for result in pool_results.values()),
        memory_requested_mib=sum(
            result.memory_requested_mib for result in pool_results.values()
        ),
        nodes_required=sum(result.nodes_required for result in pool_results.values()),
        effective_nodes_required=sum(
            result.effective_nodes_required for result in pool_results.values()
        ),
        current_nodes=sum(result.current_nodes for result in pool_results.values()),
        nodes_to_add=sum(result.nodes_to_add for result in pool_results.values()),
        nodes_to_remove=sum(result.nodes_to_remove for result in pool_results.values()),
        schedulable=all(result.schedulable for result in pool_results.values()),
        oversized_pod_count=sum(
            result.oversized_pod_count for result in pool_results.values()
        ),
        pools=pool_results,
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
        for name, workload in cluster.workloads.items()
    }

    current_replicas = {
        name: result.current_replicas for name, result in workload_results.items()
    }

    desired_replicas = {
        name: result.desired_replicas for name, result in workload_results.items()
    }

    max_replicas = {
        name: result.max_replicas for name, result in workload_results.items()
    }

    rollout_replicas = {
        name: result.rollout_replicas_at_max
        for name, result in workload_results.items()
    }

    min_replicas = {
        name: min_replicas_for(cluster.workloads[name]) for name in workload_results
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
    node_pools_added: tuple[str, ...]
    node_pools_removed: tuple[str, ...]


@dataclass(frozen=True)
class WorkloadDiff:
    raw_desired_replicas: ValueChange
    desired_replicas: ValueChange
    max_replicas: ValueChange
    rollout_replicas_at_max: ValueChange


@dataclass(frozen=True)
class ScenarioDiff:
    """Cluster-total impact changes.

    Per-pool fields (headroom, limiting resource) live on PoolScenarioResult
    and are not diffed here; a pool can appear or vanish between the two
    configurations, which a flat before/after pair cannot express.
    """

    pod_count: ValueChange
    cpu_requested_m: ValueChange
    memory_requested_mib: ValueChange
    nodes_required: ValueChange
    effective_nodes_required: ValueChange
    current_nodes: ValueChange
    nodes_to_add: ValueChange
    nodes_to_remove: ValueChange
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

    old_pools = baseline.node_pools.keys()
    new_pools = candidate.node_pools.keys()
    pools_added = tuple(sorted(new_pools - old_pools))
    pools_removed = tuple(sorted(old_pools - new_pools))

    changes: dict[str, ConfigValueChange] = {}
    for name in sorted(old_pools & new_pools):
        changes.update(
            _compare_config_values(
                baseline.node_pools[name],
                candidate.node_pools[name],
                f"node_pools.{name}",
            )
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
        node_pools_added=pools_added,
        node_pools_removed=pools_removed,
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
            schedulable_before=old.schedulable,
            schedulable_after=new.schedulable,
        )

    return ClusterDiff(workloads=workload_diffs, scenarios=scenario_diffs)


def compare(before: ClusterResult, after: ClusterResult) -> ClusterDiff:
    """Backward-compatible alias for compare_results."""
    return compare_results(before, after)
