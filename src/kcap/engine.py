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
class ContainerInfo:
    """One container's own requests, limits, and observed usage.

    Analysis-only. `Workload.resources` stays the single source of truth for
    packing, HPA math, and validation; this breakdown exists because a pod
    total cannot say which container inside it is the one living on borrowed
    CPU.

    Requests here are *effective* requests, after Kubernetes' request := limit
    defaulting (v1.33.0 pkg/apis/core/v1/defaults.go, SetDefaults_Pod, which
    copies Limits into Requests per resource key). So `None` means the
    container declared neither a request nor a limit for that resource and its
    guaranteed floor is effectively zero -- not that it declared only a limit,
    which defaults the request up to that limit. An explicit `0` is a distinct
    and legal value with the same floor. A `None` limit means unbounded.
    """

    name: str

    cpu_request_m: int | None = None
    memory_request_mib: int | None = None

    cpu_limit_m: int | None = None
    memory_limit_mib: int | None = None

    observed_cpu: UsageStat | None = None
    observed_memory: UsageStat | None = None


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

    # The pod above, broken down per container, when that is known. None is a
    # runtime state, not a legacy one: kcap's own workload editor is pod-level,
    # so anything typed in by hand has no container breakdown to report. Only
    # runtime-risk analysis reads this; placement, HPA, and node counts do not.
    containers: tuple[ContainerInfo, ...] | None = None

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
    def clamped_by(self) -> Literal["min", "max"] | None:
        """Which end of the HPA range held the recommendation, if either.

        Null means the metric recommendation stood; the direction decides
        whether the operator raises a ceiling or lowers a floor.
        """
        if self.raw_desired_replicas < self.desired_replicas:
            return "min"
        if self.raw_desired_replicas > self.desired_replicas:
            return "max"
        return None


ScaleDownBlockedReason = Literal["oversized_pods", "no_placeable_demand"]


@dataclass(frozen=True)
class ContentionFlag:
    """One workload — or one container inside it — living on borrowed CPU.

    The claim is an entitlement claim, not a prediction: the guaranteed floor
    is the CPU request, and everything observed above it exists only while
    neighbors are idle. Flags are raised only for units placed on a contended
    node, and aggregate per (workload, container) because the operator question
    is "which of my workloads are exposed", not "what happened on node 4".
    """

    workload: str

    # Which container inside the pod is borrowing. None means the flag is
    # pod-level, which is the common case rather than a degraded one: kcap's
    # editor is pod-level, so a hand-built workload has no breakdown, and an
    # edited one has had its breakdown dropped.
    container: str | None

    # The guaranteed floor this reading is measured against. 0 for a container
    # that declared neither a request nor a limit: upstream still gives such a
    # container the minimum two CPU shares rather than literally none, which at
    # a fifth of a percent of one core is a floor of effectively zero.
    cpu_request_m: int
    usage_cpu_m: int
    usage_basis: UsageBasis

    # Replicas of this workload sharing a contended node, out of the scenario's
    # replicas for it in this pool. Every replica of a workload has the same
    # shape, so a flagged workload is never one of the oversized ones and the
    # total is always a count of placed pods.
    replicas_affected: int
    replicas_total: int

    # Proportional share of one node's allocatable CPU at this unit's share of
    # the node's requests, capped at its CPU limit and at what the node has,
    # minimized over the contended nodes hosting it. A bound on the entitlement,
    # never a prediction of usage.
    worst_case_share_m: int

    # One plain sentence carrying the numbers above, composed here so every
    # consumer of the API reports contention identically.
    message: str


@dataclass(frozen=True)
class CpuContention:
    """Entitlement-based CPU contention for one pool in one scenario.

    Memory is deliberately absent: memory does not compress, so a node that
    cannot satisfy every pod at once kills rather than shares, which is a limit
    exposure question and not a contention one.
    """

    # Nodes the packer opened for this pool. Fewer than the pool's node count
    # when min_nodes exceeds demand. The DaemonSet *pods* are outside this
    # entirely — no usage of theirs is summed and they hold no slot — while the
    # reservation standing in for them is inside every figure, since it is what
    # allocatable subtracts.
    nodes_evaluated: int
    contended_node_count: int

    # Empty means all clear on this packing.
    flags: tuple[ContentionFlag, ...]

    # Zero to two one-liners naming what weakened the reading above. Distinct
    # from the importer's capture-window note: that describes the data, these
    # describe what this analysis did with it.
    basis_notes: tuple[str, ...]


