# kcap

**K**ubernetes **cap**acity laboratory — a planner that answers "how many nodes will this actually need?" by packing individual pods onto nodes instead of dividing totals.

The usual estimate, `total_requests / node_allocatable`, treats requests as a fluid. They aren't. A pod asking for 3 CPU on a 4-CPU node strands the remaining core on every node it lands on, and no amount of aggregate arithmetic will show you that. kcap models pod shape, HPA behavior, and rollout surge, then reports the node count, the resource that constrained it, and the capacity you're paying for but can't use.

FastAPI backend (Python 3.13, uv), React + Vite frontend. In production both are served from one container.

## Run it

```bash
mise run setup   # install from the lockfiles
mise run dev     # API on :8000, UI on :5173
```

`setup` installs strictly from the lockfiles, so add dependencies explicitly with `uv add <pkg>` or `npm install <pkg> --prefix frontend`.

Open http://localhost:5173. The Vite dev server proxies `/health` and `/v1` to the API, so nothing else needs configuring. If you'd rather point the UI straight at the API, set `VITE_API_BASE_URL` (see `frontend/.env.example`) and put the matching origin in `KCAP_CORS_ORIGINS`.

Run the halves separately with `mise run api-dev` and `mise run frontend-dev`, or `mise run serve` for the API alone without reload.

The container builds the UI and serves it from the API on a single port:

```bash
mise run container-up   # docker compose up --build
```

Then open http://localhost:8000. Interactive API docs are at `/docs`.

## The model

You describe one node pool — machine size, per-node reserved CPU and memory, `max_pods`, and min/current/max node counts — plus any number of workloads with per-pod requests, current replicas, observed per-pod usage, an optional HPA, and a rollout max-surge. CPU is millicores, memory is MiB.

Every evaluation runs the same cluster through five scenarios: `hpa_min`, `current`, `hpa_desired`, `hpa_max`, and `hpa_max_rollout`.

HPA math follows Kubernetes. Utilization is `usage / request` per pod, each configured metric produces its own replica recommendation, the highest one wins, and a ratio within 10% of target holds steady — the same tolerance band as `--horizontal-pod-autoscaler-tolerance`. Results carry both the raw recommendation and the one clamped to min/max, so a saturated HPA is visible instead of quietly capped.

Placement is first-fit-decreasing bin packing against allocatable capacity (`machine - reserved`) and `max_pods`. When packing needs more nodes than aggregate division would, the scenario's limiting resource is reported as `fragmentation` and names the dimension responsible. Pods too large for an empty node are pulled out and counted separately rather than papered over with more nodes.

## API

```
GET  /health         status + the running build version
POST /v1/evaluate    a cluster config -> workload results + the five scenarios
POST /v1/compare     {baseline, candidate} -> both results, the config diff, the impact diff
```

`/v1/compare` is the one worth reaching for: it reports exactly which inputs changed and what that did to node counts.

## What it doesn't model

One node pool of one machine type. No topology spread, anti-affinity, taints, or PDBs. DaemonSets exist only as flat per-node reserved CPU and memory — they don't consume a `max_pods` slot. Observed per-pod usage is held constant across all five scenarios rather than redistributed as replica counts change, so the HPA scenarios show the shape of the response, not a converged steady state. And first-fit-decreasing is a heuristic: the real scheduler will sometimes do better and sometimes worse.

## Checks

```bash
mise run test    # pytest
mise run check   # pytest + frontend lint + production build
```
