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
                "observed_cpu_per_pod_m": 400,
                "observed_memory_per_pod_mib": 128,
                "hpa": {
                    "min_replicas": 2,
                    "max_replicas": 10,
                    "cpu_target_percentage": 70,
                    "memory_target_percentage": 70,
                },
                "rollout": {"max_surge_percent": 25},
            }
        },
        "node_pool": {
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
    assert body["workloads"]["api"]["desired_replicas"] == 5
    assert body["scenarios"]["current"]["current_nodes"] == 2
    assert "effective_nodes_required" in body["scenarios"]["hpa_max"]
    assert "limiting_resource" in body["scenarios"]["hpa_max"]


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
    assert body["impact_diff"]["scenarios"]["current"]["nodes_required"][
        "delta"
    ] == 0


def test_compare_supports_node_overhead_limits_and_multiple_workloads(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    candidate = deepcopy(cluster_payload)
    candidate["node_pool"]["machine"].update(
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
        "observed_cpu_per_pod_m": 150,
        "observed_memory_per_pod_mib": 384,
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
        "node_pool.machine.reserved_memory_mib"
    ] == {"before": 512, "after": 2048}
    assert body["candidate_result"]["scenarios"]["current"]["replicas"] == {
        "api": 4,
        "worker": 3,
    }


def test_engine_validation_is_returned_as_422(
    client: TestClient,
    cluster_payload: dict[str, Any],
) -> None:
    cluster_payload["node_pool"]["machine"]["reserved_cpu_m"] = 4000

    response = client.post("/v1/evaluate", json=cluster_payload)

    assert response.status_code == 422
    assert "Reserved CPU must be less" in response.json()["detail"]


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
