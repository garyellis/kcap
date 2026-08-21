from copy import deepcopy
from importlib.metadata import PackageNotFoundError
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import kcap
from kcap.api import app, create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def cluster_payload() -> dict[str, Any]:
    return {
        "workloads": {
            "api": {
                "name": "api",
                "resources": {
                    "cpu_request_m": 500,
                    "memory_request_mib": 256,
                    "cpu_limit_m": 1000,
                    "memory_limit_mib": 512,
                },
                "current_replicas": 4,
                "observed_cpu_per_pod": {"avg": 400},
                "observed_memory_per_pod": {"avg": 128},
                "hpa": {
                    "min_replicas": 2,
                    "max_replicas": 10,
                    "cpu_target_percentage": 70,
                    "memory_target_percentage": 70,
                },
                "rollout": {"max_surge_percent": 25},
            }
        },
        "node_pools": {
            "default": {
                "name": "default",
                "machine": {
                    "cpu_m": 4000,
                    "memory_mib": 8192,
                    "reserved_cpu_m": 200,
                    "reserved_memory_mib": 512,
                    "max_pods": 110,
                },
                "min_nodes": 1,
                "current_nodes": 2,
                "max_nodes": 10,
            },
        },
    }


def test_health(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": kcap.__version__}


def test_resolve_version_prefers_the_build_injected_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KCAP_VERSION", "1.4.2")

    assert kcap._resolve_version() == "1.4.2"


def test_resolve_version_ignores_a_blank_injected_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("KCAP_VERSION", "   ")
    monkeypatch.setattr(kcap, "_distribution_version", lambda _: "9.9.9")

    assert kcap._resolve_version() == "9.9.9"


def test_resolve_version_falls_back_to_distribution_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("KCAP_VERSION", raising=False)
    # Distinct from the placeholder, so this genuinely proves the metadata path.
    monkeypatch.setattr(kcap, "_distribution_version", lambda _: "9.9.9")

    assert kcap._resolve_version() == "9.9.9"


def test_resolve_version_falls_back_to_the_placeholder_when_uninstalled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _missing(_: str) -> str:
        raise PackageNotFoundError("kcap")

    monkeypatch.delenv("KCAP_VERSION", raising=False)
    monkeypatch.setattr(kcap, "_distribution_version", _missing)

    assert kcap._resolve_version() == "0.0.0"


def test_openapi_version_matches_the_reported_version(client: TestClient) -> None:
    assert client.get("/openapi.json").json()["info"]["version"] == kcap.__version__


def test_evaluate(client: TestClient, cluster_payload: dict[str, Any]) -> None:
    response = client.post("/v1/evaluate", json=cluster_payload)

    assert response.status_code == 200
    body = response.json()
    assert body["workloads"]["api"]["cpu_utilization_percent"] == 80
    assert body["workloads"]["api"]["desired_replicas"] == 5
    assert body["workloads"]["api"]["clamped_by"] is None
    assert body["scenarios"]["current"]["current_nodes"] == 2
    assert "effective_nodes_required" in body["scenarios"]["hpa_max"]
    assert "limiting_resource" in body["scenarios"]["hpa_max"]["pools"]["default"]
    default_pool = body["scenarios"]["current"]["pools"]["default"]
    assert default_pool["nodes_to_remove"] == 1
    assert default_pool["scale_down_blocked_reason"] is None


def test_evaluate_withholds_a_scale_down_for_oversized_pods(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # 5000m never fits the fixture's 3800m allocatable node, so all four pods
    # are excluded from the sizing and the pool falls back to its one-node
    # minimum; ungated that would have instructed a removal.
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["resources"]["cpu_request_m"] = 5000
    payload["workloads"]["api"]["resources"]["cpu_limit_m"] = 5000

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 200
    pool = response.json()["scenarios"]["current"]["pools"]["default"]
    assert pool["oversized_pod_count"] == 4
    assert pool["nodes_to_remove"] == 0
    assert pool["scale_down_blocked_reason"] == "oversized_pods"
    assert pool["current_nodes"] - pool["effective_nodes_required"] == 1


def test_evaluate_withholds_a_scale_down_with_no_placeable_demand(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # Scaled to zero against a pool with no minimum: two running nodes, no
    # demand to size them against.
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["current_replicas"] = 0
    payload["node_pools"]["default"]["min_nodes"] = 0

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 200
    pool = response.json()["scenarios"]["current"]["pools"]["default"]
    assert pool["pod_count"] == 0
    assert pool["nodes_to_remove"] == 0
    assert pool["scale_down_blocked_reason"] == "no_placeable_demand"
    assert pool["current_nodes"] - pool["effective_nodes_required"] == 2


def test_evaluate_reports_which_end_of_the_hpa_range_clamped(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["hpa"]["min_replicas"] = 8

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["workloads"]["api"]["desired_replicas"] == 8
    assert body["workloads"]["api"]["clamped_by"] == "min"


def test_evaluate_honours_an_absolute_rollout_surge(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # maxSurge: 1 is one pod. The percent field is left at the value the
    # default fixture carries to prove absolute takes precedence over it.
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["rollout"] = {
        "max_surge_percent": 25,
        "max_surge_pods": 1,
    }

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["workloads"]["api"]["max_replicas"] == 10
    assert body["workloads"]["api"]["rollout_replicas_at_max"] == 11
    assert body["scenarios"]["hpa_max_rollout"]["replicas"] == {"api": 11}


def test_evaluate_without_max_surge_pods_keeps_the_percent_result(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # The fixture's {"max_surge_percent": 25} at an HPA max of 10 stays at
    # ceil(10 * 0.25) == 3 surge pods, and omitting the rollout block entirely
    # lands on the same default.
    omitted = deepcopy(cluster_payload)
    del omitted["workloads"]["api"]["rollout"]

    explicit_body = client.post("/v1/evaluate", json=cluster_payload).json()
    omitted_body = client.post("/v1/evaluate", json=omitted).json()

    assert explicit_body["workloads"]["api"]["rollout_replicas_at_max"] == 13
    assert explicit_body == omitted_body


def test_negative_max_surge_pods_is_rejected(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    cluster_payload["workloads"]["api"]["rollout"]["max_surge_pods"] = -1

    response = client.post("/v1/evaluate", json=cluster_payload)

    assert response.status_code == 422


def test_a_zero_usage_average_is_carried_through(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # Zero is a measurement, not a missing value: an idle workload scales to
    # the HPA floor. Dropping it would leave the metric unusable and hold the
    # replica count where it is.
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["observed_cpu_per_pod"] = {"avg": 0}
    payload["workloads"]["api"]["observed_memory_per_pod"] = {"avg": 0}

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["workloads"]["api"]["cpu_utilization_percent"] == 0
    assert body["workloads"]["api"]["desired_replicas"] == 2


def test_usage_statistics_beyond_the_average_do_not_move_the_hpa(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # p95 and peak are carried for the exposure and sizing questions; the
    # replica math reads the average and nothing else.
    payload = deepcopy(cluster_payload)
    workload = payload["workloads"]["api"]
    workload["observed_cpu_per_pod"] = {
        **workload["observed_cpu_per_pod"],
        "p95": 480,
        "peak": 950,
    }
    workload["usage_window_seconds"] = 300
    workload["usage_source"] = "metrics-server-samples"

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["workloads"]["api"]["cpu_utilization_percent"] == 80
    assert body["workloads"]["api"]["desired_replicas"] == 5


def test_the_withdrawn_scalar_usage_fields_are_rejected(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # The summary form is the only accepted form; the pre-distribution scalars
    # are now just unknown fields, which extra="forbid" refuses.
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["observed_cpu_per_pod_m"] = 400

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert [error["type"] for error in detail] == ["extra_forbidden"]
    assert detail[0]["loc"][-1] == "observed_cpu_per_pod_m"


def test_a_peak_below_the_average_is_rejected(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # A maximum cannot sit below the mean it summarises.
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["observed_cpu_per_pod"] = {"avg": 400, "peak": 399}

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 422
    assert "peak cannot be below avg" in response.text


def test_a_negative_usage_statistic_is_rejected(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["observed_cpu_per_pod"] = {"avg": 400, "p95": -1}

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 422
    # Named where the client can find it, not just refused.
    assert response.json()["detail"][0]["loc"][-2:] == ["observed_cpu_per_pod", "p95"]


CONTAINER_BREAKDOWN = [
    {
        "name": "app",
        "cpu_request_m": 481,
        "memory_request_mib": 192,
        "cpu_limit_m": 1000,
        "memory_limit_mib": 512,
        "observed_cpu": {"avg": 380, "peak": 900},
    },
    {
        "name": "istio-proxy",
        "cpu_request_m": 19,
        "memory_request_mib": 64,
        "observed_cpu": {"avg": 20, "peak": 210},
    },
]


def test_a_container_breakdown_moves_no_result(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # Analysis-only: the breakdown is carried, validated, and read by nothing.
    # Its usage peaks are far above the average the HPA reads, and its requests
    # deliberately do not sum to the pod request.
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["containers"] = deepcopy(CONTAINER_BREAKDOWN)

    with_containers = client.post("/v1/evaluate", json=payload)
    without = client.post("/v1/evaluate", json=cluster_payload)

    assert with_containers.status_code == 200
    assert with_containers.json() == without.json()


def test_an_unnamed_container_is_rejected_at_the_field(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["containers"] = [{"name": ""}]

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"][-2:] == [0, "name"]


def test_an_empty_container_list_is_rejected(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # Null says "no breakdown known"; an empty list would say a pod has no
    # containers, which no pod does. One spelling, so consumers cannot differ.
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["containers"] = []

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"][-1] == "containers"


def test_duplicate_container_names_are_rejected(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # Analysis is reported per (workload, container), so the name has to
    # identify one container -- which Kubernetes guarantees it does.
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["containers"] = [{"name": "app"}, {"name": "app"}]

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 422
    assert "duplicate container name 'app'" in response.text


def test_a_container_breakdown_surfaces_in_the_configuration_diff(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # compare_config recurses over every dataclass field, so adding
    # containers to Workload widened /v1/compare whether or not the analysis
    # reads it -- the same knock-on UsageStat had. Pinned rather than
    # discovered later: this is the first sequence-valued leaf in the diff, so
    # unlike resources.cpu_limit_m it reports the whole list rather than the
    # one container that changed. A tuple is not a dataclass, so
    # _compare_config_values cannot recurse into it.
    candidate = deepcopy(cluster_payload)
    candidate["workloads"]["api"]["containers"] = deepcopy(CONTAINER_BREAKDOWN)

    response = client.post(
        "/v1/compare",
        json={"baseline": cluster_payload, "candidate": candidate},
    )

    assert response.status_code == 200
    change = response.json()["configuration_diff"]["changes"][
        "workloads.api.containers"
    ]
    assert change["before"] is None
    assert [container["name"] for container in change["after"]] == [
        "app",
        "istio-proxy",
    ]


def test_a_container_request_above_its_own_limit_is_rejected(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # Within one container this is a shape Kubernetes rejects outright, and
    # the analysis this list feeds caps a worst-case share at the limit.
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["containers"] = [
        {"name": "app", "cpu_request_m": 500, "cpu_limit_m": 100}
    ]

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 422
    assert "api/app: container CPU request cannot exceed its limit" in response.text


def test_a_container_peak_below_its_average_is_rejected(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # The same ordering invariant as the pod-level statistics, named per
    # container so the offending one can be found.
    payload = deepcopy(cluster_payload)
    payload["workloads"]["api"]["containers"] = [
        {"name": "istio-proxy", "observed_cpu": {"avg": 210, "peak": 19}}
    ]

    response = client.post("/v1/evaluate", json=payload)

    assert response.status_code == 422
    assert "api/istio-proxy: observed CPU peak cannot be below avg" in response.text


def test_compare_reports_usage_changes_per_statistic(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # The diff path follows the summary shape: usage is a statistic, not a
    # scalar, so an edit reports per-statistic paths.
    baseline = deepcopy(cluster_payload)
    candidate = deepcopy(baseline)
    candidate["workloads"]["api"]["observed_cpu_per_pod"] = {"avg": 450, "peak": 900}

    response = client.post(
        "/v1/compare",
        json={"baseline": baseline, "candidate": candidate},
    )

    assert response.status_code == 200
    changes = response.json()["configuration_diff"]["changes"]
    assert changes["workloads.api.observed_cpu_per_pod.avg"] == {
        "before": 400,
        "after": 450,
    }
    assert changes["workloads.api.observed_cpu_per_pod.peak"] == {
        "before": None,
        "after": 900,
    }


def test_compare_reports_usage_appearing_as_one_change(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # Usage arriving where there was none has no per-statistic before value to
    # compare against, so the whole summary is the change.
    baseline = deepcopy(cluster_payload)
    del baseline["workloads"]["api"]["observed_cpu_per_pod"]
    candidate = deepcopy(baseline)
    candidate["workloads"]["api"]["observed_cpu_per_pod"] = {"avg": 400}

    response = client.post(
        "/v1/compare",
        json={"baseline": baseline, "candidate": candidate},
    )

    assert response.status_code == 200
    changes = response.json()["configuration_diff"]["changes"]
    assert changes["workloads.api.observed_cpu_per_pod"] == {
        "before": None,
        "after": {"avg": 400, "p95": None, "peak": None},
    }


def test_compare_returns_configuration_and_impact_diffs(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    candidate = deepcopy(cluster_payload)
    candidate["workloads"]["api"]["resources"]["cpu_limit_m"] = 1500

    response = client.post(
        "/v1/compare",
        json={"baseline": cluster_payload, "candidate": candidate},
    )

    assert response.status_code == 200
    body = response.json()
    limit_change = body["configuration_diff"]["changes"][
        "workloads.api.resources.cpu_limit_m"
    ]
    assert limit_change == {"before": 1000, "after": 1500}
    assert body["impact_diff"]["scenarios"]["current"]["nodes_required"]["delta"] == 0


def test_compare_supports_node_overhead_limits_and_multiple_workloads(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    candidate = deepcopy(cluster_payload)
    candidate["node_pools"]["default"]["machine"].update(
        {
            "memory_mib": 16384,
            "reserved_cpu_m": 500,
            "reserved_memory_mib": 2048,
        }
    )
    candidate["workloads"]["worker"] = {
        "name": "worker",
        "resources": {
            "cpu_request_m": 250,
            "memory_request_mib": 512,
            "cpu_limit_m": 1000,
            "memory_limit_mib": 2048,
        },
        "current_replicas": 3,
        "observed_cpu_per_pod": {"avg": 150},
        "observed_memory_per_pod": {"avg": 384},
        "hpa": None,
        "rollout": {"max_surge_percent": 25},
    }

    response = client.post(
        "/v1/compare",
        json={"baseline": cluster_payload, "candidate": candidate},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["configuration_diff"]["workloads_added"] == ["worker"]
    assert body["configuration_diff"]["changes"][
        "node_pools.default.machine.reserved_memory_mib"
    ] == {"before": 512, "after": 2048}
    assert body["candidate_result"]["scenarios"]["current"]["replicas"] == {
        "api": 4,
        "worker": 3,
    }


def test_engine_validation_is_returned_as_422(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    cluster_payload["node_pools"]["default"]["machine"]["reserved_cpu_m"] = 4000

    response = client.post("/v1/evaluate", json=cluster_payload)

    assert response.status_code == 422
    assert "reserved CPU must be less" in response.json()["detail"]


def test_the_withdrawn_singular_node_pool_key_is_rejected(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    # node_pools is the only accepted form; the pre-multi-pool singular key is
    # now just an unknown field, which extra="forbid" refuses.
    payload = deepcopy(cluster_payload)
    payload["node_pool"] = deepcopy(payload["node_pools"]["default"])

    response = client.post("/v1/evaluate", json=payload)

    # node_pools is still present and valid, so the extra key is the only
    # reason this fails.
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert [error["type"] for error in detail] == ["extra_forbidden"]
    assert detail[0]["loc"][-1] == "node_pool"


def test_evaluate_partitions_workloads_across_pools(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    cluster_payload["node_pools"]["highmem"] = {
        "name": "highmem",
        "machine": {"cpu_m": 4000, "memory_mib": 32768},
        "min_nodes": 0,
        "current_nodes": 1,
        "max_nodes": 5,
    }
    cluster_payload["workloads"]["api"]["pool"] = "default"
    cluster_payload["workloads"]["cache"] = {
        "name": "cache",
        "resources": {"cpu_request_m": 250, "memory_request_mib": 8192},
        "current_replicas": 2,
        "pool": "highmem",
    }

    response = client.post("/v1/evaluate", json=cluster_payload)

    assert response.status_code == 200
    scenario = response.json()["scenarios"]["current"]
    assert scenario["pools"]["default"]["pod_count"] == 4
    assert scenario["pools"]["highmem"]["pod_count"] == 2
    assert scenario["effective_nodes_required"] == (
        scenario["pools"]["default"]["effective_nodes_required"]
        + scenario["pools"]["highmem"]["effective_nodes_required"]
    )


def test_multiple_pools_without_an_assignment_is_a_422(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    cluster_payload["node_pools"]["gpu"] = deepcopy(
        cluster_payload["node_pools"]["default"]
    )
    cluster_payload["node_pools"]["gpu"]["name"] = "gpu"

    response = client.post("/v1/evaluate", json=cluster_payload)

    assert response.status_code == 422
    assert "must name a node pool" in response.json()["detail"]


def test_request_schema_rejects_unknown_fields(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    cluster_payload["unexpected"] = True

    response = client.post("/v1/evaluate", json=cluster_payload)

    assert response.status_code == 422


def test_openapi_exposes_capacity_endpoints(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()

    assert "/v1/evaluate" in schema["paths"]
    assert "/v1/compare" in schema["paths"]


def test_built_frontend_can_be_served_by_api(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<h1>KCAP frontend</h1>")
    combined_app = create_app(frontend_directory=tmp_path)

    response = TestClient(combined_app).get("/")

    assert response.status_code == 200
    assert "KCAP frontend" in response.text
    assert TestClient(combined_app).get("/health").json() == {
        "status": "ok",
        "version": kcap.__version__,
    }