@dataclass(frozen=True)
class LimitExposure:
    """How far one pool's packed nodes can be driven by declared limits alone.

    Contention asks what happens when neighbors compete for a compressible
    resource. This asks the incompressible question: if every pod on a node
    grew to the ceiling it declared, would the node survive it? A pod with no
    memory limit can grow to the whole node, so it counts as the whole node.
    """

    # Nodes the packer opened for this pool, on the same terms as CpuContention
    # counts them.
    nodes_evaluated: int

    # Nodes whose placed pods' memory ceilings outrun allocatable memory. Such
    # a node can be exhausted by pods that never exceed what they declared.
    memory_exhaustible_node_count: int

    # The worst node's ceilings as a percentage of its allocatable memory.
    memory_max_limit_percent: float

    # Placed pods with no memory limit. Reported on its own because each one
    # substitutes a whole node into the percentage above, which is true but
    # drowns the number: one such pod beside anything else already exceeds 100%.
    memory_unlimited_pod_count: int

    # The worst node's *declared* CPU limits over its allocatable CPU, and
    # informational only — CPU compresses, so an overcommitted node throttles
    # rather than kills. A pod without a CPU limit adds nothing here, unlike its
    # memory counterpart: it cannot exhaust anything, and substituting the node
    # for it would turn the ratio into a pod count. None when nothing declares a
    # CPU limit at all.
    cpu_max_limit_percent: float | None

    # Zero to two plain sentences. Empty means no node here can be exhausted by
    # pods behaving within their limits.
    flags: tuple[str, ...]


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

    # Runtime risk from the packing above. Both are None when the packer opened
    # no nodes — a pool with nothing placeable has no node to be contended, and
    # none to be exhausted either.
    cpu_contention: CpuContention | None
    limit_exposure: LimitExposure | None

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

    # Pods placed here, in placement order. The packer used to collapse to a
    # node count, discarding which pods ended up sharing a node — the one fact
    # runtime-risk analysis needs and aggregate arithmetic cannot recover.
    # Retained for that analysis only: nothing in the sizing math reads it, and
    # it stays internal to the engine rather than reaching the API.
    #
    # Three things a consumer must not assume. The remaining figures above
    # start from *allocatable* (machine minus reserved), so summing this list
    # gives what workload pods asked for and not what the node carries — the
    # DaemonSet reservation is already outside the arithmetic, and takes no
    # max_pods slot either. Oversized pods are excluded from packing entirely,
    # so some of a scenario's pods sit on no NodeAllocation at all. And a pool
    # reports at least min_nodes, so there can be fewer of these than nodes.
    pods: list[PodRequest] = field(default_factory=list)

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
        self.pods.append(pod)


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


