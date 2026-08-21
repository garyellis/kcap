from collections import Counter
from dataclasses import asdict, dataclass, replace
from math import ceil

import pytest

from kcap import engine
from kcap.engine import (
    HPA,
    HPA_TOLERANCE,
    ClusterConfig,
    ClusterResult,
    ContainerInfo,
    CpuContention,
    MachineSpec,
    NodeAllocation,
    NodePool,
    PodRequest,
    Resources,
    Rollout,
    UsageStat,
    Workload,
    WorkloadResult,
    add_workload,
    build_pods,
    compare_config,
    compare_results,
    evaluate,
    evaluate_hpa,
    evaluate_scenario,
    min_replicas_for,
    remove_workload,
    resolve_pool_name,
    update_cpu_limit,
    update_cpu_request,
    update_machine_cpu,
    validate,
)


def cluster_with(
    workload: Workload,
    *,
    machine: MachineSpec | None = None,
    min_nodes: int = 1,
    current_nodes: int = 2,
    max_nodes: int = 10,
) -> ClusterConfig:
    return ClusterConfig(
        workloads={workload.name: workload},
        node_pools={
            "default": NodePool(
                name="default",
                machine=machine or MachineSpec(cpu_m=4000, memory_mib=8192),
                min_nodes=min_nodes,
                current_nodes=current_nodes,
                max_nodes=max_nodes,
            ),
        },
    )


@pytest.fixture
def baseline() -> ClusterConfig:
    return cluster_with(
        Workload(
            "api",
            Resources(500, 128, cpu_limit_m=1000),
            current_replicas=2,
            hpa=HPA(1, 5, cpu_target_percentage=70),
        )
    )


class TestHpa:
    def test_no_metric_preserves_current_replicas(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(500, 256),
                current_replicas=7,
                hpa=HPA(min_replicas=2, max_replicas=10),
            )
        )

        result = evaluate(cluster)

        assert result.workloads["api"].desired_replicas == 7

    def test_current_usage_can_drive_scale_down(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(500, 1000),
                current_replicas=8,
                observed_cpu_per_pod=UsageStat(125),
                hpa=HPA(2, 20, cpu_target_percentage=50),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.cpu_utilization_percent == 25
        assert result.desired_replicas == 4

    def test_highest_metric_recommendation_drives_hpa(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(500, 1000),
                current_replicas=4,
                observed_cpu_per_pod=UsageStat(250),
                observed_memory_per_pod=UsageStat(1500),
                hpa=HPA(
                    2,
                    20,
                    cpu_target_percentage=50,
                    memory_target_percentage=75,
                ),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.cpu_utilization_percent == 50
        assert result.memory_utilization_percent == 150
        assert result.desired_replicas == 8

    def test_desired_replicas_are_clamped_to_hpa_range(self) -> None:
        high = cluster_with(
            Workload(
                name="api",
                resources=Resources(500, 256),
                current_replicas=4,
                observed_cpu_per_pod=UsageStat(1000),
                hpa=HPA(2, 6, cpu_target_percentage=50),
            )
        )
        low = replace(
            high,
            workloads={
                "api": replace(
                    high.workloads["api"],
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(0),
                )
            },
        )

        assert evaluate(high).workloads["api"].desired_replicas == 6
        assert evaluate(low).workloads["api"].desired_replicas == 2


class TestScheduling:
    def test_bin_packing_accounts_for_pod_shape(self) -> None:
        cluster = cluster_with(
            Workload("api", Resources(2000, 128), current_replicas=3),
            machine=MachineSpec(cpu_m=3800, memory_mib=8192),
        )

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.nodes_required == 3
        assert scenario.pools["default"].limiting_resource == "fragmentation"

    def test_scaling_fields_observe_ca_minimum_and_current_nodes(self) -> None:
        cluster = cluster_with(
            Workload("api", Resources(250, 128), current_replicas=1),
            min_nodes=3,
            current_nodes=6,
            max_nodes=20,
        )

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.nodes_required == 1
        assert scenario.effective_nodes_required == 3
        assert scenario.nodes_to_add == 0
        assert scenario.nodes_to_remove == 3
        assert scenario.pools["default"].scale_down_blocked_reason is None
        assert scenario.pools["default"].node_headroom == 17
        assert scenario.schedulable is True

    def test_pod_too_large_is_explicitly_unschedulable(self) -> None:
        cluster = cluster_with(
            Workload("api", Resources(5000, 128), current_replicas=1),
            machine=MachineSpec(cpu_m=4000, memory_mib=8192),
        )

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.schedulable is False
        assert scenario.pools["default"].limiting_resource == "pod_too_large"

    def test_max_pod_density_is_a_constraint(self) -> None:
        cluster = cluster_with(
            Workload("api", Resources(10, 10), current_replicas=5),
            machine=MachineSpec(cpu_m=4000, memory_mib=8192, max_pods=2),
        )

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.nodes_required == 3
        assert scenario.pools["default"].limiting_resource == "pod_count"

    def test_effective_requirement_over_ca_max_is_unschedulable(self) -> None:
        cluster = cluster_with(
            Workload("api", Resources(3000, 128), current_replicas=3),
            current_nodes=2,
            max_nodes=2,
        )

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.nodes_to_add == 1
        assert scenario.pools["default"].node_headroom == -1
        assert scenario.schedulable is False

    def test_reserved_platform_overhead_reduces_allocatable_capacity(self) -> None:
        cluster = cluster_with(
            Workload("api", Resources(100, 3000), current_replicas=2),
            machine=MachineSpec(
                cpu_m=4000,
                memory_mib=8192,
                reserved_cpu_m=500,
                reserved_memory_mib=4096,
            ),
        )

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.nodes_required == 2
        assert scenario.pools["default"].limiting_resource == "memory"

    def test_scenario_combines_multiple_workloads(self) -> None:
        api = Workload("api", Resources(1000, 512), current_replicas=2)
        cluster = add_workload(
            cluster_with(api),
            Workload("worker", Resources(500, 1024), current_replicas=3),
        )

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.replicas == {"api": 2, "worker": 3}
        assert scenario.pod_count == 5
        assert scenario.cpu_requested_m == 3500
        assert scenario.memory_requested_mib == 4096


class TestValidation:
    @pytest.mark.parametrize(
        ("machine", "message"),
        [
            (
                MachineSpec(cpu_m=0, memory_mib=8192),
                "default: machine CPU must be greater than zero",
            ),
            (
                MachineSpec(cpu_m=4000, memory_mib=0),
                "default: machine memory must be greater than zero",
            ),
            (
                MachineSpec(cpu_m=4000, memory_mib=8192, reserved_cpu_m=-1),
                "default: reserved CPU cannot be negative",
            ),
            (
                MachineSpec(cpu_m=4000, memory_mib=8192, reserved_cpu_m=4000),
                "default: reserved CPU must be less than machine CPU",
            ),
            (
                MachineSpec(cpu_m=4000, memory_mib=8192, reserved_memory_mib=-1),
                "default: reserved memory cannot be negative",
            ),
            (
                MachineSpec(cpu_m=4000, memory_mib=8192, reserved_memory_mib=8192),
                "default: reserved memory must be less than machine memory",
            ),
            (
                MachineSpec(cpu_m=4000, memory_mib=8192, max_pods=0),
                "default: max_pods must be greater than zero",
            ),
        ],
    )
    def test_rejects_invalid_machine_fields(
        self,
        machine: MachineSpec,
        message: str,
    ) -> None:
        cluster = cluster_with(
            Workload("api", Resources(100, 128), current_replicas=1),
            machine=machine,
        )

        with pytest.raises(ValueError) as error:
            validate(cluster)

        assert str(error.value) == message

    @pytest.mark.parametrize(
        ("workload", "message"),
        [
            (
                Workload("api", Resources(0, 128), current_replicas=1),
                "api: CPU request must be greater than zero",
            ),
            (
                Workload("api", Resources(100, 0), current_replicas=1),
                "api: memory request must be greater than zero",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128, cpu_limit_m=0),
                    current_replicas=1,
                ),
                "api: CPU limit must be greater than zero",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128, cpu_limit_m=50),
                    current_replicas=1,
                ),
                "api: CPU limit must be >= CPU request",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128, memory_limit_mib=0),
                    current_replicas=1,
                ),
                "api: memory limit must be greater than zero",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128, memory_limit_mib=64),
                    current_replicas=1,
                ),
                "api: memory limit must be >= memory request",
            ),
            (
                Workload("api", Resources(100, 128), current_replicas=-1),
                "api: replicas cannot be negative",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(-1),
                ),
                "api: observed CPU avg cannot be negative",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(100, p95=-1),
                ),
                "api: observed CPU p95 cannot be negative",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(100, peak=-1),
                ),
                "api: observed CPU peak cannot be negative",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(200, peak=199),
                ),
                "api: observed CPU peak cannot be below avg",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(100, p95=300, peak=200),
                ),
                "api: observed CPU peak cannot be below p95",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    observed_memory_per_pod=UsageStat(-1),
                ),
                "api: observed memory avg cannot be negative",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    observed_memory_per_pod=UsageStat(512, peak=256),
                ),
                "api: observed memory peak cannot be below avg",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    usage_window_seconds=-1,
                ),
                "api: usage window cannot be negative",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    rollout=Rollout(max_surge_percent=-1),
                ),
                "api: rollout max surge cannot be negative",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    rollout=Rollout(max_surge_pods=-1),
                ),
                "api: rollout max surge pods cannot be negative",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    hpa=HPA(-1, 2),
                ),
                "api: HPA min cannot be negative",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    hpa=HPA(2, 1),
                ),
                "api: HPA max must be >= HPA min",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    hpa=HPA(1, 2, cpu_target_percentage=0),
                ),
                "api: HPA target must be > 0",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    hpa=HPA(1, 2, memory_target_percentage=0),
                ),
                "api: HPA target must be > 0",
            ),
        ],
    )
    def test_rejects_invalid_workload_fields(
        self,
        workload: Workload,
        message: str,
    ) -> None:
        with pytest.raises(ValueError) as error:
            validate(cluster_with(workload))

        assert str(error.value) == message

    def test_rejects_empty_node_pools(self) -> None:
        cluster = ClusterConfig(workloads={}, node_pools={})

        with pytest.raises(ValueError, match="At least one node pool"):
            validate(cluster)

    def test_rejects_node_pool_key_name_mismatch(self) -> None:
        cluster = cluster_with(Workload("api", Resources(100, 128), current_replicas=1))
        cluster = replace(
            cluster,
            node_pools={"other": cluster.node_pools["default"]},
        )

        with pytest.raises(ValueError) as error:
            validate(cluster)

        assert str(error.value) == (
            "Node pool key 'other' does not match pool.name 'default'"
        )

    def test_rejects_workload_key_name_mismatch(self) -> None:
        cluster = cluster_with(Workload("api", Resources(100, 128), current_replicas=1))
        cluster = replace(
            cluster,
            workloads={"other": cluster.workloads["api"]},
        )

        with pytest.raises(ValueError) as error:
            validate(cluster)

        assert str(error.value) == (
            "Workload key 'other' does not match workload.name 'api'"
        )

    def test_evaluate_validates_cluster(self) -> None:
        cluster = cluster_with(Workload("api", Resources(-1, 128), current_replicas=1))

        with pytest.raises(ValueError, match="CPU request"):
            evaluate(cluster)

    def test_rejects_invalid_node_range(self) -> None:
        cluster = cluster_with(
            Workload("api", Resources(100, 128), current_replicas=1),
            min_nodes=1,
            current_nodes=4,
            max_nodes=3,
        )

        with pytest.raises(ValueError, match="min_nodes"):
            validate(cluster)

    def test_rejects_limit_below_request(self) -> None:
        cluster = cluster_with(
            Workload(
                "api",
                Resources(500, 128, cpu_limit_m=250),
                current_replicas=1,
            )
        )

        with pytest.raises(ValueError, match="limit must be >="):
            validate(cluster)


