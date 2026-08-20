"""HTTP transport schemas and domain-model adapters."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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

    Which statistic is read is a convention: HPA math reads `avg`, sizing
    suggestions read `p95`, and exposure/entitlement analysis reads `peak`.
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


# Pre-distribution scalar usage fields, mapped to the field that replaced each.
_LEGACY_USAGE_FIELDS = {
    "observed_cpu_per_pod_m": "observed_cpu_per_pod",
    "observed_memory_per_pod_mib": "observed_memory_per_pod",
}


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
    # Declared so the deprecation is visible in the OpenAPI schema and the
    # generated client types. _accept_legacy_usage consumes them before field
    # validation, so a validated model always carries None here.
    observed_cpu_per_pod_m: int | None = Field(
        default=None,
        deprecated=True,
        description=(
            "Deprecated: send observed_cpu_per_pod.avg instead. A scalar was "
            "always an average, so it is accepted and normalized into "
            "observed_cpu_per_pod, which is where it is validated and where "
            "any error names it; responses never carry it."
        ),
    )
    observed_memory_per_pod_mib: int | None = Field(
        default=None,
        deprecated=True,
        description=(
            "Deprecated: send observed_memory_per_pod.avg instead. A scalar "
            "was always an average, so it is accepted and normalized into "
            "observed_memory_per_pod, which is where it is validated and "
            "where any error names it; responses never carry it."
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

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_usage(_cls, data: Any) -> Any:
        """Normalize the pre-distribution scalar usage fields into statistics.

        A scalar observed value was always an average, so it becomes
        `{"avg": value}`. Runs before field validation, and refuses both forms
        for one dimension, on the _accept_legacy_node_pool precedent.

        Two forms means two *values*, not two keys: unlike the legacy
        node_pool, both usage fields are declared and nullable, and a client
        that names every field it knows sends the one it does not use as null.
        """
        if not isinstance(data, dict):
            return data
        legacy_keys = [key for key in _LEGACY_USAGE_FIELDS if key in data]
        if not legacy_keys:
            return data

        data = dict(data)
        for legacy in legacy_keys:
            current = _LEGACY_USAGE_FIELDS[legacy]
            value = data.pop(legacy)
            if value is None:
                continue
            if data.get(current) is not None:
                raise ValueError(f"Provide {current} or the legacy {legacy}, not both")
            data[current] = {"avg": value}
        return data

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

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_node_pool(_cls, data: Any) -> Any:
        """Normalize the pre-multi-pool `node_pool` key into `node_pools`.

        Runs before field validation because extra="forbid" would otherwise
        reject the legacy key outright.
        """
        if not isinstance(data, dict) or "node_pool" not in data:
            return data
        if "node_pools" in data:
            raise ValueError("Provide node_pools or the legacy node_pool, not both")

        data = dict(data)
        pool = data.pop("node_pool")
        name = pool.get("name") if isinstance(pool, dict) else None
        if not isinstance(name, str) or not name:
            raise ValueError("node_pool.name is required")
        data["node_pools"] = {name: pool}
        return data

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
    hpa_saturated: bool
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