def _validate_containers(
    name: str,
    containers: tuple[ContainerInfo, ...] | None,
) -> None:
    """Check a per-container breakdown for shapes no pod could have.

    Deliberately light, and deliberately without any cross-check against the
    pod-level totals: those carry Kubernetes' effective-request semantics, so
    they do not equal a plain sum of this list whenever an init container
    dominates, and forcing agreement would corrupt the number that packs.

    Names are required and must be distinct because analysis is reported per
    (workload, container), and Kubernetes guarantees it can be: container names
    are unique across the union of containers, initContainers, and
    ephemeralContainers. Upstream: kubernetes/kubernetes v1.33.0
    pkg/apis/core/validation/validation.go, validateContainers() and
    validateInitContainers() -- the latter seeds its `allNames` set from the
    regular containers before checking its own.
    """
    if containers is None:
        return
    if not containers:
        raise ValueError(
            f"{name}: container breakdown cannot be empty; omit it instead"
        )

    seen: set[str] = set()
    for container in containers:
        # Blank as well as empty: the name has to identify a container to a
        # reader, and Kubernetes requires a DNS-1123 label, which whitespace
        # is not.
        if not container.name.strip():
            raise ValueError(f"{name}: container name cannot be empty")
        if container.name in seen:
            raise ValueError(f"{name}: duplicate container name {container.name!r}")
        seen.add(container.name)

        label = f"{name}/{container.name}"
        for quantity, value in (
            ("CPU request", container.cpu_request_m),
            ("memory request", container.memory_request_mib),
            ("CPU limit", container.cpu_limit_m),
            ("memory limit", container.memory_limit_mib),
        ):
            if value is not None and value < 0:
                raise ValueError(f"{label}: container {quantity} cannot be negative")

        # Within one container, a request above its own limit is a shape
        # Kubernetes rejects outright (v1.33.0
        # pkg/apis/core/validation/validation.go, validateResourceRequirements:
        # "must be less than or equal to ... limit"). This is an ordering
        # invariant inside a single container, the same kind as peak >= avg
        # below -- not the pod-level cross-check excluded above. It matters
        # because the analysis this list feeds caps a container's worst-case
        # share at its limit, which an inverted pair turns into nonsense.
        for quantity, request, limit in (
            ("CPU", container.cpu_request_m, container.cpu_limit_m),
            ("memory", container.memory_request_mib, container.memory_limit_mib),
        ):
            if request is not None and limit is not None and request > limit:
                raise ValueError(
                    f"{label}: container {quantity} request cannot exceed its limit"
                )

        _validate_usage_stat(label, "CPU", container.observed_cpu)
        _validate_usage_stat(label, "memory", container.observed_memory)


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
    _validate_containers(name, workload.containers)
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


@dataclass(frozen=True)
class _Borrower:
    """One unit inside a pod whose observed CPU sits above its own request."""

    container: str | None
    cpu_request_m: int
    usage_cpu_m: int
    usage_basis: UsageBasis
    cpu_limit_m: int | None


def _pod_reading(workload: Workload) -> tuple[int, UsageBasis | None]:
    """One of this workload's pods as a CPU figure, and the statistic behind it.

    Exposure-basis usage when the workload has any, and the pod's request with a
    None basis when it has none — the scheduler's own assumption, so a workload
    with no metrics can neither hide contention nor fabricate it.

    The single source for the three questions that ask it: what a pod
    contributes to its node, whether that contribution was a fallback, and
    whether the pod is running above its own request. Answering them separately
    is how they drift apart.

    Deliberately pod-level even when a breakdown is present. Per-container peaks
    do not sum — the maximum of a sum is not the sum of the maxima — so adding
    them would describe a moment where every container peaked together, which is
    the reading Session E rejected when it defined `peak` at all.
    """
    stat = workload.observed_cpu_per_pod
    if stat is None:
        return workload.resources.cpu_request_m, None
    return stat.exposure()


def _node_cpu_usage_m(node: NodeAllocation, workloads: dict[str, Workload]) -> int:
    """What the pods on one node are observed to want, together.

    Summed from *pod* readings only. A container's usage is already inside its
    pod's figure, so adding the breakdown here as well would invent load.
    """
    return sum(_pod_reading(workloads[pod.workload_name])[0] for pod in node.pods)


def _pod_borrower(workload: Workload) -> list[_Borrower]:
    """The pod itself, when its reading sits above the pod's own CPU request."""
    usage_cpu_m, usage_basis = _pod_reading(workload)
    if usage_basis is None or usage_cpu_m <= workload.resources.cpu_request_m:
        # A pod with no reading contributed its request, so by construction it
        # cannot have been observed above it.
        return []
    return [
        _Borrower(
            container=None,
            cpu_request_m=workload.resources.cpu_request_m,
            usage_cpu_m=usage_cpu_m,
            usage_basis=usage_basis,
            cpu_limit_m=workload.resources.cpu_limit_m,
        )
    ]