class TestDiff:
    def test_config_diff_reports_change_even_without_impact(
        self,
        baseline: ClusterConfig,
    ) -> None:
        candidate = update_cpu_limit(baseline, "api", 1500)

        config_diff = compare_config(baseline, candidate)
        impact_diff = compare_results(evaluate(baseline), evaluate(candidate))

        change = config_diff.changes["workloads.api.resources.cpu_limit_m"]
        assert (change.before, change.after) == (1000, 1500)
        assert impact_diff.scenarios["current"].nodes_required.delta == 0

    def test_config_diff_tracks_additions_and_removals(
        self,
        baseline: ClusterConfig,
    ) -> None:
        worker = Workload("worker", Resources(100, 128), current_replicas=1)
        candidate = add_workload(baseline, worker)
        added = compare_config(baseline, candidate)
        removed = compare_config(candidate, remove_workload(candidate, "worker"))

        assert added.workloads_added == ("worker",)
        assert removed.workloads_removed == ("worker",)

    def test_impact_diff_includes_scaling_fields(
        self,
        baseline: ClusterConfig,
    ) -> None:
        candidate = update_cpu_limit(baseline, "api", 4000)
        candidate = update_cpu_request(candidate, "api", 3000)

        diff = compare_results(evaluate(baseline), evaluate(candidate))

        assert diff.scenarios["current"].nodes_required.delta > 0
        assert diff.scenarios["current"].nodes_to_add.delta >= 0


