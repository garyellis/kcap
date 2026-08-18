# syntax=docker/dockerfile:1.7

# A base image tag cannot read `.python-version`, so the 3.13 below is a manual
# copy of that pin — bump both together. `node:24-alpine` likewise tracks the
# node pin in `.mise.toml`, and the uv image tag tracks the uv pin.

FROM node:24-alpine AS frontend-builder
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim-bookworm AS backend-builder
COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /uvx /bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
COPY pyproject.toml uv.lock README.md ./
COPY src/ ./src/
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.13-slim-bookworm AS runtime
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    KCAP_FRONTEND_DIR=/app/frontend/dist

RUN addgroup --system kcap \
    && adduser --system --ingroup kcap --home /app kcap

WORKDIR /app
COPY --from=backend-builder --chown=kcap:kcap /app/.venv ./.venv
COPY --from=frontend-builder --chown=kcap:kcap /build/frontend/dist ./frontend/dist

# Declared after the COPYs so a new version only invalidates this trivial layer.
# CI passes the released semver; `docker build` without it keeps the placeholder.
ARG KCAP_VERSION=0.0.0
ENV KCAP_VERSION=${KCAP_VERSION}

USER kcap
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]

CMD ["uvicorn", "kcap.api:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