def _borrowers(workload: Workload) -> list[_Borrower]:
    """Which units of one of this workload's pods live above their CPU request.

    Per-container when the breakdown names one, pod-level otherwise. The list is
    never required — `Workload.containers` is absent for every hand-built
    workload — and a breakdown that names nobody falls back to the pod rather
    than silencing it. That fallback is load-bearing: an injected sidecar has no
    spec counterpart, so by the importer's design its usage reaches only the pod
    figure, and without it that pod would contend a node and be reported by
    nothing, so adding a breakdown would *remove* a flag.

    What the fallback does not do is reconcile the two levels. When the
    breakdown names *some* borrower, only container rows are emitted, and they
    attribute only what the breakdown can see: a pod 2500m above its request
    whose one listed borrower is 281m above its own reports the 281m. That is
    the shape the design chose — flags are per (workload, container), and §1.3
    forbids cross-checking the breakdown against pod totals derived with
    effective-request semantics — so the unattributed remainder is a known limit
    of the attribution, not of the flag.

    A container that declared neither a request nor a limit is measured against
    a floor of zero, so any usage at all flags it. That is deliberately the same
    rule every other unit gets rather than a special case: nothing in this
    analysis filters by magnitude, a 20m container against a 19m request already
    flags, and exempting the containers with *no* floor would silence the most
    exposed shape on the node. The magnitude is in the row for the reader.
    """
    borrowers = []
    for container in workload.containers or ():
        if container.observed_cpu is None:
            continue
        usage_cpu_m, usage_basis = container.observed_cpu.exposure()
        cpu_request_m = (
            0 if container.cpu_request_m is None else container.cpu_request_m
        )
        if usage_cpu_m > cpu_request_m:
            borrowers.append(
                _Borrower(
                    container=container.name,
                    cpu_request_m=cpu_request_m,
                    usage_cpu_m=usage_cpu_m,
                    usage_basis=usage_basis,
                    cpu_limit_m=container.cpu_limit_m,
                )
            )
    return borrowers or _pod_borrower(workload)


def _fallback_bases(workload: Workload) -> set[UsageBasis]:
    """Statistics below `peak` that this workload's contention reading used.

    Both levels are read — the pod stat drives every node sum, the container
    stats decide who inside the pod is named — so a fallback at either weakens
    the result and belongs in the notes. Per-container averages carry a known
    downward bias (a container absent from a sample counts as zero for it), so
    a container that falls back to avg is exactly what those notes are for.
    """
    bases: set[UsageBasis] = set()
    stats = [workload.observed_cpu_per_pod] + [
        container.observed_cpu for container in workload.containers or ()
    ]
    for stat in stats:
        if stat is None:
            continue
        _, basis = stat.exposure()
        if basis != "peak":
            bases.add(basis)
    return bases


def _worst_case_share_m(
    cpu_request_m: int,
    node_request_total_m: int,
    allocatable_cpu_m: int,
    cpu_limit_m: int | None,
) -> int:
    """This unit's proportional share of one node if everything peaks at once.

    Deliberately not a cpu.shares simulation: it flattens the pod and QoS cgroup
    nesting a kubelet builds into a single proportional division, and assumes
    every neighbor is runnable. That makes it a floor on the entitlement rather
    than a forecast of what the container will get.

    Never more than the node has. A pod request cannot exceed the node's own
    total, but a *container* request can: the breakdown is deliberately not
    cross-checked against the pod totals, so a container may claim more than the
    pod it belongs to, and the raw ratio would then report a share larger than
    the machine.
    """
    share_m = min(
        cpu_request_m * allocatable_cpu_m // node_request_total_m,
        allocatable_cpu_m,
    )
    if cpu_limit_m is None:
        return share_m
    return min(share_m, cpu_limit_m)


_BASIS_PHRASES: dict[UsageBasis, str] = {
    "peak": "peaks at",
    "p95": "reaches a p95 of",
    "avg": "averages",
}


@dataclass(frozen=True)
class _Exposure:
    """One (workload, container) aggregated over the contended nodes hosting it."""

    borrower: _Borrower
    replicas_affected: int
    # How many contended nodes those replicas are spread over. Not reported on
    # its own; it decides whether the flag's sentence says "a contended node" or
    # "contended nodes", which several replicas on one node otherwise get wrong.
    contended_node_count: int
    worst_case_share_m: int