class TestHpaTolerance:
    def test_metric_inside_tolerance_band_holds_steady(self) -> None:
        # 75% against a 70% target is a ratio of 1.07, inside the band.
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(1000, 1000),
                current_replicas=10,
                observed_cpu_per_pod=UsageStat(750),
                hpa=HPA(1, 50, cpu_target_percentage=70),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.desired_replicas == 10

    def test_metric_outside_tolerance_band_scales(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(1000, 1000),
                current_replicas=10,
                observed_cpu_per_pod=UsageStat(850),
                hpa=HPA(1, 50, cpu_target_percentage=70),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.desired_replicas == 13


class TestHpaSaturation:
    def test_clamped_recommendation_is_reported_alongside_the_raw_one(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(200, 256),
                current_replicas=9,
                observed_cpu_per_pod=UsageStat(1400),
                hpa=HPA(3, 9, cpu_target_percentage=80),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.cpu_utilization_percent == 700
        assert result.raw_desired_replicas == 79
        assert result.desired_replicas == 9
        assert result.clamped_by == "max"

    def test_unclamped_recommendation_reports_no_clamp(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(2000, 256),
                current_replicas=9,
                observed_cpu_per_pod=UsageStat(1400),
                hpa=HPA(3, 9, cpu_target_percentage=80),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.raw_desired_replicas == 8
        assert result.desired_replicas == 8
        assert result.clamped_by is None

    def test_clamped_by_names_the_ceiling_that_capped_the_recommendation(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(200, 256),
                current_replicas=9,
                observed_cpu_per_pod=UsageStat(1400),
                hpa=HPA(3, 9, cpu_target_percentage=80),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.raw_desired_replicas > result.desired_replicas
        assert result.clamped_by == "max"

    def test_clamped_by_names_the_floor_that_raised_the_recommendation(self) -> None:
        # 100m against a 1000m request is 10% utilization, so the metric asks
        # for one pod and the HPA minimum of 6 holds it up.
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(1000, 256),
                current_replicas=2,
                observed_cpu_per_pod=UsageStat(100),
                hpa=HPA(6, 12, cpu_target_percentage=80),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.raw_desired_replicas == 1
        assert result.desired_replicas == 6
        assert result.clamped_by == "min"

    def test_rollout_surge_adds_to_the_hpa_ceiling(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(250, 128),
                current_replicas=4,
                hpa=HPA(2, 9, cpu_target_percentage=70),
                rollout=Rollout(max_surge_percent=25),
            )
        )

        result = evaluate(cluster).workloads["api"]

        # ceil(9 * 0.25) == 3
        assert result.rollout_replicas_at_max == 12


def representative_cluster(
    *, rollouts: dict[str, Rollout] | None = None
) -> ClusterConfig:
    """A multi-workload, multi-pool configuration exercising every code path.

    HPA and non-HPA workloads, CPU- and memory-driven metrics, two machine
    shapes, and a pool whose minimum exceeds its demand.
    """
    rollouts = rollouts or {}
    return ClusterConfig(
        workloads={
            "api": Workload(
                name="api",
                resources=Resources(500, 256, cpu_limit_m=1000),
                current_replicas=4,
                observed_cpu_per_pod=UsageStat(400),
                hpa=HPA(2, 10, cpu_target_percentage=70),
                rollout=rollouts.get("api", Rollout()),
                pool="default",
            ),
            "worker": Workload(
                name="worker",
                resources=Resources(250, 512),
                current_replicas=3,
                observed_memory_per_pod=UsageStat(384),
                rollout=rollouts.get("worker", Rollout(max_surge_percent=10)),
                pool="default",
            ),
            "cache": Workload(
                name="cache",
                resources=Resources(1000, 8192),
                current_replicas=2,
                observed_memory_per_pod=UsageStat(6000),
                hpa=HPA(1, 5, memory_target_percentage=60),
                rollout=rollouts.get("cache", Rollout()),
                pool="highmem",
            ),
        },
        node_pools={
            "default": NodePool(
                name="default",
                machine=MachineSpec(
                    cpu_m=4000,
                    memory_mib=8192,
                    reserved_cpu_m=200,
                    reserved_memory_mib=512,
                ),
                min_nodes=1,
                current_nodes=2,
                max_nodes=10,
            ),
            "highmem": NodePool(
                name="highmem",
                machine=MachineSpec(cpu_m=8000, memory_mib=32768),
                min_nodes=2,
                current_nodes=2,
                max_nodes=6,
            ),
        },
    )


def percent_only_evaluate(cluster: ClusterConfig) -> ClusterResult:
    """The pre-P0.2 evaluate(), reproduced with no knowledge of max_surge_pods.

    Surge here is unconditionally ceil(max_replicas * max_surge_percent / 100),
    exactly as engine.evaluate_workload computed it before absolute surge
    existed. Comparing a full evaluate() against this is the regression proof
    that adding the field changed nothing for configurations that omit it.
    """
    workload_results: dict[str, WorkloadResult] = {}
    for name, workload in cluster.workloads.items():
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
        surge = ceil(max_replicas * workload.rollout.max_surge_percent / 100)
        workload_results[name] = WorkloadResult(
            name=workload.name,
            cpu_utilization_percent=cpu_utilization,
            memory_utilization_percent=memory_utilization,
            current_replicas=workload.current_replicas,
            raw_desired_replicas=raw_desired_replicas,
            desired_replicas=desired_replicas,
            max_replicas=max_replicas,
            rollout_replicas_at_max=max_replicas + surge,
        )

    replicas_by_scenario = {
        "hpa_min": {
            name: min_replicas_for(cluster.workloads[name]) for name in workload_results
        },
        "current": {
            name: result.current_replicas for name, result in workload_results.items()
        },
        "hpa_desired": {
            name: result.desired_replicas for name, result in workload_results.items()
        },
        "hpa_max": {
            name: result.max_replicas for name, result in workload_results.items()
        },
        "hpa_max_rollout": {
            name: result.rollout_replicas_at_max
            for name, result in workload_results.items()
        },
    }

    return ClusterResult(
        workloads=workload_results,
        scenarios={
            scenario_name: evaluate_scenario(scenario_name, cluster, replicas)
            for scenario_name, replicas in replicas_by_scenario.items()
        },
    )


def scalar_usage_evaluate(
    cluster: ClusterConfig,
    scalars: dict[str, tuple[int | None, int | None]],
) -> ClusterResult:
    """The pre-P1.1 evaluate(), reproduced with no knowledge of UsageStat.

    Observed usage is read here as one scalar per dimension, taken from
    `scalars`, exactly as engine.evaluate_hpa read Workload's two scalar
    observed-usage fields — one CPU figure in millicores, one memory figure in
    MiB — before the distribution summary replaced them with
    observed_cpu_per_pod / observed_memory_per_pod. Everything downstream of
    the HPA numbers is
    the shipped engine, so a difference in the compared result can only come
    from the usage change.
    """
    workload_results: dict[str, WorkloadResult] = {}
    for name, workload in cluster.workloads.items():
        observed_cpu_m, observed_memory_mib = scalars[name]
        cpu_utilization: float | None = None
        memory_utilization: float | None = None
        desired_candidates: list[int] = []

        if workload.hpa is None:
            raw_desired_replicas = workload.current_replicas
            desired_replicas = workload.current_replicas
            max_replicas = workload.current_replicas
        else:
            if (
                workload.hpa.cpu_target_percentage is not None
                and observed_cpu_m is not None
                and workload.resources.cpu_request_m > 0
            ):
                cpu_utilization = (
                    observed_cpu_m / workload.resources.cpu_request_m * 100
                )
                desired_candidates.append(
                    _scalar_metric_recommendation(
                        workload.current_replicas,
                        cpu_utilization,
                        workload.hpa.cpu_target_percentage,
                    )
                )
            if (
                workload.hpa.memory_target_percentage is not None
                and observed_memory_mib is not None
                and workload.resources.memory_request_mib > 0
            ):
                memory_utilization = (
                    observed_memory_mib / workload.resources.memory_request_mib * 100
                )
                desired_candidates.append(
                    _scalar_metric_recommendation(
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
                min(raw_desired_replicas, workload.hpa.max_replicas),
            )
            max_replicas = workload.hpa.max_replicas

        if workload.rollout.max_surge_pods is not None:
            surge = workload.rollout.max_surge_pods
        else:
            surge = ceil(max_replicas * workload.rollout.max_surge_percent / 100)

        workload_results[name] = WorkloadResult(
            name=workload.name,
            cpu_utilization_percent=cpu_utilization,
            memory_utilization_percent=memory_utilization,
            current_replicas=workload.current_replicas,
            raw_desired_replicas=raw_desired_replicas,
            desired_replicas=desired_replicas,
            max_replicas=max_replicas,
            rollout_replicas_at_max=max_replicas + surge,
        )

    replicas_by_scenario = {
        "hpa_min": {
            name: min_replicas_for(cluster.workloads[name]) for name in workload_results
        },
        "current": {
            name: result.current_replicas for name, result in workload_results.items()
        },
        "hpa_desired": {
            name: result.desired_replicas for name, result in workload_results.items()
        },
        "hpa_max": {
            name: result.max_replicas for name, result in workload_results.items()
        },
        "hpa_max_rollout": {
            name: result.rollout_replicas_at_max
            for name, result in workload_results.items()
        },
    }

    return ClusterResult(
        workloads=workload_results,
        scenarios={
            scenario_name: evaluate_scenario(scenario_name, cluster, replicas)
            for scenario_name, replicas in replicas_by_scenario.items()
        },
    )


def _scalar_metric_recommendation(
    current_replicas: int,
    utilization_percent: float,
    target_percentage: float,
) -> int:
    """The pre-P1.1 single-metric recommendation, tolerance band included."""
    ratio = utilization_percent / target_percentage
    if abs(ratio - 1) <= HPA_TOLERANCE:
        return current_replicas
    return ceil(current_replicas * ratio)


@dataclass
class _PlacementFreeNode:
    """The pre-P1.5 NodeAllocation: remaining capacity and nothing else."""

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


def placement_free_pack(
    machine: MachineSpec,
    pods: list[PodRequest],
) -> tuple[list[_PlacementFreeNode], list[PodRequest]]:
    """The pre-P1.5 _pack_pods(), reproduced with no retained placements.

    Same first-fit-decreasing walk over the same ordering, onto nodes that
    forget what they placed. Substituted for the shipped packer, it evaluates a
    configuration exactly as the engine did before placements were kept.
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

    nodes: list[_PlacementFreeNode] = []
    for pod in candidates:
        for node in nodes:
            if node.fits(pod):
                node.place(pod)
                break
        else:
            node = _PlacementFreeNode(
                cpu_remaining_m=machine.allocatable_cpu_m,
                memory_remaining_mib=machine.allocatable_memory_mib,
                pods_remaining=machine.max_pods,
            )
            node.place(pod)
            nodes.append(node)

    return nodes, oversized


def _node_math(result: ClusterResult) -> dict[str, object]:
    """The whole ClusterResult with only the runtime-risk block removed."""
    data = asdict(result)
    for scenario in data["scenarios"].values():
        for pool in scenario["pools"].values():
            pool.pop("cpu_contention")
    return data


class TestRetainedPlacements:
    """The packer keeps its placements, and only runtime-risk analysis reads them.

    Retention exists so that analysis can ask who shares a node with whom — the
    one fact aggregate arithmetic cannot recover. Until Phase 2 the placements
    moved no number at all, and one test proved it by substituting a packer that
    discarded them; that test was written to expire here, and it has. What
    survives it is the pair below: the packer packs exactly as it did before
    retention, and the analysis reading the placements moves no node number.
    """

    def test_retaining_placements_did_not_change_the_packing(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The retained list is a by-product; the walk itself is untouched.

        placement_free_pack() is the pre-P1.5 packer, reproduced over nodes that
        forget what they hold. Run over the same pods it must open the same
        nodes, reject the same oversized pods, and leave each node holding the
        same remainder. Pool sizing reads only the first two out of the packer;
        the remainders are asserted as well because they are what says the two
        walks placed the same pods, and not merely the same number of them.

        The shadow can no longer be substituted into evaluate() -- contention
        analysis genuinely needs the placements the shadow discards -- so the
        comparison moved down to the packer, where the claim actually lives.
        That move costs the guard the Session F review added, so it is taken
        separately below: without it this compares two functions that evaluate()
        may have stopped calling.
        """
        cluster = representative_cluster()
        reached: list[int] = []
        # Bound before the patch: reaching for it through the module inside the
        # shim would find the shim.
        shipped_pack = engine._pack_pods

        def counting_pack(
            machine: MachineSpec,
            pods: list[PodRequest],
        ) -> tuple[list[NodeAllocation], list[PodRequest]]:
            reached.append(len(pods))
            return shipped_pack(machine, pods)

        monkeypatch.setattr(engine, "_pack_pods", counting_pack)
        evaluate(cluster)
        monkeypatch.undo()

        # Two pools x five scenarios. Counting the pods each call received, not
        # the calls, so a fixture that stopped putting pods in one of the pools
        # cannot leave this passing on empty comparisons.
        assert len(reached) == 10, "_pack_pods is not the function evaluate() reaches"
        assert all(reached), "a pool received no pods, so it compares nothing"

        compared = 0
        for scenario in evaluate(cluster).scenarios.values():
            for pool_name, pool in cluster.node_pools.items():
                pods = [
                    pod
                    for pod in build_pods(cluster, scenario.replicas)
                    if resolve_pool_name(cluster, cluster.workloads[pod.workload_name])
                    == pool_name
                ]
                shipped_nodes, shipped_oversized = engine._pack_pods(pool.machine, pods)
                shadow_nodes, shadow_oversized = placement_free_pack(pool.machine, pods)

                assert shipped_oversized == shadow_oversized
                assert [
                    (
                        node.cpu_remaining_m,
                        node.memory_remaining_mib,
                        node.pods_remaining,
                    )
                    for node in shipped_nodes
                ] == [
                    (
                        node.cpu_remaining_m,
                        node.memory_remaining_mib,
                        node.pods_remaining,
                    )
                    for node in shadow_nodes
                ]
                compared += 1

        assert compared == 10

    def test_contention_moves_no_node_number(self) -> None:
        """Runtime risk is additive context, not a new verdict channel.

        Every observed statistic in the fixture keeps its average and gains a
        p95 and a peak far above it -- the same edit the HPA convention test
        makes, which leaves every replica number alone and is enough to contend
        the default pool. Not one field of any pool result outside
        cpu_contention may move: if one did, a risk readout would be quietly
        sizing the cluster.
        """
        plain = representative_cluster()
        contended = replace(
            plain,
            workloads={
                name: replace(
                    workload,
                    observed_cpu_per_pod=_with_tails(workload.observed_cpu_per_pod),
                    observed_memory_per_pod=_with_tails(
                        workload.observed_memory_per_pod
                    ),
                )
                for name, workload in plain.workloads.items()
            },
        )

        contended_result = evaluate(contended)
        flagged = [
            flag
            for scenario in contended_result.scenarios.values()
            for pool in scenario.pools.values()
            if pool.cpu_contention is not None
            for flag in pool.cpu_contention.flags
        ]

        # The premise: without flags this test would prove nothing.
        assert flagged
        assert _node_math(contended_result) == _node_math(evaluate(plain))

    def test_every_placed_pod_is_retained_on_the_node_that_holds_it(self) -> None:
        machine = MachineSpec(cpu_m=4000, memory_mib=8192, max_pods=110)
        pods = [
            PodRequest("api", cpu_m=1500, memory_mib=2048),
            PodRequest("api", cpu_m=1500, memory_mib=2048),
            PodRequest("worker", cpu_m=1500, memory_mib=2048),
            PodRequest("oversized", cpu_m=9000, memory_mib=512),
        ]

        nodes, oversized = engine._pack_pods(machine, pods)

        # Two nodes: 4000m of CPU holds two 1500m pods, not three.
        assert len(nodes) == 2
        assert oversized == [PodRequest("oversized", cpu_m=9000, memory_mib=512)]

        placed = [pod for node in nodes for pod in node.pods]
        assert Counter(placed) == Counter(pods[:3])
        # "In placement order" is a promise the field comment makes, so it is
        # asserted rather than assumed -- and placement order is not input
        # order. These three pods tie on every sizing term, so the sort falls
        # through to workload_name, descending: worker is placed first, then
        # both api pods, and first-fit fills node one before opening node two.
        api = PodRequest("api", cpu_m=1500, memory_mib=2048)
        assert nodes[0].pods == [PodRequest("worker", cpu_m=1500, memory_mib=2048), api]
        assert nodes[1].pods == [api]

        # Each node's retained list accounts for exactly the capacity it spent,
        # so the placements describe the packing rather than shadowing it.
        for node in nodes:
            assert node.cpu_remaining_m == machine.allocatable_cpu_m - sum(
                pod.cpu_m for pod in node.pods
            )
            assert node.memory_remaining_mib == machine.allocatable_memory_mib - sum(
                pod.memory_mib for pod in node.pods
            )
            assert node.pods_remaining == machine.max_pods - len(node.pods)


def _with_tails(stat: UsageStat | None) -> UsageStat | None:
    """Same average, with a p95 and a peak far above it."""
    if stat is None:
        return None
    return replace(stat, p95=stat.avg * 2 + 7, peak=stat.avg * 3 + 11)


def _hpa_numbers(result: ClusterResult) -> object:
    """Everything the avg-only HPA convention decides.

    Both utilization percentages, every replica number the HPA produced, the
    surge, and the replica counts each scenario expanded into pods. Contention
    analysis reads `peak`, so whole-result equality across added statistics
    stopped being true when it landed; this is the part of the claim that is
    still exactly right, and still the one worth pinning.
    """
    return (
        {name: asdict(workload) for name, workload in result.workloads.items()},
        {name: dict(scenario.replicas) for name, scenario in result.scenarios.items()},
    )


class TestUsageStatistics:
    """Observed usage is a distribution summary; HPA still reads its average.

    The convention is enforced at the call site, so these tests pin both
    halves: HPA numbers must not move for avg-only stats, and adding p95/peak
    to a workload must not move them either.
    """

    def test_exposure_prefers_peak_then_p95_then_average(self) -> None:
        assert UsageStat(avg=100, p95=180, peak=240).exposure() == (240, "peak")
        assert UsageStat(avg=100, p95=180).exposure() == (180, "p95")
        assert UsageStat(avg=100).exposure() == (100, "avg")

    def test_exposure_falls_back_past_a_missing_statistic(self) -> None:
        # p95 absent, peak present: the chain skips the gap rather than
        # stopping at it.
        assert UsageStat(avg=100, peak=240).exposure() == (240, "peak")

    def test_sizing_prefers_p95_and_falls_back_to_average(self) -> None:
        # Sizing never reads peak: a request bought for the maximum is idle
        # capacity the scheduler cannot pack around.
        assert UsageStat(avg=100, p95=180, peak=240).sizing() == 180
        assert UsageStat(avg=100, peak=240).sizing() == 100

    def test_hpa_reads_the_average_and_ignores_the_other_statistics(self) -> None:
        # 400m against a 500m request is 80% utilization at a 70% target, which
        # scales 4 replicas to 5. Reading p95 or peak here would give 6 or 7.
        def cluster_for(usage: UsageStat) -> ClusterConfig:
            return cluster_with(
                Workload(
                    name="api",
                    resources=Resources(500, 256),
                    current_replicas=4,
                    observed_cpu_per_pod=usage,
                    hpa=HPA(2, 10, cpu_target_percentage=70),
                )
            )

        average_only = evaluate(cluster_for(UsageStat(avg=400)))
        with_tail = evaluate(cluster_for(UsageStat(avg=400, p95=550, peak=700)))

        assert average_only.workloads["api"].cpu_utilization_percent == 80
        assert average_only.workloads["api"].desired_replicas == 5
        assert _hpa_numbers(average_only) == _hpa_numbers(with_tail)

    def test_average_only_stats_evaluate_identically_to_the_scalar_engine(
        self,
    ) -> None:
        """Regression proof that UsageStat is inert for avg-only usage.

        The representative multi-workload, multi-pool configuration is
        evaluated twice: once through the shipped engine and once through
        scalar_usage_evaluate(), which reads the same numbers the way the
        engine read them before UsageStat existed. The comparison is over the
        whole ClusterResult via dataclasses.asdict -- both utilization
        percentages, every replica number, and every field of all five
        scenarios, per pool.
        """
        # Spelled out rather than read off the fixture, so the shadow engine
        # never sources its inputs from the accessor under test. These are
        # representative_cluster()'s (cpu_m, memory_mib) per workload.
        scalars: dict[str, tuple[int | None, int | None]] = {
            "api": (400, None),
            "worker": (None, 384),
            "cache": (None, 6000),
        }

        cluster = representative_cluster()

        assert asdict(evaluate(cluster)) == asdict(
            scalar_usage_evaluate(cluster, scalars)
        )

    def test_adding_tail_statistics_moves_no_hpa_or_replica_number(
        self,
    ) -> None:
        # The convention across the full multi-workload, multi-pool fixture:
        # give every observed statistic a p95 and a peak well above its
        # average, and no HPA or replica number may move.
        #
        # This asserted the whole ClusterResult until entitlement analysis
        # landed. That analysis reads `peak` by design, so "moves nothing at
        # all" is now false — and would be a bug if it were true. What the
        # convention actually claims is that the tail statistics never reach
        # the replica math, which is what _hpa_numbers compares. The node math
        # under the same edit is pinned separately, by
        # TestRetainedPlacements.test_contention_moves_no_node_number.
        plain = representative_cluster()
        with_tails = replace(
            plain,
            workloads={
                name: replace(
                    workload,
                    observed_cpu_per_pod=_with_tails(workload.observed_cpu_per_pod),
                    observed_memory_per_pod=_with_tails(
                        workload.observed_memory_per_pod
                    ),
                )
                for name, workload in plain.workloads.items()
            },
        )

        assert _hpa_numbers(evaluate(plain)) == _hpa_numbers(evaluate(with_tails))


class TestContainerBreakdown:
    """Per-container detail is analysis-only and validated lightly.

    Pod-level Resources stays the single source of truth for packing, HPA math,
    and validation. Entitlement analysis reads the breakdown -- it is the only
    thing that does, and it is what the list was added for -- so the claim below
    is that a breakdown moves no *node* number, not that it moves nothing.
    """

    def test_containers_move_no_node_number(self) -> None:
        # Every workload in the multi-workload, multi-pool fixture gains a
        # breakdown whose numbers deliberately disagree with its pod totals --
        # a sidecar the pod request never counted, a limit the pod does not
        # carry, usage far above the average the HPA reads. No number outside
        # the runtime-risk block may move.
        plain = representative_cluster()
        with_containers = replace(
            plain,
            workloads={
                name: replace(
                    workload,
                    containers=(
                        ContainerInfo(
                            name="app",
                            cpu_request_m=workload.resources.cpu_request_m,
                            memory_request_mib=workload.resources.memory_request_mib,
                            cpu_limit_m=9000,
                            observed_cpu=UsageStat(avg=10, peak=8000),
                        ),
                        ContainerInfo(name="istio-proxy", cpu_request_m=19),
                    ),
                )
                for name, workload in plain.workloads.items()
            },
        )

        assert _node_math(evaluate(plain)) == _node_math(evaluate(with_containers))

    def test_a_breakdown_is_not_cross_checked_against_the_pod_totals(self) -> None:
        # The pod numbers are effective requests, so an init container can set
        # them and a plain sum of the containers will not match. Requiring
        # agreement would reject configurations a real cluster produces.
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(900, 1024),
                current_replicas=2,
                containers=(ContainerInfo(name="app", cpu_request_m=100),),
            )
        )

        # No assertion by design: the whole claim is that validate() does not
        # raise on a breakdown that disagrees with the pod totals.
        validate(cluster)

    def test_a_container_request_may_equal_but_not_exceed_its_own_limit(self) -> None:
        # The boundary of the check above: equal is the Guaranteed shape, and
        # a declared limit with no request is what Kubernetes defaults up.
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(500, 256),
                current_replicas=2,
                containers=(
                    ContainerInfo(name="app", cpu_request_m=500, cpu_limit_m=500),
                    ContainerInfo(name="istio-proxy", cpu_limit_m=100),
                ),
            )
        )

        validate(cluster)

    @pytest.mark.parametrize(
        ("containers", "message"),
        [
            ((), "container breakdown cannot be empty"),
            ((ContainerInfo(name=""),), "container name cannot be empty"),
            (
                (ContainerInfo(name="app"), ContainerInfo(name="app")),
                "duplicate container name 'app'",
            ),
            (
                (ContainerInfo(name="app", cpu_request_m=-1),),
                "container CPU request cannot be negative",
            ),
            (
                (ContainerInfo(name="app", memory_limit_mib=-1),),
                "container memory limit cannot be negative",
            ),
            (
                (ContainerInfo(name="app", observed_cpu=UsageStat(avg=100, peak=50)),),
                "observed CPU peak cannot be below avg",
            ),
            (
                (ContainerInfo(name="app", cpu_request_m=200, cpu_limit_m=100),),
                "container CPU request cannot exceed its limit",
            ),
            (
                (
                    ContainerInfo(
                        name="app", memory_request_mib=512, memory_limit_mib=256
                    ),
                ),
                "container memory request cannot exceed its limit",
            ),
            ((ContainerInfo(name="   "),), "container name cannot be empty"),
        ],
    )
    def test_light_validation_rejects_impossible_breakdowns(
        self,
        containers: tuple[ContainerInfo, ...],
        message: str,
    ) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(500, 256),
                current_replicas=2,
                containers=containers,
            )
        )

        with pytest.raises(ValueError, match=message):
            validate(cluster)

    def test_a_rejected_container_is_named_in_the_message(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(500, 256),
                current_replicas=2,
                containers=(
                    ContainerInfo(name="app"),
                    ContainerInfo(name="istio-proxy", cpu_limit_m=-5),
                ),
            )
        )

        with pytest.raises(ValueError, match="api/istio-proxy"):
            validate(cluster)


