# How kcap models Kubernetes

kcap is a capacity advisor, not kube-scheduler, the kubelet, or the HPA controller. This document
records every place its behavior departs from Kubernetes, what the departure buys, and what it
costs the reader of a result. Anything not listed is meant to match upstream, so an unlisted
difference is a bug in one or the other.

Evidence is pinned to `kubernetes/kubernetes` **v1.33.0**; implementation is the authority, not
docs or KEPs. Each entry cites the kcap symbol, then the upstream symbol it answers to. Change a
behavior below and its entry moves with it.

## What kcap reproduces

- The shape of effective pod requests: regular containers and sidecars summed, plain init
  containers maxed against that sum.
- A missing request defaulting to the container's limit, per resource, at import — a pod template
  has not been through pod defaulting yet, so kcap has to.
- HPA scaling as `ceil(replicas × ratio)`, one recommendation per metric, the highest winning,
  held steady inside the default ±10% tolerance band.
- Requests, not limits, deciding placement; a pod that exceeds an empty node never schedules.
- Rolling-update surge from `maxSurge`: an absolute value carried through as a pod count, a
  percentage ceiling-rounded against a replica count, StatefulSets surging by zero.

Everything below is where it stops.

## Requests and limits

**Effective pod request.** kcap takes `max(Σ containers + Σ sidecars, largest plain init
container)`. Upstream's init term is `init_i + Σ sidecars declared before it`, so kcap
under-counts a plain init container that starts after a sidecar. It never over-counts.
`importers.ts` `effectiveRequest` ⇄ [`AggregateContainerRequests`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/staging/src/k8s.io/component-helpers/resource/helpers.go#L144)

**Pod limit.** Upstream sums declared limits, so a container without one contributes zero and the
pod total stays finite. kcap calls any counted container without a limit unbounded and reports no
pod limit at all — its single limit is a runtime ceiling, not an API projection. Plain init
containers count toward the limit exactly as far as they count toward the request: a declared
limit joins the maximum, a request with no limit makes the pod unbounded, and declaring neither
leaves the pod untouched.
`importers.ts` `summedLimit` ⇄ [`AggregateContainerLimits`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/staging/src/k8s.io/component-helpers/resource/helpers.go#L310)

**Quantities.** kcap rounds CPU up to whole millicores, which is what the scheduler sees anyway:
`MilliValue()` is documented as `ceil(q * 1000)`, and a `Quantity` is fixed-point to three decimal
places, so `0.1m` is already 1m upstream. Memory is the departure. kcap rounds up to whole MiB
where Kubernetes ceils to whole bytes, so a memory request imports up to 1 MiB larger than
declared, per container.
`importers.ts` `parseCpuQuantity`, `parseMemoryQuantity` ⇄ [`MilliValue`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/staging/src/k8s.io/apimachinery/pkg/api/resource/quantity.go#L817)

**Zero requests.** kcap requires a positive request and floors a request-less pod at 1m / 1 MiB.
Upstream fits a BestEffort pod at zero, anywhere a pod slot remains, but *scores* it as
100m / 200 MiB. kcap reserves a little capacity where the filter reserves none, and cannot
represent BestEffort at all.
`engine.py` `_validate_resources`, `importers.ts` `transformClusterExport` ⇄ [`fitsRequest`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/scheduler/framework/plugins/noderesources/fit.go#L499), [`DefaultMilliCPURequest`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/scheduler/util/pod_resources.go#L29)

**Pod overhead.** Upstream adds `spec.overhead`, the RuntimeClass's per-pod cost, to the requests
the scheduler fits. kcap has no overhead concept and never imports the field, so workloads on a
sandboxed runtime pack smaller than they schedule.
`importers.ts` `effectiveRequest` ⇄ [`PodRequests`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/staging/src/k8s.io/component-helpers/resource/helpers.go#L122)

**Resource dimensions.** kcap models CPU, memory, and pod slots. Ephemeral storage, hugepages,
and extended resources such as GPUs are neither imported nor packed, so a cluster constrained by
one of them reads as roomier than it is.
`engine.py` `PodRequest` ⇄ [`fitsRequest`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/scheduler/framework/plugins/noderesources/fit.go#L499)

## Autoscaling

**Replica formula.** kcap scales the current replica count, `ceil(current × ratio)`, from one
average usage figure per pod — `UsageStat.avg`; a p95 or peak carried alongside it never enters
this formula. Upstream scales the *ready* count, over a population that excludes pods being
deleted and substitutes missing metrics differently for scale-up and scale-down. kcap
gives the number a fully ready, fully reported workload would get; add unready or unmetered pods
and the cluster picks a different one.
`engine.py` `evaluate_hpa`, `_metric_recommendation` ⇄ [`GetResourceReplicas`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/controller/podautoscaler/replica_calculator.go#L115)

**Utilization arithmetic.** kcap divides one pod's usage by one pod's request and keeps the
float. Upstream divides summed fleet usage by summed requests, truncates to a whole percent, and
takes the ratio from that integer. They agree on uniform pods and drift on skewed ones; near a
tolerance boundary the truncation alone can decide whether Kubernetes moves.
`engine.py` `evaluate_hpa` ⇄ [`GetResourceUtilizationRatio`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/controller/podautoscaler/metrics/utilization.go#L38)

**Utilization denominator.** Upstream divides by the sum of regular and sidecar requests — plain
init containers excluded — and aborts the whole metric with `FailedGetResourceMetric` if any
counted container declares no request. kcap divides by the imported pod request, which a large
plain init container can dominate and which is floored rather than fatal when absent. Such a
workload reads as less utilized in kcap than in the cluster, and scales later.
`engine.py` `evaluate_hpa` ⇄ [`calculatePodRequests`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/controller/podautoscaler/replica_calculator.go#L436)

**Trajectory.** kcap reports what the metrics imply right now. The controller holds a downscale
to the highest value seen in a five-minute window, and with no `behavior` block caps a scale-up
at double the current replicas, or four pods, per sync. kcap's scenarios are endpoints, not a
path, and say nothing about the time a cluster spends between them.
`engine.py` `evaluate_hpa` ⇄ [`stabilizeRecommendation`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/controller/podautoscaler/horizontal.go#L917), [`scaleUpLimitFactor`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/controller/podautoscaler/horizontal.go#L61)

**Metric types.** Only `Resource` CPU and memory targets are imported; `Pods`, `Object`,
`External`, and `ContainerResource` metrics are dropped. A workload that scales on queue depth
imports as one that does not scale on anything.
`importers.ts` `toHpa` ⇄ [`MetricSpec`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/staging/src/k8s.io/api/autoscaling/v2/types.go#L102)

**Observed usage.** Per-pod usage is summed from `PodMetrics.containers[].usage` and averaged
over the pods a workload's selector matches. Upstream stamps each `PodMetrics` with the interval
its numbers came from — `[Timestamp-Window, Timestamp]` — and the export projection keeps neither,
so kcap cannot tell a fresh reading from a stale one. `usage_window_seconds` reports kcap's *own*
capture span instead: the measured time from the first sample to the last, and 0 for the
single-sample default. A `peak` therefore exists only when the export sampled more than once, and
it is the highest per-pod average any *single* sample showed — not the average of each pod's own
maximum, which is a larger number describing a moment where every pod peaked together. `p95` is
never derived; these sample counts cannot support one.
`importers.ts` `observedUsage`, `buildExportScript` ⇄ [`PodMetrics`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/staging/src/k8s.io/metrics/pkg/apis/metrics/v1beta1/types.go#L66)

**Per-container usage.** The same figures are also kept per container, joined to the pod spec by
`ContainerMetrics.Name` and read on the identical rule — a container's peak is the highest
per-container average any *one* sample showed — so the two levels cannot mean different things by
"peak". Every series divides by the same pod count the pod-level figure uses, which makes a
container average that container's share of the pod average. The breakdown covers the
always-running set only (regular containers plus restartPolicy-Always init containers): a plain
init container has exited before the steady state this describes. A reading whose name no spec
declares — an injected sidecar — is named in an import note rather than folded into a container it
does not belong to, and its usage still counts toward the pod figure, since that is what it is.
Two departures worth knowing before reading a container number. A container that reported nothing
in a sample counts as **zero** for that sample, where a *pod* that reported nothing has its sample
dropped instead. The asymmetry is deliberate and load-bearing: dropping absent samples would leave
a sidecar injected partway through a three-sample window with a one-element series, and a single
sample carries no peak — so the reading entitlement analysis actually consumes would be destroyed
to protect one it does not. What zero-filling depresses is the container *average* (a sidecar that
ran for the last third of the window reads 20m against the 60m it used while running); the peak
stays the highest per-container average any one sample showed, which is what `exposure()` reads.
And the
breakdown describes one import and only that: kcap's editor is pod-level, so a hand edit to the
pod's requests, limits, or observed usage **drops** the breakdown rather than carrying a list that
contradicts the pod. Staleness cannot be detected later — a breakdown that does not sum to the pod
totals is the normal case, since the pod numbers are effective requests — so it is caught at the
edit or not at all, and analysis falls back to the pod level, exactly as it does for the hand-built
workloads that never had one.
The breakdown is analysis-only and optional: nothing in placement, HPA math, or node counts reads
it (it does surface in `/v1/compare`'s configuration diff, which reports every changed input), and
it is absent for any workload configured in kcap's own editor.
`importers.ts` `observedUsage`, `containerBreakdown`, `engine.py` `ContainerInfo` ⇄ [`ContainerMetrics`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/staging/src/k8s.io/metrics/pkg/apis/metrics/v1beta1/types.go#L97)

**Usage under scaling.** Observed per-pod usage is held constant across all five scenarios,
though in reality adding replicas divides the same work across more pods and per-pod usage falls.
The HPA scenarios show the shape of a response, not a converged steady state.
`engine.py` `evaluate` ⇄ no upstream analogue

**Node instructions.** `nodes_to_add` and `nodes_to_remove` are sizing arithmetic against the
configured current node count, not a Cluster Autoscaler simulation: no candidate scan, no
utilization threshold, no unreplicated-pod or PDB blocker, no cooldown. kcap additionally
withholds the removal — 0, with `scale_down_blocked_reason` naming the case — whenever pods were
excluded from the sizing as oversized, or nothing was placeable at all; a real autoscaler faced
with an idle pool does drain it toward its minimum, and kcap declines to say so because a node
count sized against demand it never placed is arithmetic rather than an instruction. That
arithmetic stays derivable as `max(0, current_nodes − effective_nodes_required)`.
`engine.py` `_evaluate_pool_scenario` ⇄ no upstream analogue

## Rollout

**Surge shape.** Upstream caps a rolling update at `replicas + maxSurge`, resolving an absolute
value to itself and a percentage against `spec.replicas`, rounded up. kcap carries an absolute
`maxSurge` through unscaled as a pod count, matching that pass-through, but scales a percentage
against the HPA maximum instead — deliberately, since the expensive rollout is the one that
happens while already scaled out. `maxUnavailable` is not modeled at all: kcap reports the surge
peak and never the trough, which is the pessimistic and cheaper-to-be-wrong end.
`engine.py` `evaluate_workload`, `importers.ts` `rolloutFromMaxSurge` ⇄ [`ResolveFenceposts`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/controller/deployment/util/deployment_util.go#L887), [`GetScaledValueFromIntOrPercent`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/staging/src/k8s.io/apimachinery/pkg/util/intstr/intstr.go#L181)

## Placement

**Packing.** kcap packs, deterministically, first-fit-decreasing. The scheduler filters and then
scores, and its default `LeastAllocated` strategy, balanced across CPU and memory, spreads. So
kcap reports what a consolidating packer could achieve, not where pods land today; a live cluster
reaches that density only after the autoscaler consolidates. The heuristic stays because it is
reproducible, and because it preserves pod shape and fragmentation, which aggregate division
destroys.
`engine.py` `_pack_pods` ⇄ [`Fit.Filter`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/scheduler/framework/plugins/noderesources/fit.go#L455), [`leastRequestedScore`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/scheduler/framework/plugins/noderesources/least_allocated.go#L52)

**Constraints.** Taints and tolerations, node affinity, pod topology spread, inter-pod affinity,
image locality, and preemption are default-enabled plugins with real weight in every scheduling
decision. kcap simulates none of them, and PodDisruptionBudgets nowhere at all. Workloads go
statically to one pool with no spillover — a stand-in for the placement those mechanisms produce,
and only as good as the assignment.
`engine.py` `evaluate_scenario` ⇄ [`getDefaultPlugins`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/scheduler/apis/config/v1/default_plugins.go#L30)

**Limits.** Imported and validated, but inert: no effect on placement, HPA math, or node counts.
That matches the scheduler, which fits on requests — but a cluster safe by request and
exhaustible by limit reads as safe.
`engine.py` `Resources` ⇄ [`fitsRequest`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/scheduler/framework/plugins/noderesources/fit.go#L499)

## Node capacity

**Allocatable.** kcap's allocatable is `machine − reserved`, one flat number per pool, taken from
the first node found there and applied to every node in it. Upstream, each kubelet computes its
own from capacity minus kube-reserved, system-reserved, and the hard eviction threshold. Import
captures those three together, and a heterogeneous pool imports as uniform.
`engine.py` `MachineSpec.allocatable_cpu_m`, `importers.ts` `deriveNodePools` ⇄ [`GetNodeAllocatableReservation`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/kubelet/cm/node_container_manager_linux.go#L279)

**DaemonSets.** Modeled only as configured flat per-node reserved CPU and memory, consuming no
pod slot. Upstream they are ordinary pods: a `max_pods` slot on every node, scaling with the node
count. A pool near its pod-slot ceiling reads as having more headroom than it has.
`engine.py` `MachineSpec` ⇄ [`syncNodes`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/controller/daemon/daemon_controller.go#L990), [pod-slot check](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/scheduler/framework/plugins/noderesources/fit.go#L502)

**Pod density.** `pods_per_node` reports the tightest pod shape in the pool — a floor across
mixed shapes, not a count any single workload achieves.
`engine.py` `_shape_density` ⇄ no upstream analogue
