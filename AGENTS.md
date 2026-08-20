# AGENTS.md

## Project

kcap is a Kubernetes capacity-planning simulator. It expands workloads into pods,
evaluates HPA and rollout scenarios, and estimates nodes with deterministic
first-fit-decreasing packing. It is an advisor, not kube-scheduler or an autoscaler.

Keep assumptions visible. Never present an approximation as Kubernetes parity.

## Architecture

- `src/kcap/engine.py`: framework-free domain models, invariants, HPA/scenario math,
  pod packing, and comparisons.
- `src/kcap/schemas.py`: Pydantic HTTP models and domain adapters.
- `src/kcap/api.py`: FastAPI routes, CORS, version reporting, and UI serving.
- Backend layers are `api` (outer), `schemas`, then `engine` (inner). Imports may
  go inward across layers, never outward.
- `frontend/src/api.ts` is the HTTP/type boundary; `importers.ts` holds pure
  Kubernetes/scenario transforms; `components/` and `App.tsx` are the React UI.
  Keep `api.ts`, `defaults.ts`, and `importers.ts` independent of UI modules.
- `frontend/src/generated/` comes from FastAPI OpenAPI; never hand-edit it.
- The production image builds Vite and serves it through FastAPI on port 8100.

Stack: Python 3.13, uv, FastAPI, Pydantic, pytest, React, TypeScript, Vite, Vitest,
Docker, and mise. Tool pins: `.python-version` and `.mise.toml`; tasks: `.mise.toml`;
dependencies: `pyproject.toml` and `frontend/package.json`.

## Kubernetes behavior

Kubernetes-sensitive behavior must be correct within kcap's stated boundaries.

- Use official `kubernetes/kubernetes` implementation and adjacent tests as the
  behavioral authority. Pin evidence to a release tag, or an exact commit for
  unreleased behavior; never use a moving branch.
- Documentation, API references, KEPs, and live-cluster reproductions are supporting
  evidence, not substitutes for upstream source and tests.
- Before changing HPA math, rollout surge, quantities, request defaulting, effective
  Pod requests, or scheduling fit, locate the relevant upstream types, defaulting,
  validation, controller, or scheduler code and add focused local tests.
- For non-obvious or version-sensitive behavior, record tag/commit, path, and symbol
  in a short test comment or design note. If releases or feature gates differ,
  preserve kcap's tested behavior unless the task selects a target, and state the choice.

Preserve these boundaries: static pools with no spillover; CPU, memory, and pod slots
only; imported node selectors may infer a pool, but taints/tolerations, affinity,
topology spread, PDBs, and scheduler scoring are not simulated; DaemonSet overhead is
modeled only as configured flat per-node CPU/memory reservation and uses no `max_pods`
slot; observed per-pod usage stays constant across scenarios; first-fit-decreasing is
a heuristic. Document and test intentional approximations or Kubernetes divergences.

## Change rules

- Keep domain behavior deterministic and framework-free; prefer frozen models and pure
  functions. Keep HTTP validation in schemas and domain invariants in the engine.
- For API contract changes, update schemas, API tests, consumers, and generated types.
  Use the export and generator commands in `scripts/check-api-contract.sh`, targeting
  `frontend/src/generated/`; `mise run api-contract` must pass.
- Keep import transforms pure and export projections allowlisted. Do not export images,
  environment variables, annotations, or secrets unless the task explicitly requires
  and tests the wider data boundary.
- Add regression tests for behavior changes and HTTP boundary tests for contract changes.
  Update docs when model inputs, outputs, assumptions, or limitations change.
- Add dependencies with `uv add <pkg>` or `npm install <pkg> --prefix frontend`;
  commit the matching lockfile.
- Never weaken lint, architecture, contract, security, or dead-code gates to pass CI.

## Workflow

Use mise for repository tasks.

- Run `mise run setup` when dependencies are absent or lockfiles changed.
- After code changes, run the smallest relevant tests and `mise run habit-hooks`.
- Before handing off code, configuration, or dependency changes, run
  `mise run check`; it covers all tests, quality/architecture gates, Habit Hooks,
  the OpenAPI contract, production build, and security scans.
- Fix change-caused failures. If another failure remains, report its command and
  relevant output; do not claim full verification.