# A 4000m / 8192MiB node with nothing reserved, so allocatable CPU is a round
# 4000m and every bound below can be read off the numbers in the test.
CONTENTION_MACHINE = MachineSpec(cpu_m=4000, memory_mib=8192)


def contention_cluster(*workloads: Workload) -> ClusterConfig:
    """One pool of CONTENTION_MACHINE nodes holding the given workloads."""
    return ClusterConfig(
        workloads={workload.name: workload for workload in workloads},
        node_pools={
            "default": NodePool(
                name="default",
                machine=CONTENTION_MACHINE,
                min_nodes=1,
                current_nodes=2,
                max_nodes=10,
            ),
        },
    )


def contention_of(cluster: ClusterConfig, **replicas: int) -> CpuContention:
    """The default pool's contention for one hand-chosen replica set."""
    contention = (
        evaluate_scenario("current", cluster, replicas).pools["default"].cpu_contention
    )
    assert contention is not None, "the pool placed no pods"
    return contention


class TestCpuContention:
    """Entitlement-based CPU contention over the retained placements.

    The model is an entitlement one, not a simulation: a unit's guaranteed floor
    is its CPU request, a node is contended when its placed pods' exposure-basis
    usage outruns allocatable CPU, and everything above the floor on such a node
    exists only while neighbors are idle.
    """

    def test_a_contended_node_flags_only_the_pod_above_its_request(self) -> None:
        # 3500 + 1000 = 4500m of peak against 4000m allocatable, so the node is
        # contended -- and batch, peaking at a third of what it reserved, is not
        # the one borrowing.
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=3500),
            ),
            Workload(
                name="batch",
                resources=Resources(3000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=1000),
            ),
        )

        contention = contention_of(cluster, web=1, batch=1)

        assert contention.nodes_evaluated == 1
        assert contention.contended_node_count == 1
        assert [flag.workload for flag in contention.flags] == ["web"]

        flag = contention.flags[0]
        assert flag.container is None
        assert (flag.cpu_request_m, flag.usage_cpu_m, flag.usage_basis) == (
            1000,
            3500,
            "peak",
        )
        assert (flag.replicas_affected, flag.replicas_total) == (1, 1)
        # The node's requests fill it exactly, so web's proportional share is
        # its own request: 1000 / 4000 x 4000m.
        assert flag.worst_case_share_m == 1000
        assert flag.message == (
            "web peaks at 3500m against a 1000m request; "
            "1 of 1 replica shares a contended node. "
            "Worst-case bound if every neighbor peaks at once: 1000m."
        )
        assert contention.basis_notes == ()

    def test_a_node_whose_peaks_fit_flags_nothing(self) -> None:
        # Same pods, web peaking at 2000m: still twice its request, but
        # 2000 + 1000 fits inside 4000m. Contention is a property of the node,
        # not of the pod, and this is what makes that assertable.
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=2000),
            ),
            Workload(
                name="batch",
                resources=Resources(3000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=1000),
            ),
        )

        contention = contention_of(cluster, web=1, batch=1)

        assert contention.nodes_evaluated == 1
        assert contention.contended_node_count == 0
        assert contention.flags == ()

    def test_the_bound_is_capped_at_the_cpu_limit(self) -> None:
        # The node's requests total 1000m of 4000m allocatable, so each pod's
        # proportional share is 2000m -- four times what it reserved. web's
        # 700m limit is what it can actually use, so the bound stops there;
        # batch, unlimited, keeps the full share.
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(500, 256, cpu_limit_m=700),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=3000),
            ),
            Workload(
                name="batch",
                resources=Resources(500, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=1500),
            ),
        )

        contention = contention_of(cluster, web=1, batch=1)

        bounds = {flag.workload: flag.worst_case_share_m for flag in contention.flags}
        assert bounds == {"web": 700, "batch": 2000}

    def test_the_bound_is_the_minimum_across_the_contended_nodes(self) -> None:
        # web's two replicas land on different nodes: one beside a 3500m
        # neighbor (node requests total 4000m, share 500m), one beside a 2500m
        # neighbor (total 3000m, share 666m). The bound is a worst case, so the
        # tighter node decides.
        cluster = contention_cluster(
            Workload(
                name="big",
                resources=Resources(3500, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=3900),
            ),
            Workload(
                name="mid",
                resources=Resources(2500, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=3900),
            ),
            Workload(
                name="web",
                resources=Resources(500, 256),
                current_replicas=2,
                observed_cpu_per_pod=UsageStat(avg=100, peak=2000),
            ),
        )

        contention = contention_of(cluster, big=1, mid=1, web=2)

        assert contention.contended_node_count == 2
        bounds = {flag.workload: flag.worst_case_share_m for flag in contention.flags}
        # 666 is the share on the roomier node; taking it would understate the
        # worst case, and 500 is the number the operator has to plan against.
        assert bounds["web"] == 500
        # Two replicas over two contended nodes, so the sentence says nodes.
        web = next(flag for flag in contention.flags if flag.workload == "web")
        assert "2 of 2 replicas share contended nodes" in web.message

    def test_the_minimum_is_not_merely_the_first_node_visited(self) -> None:
        """The tighter node decides even when it is packed second.

        First-fit-decreasing usually opens its fullest node first, so `min` and
        "keep the first value" normally agree and a plain two-node fixture
        cannot tell them apart. Memory separates them: `memhog` claims almost
        all of node one's memory and only 100m of its CPU, so `cpubig` is pushed
        onto a second node that ends up carrying five times node one's CPU
        requests. web has a replica on each.

        node one: 600m of requests, so web's share is 500/600 x 4000 = 3333m.
        node two: 2500m of requests, so its share is 500/2500 x 4000 = 800m.
        Keeping the first value would report 3333m -- four times the entitlement
        the operator can actually count on.
        """
        cluster = ClusterConfig(
            workloads={
                "memhog": Workload(
                    name="memhog",
                    resources=Resources(100, 900),
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(avg=100, peak=1500),
                ),
                "cpubig": Workload(
                    name="cpubig",
                    resources=Resources(2000, 300),
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(avg=100, peak=2100),
                ),
                "web": Workload(
                    name="web",
                    resources=Resources(500, 60),
                    current_replicas=2,
                    observed_cpu_per_pod=UsageStat(avg=100, peak=3000),
                ),
            },
            node_pools={
                "default": NodePool(
                    name="default",
                    machine=MachineSpec(cpu_m=4000, memory_mib=1000),
                    min_nodes=1,
                    current_nodes=2,
                    max_nodes=10,
                ),
            },
        )

        contention = contention_of(cluster, memhog=1, cpubig=1, web=2)

        assert contention.contended_node_count == 2
        web = next(flag for flag in contention.flags if flag.workload == "web")
        assert web.worst_case_share_m == 800

    def test_replicas_are_counted_against_the_workload_not_the_node(self) -> None:
        # Five web replicas: one shares a node with the hog and is exposed, four
        # share a node with each other and are not. The flag is aggregated per
        # workload, so it has to say which fraction is affected.
        cluster = contention_cluster(
            Workload(
                name="hog",
                resources=Resources(3500, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=3900),
            ),
            Workload(
                name="web",
                resources=Resources(500, 256),
                current_replicas=5,
                observed_cpu_per_pod=UsageStat(avg=100, peak=900),
            ),
        )

        contention = contention_of(cluster, hog=1, web=5)

        assert contention.nodes_evaluated == 2
        assert contention.contended_node_count == 1
        web = next(flag for flag in contention.flags if flag.workload == "web")
        assert (web.replicas_affected, web.replicas_total) == (1, 5)
        assert "1 of 5 replicas shares a contended node" in web.message

    def test_a_missing_peak_falls_back_to_avg_and_says_so(self) -> None:
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=3500),
            ),
            Workload(
                name="batch",
                resources=Resources(3000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=1000),
            ),
        )

        contention = contention_of(cluster, web=1, batch=1)

        flag = contention.flags[0]
        assert (flag.usage_basis, flag.usage_cpu_m) == ("avg", 3500)
        assert flag.message.startswith("web averages 3500m against a 1000m request;")
        # Both workloads fell back, including the one that did not flag: a
        # reading that fell back on a node that came out uncontended is exactly
        # how contention hides, which is what makes this a lower bound.
        assert contention.basis_notes == (
            "Peak unavailable for 2 workloads — avg used; "
            "contention here is a lower bound.",
        )

    def test_a_pod_with_no_usage_contributes_its_request_and_is_counted(self) -> None:
        # The scheduler's own assumption, so missing data can neither hide
        # contention nor fabricate it: batch is credited with the 1000m it
        # reserved, which is enough to tip the node, and it is never flagged
        # because nothing observed it above that.
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=3500),
            ),
            Workload(
                name="batch",
                resources=Resources(1000, 256),
                current_replicas=2,
            ),
        )

        contention = contention_of(cluster, web=1, batch=2)

        assert contention.contended_node_count == 1
        assert [flag.workload for flag in contention.flags] == ["web"]
        assert contention.basis_notes == (
            "2 pods had no pod-level usage data — their requests were used.",
        )

    def test_flags_name_containers_only_when_a_breakdown_is_present(self) -> None:
        # Pod-level is the norm rather than a degraded mode, so the same pod is
        # evaluated both ways. The node sum is identical in each: it is summed
        # from pod contributions, and a container's usage is already inside its
        # pod's figure.
        def cluster_for(containers: tuple[ContainerInfo, ...] | None) -> ClusterConfig:
            return contention_cluster(
                Workload(
                    name="payments",
                    resources=Resources(1000, 256),
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(avg=300, peak=3500),
                    containers=containers,
                ),
                Workload(
                    name="batch",
                    resources=Resources(3000, 256),
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(avg=100, peak=1000),
                ),
            )

        pod_level = contention_of(cluster_for(None), payments=1, batch=1)
        assert [(flag.workload, flag.container) for flag in pod_level.flags] == [
            ("payments", None)
        ]

        per_container = contention_of(
            cluster_for(
                (
                    ContainerInfo(
                        name="app",
                        cpu_request_m=900,
                        observed_cpu=UsageStat(avg=200, peak=800),
                    ),
                    ContainerInfo(
                        name="istio-proxy",
                        cpu_request_m=19,
                        observed_cpu=UsageStat(avg=100, peak=2700),
                    ),
                )
            ),
            payments=1,
            batch=1,
        )

        # Spelled out, not compared: two equal values could both be wrong, and
        # the claim is that the breakdown does not move the node sum.
        assert pod_level.contended_node_count == 1
        assert per_container.contended_node_count == 1
        # app stays inside its request; the sidecar is the one borrowing, which
        # is the whole reason the breakdown exists.
        assert [(flag.workload, flag.container) for flag in per_container.flags] == [
            ("payments", "istio-proxy")
        ]
        flag = per_container.flags[0]
        assert (flag.cpu_request_m, flag.usage_cpu_m) == (19, 2700)
        assert flag.worst_case_share_m == 19
        assert flag.message == (
            "istio-proxy in payments peaks at 2700m against a 19m request; "
            "1 of 1 replica shares a contended node. "
            "Worst-case bound if every neighbor peaks at once: 19m."
        )

    def test_container_usage_is_not_added_into_the_node_sum(self) -> None:
        # Node pressure is summed from pod contributions only. A container's
        # usage is already inside its pod's figure, so counting it again would
        # invent load: here the two containers would double the node's reading
        # and tip a node that genuinely fits.
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=2000),
                containers=(
                    ContainerInfo(
                        name="app",
                        cpu_request_m=900,
                        observed_cpu=UsageStat(avg=100, peak=1500),
                    ),
                    ContainerInfo(
                        name="istio-proxy",
                        cpu_request_m=19,
                        observed_cpu=UsageStat(avg=100, peak=1500),
                    ),
                ),
            ),
            Workload(
                name="batch",
                resources=Resources(3000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=1000),
            ),
        )

        contention = contention_of(cluster, web=1, batch=1)

        # 2000 + 1000 against 4000m allocatable. Adding the containers would
        # read 6000m and flag both of them.
        assert contention.contended_node_count == 0
        assert contention.flags == ()

    def test_a_breakdown_without_usage_falls_back_to_the_pod_reading(self) -> None:
        # Present-but-usage-less says nothing a container comparison could use,
        # so it degrades to pod-level exactly as an absent list does.
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=3500),
                containers=(
                    ContainerInfo(name="app", cpu_request_m=981),
                    ContainerInfo(name="istio-proxy", cpu_request_m=19),
                ),
            ),
            Workload(
                name="batch",
                resources=Resources(3000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=1000),
            ),
        )

        contention = contention_of(cluster, web=1, batch=1)

        assert [(flag.workload, flag.container) for flag in contention.flags] == [
            ("web", None)
        ]

    def test_a_breakdown_that_names_nobody_falls_back_to_the_pod(self) -> None:
        """A breakdown can refine a flag; it must never erase one.

        This is the injected-sidecar shape the importer deliberately produces: a
        container with no spec counterpart is not merged into one that exists, so
        its usage reaches the pod figure and nothing else. Here the pod peaks at
        3500m against a 1000m request and contends the node, while both listed
        containers sit inside their own requests -- the 2600m nobody declared is
        the whole point. Reporting only the containers would have this node
        contended and flagged by nothing, and would mean that adding a breakdown
        *removes* a flag pod-level analysis had already raised.
        """
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=3500),
                containers=(
                    ContainerInfo(
                        name="app",
                        cpu_request_m=981,
                        observed_cpu=UsageStat(avg=100, peak=900),
                    ),
                    ContainerInfo(
                        name="istio-proxy",
                        cpu_request_m=19,
                        observed_cpu=UsageStat(avg=5, peak=10),
                    ),
                ),
            ),
            Workload(
                name="batch",
                resources=Resources(3000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=1000),
            ),
        )

        contention = contention_of(cluster, web=1, batch=1)

        assert contention.contended_node_count == 1
        assert [(flag.workload, flag.container) for flag in contention.flags] == [
            ("web", None)
        ]
        assert contention.flags[0].usage_cpu_m == 3500

    def test_a_contended_node_always_produces_at_least_one_flag(self) -> None:
        """The invariant that makes an empty flag list mean "all clear".

        Requests always fit the node -- that is what packing enforces -- and a
        pod with no reading contributes exactly its request. So a node whose
        contributions outrun allocatable must hold a pod observed above its own
        request, and something has to say so. A silent contended node would read
        on screen as no finding at all.

        Checked over the shapes that could break it rather than one fixture:
        pod-level only, a breakdown that names the borrower, and a breakdown
        that names nobody.
        """
        borrower = Workload(
            name="web",
            resources=Resources(1000, 256),
            current_replicas=1,
            observed_cpu_per_pod=UsageStat(avg=100, peak=3500),
        )
        breakdowns: list[tuple[ContainerInfo, ...] | None] = [
            None,
            (
                ContainerInfo(
                    name="app",
                    cpu_request_m=19,
                    observed_cpu=UsageStat(avg=100, peak=3400),
                ),
            ),
            (
                ContainerInfo(
                    name="app",
                    cpu_request_m=1000,
                    observed_cpu=UsageStat(avg=100, peak=900),
                ),
            ),
        ]

        for containers in breakdowns:
            cluster = contention_cluster(
                replace(borrower, containers=containers),
                Workload(
                    name="batch",
                    resources=Resources(3000, 256),
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(avg=100, peak=1000),
                ),
            )

            contention = contention_of(cluster, web=1, batch=1)

            assert contention.contended_node_count == 1
            assert contention.flags, f"contended node, no flag, for {containers}"

    def test_a_workload_measured_only_per_container_contributes_its_request(
        self,
    ) -> None:
        """Node pressure is a pod-level reading, and the note says so.

        Per-container peaks do not sum -- the maximum of a sum is not the sum of
        the maxima -- so kcap will not build a pod figure out of them, and this
        workload contributes the request instead. That is honest but it is a
        real limit: the container is observed at 3500m and the node reads as
        fitting. The note therefore has to say *pod-level*, because "had no
        usage data" would be false of exactly this workload.

        Nothing kcap builds produces this shape -- the importer sets both levels
        from the same metrics, and the editor drops the breakdown on a pod edit
        -- but the API accepts it, so its output must not lie.
        """
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                containers=(
                    ContainerInfo(
                        name="app",
                        cpu_request_m=1000,
                        observed_cpu=UsageStat(avg=3500),
                    ),
                ),
            ),
            Workload(
                name="batch",
                resources=Resources(3000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=3000),
            ),
        )

        contention = contention_of(cluster, web=1, batch=1)

        # 1000m of request plus batch's 3000m peak is exactly allocatable.
        assert contention.contended_node_count == 0
        assert contention.basis_notes == (
            "Peak unavailable for 1 workload — avg used; "
            "contention here is a lower bound.",
            "1 pod had no pod-level usage data — its request was used.",
        )

    def test_the_bound_never_exceeds_what_the_node_has(self) -> None:
        # A container may claim more CPU than the pod it belongs to: the
        # breakdown is deliberately not cross-checked against the pod totals,
        # since those are effective requests. The raw ratio would report 30x the
        # machine here, which is not a bound on anything.
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(100, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=4500),
                containers=(
                    ContainerInfo(
                        name="app",
                        cpu_request_m=3000,
                        observed_cpu=UsageStat(avg=100, peak=3500),
                    ),
                ),
            ),
        )

        contention = contention_of(cluster, web=1)

        assert contention.flags[0].worst_case_share_m == 4000

    def test_a_p95_basis_reaches_both_the_message_and_the_note(self) -> None:
        # p95 is file-only in the UI, so it is the basis least likely to be
        # exercised by hand and the easiest to leave unworded.
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=200, p95=3500),
            ),
            Workload(
                name="batch",
                resources=Resources(3000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=1000),
            ),
        )

        contention = contention_of(cluster, web=1, batch=1)

        flag = contention.flags[0]
        assert flag.usage_basis == "p95"
        assert flag.message.startswith("web reaches a p95 of 3500m against a 1000m ")
        assert contention.basis_notes == (
            "Peak unavailable for 1 workload — p95 used; "
            "contention here is a lower bound.",
        )

    def test_both_kinds_of_note_can_fire_at_once(self) -> None:
        # The §4 bar is at most two lines, and this is the shape that reaches
        # it: one workload measured but without a peak, one not measured at all.
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=3500),
            ),
            Workload(
                name="batch",
                resources=Resources(1000, 256),
                current_replicas=1,
            ),
        )

        contention = contention_of(cluster, web=1, batch=1)

        assert contention.basis_notes == (
            "Peak unavailable for 1 workload — avg used; "
            "contention here is a lower bound.",
            "1 pod had no pod-level usage data — its request was used.",
        )

    def test_a_container_with_no_request_is_flagged_on_any_usage(self) -> None:
        """The pinned choice for a container that declared neither request nor limit.

        Its floor really is zero, so every millicore it uses is borrowed. kcap
        flags it on the same `usage > request` rule every other unit gets rather
        than exempting it below some threshold: nothing in this analysis filters
        by magnitude -- a 20m container against a 19m request already flags --
        and a rule that silenced the units with *no* floor would hide the most
        exposed shape on the node. The magnitude is in the row for the reader.
        """
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=3500),
                containers=(
                    ContainerInfo(
                        name="app",
                        cpu_request_m=1000,
                        observed_cpu=UsageStat(avg=100, peak=900),
                    ),
                    ContainerInfo(
                        name="debug-sidecar",
                        observed_cpu=UsageStat(avg=1, peak=5),
                    ),
                ),
            ),
            Workload(
                name="batch",
                resources=Resources(3000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=1000),
            ),
        )

        contention = contention_of(cluster, web=1, batch=1)

        assert [flag.container for flag in contention.flags] == ["debug-sidecar"]
        flag = contention.flags[0]
        assert (flag.cpu_request_m, flag.worst_case_share_m) == (0, 0)
        assert flag.message.startswith("debug-sidecar in web peaks at 5m against no ")

    def test_flags_come_out_in_a_stable_order(self) -> None:
        # Sorted by workload, then container, rather than emitted in placement
        # order: the same workload has to be findable in the same place when the
        # operator moves between scenario tabs.
        cluster = contention_cluster(
            Workload(
                name="zeta",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=2500),
            ),
            Workload(
                name="alpha",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=2500),
                containers=(
                    ContainerInfo(
                        name="sidecar", observed_cpu=UsageStat(avg=10, peak=40)
                    ),
                    ContainerInfo(
                        name="app", observed_cpu=UsageStat(avg=100, peak=2400)
                    ),
                ),
            ),
        )

        contention = contention_of(cluster, zeta=1, alpha=1)

        assert [(flag.workload, flag.container) for flag in contention.flags] == [
            ("alpha", "app"),
            ("alpha", "sidecar"),
            ("zeta", None),
        ]

    def test_a_pool_that_placed_nothing_reports_no_contention(self) -> None:
        # No node was opened, so there is no node that could be contended --
        # distinct from an all-clear, which is a node that was checked.
        cluster = contention_cluster(
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=0,
                observed_cpu_per_pod=UsageStat(avg=100, peak=3500),
            ),
        )

        result = evaluate_scenario("current", cluster, {"web": 0})

        assert result.pools["default"].cpu_contention is None

    def test_an_oversized_pod_is_on_no_node_and_contends_nothing(self) -> None:
        # Oversized pods are excluded from packing entirely, so they sit on no
        # NodeAllocation and cannot tip one -- even at a peak far past the
        # machine. The pool still has a packed node, from the pods that fit.
        cluster = contention_cluster(
            Workload(
                name="huge",
                resources=Resources(9000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=9000),
            ),
            Workload(
                name="web",
                resources=Resources(1000, 256),
                current_replicas=1,
                observed_cpu_per_pod=UsageStat(avg=100, peak=2000),
            ),
        )

        contention = contention_of(cluster, huge=1, web=1)

        assert contention.nodes_evaluated == 1
        assert contention.contended_node_count == 0
        assert contention.flags == ()

    def test_a_daemonset_reservation_leaves_the_node_sum_alone(self) -> None:
        # NodeAllocation's remaining figures start from allocatable, so the
        # reservation is outside this arithmetic: contention is measured against
        # what workload pods can actually be scheduled, and the DaemonSet's own
        # usage is not in any placed pod's figure.
        cluster = ClusterConfig(
            workloads={
                "web": Workload(
                    name="web",
                    resources=Resources(1000, 256),
                    current_replicas=1,
                    observed_cpu_per_pod=UsageStat(avg=100, peak=3500),
                ),
            },
            node_pools={
                "default": NodePool(
                    name="default",
                    machine=MachineSpec(
                        cpu_m=4000, memory_mib=8192, reserved_cpu_m=1000
                    ),
                    min_nodes=1,
                    current_nodes=2,
                    max_nodes=10,
                ),
            },
        )

        contention = contention_of(cluster, web=1)

        # 3500m against 3000m of allocatable, not against the machine's 4000m.
        assert contention.contended_node_count == 1
        assert contention.flags[0].worst_case_share_m == 3000