def _aggregate_exposures(
    contended_nodes: list[NodeAllocation],
    workloads: dict[str, Workload],
    allocatable_cpu_m: int,
) -> dict[tuple[str, str | None], _Exposure]:
    """Collapse the contended nodes into one entry per borrowing unit.

    Node by node, then folded: the reading and the bound are constant per unit
    on a given node — every replica of a workload has the same shape — so a node
    contributes a replica count, one node to the spread, and one candidate for
    the tightest bound.
    """
    if not contended_nodes:
        return {}

    # Constant per workload, and asked once per replica per node otherwise.
    borrowers_by_workload = {
        name: _borrowers(workload) for name, workload in workloads.items()
    }

    exposures: dict[tuple[str, str | None], _Exposure] = {}
    for node in contended_nodes:
        node_request_total_m = sum(pod.cpu_m for pod in node.pods)
        replicas_here: dict[tuple[str, str | None], int] = {}
        borrower_here: dict[tuple[str, str | None], _Borrower] = {}
        for pod in node.pods:
            for borrower in borrowers_by_workload[pod.workload_name]:
                key = (pod.workload_name, borrower.container)
                replicas_here[key] = replicas_here.get(key, 0) + 1
                borrower_here[key] = borrower

        for key, replicas in replicas_here.items():
            borrower = borrower_here[key]
            bound_m = _worst_case_share_m(
                borrower.cpu_request_m,
                node_request_total_m,
                allocatable_cpu_m,
                borrower.cpu_limit_m,
            )
            seen = exposures.get(key)
            exposures[key] = _Exposure(
                borrower=borrower,
                replicas_affected=(
                    replicas if seen is None else seen.replicas_affected + replicas
                ),
                contended_node_count=(
                    1 if seen is None else seen.contended_node_count + 1
                ),
                worst_case_share_m=(
                    bound_m if seen is None else min(seen.worst_case_share_m, bound_m)
                ),
            )
    return exposures


def _contention_flag(
    workload_name: str,
    exposure: _Exposure,
    replicas_total: int,
) -> ContentionFlag:
    """One flag, including the sentence that carries every number on it."""
    borrower = exposure.borrower
    subject = (
        workload_name
        if borrower.container is None
        else f"{borrower.container} in {workload_name}"
    )
    against = (
        "no CPU request"
        if borrower.cpu_request_m == 0
        else f"a {borrower.cpu_request_m}m request"
    )
    noun = "replica" if replicas_total == 1 else "replicas"
    verb = "shares" if exposure.replicas_affected == 1 else "share"
    nodes = (
        "a contended node" if exposure.contended_node_count == 1 else "contended nodes"
    )
    shared = f"{exposure.replicas_affected} of {replicas_total} {noun} {verb} {nodes}"
    return ContentionFlag(
        workload=workload_name,
        container=borrower.container,
        cpu_request_m=borrower.cpu_request_m,
        usage_cpu_m=borrower.usage_cpu_m,
        usage_basis=borrower.usage_basis,
        replicas_affected=exposure.replicas_affected,
        replicas_total=replicas_total,
        worst_case_share_m=exposure.worst_case_share_m,
        message=(
            f"{subject} {_BASIS_PHRASES[borrower.usage_basis]} "
            f"{borrower.usage_cpu_m}m against {against}; {shared}. "
            f"Worst-case bound if every neighbor peaks at once: "
            f"{exposure.worst_case_share_m}m."
        ),
    )


def _basis_notes(
    packed_nodes: list[NodeAllocation],
    workloads: dict[str, Workload],
) -> tuple[str, ...]:
    """Zero to two one-liners saying what weakened the flags above.

    Counted over every placed pod, not only the flagged ones: a reading that
    fell back on a node that came out uncontended is precisely how contention
    hides, which is what makes the whole block a lower bound.

    The second note says *pod-level* deliberately. Node pressure is a pod-level
    reading, so a workload carrying only a per-container breakdown still
    contributes its request — saying it "had no usage data" would be false of
    exactly that workload, which does have usage, at a level this sum does not
    read.
    """
    placed = sorted({pod.workload_name for node in packed_nodes for pod in node.pods})
    fallen_back = {
        name: bases for name in placed if (bases := _fallback_bases(workloads[name]))
    }
    request_pods = sum(
        1
        for node in packed_nodes
        for pod in node.pods
        if _pod_reading(workloads[pod.workload_name])[1] is None
    )

    notes: list[str] = []
    if fallen_back:
        count = len(fallen_back)
        subject = "workload" if count == 1 else "workloads"
        used = " and ".join(
            sorted({basis for bases in fallen_back.values() for basis in bases})
        )
        notes.append(
            f"Peak unavailable for {count} {subject} — {used} used; "
            f"contention here is a lower bound."
        )
    if request_pods == 1:
        notes.append("1 pod had no pod-level usage data — its request was used.")
    elif request_pods > 1:
        notes.append(
            f"{request_pods} pods had no pod-level usage data — "
            f"their requests were used."
        )
    return tuple(notes)


