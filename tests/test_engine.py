from dataclasses import asdict, replace
from math import ceil

import pytest

from kcap.engine import (
    HPA,
    ClusterConfig,
    ClusterResult,
    MachineSpec,
    NodePool,
    Resources,
    Rollout,
    Workload,
    WorkloadResult,
    add_workload,
    compare_config,
    compare_results,
    evaluate,
    evaluate_hpa,
    evaluate_scenario,
    min_replicas_for,
    remove_workload,
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
                observed_cpu_per_pod_m=125,
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
                observed_cpu_per_pod_m=250,
                observed_memory_per_pod_mib=1500,
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
                observed_cpu_per_pod_m=1000,
                hpa=HPA(2, 6, cpu_target_percentage=50),
            )
        )
        low = replace(
            high,
            workloads={
                "api": replace(
                    high.workloads["api"],
                    current_replicas=1,
                    observed_cpu_per_pod_m=0,
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
                    observed_cpu_per_pod_m=-1,
                ),
                "api: observed CPU cannot be negative",
            ),
            (
                Workload(
                    "api",
                    Resources(100, 128),
                    current_replicas=1,
                    observed_memory_per_pod_mib=-1,
                ),
                "api: observed memory cannot be negative",
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
                observed_cpu_per_pod_m=750,
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
                observed_cpu_per_pod_m=850,
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
                observed_cpu_per_pod_m=1400,
                hpa=HPA(3, 9, cpu_target_percentage=80),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.cpu_utilization_percent == 700
        assert result.raw_desired_replicas == 79
        assert result.desired_replicas == 9
        assert result.hpa_saturated is True

    def test_unclamped_recommendation_is_not_saturated(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(2000, 256),
                current_replicas=9,
                observed_cpu_per_pod_m=1400,
                hpa=HPA(3, 9, cpu_target_percentage=80),
            )
        )

        result = evaluate(cluster).workloads["api"]

        assert result.raw_desired_replicas == 8
        assert result.desired_replicas == 8
        assert result.hpa_saturated is False
        assert result.clamped_by is None

    def test_clamped_by_names_the_ceiling_that_capped_the_recommendation(self) -> None:
        cluster = cluster_with(
            Workload(
                name="api",
                resources=Resources(200, 256),
                current_replicas=9,
                observed_cpu_per_pod_m=1400,
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
                observed_cpu_per_pod_m=100,
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
                observed_cpu_per_pod_m=400,
                hpa=HPA(2, 10, cpu_target_percentage=70),
                rollout=rollouts.get("api", Rollout()),
                pool="default",
            ),
            "worker": Workload(
                name="worker",
                resources=Resources(250, 512),
                current_replicas=3,
                observed_memory_per_pod_mib=384,
                rollout=rollouts.get("worker", Rollout(max_surge_percent=10)),
                pool="default",
            ),
            "cache": Workload(
                name="cache",
                resources=Resources(1000, 8192),
                current_replicas=2,
                observed_memory_per_pod_mib=6000,
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