class TestRolloutAbsoluteSurge:
    """Absolute maxSurge is a pod count, not a ratio.

    Behavioral authority: kubernetes/kubernetes v1.33.0
    pkg/controller/deployment/util/deployment_util.go MaxSurge(), which calls
    ResolveFenceposts() ->
    intstr.GetScaledValueFromIntOrPercent(maxSurge, desired, roundUp=true).
    An Int value is returned unscaled; only a percent String is scaled against
    the replica count (and rounded up). Converting an absolute maxSurge into a
    percentage of the *current* replicas and then applying it at *max* replicas
    is the bug this class pins.
    """

    @pytest.mark.parametrize("max_replicas", [2, 20])
    def test_one_surge_pod_is_one_pod_at_any_replica_count(
        self,
        max_replicas: int,
    ) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(250, 128),
                current_replicas=2,
                hpa=HPA(1, max_replicas, cpu_target_percentage=70),
                rollout=Rollout(max_surge_pods=1),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.max_replicas == max_replicas
        assert result.rollout_replicas_at_max == max_replicas + 1

    def test_absolute_surge_takes_precedence_over_percent(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(250, 128),
                current_replicas=2,
                hpa=HPA(1, 20, cpu_target_percentage=70),
                rollout=Rollout(max_surge_pods=1, max_surge_percent=50),
            )
        )

        result = evaluate(cluster).workloads["api"]

        # The percent path would add 10 pods; the absolute value wins.
        assert result.rollout_replicas_at_max == 21

    def test_zero_absolute_surge_is_honoured_as_no_surge(self) -> None:
        # 0 is a set value, not an absent one: maxSurge: 0 means recreate-style
        # rollout headroom of nothing, and must not fall back to the percent.
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(250, 128),
                current_replicas=2,
                hpa=HPA(1, 12, cpu_target_percentage=70),
                rollout=Rollout(max_surge_pods=0, max_surge_percent=25),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.rollout_replicas_at_max == 12

    def test_absolute_surge_sizes_the_hpa_max_rollout_scenario(self) -> None:
        # 1000m pods on 4000m allocatable pack four per node.
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(1000, 1024),
                current_replicas=2,
                hpa=HPA(2, 20, cpu_target_percentage=70),
                rollout=Rollout(max_surge_pods=1),
            )
        )

        result = evaluate(cluster)
        rollout = result.scenarios["hpa_max_rollout"]

        assert rollout.replicas == {"api": 21}
        assert rollout.pod_count == 21
        # 20 pods fill five nodes exactly; the single surge pod opens a sixth.
        assert result.scenarios["hpa_max"].effective_nodes_required == 5
        assert rollout.effective_nodes_required == 6
        assert rollout.pools["default"].nodes_required == 6

    def test_negative_absolute_surge_is_rejected(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(100, 128),
                current_replicas=1,
                rollout=Rollout(max_surge_pods=-1),
            )
        )

        with pytest.raises(
            ValueError,
            match="api: rollout max surge pods cannot be negative",
        ):
            validate(cluster)

    def test_default_rollout_evaluates_identically_to_the_percent_only_engine(
        self,
    ) -> None:
        """Regression proof that adding max_surge_pods is inert by default.

        A representative multi-workload, multi-pool configuration that never
        sets max_surge_pods is evaluated twice: once through the shipped engine
        and once through percent_only_evaluate(), which reproduces the surge
        formula as it stood before this field existed. The comparison is over
        the whole ClusterResult via dataclasses.asdict -- every workload result
        and every field of all five scenarios, per pool -- not just the surge
        number, so any incidental change to the default path fails here.
        """
        cluster = representative_cluster()

        result = evaluate(cluster)

        for name, workload in cluster.workloads.items():
            assert workload.rollout.max_surge_pods is None
            max_replicas = result.workloads[name].max_replicas
            expected_surge = ceil(
                max_replicas * workload.rollout.max_surge_percent / 100
            )
            assert (
                result.workloads[name].rollout_replicas_at_max
                == max_replicas + expected_surge
            )

        assert asdict(result) == asdict(percent_only_evaluate(cluster))

    def test_absolute_surge_is_the_only_difference_from_the_default_result(
        self,
    ) -> None:
        # The converse of the proof above: setting the field on one workload
        # changes that workload's surge and the rollout scenario, and nothing
        # else in the result.
        baseline_result = asdict(evaluate(representative_cluster()))
        surged_result = asdict(
            evaluate(
                representative_cluster(rollouts={"api": Rollout(max_surge_pods=1)})
            )
        )

        assert baseline_result["workloads"]["api"]["rollout_replicas_at_max"] == 13
        assert surged_result["workloads"]["api"]["rollout_replicas_at_max"] == 11
        assert (
            baseline_result["workloads"]["worker"]
            == surged_result["workloads"]["worker"]
        )
        assert (
            baseline_result["workloads"]["cache"] == surged_result["workloads"]["cache"]
        )
        for scenario in ("hpa_min", "current", "hpa_desired", "hpa_max"):
            assert (
                baseline_result["scenarios"][scenario]
                == (surged_result["scenarios"][scenario])
            )
        assert surged_result["scenarios"]["hpa_max_rollout"]["replicas"]["api"] == 11