def _evaluate_cpu_contention(
    machine: MachineSpec,
    packed_nodes: list[NodeAllocation],
    pods: list[PodRequest],
    workloads: dict[str, Workload],
) -> CpuContention | None:
    """Flag the workloads on this packing that depend on borrowed CPU.

    A node is contended when its placed pods together want more CPU than it can
    schedule; the units on such a node observed above their own request are the
    ones borrowing. `pods` is the pool's whole set, oversized pods included, and
    supplies the replica totals the flags are reported against.
    """
    if not packed_nodes:
        return None

    allocatable_cpu_m = machine.allocatable_cpu_m
    contended_nodes = [
        node
        for node in packed_nodes
        if _node_cpu_usage_m(node, workloads) > allocatable_cpu_m
    ]
    exposures = _aggregate_exposures(contended_nodes, workloads, allocatable_cpu_m)

    replicas_total: dict[str, int] = {}
    for pod in pods:
        replicas_total[pod.workload_name] = replicas_total.get(pod.workload_name, 0) + 1

    # Sorted rather than emitted in placement order: a stable, packing-independent
    # order lets the same workload be read across scenario tabs.
    ordered = sorted(exposures, key=lambda key: (key[0], key[1] or ""))

    return CpuContention(
        nodes_evaluated=len(packed_nodes),
        contended_node_count=len(contended_nodes),
        flags=tuple(
            _contention_flag(key[0], exposures[key], replicas_total[key[0]])
            for key in ordered
        ),
        basis_notes=_basis_notes(packed_nodes, workloads),
    )


def _memory_ceiling_mib(resources: list[Resources], allocatable_mib: int) -> int:
    """What one node's pods could claim together while honoring their limits.

    A pod with no memory limit substitutes the whole node: nothing it declared
    stops it from taking everything there is.
    """
    return sum(
        allocatable_mib
        if resource.memory_limit_mib is None
        else resource.memory_limit_mib
        for resource in resources
    )


def _percent_of_allocatable(value: int, allocatable: int) -> float:
    """A percentage that never rounds across the boundary the MiB count decides.

    Exhaustibility is settled in whole MiB, so a node one MiB over its
    allocatable is exhaustible while its true percentage rounds to a flat
    100.0 — a number that contradicts the sentence printed beside it. Inside
    that last tenth of a percent the figure is moved to the correct side of 100
    rather than to the nearest tenth: which side of the line a node sits on is
    what the reader needs, and the tenth is not.

    `allocatable` cannot be zero: `validate` requires each pool's reservation to
    be strictly below its machine in both dimensions.
    """
    rounded = round(value / allocatable * 100, 1)
    if value > allocatable and rounded <= 100.0:
        return 100.1
    if value < allocatable and rounded >= 100.0:
        return 99.9
    return rounded


def _format_percent(percent: float) -> str:
    """A percentage without a trailing `.0`, so a whole number reads as one."""
    return f"{percent:.1f}".removesuffix(".0")


def _exposure_flags(
    nodes_evaluated: int,
    exhaustible_nodes: int,
    memory_max_percent: float,
    unlimited_pods: int,
) -> tuple[str, ...]:
    """Zero to two plain sentences naming what the numbers above mean.

    Two words are load-bearing. **Ceilings**, not limits: a pod that declares no
    memory limit contributes the whole node, so calling the total a sum of
    limits would send the reader looking for a declaration nobody made — the
    second sentence is what explains where the number came from, and it fires
    whenever such a pod is placed. And **most exposed**, not fullest: the node
    reported is the one with the highest ceiling, which is routinely not the one
    carrying the most requests.
    """
    flags: list[str] = []
    if exhaustible_nodes:
        noun = "node" if nodes_evaluated == 1 else "nodes"
        flags.append(
            f"Memory ceilings on the most exposed node reach "
            f"{_format_percent(memory_max_percent)}% of allocatable — "
            f"{exhaustible_nodes} of {nodes_evaluated} {noun} can be exhausted "
            f"by pods behaving within their limits."
        )
    if unlimited_pods == 1:
        # "Any node it shares", not any node hosting it: alone on a node such a
        # pod claims exactly what the node has, so it takes a neighbor to push
        # the ceiling past allocatable.
        flags.append(
            "1 pod carries no memory limit; it can claim its whole node, so "
            "any node it shares can be exhausted."
        )
    elif unlimited_pods > 1:
        flags.append(
            f"{unlimited_pods} pods carry no memory limit; each can claim its "
            f"whole node, so any node they share can be exhausted."
        )
    return tuple(flags)


