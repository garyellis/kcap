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

**CPU entitlement under contention.** kcap flags a workload — or a container inside it, when the
import carried a breakdown — observed above the CPU request that is its only guarantee, on a node
whose placed pods together want more CPU than the node can schedule. Node pressure is summed from
pod-level readings only. Per-container peaks do not sum — the maximum of a sum is not the sum of
the maxima — so a workload measured only per container contributes its request, which is the
scheduler's own assumption and what a pod with no reading at all contributes too; the block counts
those pods and says *pod-level* when it does. A breakdown can therefore refine which unit a flag
names, but never overrule the pod: when it names nobody, the pod-level flag stands, because an
injected sidecar has no spec counterpart and its usage reaches only the pod figure. Requests always
fit the node, so a contended node always holds something above its own request and always produces
at least one flag. This is deliberately **not** a `cpu.shares` simulation. Upstream turns each
request into a weight of `milliCPU × 1024 / 1000` floored at two shares — so a container that
declared nothing is entitled to a fifth of a percent of a core rather than to literally none, which
is why kcap reporting its floor as `0` is a rounding and not a claim. That weight divides CPU only
among the *runnable* siblings at one level of a `kubepods` → QoS-class → pod → container hierarchy,
in which Guaranteed pods hang off the root and compete against the whole burstable subtree rather
than against individual pods. Reproducing that needs an assumption about which pods are busy at the
same instant, which kcap has no basis for. So `worst_case_share_m` bounds one thing: the CPU a unit
is entitled to if every pod on its node is runnable at once — one flat
`request / Σ requests × allocatable` division, capped at the unit's own CPU limit and never above
what the node has (a container request is not cross-checked against its pod's, so the raw ratio can
exceed the machine). It flattens the cgroup nesting, ignores QoS class, and is a floor on the
entitlement rather than a forecast of usage; the kernel hands out more whenever a neighbor is idle.
Memory has no counterpart here by design: memory does not compress, so its failure mode is
exhaustion, not sharing.
`engine.py` `_evaluate_cpu_contention`, `_worst_case_share_m` ⇄ [`MilliCPUToShares`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/kubelet/cm/helpers_linux.go#L88), [`ResourceConfigForPod`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/kubelet/cm/helpers_linux.go#L124), [`setCPUCgroupConfig`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/kubelet/cm/qos_container_manager_linux.go#L171)

**Contention basis.** The flags read the highest observed statistic available — `peak`, else `p95`,
else `avg` — and name the one they used, because a fallback makes every flag a lower bound: a
workload whose average hides its spike can leave a genuinely contended node reading as clear. A
container that falls back is folded into that same note rather than getting one of its own, which
matters because per-container averages carry a further known downward bias (see "Per-container
usage") on top of being an average. The only other note counts the pods whose request stood in for
a reading. kcap warns; it never refuses to compute.
`engine.py` `UsageStat.exposure`, `_basis_notes` ⇄ no upstream analogue

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
The breakdown is analysis-only and optional, and its one reader is the CPU contention analysis:
nothing in placement, HPA math, or node counts reads it (it does surface in `/v1/compare`'s
configuration diff, which reports every changed input). That one reader is not cosmetic. A listed
container is compared against **its own** request rather than the pod's, so it can be flagged
while its pod is not, and its request, usage, limit, and basis are the numbers on the flag — its
request is the numerator of the worst-case bound and its limit is the bound's cap. What the
breakdown cannot do is erase a flag: contention falls back to the pod reading when the list is
absent (every workload configured in kcap's own editor), when it carries no container usage, and
when it carries usage but names no borrower — that last case being the injected sidecar, whose
usage reaches the pod figure and nothing else. Since a pod-level edit **drops** the breakdown,
which flags an operator sees can change with an edit that touches no container.
`importers.ts` `observedUsage`, `containerBreakdown`, `engine.py` `ContainerInfo` ⇄ [`ContainerMetrics`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/staging/src/k8s.io/metrics/pkg/apis/metrics/v1beta1/types.go#L97)

**Usage under scaling.** Observed per-pod usage is held constant across all five scenarios,
though in reality adding replicas divides the same work across more pods and per-pod usage falls.
The HPA scenarios show the shape of a response, not a converged steady state.
`engine.py` `evaluate` ⇄ no upstream analogue

**Node instructions.** `nodes_to_add` and `nodes_to_remove` are sizing arithmetic against the
configured current node count, not a Cluster Autoscaler simulation: no candidate scan, no
utilization threshold, no unreplicated-pod or PDB blocker, no cooldown. kcap additionally
withholds the removal — 0, with `scale_down_blocked_reason` naming the case — in two situations.
Pods excluded from the sizing as oversized block it, because the pool was then sized against
demand that is not all of its demand. And an idle pool with no configured minimum blocks it,
because the arithmetic there instructs removing every node the pool runs; a real autoscaler can
take a node group to zero, and kcap will not say so from a node count sized against demand it
never placed. An idle pool that does keep a minimum is drained to that minimum, which is what a
real autoscaler does — `min_nodes <= current_nodes` is validated, so the floor is always reachable
by removal. The withheld arithmetic stays derivable as
`max(0, current_nodes − effective_nodes_required)`.
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

**Limits.** Imported and validated, and inert to sizing: no effect on placement, HPA math, or
node counts. That matches the scheduler, which fits on requests — but a cluster safe by request
and exhaustible by limit reads as safe — so both limits feed the runtime-risk readout. A CPU
limit caps the worst-case share on a contention flag, because a container cannot use a share
larger than its own ceiling; memory limits set the exhaustion ceiling below.
`engine.py` `Resources` ⇄ [`fitsRequest`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/scheduler/framework/plugins/noderesources/fit.go#L499)

**Node exhaustion.** kcap sums the memory limits of each packed node's pods against its
allocatable memory — a pod declaring none counts as the whole node — and reports the worst
node's ratio. That is a statement about declarations, not about a moment: nothing here
simulates what a node does when memory actually runs out. Upstream, a container reaching its
own limit is OOM-killed by its cgroup with no node-level signal involved; separately, the
kubelet evicts on live `memory.available` against its eviction thresholds, and the
`oom_score_adj` it assigns is derived from each container's memory *request* against node
capacity, not from the limit kcap sums here. So a real node picks a victim and kcap names none,
and a ratio at or below 100% means the declarations cannot exhaust the node rather than that
the node is safe. The DaemonSet reservation is on the other side of the arithmetic — it is
deducted from allocatable rather than counted as a ceiling, so DaemonSet pods whose own limits
exceed the configured reservation can exhaust a node kcap reports as clear.
`engine.py` `_evaluate_limit_exposure` ⇄ [`synchronize`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/kubelet/eviction/eviction_manager.go#L243), [`GetContainerOOMScoreAdjust`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/kubelet/qos/policy.go#L45)

**CPU overcommit.** kcap sums the declared CPU limits of each packed node's pods against its
allocatable CPU and reports the worst node's ratio wherever it has one — a reading beside the
memory finding, never a finding of its own, and it moves no node number. It says so because CPU
is compressible upstream: a limit becomes a CFS quota on that container's own cgroup, so a node
whose declared limits sum past its allocatable does not fail. Each container is held at its own
ceiling and the ones competing for what remains are throttled, which is the outcome the ratio
above 100% describes. Two departures follow. A pod that declares no CPU limit contributes
nothing to kcap's ratio while being the pod upstream leaves unthrottled, so the figure is a
statement about declarations and understates real CPU pressure exactly where limits are missing.
And the ratio is not a throttling prediction: whether a container is actually throttled depends
on live demand and on the `cpu.shares` weighting kcap models separately as a worst-case share,
not on this sum.
`engine.py` `_evaluate_limit_exposure` (`cpu_max_limit_percent`) ⇄ [`MilliCPUToQuota`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/kubelet/cm/helpers_linux.go#L61), [`MilliCPUToShares`](https://github.com/kubernetes/kubernetes/blob/v1.33.0/pkg/kubelet/cm/helpers_linux.go#L88)

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