class TestSaturationAndConstraint:
    def test_capacity_and_stranded_capacity_track_the_node_target(self) -> None:
        cluster = cluster_with(
            Workload("api", Resources(2000, 6000), current_replicas=8),
            machine=MachineSpec(
                cpu_m=4000,
                memory_mib=16384,
                reserved_cpu_m=400,
                reserved_memory_mib=1536,
            ),
            min_nodes=1,
            current_nodes=1,
            max_nodes=18,
        )

        scenario = evaluate(cluster).scenarios["current"]
        pool = scenario.pools["default"]

        # Only one 2000m pod fits in 3600m of allocatable CPU.
        assert scenario.effective_nodes_required == 8
        assert pool.pods_per_node == 1
        assert pool.limiting_resource == "fragmentation"
        assert pool.fragmentation_resource == "cpu"
        assert pool.capacity_cpu_m == 8 * 3600
        assert pool.stranded_cpu_m == 8 * 3600 - 16000

    def test_memory_bound_shape_reports_memory_fragmentation(self) -> None:
        cluster = cluster_with(
            Workload("api", Resources(200, 3096), current_replicas=9),
            machine=MachineSpec(
                cpu_m=4000,
                memory_mib=16384,
                reserved_cpu_m=400,
                reserved_memory_mib=1536,
            ),
            min_nodes=1,
            current_nodes=1,
            max_nodes=18,
        )

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.effective_nodes_required == 3
        assert scenario.pools["default"].pods_per_node == 4
        assert scenario.pools["default"].fragmentation_resource == "memory"

    def test_tied_requirements_resolve_to_the_tighter_resource(self) -> None:
        # CPU rounds up from 1.0 nodes, memory from 2.0 nodes worth of demand
        # divided across the same node count; memory is the genuine pressure.
        cluster = cluster_with(
            Workload("api", Resources(1000, 3900), current_replicas=2),
            machine=MachineSpec(cpu_m=4000, memory_mib=4096),
        )

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.pools["default"].limiting_resource == "memory"

    def test_oversized_pods_are_excluded_from_the_node_instruction(self) -> None:
        cluster = cluster_with(
            Workload("api", Resources(5000, 128), current_replicas=3),
            machine=MachineSpec(cpu_m=4000, memory_mib=8192),
            min_nodes=0,
            current_nodes=0,
            max_nodes=10,
        )

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.oversized_pod_count == 3
        assert scenario.nodes_required == 0
        assert scenario.nodes_to_add == 0
        assert scenario.schedulable is False
        assert scenario.pools["default"].limiting_resource == "pod_too_large"