def _evaluate_limit_exposure(
    machine: MachineSpec,
    packed_nodes: list[NodeAllocation],
    workloads: dict[str, Workload],
) -> LimitExposure | None:
    """Read how far this packing's nodes can be driven by declared limits alone.

    Requests decided the packing; this asks what the same nodes look like if
    every pod on them grew to the ceiling it declared. Memory is the question
    that matters — a node whose ceilings outrun its allocatable memory can be
    exhausted by pods that never misbehave — and CPU rides along as a ratio
    only, because an overcommitted CPU throttles where memory kills.

    Pod-level limits are the whole input. The per-container breakdown is not
    read here: it is deliberately never cross-checked against the pod totals,
    so summing it would produce a second, disagreeing ceiling for the same pod.
    """
    if not packed_nodes:
        return None

    memory_allocatable = machine.allocatable_memory_mib
    cpu_allocatable = machine.allocatable_cpu_m
    per_node = [
        [workloads[pod.workload_name].resources for pod in node.pods]
        for node in packed_nodes
    ]

    memory_ceilings = [
        _memory_ceiling_mib(node, memory_allocatable) for node in per_node
    ]
    # Counted in MiB rather than off the percentages: a node whose ceilings come
    # to exactly its allocatable is not exhaustible, and a rounded percentage
    # cannot be trusted to say which side of that line a node is on.
    exhaustible_nodes = sum(
        1 for ceiling in memory_ceilings if ceiling > memory_allocatable
    )
    memory_max_percent = _percent_of_allocatable(
        max(memory_ceilings), memory_allocatable
    )
    unlimited_pods = sum(
        1 for node in per_node for resource in node if resource.memory_limit_mib is None
    )

    # Declared CPU limits only — a pod without one adds nothing, where its
    # memory counterpart adds the whole node. The substitution earns its place
    # on the memory side because an unlimited pod really can exhaust the node;
    # on the CPU side it would only add 100% per pod without a limit, turning an
    # overcommit ratio into a pod count. Null when the sum has no declaration
    # behind it at all, since 0% would read as a finding of its own.
    declared_cpu_m = [
        sum(resource.cpu_limit_m or 0 for resource in node) for node in per_node
    ]
    cpu_max_percent = None
    if any(resource.cpu_limit_m is not None for node in per_node for resource in node):
        cpu_max_percent = _percent_of_allocatable(max(declared_cpu_m), cpu_allocatable)

    return LimitExposure(
        nodes_evaluated=len(packed_nodes),
        memory_exhaustible_node_count=exhaustible_nodes,
        memory_max_limit_percent=memory_max_percent,
        memory_unlimited_pod_count=unlimited_pods,
        cpu_max_limit_percent=cpu_max_percent,
        flags=_exposure_flags(
            len(packed_nodes),
            exhaustible_nodes,
            memory_max_percent,
            unlimited_pods,
        ),
    )


def _evaluate_pool_scenario(
    pool: NodePool,
    pods: list[PodRequest],
    workloads: dict[str, Workload],
) -> PoolScenarioResult:
    """Pack one pool's pods onto its machine shape and size the pool.

    `workloads` is the seam for per-node runtime-risk analysis: the packer
    retains its placements, and reaching a placed pod's requests, limits, and
    observed usage means looking the pod's workload up by name. The sizing math
    below reads neither — runtime risk is additive context, not a new verdict
    channel, so no node count moves because of it.
    """
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
        cpu_contention=_evaluate_cpu_contention(machine, packed_nodes, pods, workloads),
        limit_exposure=_evaluate_limit_exposure(machine, packed_nodes, workloads),
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
        pool_name: _evaluate_pool_scenario(
            pool, pods_by_pool[pool_name], cluster.workloads
        )
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
