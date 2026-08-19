"""kcap package."""

import os
from importlib.metadata import PackageNotFoundError, version as _distribution_version

_PLACEHOLDER_VERSION = "0.0.0"


def _resolve_version() -> str:
    """Return the running build's version.

    The version in `pyproject.toml` is a placeholder that nothing writes back to,
    so the release version is injected into the image as `KCAP_VERSION` and takes
    precedence. Falling back to the installed distribution metadata keeps a plain
    `pip install .` honest, and the placeholder covers a source checkout.
    """
    injected = os.getenv("KCAP_VERSION", "").strip()
    if injected:
        return injected
    try:
        return _distribution_version("kcap")
    except PackageNotFoundError:
        return _PLACEHOLDER_VERSION


__version__ = _resolve_version()


def main() -> None:
    """Run the kcap API server."""
    import uvicorn

    uvicorn.run(
        "kcap.api:app",
        host="0.0.0.0",
        port=8100,
        reload=False,
    )
