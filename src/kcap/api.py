"""FastAPI surface for the capacity engine."""

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import __version__
from .engine import compare_config, compare_results, evaluate
from .schemas import (
    ClusterConfigSchema,
    ClusterResultSchema,
    CompareRequest,
    CompareResponse,
    HealthResponse,
)

_DEFAULT_CORS_ORIGINS = (
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:5173,http://127.0.0.1:5173"
)


def _cors_origins() -> list[str]:
    configured = os.getenv("KCAP_CORS_ORIGINS", _DEFAULT_CORS_ORIGINS)
    return [origin.strip() for origin in configured.split(",") if origin.strip()]


def create_app(frontend_directory: str | Path | None = None) -> FastAPI:
    app = FastAPI(
        title="kcap API",
        version=__version__,
        description="Kubernetes workload and node-capacity simulation API.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    @app.get("/health", response_model=HealthResponse, tags=["system"])
    def health() -> HealthResponse:
        return HealthResponse(status="ok", version=__version__)

    @app.post(
        "/v1/evaluate",
        response_model=ClusterResultSchema,
        tags=["capacity"],
    )
    def evaluate_cluster(config: ClusterConfigSchema) -> ClusterResultSchema:
        try:
            result = evaluate(config.to_domain())
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return ClusterResultSchema.model_validate(result)

    @app.post(
        "/v1/compare",
        response_model=CompareResponse,
        tags=["capacity"],
    )
    def compare_clusters(request: CompareRequest) -> CompareResponse:
        baseline = request.baseline.to_domain()
        candidate = request.candidate.to_domain()
        try:
            baseline_result = evaluate(baseline)
            candidate_result = evaluate(candidate)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

        return CompareResponse.model_validate(
            {
                "baseline_result": baseline_result,
                "candidate_result": candidate_result,
                "configuration_diff": compare_config(baseline, candidate),
                "impact_diff": compare_results(baseline_result, candidate_result),
            }
        )

    if frontend_directory is None:
        # `or None` matters: an explicitly-empty var would otherwise become
        # Path("") -> "." and mount the working directory as static files.
        frontend_directory = os.getenv("KCAP_FRONTEND_DIR") or None
    if frontend_directory is None:
        frontend_directory = Path(__file__).resolve().parents[2] / "frontend" / "dist"

    frontend_path = Path(frontend_directory)
    if frontend_path.is_dir():
        # Mounted last so API and OpenAPI routes retain precedence.
        app.mount(
            "/",
            StaticFiles(directory=frontend_path, html=True),
            name="frontend",
        )

    return app


app = create_app()
