"""HTTP transport schemas and domain-model adapters."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from . import engine


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class ResourcesSchema(ApiModel):
    cpu_request_m: int = Field(
        gt=0,
        description="Per-pod CPU request in millicores; used for scheduling.",
    )
    memory_request_mib: int = Field(
        gt=0,
        description="Per-pod memory request in MiB; used for scheduling.",
    )
    cpu_limit_m: int | None = Field(
        default=None,
        gt=0,
        description="Optional per-pod CPU runtime limit in millicores.",
    )
    memory_limit_mib: int | None = Field(
        default=None,
        gt=0,
        description="Optional per-pod memory runtime limit in MiB.",
    )

    def to_domain(self) -> engine.Resources:
        return engine.Resources(**self.model_dump())


class HpaSchema(ApiModel):
    min_replicas: int = Field(ge=0)
    max_replicas: int = Field(ge=0)
    cpu_target_percentage: float | None = Field(
        default=None,
        gt=0,
        description="Target CPU usage as a percentage of the CPU request.",
    )
    memory_target_percentage: float | None = Field(
        default=None,
        gt=0,
        description="Target memory usage as a percentage of the memory request.",
    )

    def to_domain(self) -> engine.HPA:
        return engine.HPA(**self.model_dump())


class RolloutSchema(ApiModel):
    max_surge_percent: float = Field(
        default=25.0,
        ge=0,
        description=(
            "Rollout surge as a percentage of max replicas, rounded up. "
            "Ignored when max_surge_pods is set."
        ),
    )
    max_surge_pods: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Absolute rollout surge in pods, mirroring an integer Deployment "
            "maxSurge. Takes precedence over max_surge_percent when set, "
            "including when set to 0."
        ),
    )

    def to_domain(self) -> engine.Rollout:
        return engine.Rollout(**self.model_dump())


class UsageStatSchema(ApiModel):
    """Observed per-pod usage in one dimension, in that dimension's units.

    Which statistic is read is a convention: HPA math reads `avg`, and
    exposure/entitlement analysis reads the highest one available — `peak`,
    else `p95`, else `avg` — reporting which it fell back to.
    """

    avg: int = Field(
        ge=0,
        description=(
            "Average observed usage per pod, in millicores or MiB. HPA "
            "utilization is computed from this value."
        ),
    )
    p95: int | None = Field(
        default=None,
        ge=0,
        description="95th-percentile observed usage per pod, when measured.",
    )
    peak: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Maximum observed usage per pod, when measured. Must be at least "
            "avg, and at least p95 when both are given; a point-in-time "
            "snapshot cannot supply one. That ordering is a domain invariant, "
            "so violating it returns a 422 carrying a message rather than a "
            "field location."
        ),
    )

    def to_domain(self) -> engine.UsageStat:
        return engine.UsageStat(**self.model_dump())


class ContainerInfoSchema(ApiModel):
    """One container's own requests, limits, and observed usage.

    Analysis-only, and deliberately not cross-checked against the pod-level
    `resources`: those carry Kubernetes' effective-request semantics, so they
    do not equal a plain sum of this list whenever an init container dominates.
    """

    name: str = Field(
        min_length=1,
        description=(
            "Container name as the pod spec spells it. Unique within a pod, "
            "and how observed per-container usage is matched to a container."
        ),
    )
    cpu_request_m: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Effective per-container CPU request in millicores, after "
            "Kubernetes' request := limit defaulting. Null means the container "
            "declared neither a request nor a limit, so its guaranteed floor "
            "is effectively zero; an explicit 0 is legal and means the same "
            "floor, which is why this is ge=0 where the pod-level request is "
            "gt=0. Must not exceed cpu_limit_m when both are given."
        ),
    )
    memory_request_mib: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Effective per-container memory request in MiB, on the same rule "
            "as cpu_request_m; null when neither request nor limit was declared."
        ),
    )
    cpu_limit_m: int | None = Field(
        default=None,
        ge=0,
        description="Per-container CPU limit in millicores; null when unbounded.",
    )
    memory_limit_mib: int | None = Field(
        default=None,
        ge=0,
        description="Per-container memory limit in MiB; null when unbounded.",
    )
    observed_cpu: UsageStatSchema | None = Field(
        default=None,
        description="Observed CPU usage for this container, per pod, in millicores.",
    )
    observed_memory: UsageStatSchema | None = Field(
        default=None,
        description="Observed memory usage for this container, per pod, in MiB.",
    )

    def to_domain(self) -> engine.ContainerInfo:
        return engine.ContainerInfo(
            name=self.name,
            cpu_request_m=self.cpu_request_m,
            memory_request_mib=self.memory_request_mib,
            cpu_limit_m=self.cpu_limit_m,
            memory_limit_mib=self.memory_limit_mib,
            observed_cpu=(
                self.observed_cpu.to_domain() if self.observed_cpu is not None else None
            ),
            observed_memory=(
                self.observed_memory.to_domain()
                if self.observed_memory is not None
                else None
            ),
        )


class WorkloadSchema(ApiModel):
    name: str = Field(min_length=1)
    resources: ResourcesSchema
    current_replicas: int = Field(ge=0)
    observed_cpu_per_pod: UsageStatSchema | None = Field(
        default=None,
        description="Observed CPU usage per pod in millicores.",
    )
    observed_memory_per_pod: UsageStatSchema | None = Field(
        default=None,
        description="Observed memory usage per pod in MiB.",
    )
    usage_window_seconds: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Capture window behind the observed usage. Null or 0 means a "
            "point-in-time snapshot, which can report an average but no peak."
        ),
    )
    usage_source: str | None = Field(
        default=None,
        min_length=1,
        description=(
            "Where the observed usage came from, e.g. "
            "'metrics-server-snapshot' or 'manual'."
        ),
    )
    containers: list[ContainerInfoSchema] | None = Field(
        default=None,
        min_length=1,
        description=(
            "This workload's pod broken down per container, when that is "
            "known. Null for a workload configured by hand — kcap's editor is "
            "pod-level — and for an import that carried no container detail. "
            "Analysis-only: placement, HPA math, and node counts never read it."
        ),
    )
    hpa: HpaSchema | None = None
    rollout: RolloutSchema = Field(default_factory=RolloutSchema)
    pool: str | None = Field(
        default=None,
        min_length=1,
        description=(
            "Node pool this workload is pinned to. May be omitted only when "
            "the cluster has a single pool."
        ),
    )

    def to_domain(self) -> engine.Workload:
        return engine.Workload(
            name=self.name,
            resources=self.resources.to_domain(),
            current_replicas=self.current_replicas,
            observed_cpu_per_pod=(
                self.observed_cpu_per_pod.to_domain()
                if self.observed_cpu_per_pod is not None
                else None
            ),
            observed_memory_per_pod=(
                self.observed_memory_per_pod.to_domain()
                if self.observed_memory_per_pod is not None
                else None
            ),
            usage_window_seconds=self.usage_window_seconds,
            usage_source=self.usage_source,
            containers=(
                tuple(container.to_domain() for container in self.containers)
                if self.containers is not None
                else None
            ),
            hpa=self.hpa.to_domain() if self.hpa is not None else None,
            rollout=self.rollout.to_domain(),
            pool=self.pool,
        )


class MachineSpecSchema(ApiModel):
    cpu_m: int = Field(
        gt=0,
        description="Raw CPU capacity per node in millicores.",
    )
    memory_mib: int = Field(
        gt=0,
        description="Raw memory capacity per node in MiB.",
    )
    reserved_cpu_m: int = Field(
        default=0,
        ge=0,
        description=(
            "Per-node CPU unavailable to workload pods. Include OS, kubelet, "
            "CNI, cloud agents, and fixed platform DaemonSet overhead."
        ),
    )
    reserved_memory_mib: int = Field(
        default=0,
        ge=0,
        description=(
            "Per-node memory unavailable to workload pods. Include OS, "
            "kubelet, eviction reserve, CNI, cloud agents, and fixed "
            "platform DaemonSet overhead."
        ),
    )
    max_pods: int = Field(default=110, gt=0)

    def to_domain(self) -> engine.MachineSpec:
        return engine.MachineSpec(**self.model_dump())


class NodePoolSchema(ApiModel):
    name: str = Field(min_length=1)
    machine: MachineSpecSchema
    min_nodes: int = Field(ge=0)
    current_nodes: int = Field(ge=0)
    max_nodes: int = Field(ge=0)

    def to_domain(self) -> engine.NodePool:
        return engine.NodePool(
            name=self.name,
            machine=self.machine.to_domain(),
            min_nodes=self.min_nodes,
            current_nodes=self.current_nodes,
            max_nodes=self.max_nodes,
        )


class ClusterConfigSchema(ApiModel):
    workloads: dict[str, WorkloadSchema] = Field(
        min_length=1,
        description="Workloads keyed by their unique name.",
    )
    node_pools: dict[str, NodePoolSchema] = Field(
        min_length=1,
        description="Node pools keyed by their unique name.",
    )

    def to_domain(self) -> engine.ClusterConfig:
        return engine.ClusterConfig(
            workloads={
                name: workload.to_domain() for name, workload in self.workloads.items()
            },
            node_pools={
                name: pool.to_domain() for name, pool in self.node_pools.items()
            },
        )


class WorkloadResultSchema(ApiModel):
    name: str
    cpu_utilization_percent: float | None
    memory_utilization_percent: float | None
    current_replicas: int
    raw_desired_replicas: int
    desired_replicas: int
    clamped_by: Literal["min", "max"] | None = Field(
        default=None,
        description=(
            "Which end of the HPA range held the recommendation: 'min' when "
            "the floor raised it, 'max' when the ceiling capped it, null when "
            "it was not clamped."
        ),
    )
    max_replicas: int
    rollout_replicas_at_max: int


class ContentionFlagSchema(ApiModel):
    """One workload — or one container inside it — living on borrowed CPU.

    An entitlement claim, not a prediction: the guaranteed floor is the CPU
    request, and everything observed above it exists only while neighbors are
    idle.
    """

    workload: str
    # No default: this is a response model, the engine always populates it, and
    # a default would generate an optional field in the client types for
    # something that is always present.
    container: str | None = Field(
        description=(
            "Which container inside the pod is borrowing. Null means the flag "
            "is pod-level, which is the common case rather than a degraded "
            "one: kcap's editor is pod-level, so a hand-built workload carries "
            "no per-container breakdown and an edited one has had its "
            "breakdown dropped."
        ),
    )
    cpu_request_m: int = Field(
        description=(
            "The guaranteed floor this reading is measured against, in "
            "millicores. 0 for a container that declared neither a request nor "
            "a limit: upstream still grants it the minimum two CPU shares "
            "rather than none, which is a floor of effectively zero, so any "
            "usage at all is borrowed."
        ),
    )
    usage_cpu_m: int = Field(
        description="The exposure-basis usage that tripped the flag, in millicores.",
    )
    usage_basis: engine.UsageBasis = Field(
        description=(
            "Which observed statistic supplied usage_cpu_m. Anything below "
            "'peak' means the flag is a lower bound; basis_notes says so once "
            "for the pool."
        ),
    )
    replicas_affected: int = Field(
        description="Replicas of this workload sharing a contended node.",
    )
    replicas_total: int = Field(
        description=(
            "The scenario's replicas for this workload in this pool. Every "
            "replica of a workload has the same shape, so a flagged workload is "
            "never one of the oversized ones and this counts placed pods."
        ),
    )
    worst_case_share_m: int = Field(
        description=(
            "Proportional share of one node's allocatable CPU at this unit's "
            "share of the node's requests, capped at its CPU limit and at what "
            "the node has, minimized over the contended nodes hosting it. A "
            "bound on the entitlement, never a prediction of what the container "
            "will get."
        ),
    )
    message: str = Field(
        description=(
            "One plain sentence carrying the numbers above, composed by the "
            "engine so every consumer reports contention identically."
        ),
    )


class CpuContentionSchema(ApiModel):
    """Entitlement-based CPU contention for one pool in one scenario.

    Memory is deliberately absent: memory does not compress, so a node that
    cannot satisfy every pod at once kills rather than shares.
    """

    nodes_evaluated: int = Field(
        description=(
            "Nodes the packer opened for this pool. Fewer than the pool's node "
            "count when min_nodes exceeds demand."
        ),
    )
    contended_node_count: int = Field(
        description=(
            "Nodes whose placed pods' summed exposure-basis CPU usage exceeds "
            "allocatable CPU."
        ),
    )
    flags: list[ContentionFlagSchema] = Field(
        description="Empty means all clear on this packing.",
    )
    basis_notes: list[str] = Field(
        description=(
            "Zero to two one-liners naming what weakened the flags: usage that "
            "fell back below 'peak', and pods with no usage data whose request "
            "was assumed instead."
        ),
    )


class LimitExposureSchema(ApiModel):
    """How far one pool's packed nodes can be driven by declared limits alone.

    Contention asks what happens when neighbors compete for a compressible
    resource. This asks the incompressible question: if every pod on a node
    grew to the ceiling it declared, would the node survive it?
    """

    nodes_evaluated: int = Field(
        description=(
            "Nodes the packer opened for this pool. Fewer than the pool's node "
            "count when min_nodes exceeds demand."
        ),
    )
    memory_exhaustible_node_count: int = Field(
        description=(
            "Nodes whose placed pods' memory limits — a pod with none counting "
            "as the whole node — outrun allocatable memory. Such a node can be "
            "exhausted by pods that never exceed what they declared."
        ),
    )
    memory_max_limit_percent: float = Field(
        description=(
            "The worst node's memory ceilings as a percentage of its "
            "allocatable memory. Above 100 means that node is exhaustible — "
            "exhaustibility is settled in whole MiB, and this figure is kept on "
            "the matching side of 100 rather than rounded to the nearest tenth."
        ),
    )
    memory_unlimited_pod_count: int = Field(
        description=(
            "Placed pods with no memory limit. Reported on its own because "
            "each substitutes a whole node into the percentage above, which is "
            "true but drowns it: one such pod beside anything else already "
            "exceeds 100%."
        ),
    )
    # No default: this is a response model, the engine always populates it, and
    # a default would generate an optional field in the client types for
    # something that is always present.
    cpu_max_limit_percent: float | None = Field(
        description=(
            "The worst node's declared CPU limits as a percentage of its "
            "allocatable CPU, and informational only — CPU compresses, so an "
            "overcommitted node throttles rather than kills. A pod without a "
            "CPU limit adds nothing here, unlike its memory counterpart: it "
            "cannot exhaust anything, and substituting the node for it would "
            "turn the ratio into a pod count. Null when nothing declares a CPU "
            "limit at all."
        ),
    )
    flags: list[str] = Field(
        description=(
            "Zero to two plain sentences, composed by the engine so every "
            "consumer reports exposure identically. Empty means no node here "
            "can be exhausted by pods behaving within their limits."
        ),
    )


class PoolScenarioResultSchema(ApiModel):
    pool: str
    pod_count: int
    cpu_requested_m: int
    memory_requested_mib: int
    capacity_cpu_m: int
    capacity_memory_mib: int
    stranded_cpu_m: int
    stranded_memory_mib: int
    nodes_required: int
    effective_nodes_required: int
    current_nodes: int
    nodes_to_add: int
    nodes_to_remove: int
    scale_down_blocked_reason: engine.ScaleDownBlockedReason | None = Field(
        default=None,
        description=(
            "Why no scale-down is being instructed: 'oversized_pods' when pods "
            "too large for any node were excluded from the sizing, "
            "'no_placeable_demand' when a pool running nodes has nothing left "
            "to place, null otherwise. When set, nodes_to_remove is 0; the "
            "ungated difference remains current_nodes - effective_nodes_required."
        ),
    )
    node_headroom: int
    limiting_resource: str
    schedulable: bool
    oversized_pod_count: int
    pods_per_node: int | None
    fragmentation_resource: str | None
    cpu_contention: CpuContentionSchema | None = Field(
        description=(
            "Runtime CPU risk read off this pool's packing. Null when the "
            "packer opened no nodes — a pool with nothing placeable has no "
            "node that could be contended. Requests alone drive placement; "
            "this block is additive context, never a verdict."
        ),
    )
    limit_exposure: LimitExposureSchema | None = Field(
        description=(
            "Runtime exhaustion risk read off this pool's packing. Null on the "
            "same condition as cpu_contention: the packer opened no nodes, so "
            "there is none to exhaust. Additive context, never a verdict."
        ),
    )


class ScenarioResultSchema(ApiModel):
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
    pools: dict[str, PoolScenarioResultSchema]


class ClusterResultSchema(ApiModel):
    workloads: dict[str, WorkloadResultSchema]
    scenarios: dict[str, ScenarioResultSchema]


class ValueChangeSchema(ApiModel):
    before: int | float
    after: int | float
    delta: int | float


class ConfigValueChangeSchema(ApiModel):
    before: Any
    after: Any


class ConfigDiffSchema(ApiModel):
    changes: dict[str, ConfigValueChangeSchema]
    workloads_added: tuple[str, ...]
    workloads_removed: tuple[str, ...]
    node_pools_added: tuple[str, ...]
    node_pools_removed: tuple[str, ...]


class WorkloadDiffSchema(ApiModel):
    raw_desired_replicas: ValueChangeSchema
    desired_replicas: ValueChangeSchema
    max_replicas: ValueChangeSchema
    rollout_replicas_at_max: ValueChangeSchema


class ScenarioDiffSchema(ApiModel):
    pod_count: ValueChangeSchema
    cpu_requested_m: ValueChangeSchema
    memory_requested_mib: ValueChangeSchema
    nodes_required: ValueChangeSchema
    effective_nodes_required: ValueChangeSchema
    current_nodes: ValueChangeSchema
    nodes_to_add: ValueChangeSchema
    nodes_to_remove: ValueChangeSchema
    schedulable_before: bool
    schedulable_after: bool


class ClusterDiffSchema(ApiModel):
    workloads: dict[str, WorkloadDiffSchema]
    scenarios: dict[str, ScenarioDiffSchema]


class CompareRequest(ApiModel):
    baseline: ClusterConfigSchema
    candidate: ClusterConfigSchema


class CompareResponse(ApiModel):
    baseline_result: ClusterResultSchema
    candidate_result: ClusterResultSchema
    configuration_diff: ConfigDiffSchema
    impact_diff: ClusterDiffSchema


class HealthResponse(ApiModel):
    status: str
    version: str = Field(
        description="Running build version, injected at image build time.",
    )