class TestScaleDownGating:
    """nodes_to_remove is an instruction, so it is withheld when unsafe.

    Each case asserts the ungated difference too: the arithmetic stays
    derivable from current_nodes and effective_nodes_required.
    """

    def test_oversized_pods_block_the_scale_down_instruction(self) -> None:
        # 5000m never fits a 4000m node, so all three pods are excluded from
        # the sizing and the pool requires nothing.
        cluster = cluster_with(
            Workload("api", Resources(5000, 128), current_replicas=3),
            machine=MachineSpec(cpu_m=4000, memory_mib=8192),
            min_nodes=0,
            current_nodes=4,
            max_nodes=10,
        )

        scenario = evaluate(cluster).scenarios["current"]
        pool_result = scenario.pools["default"]

        assert pool_result.oversized_pod_count == 3
        assert pool_result.effective_nodes_required == 0
        assert pool_result.nodes_to_remove == 0
        assert pool_result.scale_down_blocked_reason == "oversized_pods"
        # Ungated, this pool would have been told to drop all four of its nodes.
        assert pool_result.current_nodes - pool_result.effective_nodes_required == 4
        assert scenario.nodes_to_remove == 0

    def test_a_pool_with_nothing_placeable_keeps_its_nodes(self) -> None:
        # Scaled to zero replicas: nothing is oversized, there is simply no
        # demand to size the running nodes against.
        cluster = cluster_with(
            Workload("api", Resources(250, 128), current_replicas=0),
            min_nodes=0,
            current_nodes=3,
            max_nodes=10,
        )

        scenario = evaluate(cluster).scenarios["current"]
        pool_result = scenario.pools["default"]

        assert pool_result.pod_count == 0
        assert pool_result.oversized_pod_count == 0
        assert pool_result.effective_nodes_required == 0
        assert pool_result.nodes_to_remove == 0
        assert pool_result.scale_down_blocked_reason == "no_placeable_demand"
        assert pool_result.current_nodes - pool_result.effective_nodes_required == 3
        assert scenario.nodes_to_remove == 0

    def test_oversized_pods_block_the_scale_down_beside_placeable_demand(self) -> None:
        # The six 1000m pods pack onto two 4000m nodes, so the pool is sized
        # from real demand; only the one 5000m pod is excluded. The block is
        # unconditional on that placeable demand, not a symptom of an empty pool.
        cluster = ClusterConfig(
            workloads={
                "api": Workload(
                    "api",
                    Resources(1000, 128),
                    current_replicas=6,
                    pool="default",
                ),
                "oversized": Workload(
                    "oversized",
                    Resources(5000, 128),
                    current_replicas=1,
                    pool="default",
                ),
            },
            node_pools={
                "default": NodePool(
                    name="default",
                    machine=MachineSpec(cpu_m=4000, memory_mib=8192),
                    min_nodes=0,
                    current_nodes=20,
                    max_nodes=30,
                ),
            },
        )

        scenario = evaluate(cluster).scenarios["current"]
        pool_result = scenario.pools["default"]

        assert pool_result.oversized_pod_count == 1
        assert pool_result.effective_nodes_required == 2
        assert pool_result.nodes_to_remove == 0
        assert pool_result.scale_down_blocked_reason == "oversized_pods"
        # Ungated, the placeable demand alone would have removed 18 nodes.
        assert pool_result.current_nodes - pool_result.effective_nodes_required == 18
        assert scenario.nodes_to_remove == 0

    def test_a_pool_that_never_ran_nodes_is_not_blocked(self) -> None:
        # Nothing placeable and nothing running: an ordinary steady state, not
        # a scale-down instruction withheld.
        cluster = cluster_with(
            Workload("api", Resources(250, 128), current_replicas=0),
            min_nodes=0,
            current_nodes=0,
            max_nodes=10,
        )

        scenario = evaluate(cluster).scenarios["current"]
        pool_result = scenario.pools["default"]

        assert pool_result.pod_count == 0
        assert pool_result.effective_nodes_required == 0
        assert pool_result.current_nodes == 0
        assert pool_result.nodes_to_remove == 0
        assert pool_result.scale_down_blocked_reason is None
        assert scenario.nodes_to_remove == 0


