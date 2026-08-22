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
  Kubernetes/scenario transforms; `surge.ts` holds the rollout-surge unit math the
  editor shares with the engine; `caAction.ts` maps the engine's node deltas to the
  results panel's CA-action readout; `usage.ts` keeps an edited observed-usage
  summary within the engine's ordering rules; `breakdown.ts` drops a per-container
  breakdown the pod-level editor has just contradicted; `contention.ts` and
  `exposure.ts` read the engine's CPU-contention and node-limit-exposure blocks
  for the Runtime risk section; `format.ts` prints millicores and MiB as an
  operator reads them, and agrees a count with the noun beside it;
  `populations.ts` names which pod population each of the
  results panel's readings is about; `components/` and
  `App.tsx` are the React UI. Every plain `.ts` at the root of `frontend/src/`
  is core and may not import a React module; the `core-does-not-import-ui` rule
  in `frontend/dependency-cruiser.config.mjs` enforces that by pattern rather
  than by a list, so a new one is covered the moment it exists.
- `frontend/src/components/` holds every React module that is not `App.tsx`,
  plus helpers private to them (`clipboard.ts`/`download.ts` for the modals,
  `fieldValue.ts` for `Fields.tsx`). Reusability is not the criterion — a
  one-off panel section belongs there beside a generic `Modal`. A helper
  imported from outside that directory belongs one level up in `src/` instead.
  A results-panel section moves out of `App.tsx` once it owns bindings — hooks,
  memos, derived readouts — that no sibling section reads; a section that only
  reads `ResultsPanel`'s shared bindings stays inline, because extracting it
  would mean passing those same bindings back down as props.
- `frontend/src/generated/` comes from FastAPI OpenAPI; never hand-edit it.
- `frontend/e2e/` is the Playwright suite for scenarios promoted out of
  `docs/ui-regression-scenarios.md`. It drives the built UI from outside and imports
  nothing from `src/`; `frontend/e2e/support/kcap.ts` states its selector policy.
- Frontend vitest suites are pure-module. `components/Fields.test.tsx` is the exception
  and stays a narrow one: it renders the field under jsdom, declared per file so every
  other suite keeps the node environment. Reach for a rendered test only where the claim
  is about what a component *displays* given how a caller answered it, which no pure
  function holds. A claim an operator would state as a gesture belongs in `frontend/e2e/`.
- The production image builds Vite and serves it through FastAPI on port 8100.

Stack: Python 3.13, uv, FastAPI, Pydantic, pytest, React, TypeScript, Vite, Vitest,
Playwright, Docker, and mise. Tool pins: `.python-version` and `.mise.toml`; tasks: `.mise.toml`;
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
- `docs/model-fidelity.md` is the authoritative record of how kcap models Kubernetes and where it
  departs, with pinned upstream evidence. Changing any behavior it describes — or adding a
  new divergence — updates that entry in the same change.

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
  the OpenAPI contract, security scans, and — last, because it is slowest and
  builds the production bundle on the way — the Playwright browser suite.
- Fix change-caused failures. If another failure remains, report its command and
  relevant output; do not claim full verification.
- `docs/ui-regression-scenarios.md` is the browser checklist for readouts a green
  suite cannot prove. Changing UI behavior means walking the affected scenarios and
  adding one for the behavior in the same change; a scenario is marked verified only
  on the date someone actually ran it. It also means **promoting** a scenario to
  `frontend/e2e/` once its expectation is settled — normally the session after the one
  that wrote it, so the manual walk still happens where judgment is needed. Promotion
  guards a settled decision against rot; it never replaces the walk, and a scenario
  whose expectation nobody has decided is never promoted. The checklist's "Promotion"
  section holds the rules; `mise run e2e` runs the promoted suite, and `mise run check`
  includes it.
