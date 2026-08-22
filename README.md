# kcap

**K**ubernetes **cap**acity simulator.

## Why

Change one capacity setting and you've changed how another behaves:

- Raise a memory request — fewer pods fit per node, and utilization
  (`usage / request`) drops, so the HPA desires fewer replicas.
- Lift `hpa_max` — the peak scenarios grow with it, and the peak is what you
  provision for.
- Pick a larger machine — fewer nodes cuts total reserved overhead, but every
  node the pods can't tile strands more capacity.
- Set rollout `maxSurge` — during a deploy the replica ceiling is `hpa_max`
  plus the surge, not `hpa_max`.
- Scale out far enough — `max_pods` runs out before CPU or memory, and nodes
  get added with capacity to spare.

The usual estimate, `total_requests / node_allocatable`, hides all of this by
treating requests as a fluid. They aren't: a pod asking for 3 CPU on a 4-CPU
node strands the remaining core on every node it lands on.

## What it reports

- Nodes needed per pool, and which resource ran out first — including
  `fragmentation` when packing needs more nodes than plain division would.
- Stranded capacity: paid for, but unusable.
- Whether the HPA is saturated, or the rollout is what's really sizing the cluster.
- Five scenarios per evaluation: `hpa_min`, `current`, `hpa_desired`,
  `hpa_max`, and `hpa_max_rollout`.
- CPU contention per pool, on `/v1/evaluate` and in the results panel's
  **Runtime risk** section: which workloads — and, when the import carried a
  breakdown, which containers inside them — are observed above the CPU request
  that is their only guarantee, on nodes whose pods together want more CPU than
  the node can schedule. Each flag carries a worst-case share of the node,
  labeled a bound rather than a prediction. It is additive context and never a
  verdict: a flag moves no node count, no scenario, and no scale-up advice.
- Node limit exposure per pool, in the same block and the same section: each
  packed node's memory limits summed against its allocatable memory, with a pod
  that declares no limit counting as the whole node. Above 100% the node can be
  exhausted by pods behaving entirely within what they declared. The same
  arithmetic for CPU rides along in the block as context only — CPU throttles
  where memory kills, so it never raises a finding, and the panel prints it
  beside a memory finding rather than on its own. Neither number moves a node
  count either.
- Baseline-vs-candidate comparison: edit a request, an HPA ceiling, or a
  machine size, and `/v1/compare` returns both results, the config diff, and
  the impact diff.

kcap is an advisor, not a scheduler and not an autoscaler —
[docs/model-fidelity.md](docs/model-fidelity.md) records how it models
Kubernetes and where it diverges.

## Run it

FastAPI backend (Python 3.13, uv), React + Vite frontend. In production both
are served from one container.

```bash
mise run setup   # install from the lockfiles
mise run dev     # API on :8100, UI on :5173
```

Open http://localhost:5173. The Vite dev server proxies `/health` and `/v1` to
the API. To point the UI straight at the API instead, set `VITE_API_BASE_URL`
(see `frontend/.env.example`) and add the matching origin to `KCAP_CORS_ORIGINS`.

`setup` installs strictly from the lockfiles; add dependencies with
`uv add <pkg>` or `npm install <pkg> --prefix frontend`. Run the halves
separately with `mise run api-dev` and `mise run frontend-dev`, or
`mise run serve` for the API alone without reload.

Single-container build, UI served from the API on one port:

```bash
mise run container-up   # docker compose up --build
```

Then open http://localhost:8100. Interactive API docs are at `/docs`.

## How it works

- **Inputs.** One or more node pools — machine size, per-node reserved CPU and
  memory, `max_pods`, min/current/max node counts — plus workloads with per-pod
  requests, current replicas, observed per-pod usage, an optional HPA, and a
  rollout max-surge. Observed usage is a summary — `avg`, plus optional `p95`
  and `peak` — alongside the capture window and source it came from. A cluster
  import additionally carries a per-container breakdown of each pod (requests,
  limits, and usage per container); the editor is pod-level and never produces
  one. Each workload is pinned to one pool (the assignment may be omitted only
  when there is a single pool). CPU is millicores, memory is MiB.
- **HPA math follows Kubernetes.** Utilization is `usage / request` per pod and
  reads the average usage, nothing else — the controller compares its target
  against current *average* utilization. Each configured metric produces its
  own replica recommendation, the highest wins, and a ratio within 10% of
  target holds steady — the same tolerance band as
  `--horizontal-pod-autoscaler-tolerance`. Results carry both the raw
  recommendation and the one clamped to min/max, so a saturated HPA is visible
  instead of quietly capped.
- **Placement is first-fit-decreasing bin packing** against allocatable
  capacity (`machine - reserved`) and `max_pods`, run independently per pool.
  Each scenario reports every pool's node math (target, headroom, limiting
  resource) plus cluster totals. Pods too large for an empty node are pulled
  out and counted separately rather than papered over with more nodes.

## API

```
GET  /health         status + the running build version
POST /v1/evaluate    a cluster config -> workload results + the five scenarios
POST /v1/compare     {baseline, candidate} -> both results, config diff, impact diff
```

## What it doesn't model

- Workloads are statically assigned to pools: no cross-pool spillover, and
  taints, tolerations, and affinity — the mechanisms that produce such an
  assignment in a real cluster — are not simulated.
- No topology spread, anti-affinity, or PDBs.
- DaemonSets exist only as flat per-node reserved CPU and memory; they don't
  consume a `max_pods` slot.
- Observed per-pod usage is held constant across all five scenarios, so the
  HPA scenarios show the shape of the response, not a converged steady state.
- Container limits are imported and validated but don't affect placement, HPA
  math, or node counts. They drive the runtime-risk readout instead: memory
  limits set each node's exhaustion ceiling, and a CPU limit caps the worst-case
  share a contention flag reports.
- Which statistic gets read is a convention. HPA math reads `avg` and nothing
  else; CPU contention reads the highest one available — `peak`, else `p95`,
  else `avg` — and says which it fell back to, so a `p95` does move contention
  on a workload that has no `peak`. Nothing reads `p95` in preference to
  `peak`, and the capture window and usage source are recorded but read by no
  computation. The per-container breakdown is read only by contention
  analysis, which compares each listed container against its own request:
  placement, HPA math, and node counts never read it, but it decides which
  flags appear and supplies their numbers. (Usage and the breakdown both
  appear in `/v1/compare`'s configuration diff, which reports every changed
  input.)
- CPU contention is an entitlement reading, not a kernel or scheduler
  simulation: no `cpu.shares` weighting, no assumption about which pods are
  busy at the same moment. The worst-case share on each flag bounds the
  guarantee; it does not predict what a container will get. Memory has no
  contention reading at all — memory does not compress, so the memory question
  is exhaustion rather than sharing.
- First-fit-decreasing is a heuristic; the real scheduler will sometimes do
  better and sometimes worse.

Every divergence is recorded with upstream evidence in
[docs/model-fidelity.md](docs/model-fidelity.md).

## Checks

```bash
mise run test    # pytest
mise run check   # pytest + frontend lint + production build
```