def pool(name: str, *, cpu_m: int = 4000, memory_mib: int = 8192) -> NodePool:
    return NodePool(
        name=name,
        machine=MachineSpec(cpu_m=cpu_m, memory_mib=memory_mib),
        min_nodes=0,
        current_nodes=2,
        max_nodes=10,
    )


class TestMultiPool:
    def two_pool_cluster(self) -> ClusterConfig:
        return ClusterConfig(
            workloads={
                "api": Workload(
                    "api",
                    Resources(2000, 512),
                    current_replicas=3,
                    pool="general",
                ),
                "batch": Workload(
                    "batch",
                    Resources(500, 6000),
                    current_replicas=4,
                    pool="highmem",
                ),
            },
            node_pools={
                "general": pool("general"),
                "highmem": pool("highmem", memory_mib=16384),
            },
        )

    def test_pools_pack_independently_and_totals_sum(self) -> None:
        cluster = self.two_pool_cluster()

        scenario = evaluate(cluster).scenarios["current"]

        general = scenario.pools["general"]
        highmem = scenario.pools["highmem"]
        # Two 2000m pods per 4000m node; batch is memory-bound on 16 GiB nodes.
        assert general.pod_count == 3
        assert general.nodes_required == 2
        assert highmem.pod_count == 4
        assert highmem.nodes_required == 2
        assert scenario.pod_count == 7
        assert (
            scenario.nodes_required == general.nodes_required + highmem.nodes_required
        )
        assert scenario.effective_nodes_required == (
            general.effective_nodes_required + highmem.effective_nodes_required
        )
        assert scenario.current_nodes == 4
        assert scenario.cpu_requested_m == (
            general.cpu_requested_m + highmem.cpu_requested_m
        )

    def test_one_blocked_pool_blocks_the_scenario(self) -> None:
        cluster = self.two_pool_cluster()
        cluster = replace(
            cluster,
            workloads={
                **cluster.workloads,
                "batch": replace(
                    cluster.workloads["batch"],
                    resources=Resources(500, 20000),
                ),
            },
        )

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.pools["general"].schedulable is True
        assert scenario.pools["highmem"].schedulable is False
        assert scenario.schedulable is False

    def test_cluster_totals_sum_only_the_unblocked_scale_downs(self) -> None:
        cluster = self.two_pool_cluster()
        cluster = replace(
            cluster,
            workloads={
                # 5000m never fits general's 4000m nodes, blocking its removal.
                "api": replace(
                    cluster.workloads["api"],
                    resources=Resources(5000, 512),
                ),
                # One 6000 MiB pod needs one of highmem's two nodes.
                "batch": replace(cluster.workloads["batch"], current_replicas=1),
            },
        )

        scenario = evaluate(cluster).scenarios["current"]
        general = scenario.pools["general"]
        highmem = scenario.pools["highmem"]

        assert general.scale_down_blocked_reason == "oversized_pods"
        assert general.nodes_to_remove == 0
        assert general.current_nodes - general.effective_nodes_required == 2
        assert highmem.scale_down_blocked_reason is None
        assert highmem.nodes_to_remove == 1
        assert scenario.nodes_to_remove == 1

    def test_unknown_pool_is_rejected(self) -> None:
        cluster = cluster_with(
            Workload("api", Resources(100, 128), current_replicas=1, pool="gpu")
        )

        with pytest.raises(ValueError, match="unknown node pool"):
            validate(cluster)

    def test_multiple_pools_require_an_explicit_assignment(self) -> None:
        cluster = self.two_pool_cluster()
        cluster = replace(
            cluster,
            workloads={
                **cluster.workloads,
                "api": replace(cluster.workloads["api"], pool=None),
            },
        )

        with pytest.raises(ValueError, match="must name a node pool"):
            validate(cluster)

    def test_unset_pool_resolves_to_the_sole_pool(self) -> None:
        cluster = cluster_with(Workload("api", Resources(100, 128), current_replicas=2))

        scenario = evaluate(cluster).scenarios["current"]

        assert scenario.pools["default"].pod_count == 2

    def test_config_diff_tracks_pool_additions_and_changes(self) -> None:
        baseline = cluster_with(
            Workload("api", Resources(100, 128), current_replicas=1)
        )
        candidate = replace(
            baseline,
            node_pools={**baseline.node_pools, "gpu": pool("gpu")},
        )
        candidate = update_machine_cpu(candidate, "default", 8000)

        diff = compare_config(baseline, candidate)

        assert diff.node_pools_added == ("gpu",)
        assert diff.node_pools_removed == ()
        change = diff.changes["node_pools.default.machine.cpu_m"]
        assert (change.before, change.after) == (4000, 8000)
