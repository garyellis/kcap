# UI regression scenarios

Browser checks for behavior that only the running UI proves: readouts the engine cannot
assert about itself, editor round-trips, and import paths that end in a rendered panel.
Unit and API coverage lives in `tests/` and `frontend/src/*.test.ts` — a scenario belongs
here only when a green suite would still let the screen lie.

Each scenario is self-contained: start from **Reset**, do the steps, read the expectation.

## Manual first, automated once settled

Every scenario is written to be walked by a human, and is walked by a human the session it
is written — that is when judgment is needed, and when errors in the checklist itself
surface. This file has earned that: walking it found the lossy surge round-trip behind the
P0.2 follow-up, and raised C1 and C2, neither of which an automated check could have asked.

A scenario is **promoted** to `frontend/e2e/` once its expectation is settled, so that it
cannot silently rot between passes. Promotion is an anti-rot guard for decisions already
made — it is not a discovery tool, and it does not retire the manual walk.

Every row carries exactly one status. Ten are **Automated**, naming their spec file and
keeping a separate **Last walked manually** date that CI never touches. Six are **manual
only**, each saying why automating it would be worse than not. Three are **not yet
promoted** — eligible, simply not in the first batch.

```bash
mise run e2e      # the promoted scenarios, on a build the suite makes itself
```

## Running the checklist

```bash
VITE_API_BASE_URL= npm --prefix frontend run build
KCAP_FRONTEND_DIR=frontend/dist uv run uvicorn kcap.api:app --host 127.0.0.1 --port 8123
```

Then open <http://localhost:8123>.

- **Not port 8100.** A stale `kcap` container often holds it, and Vite's dev proxy reaches
  that container instead of your build — you would be testing the last image, not this
  working tree. Serve the built `frontend/dist` from your own uvicorn on a spare port.
- **Clear `VITE_API_BASE_URL` when you build**, as the command above does. Vite bakes it into
  the bundle, so a local `frontend/.env` — which `frontend/.env.example` suggests pointing at
  port 8100 — sends every request from your build to that stale container. Nothing on screen
  says so: the pill still reads `Live`, because those requests succeed. `mise run e2e` clears
  it for the same reason.
- Press **Reset** (top of the Configuration panel) between scenarios; several of them leave
  the config in a deliberately broken state.
- The connection pill top-right must read **Live** throughout. `Engine offline` means the
  server is not the one you just started.
- Watch the browser console: a scenario that renders correctly but logs a 422 is a failure.

## Updating this file

- Add a row in the same change that ships the UI behavior it pins, and say which task or
  session it came from.
- IDs are stable and never reused. A new scenario takes the next free number and lives with
  its topic group, so the file does not read in numeric order — that is the trade for never
  renumbering. Retire a scenario by striking its heading and saying why.
- Update **Last verified** whenever a session actually walks the scenario; leave it alone
  otherwise. A stale date is information — a false one is not.
- Keep the expectation in the user's words (what the screen says), not the field names behind
  it. The point is to catch a correct engine wired to a wrong readout.

### Promotion

- A new scenario is walked manually in the session that ships it, and **promoted to
  `frontend/e2e/` once its expectation is settled** — normally the next session, once the
  behavior has survived a review. Promote in the same change that settles it.
- Never promote a scenario whose expectation nobody has decided. A candidate under
  "Observed, not yet decided" is a question, and a test would freeze the answer nobody gave.
- A promoted scenario keeps its row here, gains an **Automated** field naming the spec file,
  and its date field becomes **Last walked manually**. CI must never touch that date: it
  records when a human last read the screen, which is the one thing the suite cannot do.
  A promoted scenario whose manual date is old is fine; a promoted scenario nobody has ever
  walked is not.
- The test asserts what the operator reads, in the operator's words. If the row says the
  field reads `1 pods`, the test reads the field — never app state, never a JSON blob (R19
  is the exception that proves it: there, the exported JSON *is* the readout). The selector
  policy is stated once, in `frontend/e2e/support/kcap.ts`, and followed everywhere.
- Pin the relationship the scenario claims, not the number it happened to show. R3's claim
  is "+1 surge pod at any replica count", so its test moves the replica ceiling and re-reads
  rather than asserting `30 → 31`.
- If a control has no accessible name, fix the app — an `aria-label` helps every user, a
  `data-testid` helps only the test. Either way it is a UI change: justify it in a comment
  and walk the affected scenarios.

---

## Baseline

### R1 — The default configuration evaluates live
**Pins:** the app boots, reaches the engine, and renders all five scenarios.
**Steps:** load the page.
**Expect:** connection pill reads `Live`; the scenario tabs (`HPA min`, `Current`, `Desired`,
`HPA max`, `Rollout`) each show a pod count; the verdict reads `Capacity clear`; no console
errors.
**Origin:** baseline · **Manual only:** this is the check that the app renders at all. An
automated version would be the suite testing its own harness — if the app did not load, every
other promoted test would already be red, and none of them would tell you it was this. A human
opening the page is the honest form of it. · **Last verified:** 2026-08-20 (Session F)

### R2 — Observed usage moves the HPA recommendation
**Pins:** the usage editor reaches `evaluate_hpa` end to end. The editor posts the
`observed_cpu_per_pod` summary, which since the Session E cleanup is the only form the API
accepts at all.
**Steps:** select workload `api`, set **Average CPU usage / pod** to `900`, blur the field.
**Expect:** the `Desired` tab's pod count rises (12 → 15 on the shipped defaults); the change
chip reads `1 change`; no 422 in the console or the server log.
**Origin:** P1.1/P1.2 (Session D), relabelled by P1.3 (Session E) ·
**Automated:** `frontend/e2e/observed-usage.spec.ts` — the test pins the *direction*, not
`12 → 15`, because the scenario has been walked truthfully at other usage values ·
**Last walked manually:** 2026-08-20 (Session E, walked at 1200 mCPU: 12 → 18)

### R16 — A peak can be entered, and cannot be entered below the average
**Pins:** P1.3's optional peak input, and the `peak >= avg` ordering that `usage.ts` keeps the
editor inside. The engine returns that violation as a message-only 422, so a config the UI can
compose but the engine must reject would surface as an unexplained error banner.
**Steps:** select `api` (average CPU 620 on the shipped defaults). (a) Set **Peak CPU usage /
pod** to `400` and blur. (b) Set it to `900` and blur. (c) Now raise **Average CPU usage / pod**
to `1200` and blur.
**Expect:** (a) the field snaps to `620` — the average is the smallest honest peak. (b) it holds
`900`. (c) the peak follows the average up to `1200`, never left stranded below it. Every
projected number — the five scenario tabs, the verdict, the CA action — is identical before and
after (a) and (b); only (c) moves them, and it moves them because the *average* changed. No 422
anywhere. Setting a peak back to `0` clears the measurement.
**Origin:** P1.3 (Session E) · **Not yet promoted** — eligible; the expectation is settled,
it simply was not part of the first promotion batch. · **Last verified:** 2026-08-20
(Session E, before the compat cleanup — which did not touch `usage.ts` or these fields)

---

## Rollout surge

### R3 — An absolute surge is one pod, at any replica count
**Pins:** P0.2 — an absolute `maxSurge` must not be scaled as a percentage.
**Steps:** the scenario tabs are cluster totals, so silence the other workload first: set
`worker`'s **Rollout max surge** to `0 pods`. Then select `api`, set its **Rollout max surge**
to `1 pods`, and compare the `HPA max` and `Rollout` tabs.
**Expect:** `Rollout` = `HPA max` + 1 exactly (30 → 31 on the shipped defaults). Raise `api`'s
**Replica ceiling** to 40 and re-read: still + 1 (52 → 53). A surge that tracks the replica
count is the bug this pins.
**Origin:** P0.2 (Session B) ·
**Automated:** `frontend/e2e/rollout-surge.spec.ts` — the test moves the ceiling and re-reads,
because the claim is "+1 at any replica count", not "30 → 31" ·
**Last walked manually:** 2026-08-20 (Playwright session, read as 30 → 31)

### R4 — Switching surge units round-trips
**Pins:** the P0.2 follow-up. `pods → %` once nulled the pod count and revealed the
importer's filler `25`, so an imported `maxSurge: 1` came back as **5** pods — the same bug
class P0.2 fixed, at 5×.
**Steps:** with **Rollout max surge** at `1 pods`, switch the unit to `%`, then back to
`pods`.
**Expect:** the field reads `1 pods` again, and the `Rollout` tab is back to `HPA max` + 1.
The intermediate `%` value is fractional (`2.5 %` at a ceiling of 40) — that is the conversion
working, not a defect.
**Origin:** P0.2 follow-up (Session B) ·
**Automated:** `frontend/e2e/rollout-surge.spec.ts` — and proven able to fail: reintroducing
the defect makes this test read `5` where the field should read `1` ·
**Last walked manually:** 2026-08-20 (Playwright session)

### R5 — A percent surge survives a focus-blur
**Pins:** the `NumberField` integer-rounding rule that once re-rounded a converted percent on
a bare focus + blur.
**Steps:** after R4, switch to `%` (leaving whatever fractional value the conversion
produced), click into the field and click away without typing.
**Expect:** the value is unchanged, and switching back to `pods` still reads `1`.
**Origin:** P0.2 follow-up (Session B) ·
**Automated:** `frontend/e2e/rollout-surge.spec.ts` — the test first asserts the conversion
really did leave a fraction, so it cannot quietly become a test of nothing ·
**Last walked manually:** 2026-08-20 (Session D)

### R15 — A no-op unit round-trip changes no result
**Pins:** the surge conversion is lossless where it counts. The change chip legitimately
counts *input* edits, and a round-trip does rewrite two fields (`max_surge_pods` and
`max_surge_percent`), so its number moves — every projected number must not.
**Steps:** with **Rollout max surge** at `1 pods`, note the `HPA max` and `Rollout` pod counts
and the CA action; switch the unit to `%`, then back to `pods`, re-reading all three each time.
**Expect:** identical `HPA max`, `Rollout`, and CA action in all three states. The change chip
may read a different count — that reflects the config, not the capacity answer.
**Origin:** Session D UI regression pass ·
**Automated:** `frontend/e2e/rollout-surge.spec.ts` — the test compares `HPA max`, `Rollout`
and the CA action across all three states and deliberately does *not* assert the change chip ·
**Last walked manually:** 2026-08-20 (Playwright session; 30 / 31 / `−3 nodes` identical in
all three states, chip 2 → 3. Session D saw 3 → 4 from a different starting config — which is
exactly why the chip is not pinned.)

---

## Cluster-autoscaler action readout

The **CA action** tile sits beside the scheduler verdict. Its four readings are
`+N · nodes`, `−N · nodes`, `Hold · steady`, and `None` with either `no fix` or `no demand`.

**R6–R10 are manual only, on purpose.** These five pin what the screen *says* — which of four
near-synonyms the tile chose, whether the verdict names the right end of the clamp, whether two
true statements about two different pod populations both stay on screen. A test can assert that
the string is `None · no fix`; it cannot notice that `None · no fix` is the wrong sentence for
what just happened. That judgement is the whole value of these rows, and a green assertion
beside a misleading readout would actively hide it. R15 automates the CA action only as a value
held *equal to itself* across a no-op — the one CA-action claim that needs no reading.

### R6 — An ordinary pool instructs a real scale-down
**Pins:** the unblocked path, so the scenarios below prove something.
**Steps:** load the defaults, select the `Current` tab (the app opens on `Desired`), and read
the CA action.
**Expect:** `−N · nodes` (`−3` on the shipped defaults), or `Hold · steady` if the pool is
already right-sized. Never `None`.
**Origin:** P0.3 (Session C) · **Manual only:** see the group note above. · **Last verified:** 2026-08-20 (Session D)

### R7 — An oversized pod withholds the scale-down, not the truth
**Pins:** P0.3 — `nodes_to_remove` is gated, and the panel says why.
**Steps:** select `api`, set **CPU request** above one node's allocatable (e.g. `8000` on the
default 4-core node).
**Expect:** verdict reads `Capacity blocked` with `N pods request more than one whole node. No
node count places them.`; CA action reads `None · no fix`; the constraint chip reads
`POD SIZE`.
**Origin:** P0.3 (Session C) · **Manual only:** see the group note above. · **Last verified:** 2026-08-20 (Session D)

### R8 — A partly-oversized pool still reports its genuine addition
**Pins:** the P0.3 follow-up — the panel used to suppress `+N` whenever any pod was oversized,
so ninety placeable pods went unreported next to one that could not be placed.
**Steps:** from R7's state, raise `worker`'s **Current replicas** until the placeable demand
needs more nodes than the pool runs (e.g. `60`).
**Expect:** CA action reads `+N · nodes` (`+3` at 60 worker replicas) **beside** the unchanged
"no node count places them" paragraph. The two statements are about different pods and both
belong on screen.
**Origin:** P0.3 follow-up (Session C) · **Manual only:** see the group note above. · **Last verified:** 2026-08-20 (Session D)

### R9 — An idle pool reads as no demand, not as steady state
**Pins:** P0.3's `no_placeable_demand` gate, and the cluster-total tile that reads blocked-ness
off the pools it sums.
**Steps:** set **Current replicas** to `0` on every workload, and the pool's **Minimum nodes**
to `0`. Then press **Duplicate** on the pool — the cluster-total tile appears only with two or
more pools.
**Expect:** each pool's CA action reads `None · no demand`, and the `All pools` tile reads
`None` / `summed across pools`. An idle cluster that totals to `Hold` while every pool it sums
says `None` is the exact regression this pins.
**Origin:** P0.3 (Session C) · **Manual only:** see the group note above. · **Last verified:** 2026-08-20 (Session D)

---

## HPA reporting

### R10 — The saturation callout names the end that clamped
**Pins:** P0.5 — `clamped_by` replaced a re-derived direction.
**Steps:** select `api` with the HPA enabled. (a) Set **Minimum replicas** above the desired
count. (b) Reset, then set **Current CPU usage / pod** high enough that the raw recommendation
exceeds the **Replica ceiling**.
**Expect:** (a) the callout reads `held at N by the minimum`; (b) it reads `held at N by the
ceiling`. The wording must match the direction in both cases.
**Origin:** P0.5 (Session A) · **Manual only:** the same reason as R6–R9 in the group above,
which names this row too — it is entirely about whether the sentence picks the right end of
the clamp, and a test can check the string without noticing it is the wrong string. · **Last verified:**
2026-08-20 (Session E, re-walked after the compat cleanup)

---

## Import

Press **Import**, paste a fixture into the Step 2 box, and commit. A cluster-export payload
(F1, F2) offers a `Merge` / `Replace` picker and commits with **Replace workloads**; a saved
scenario has no picker — it says so, and commits with **Replace configuration**. Fixtures are
at the bottom of this file.

### R11 — A Guaranteed pod with a native sidecar imports cleanly
**Pins:** P0.1 and its follow-up — the pod request counted the sidecar while the pod limit did
not, so the import hit the engine's `request > limit` 422 and could not be fixed from the
dialog.
**Steps:** import fixture **F1**.
**Expect:** the workload lands as `demo/web` with **CPU request** `600` mCPU and **CPU limit
value** `600` mCPU (500 + 100 on both sides), memory `640` / `640` MiB, the evaluation is
`Live`, and no 422 appears in the console or the server log.
**Origin:** P0.1 (Session A) ·
**Automated:** `frontend/e2e/import.spec.ts` — the test pastes fixture F1 out of *this file*,
so the bytes it imports are the bytes a human pastes ·
**Last walked manually:** 2026-08-20 (Session F, re-walked after F1 gained container names)

### R12 — An absolute maxSurge survives the import
**Pins:** the importer half of P0.2 — `maxSurge: 1` maps to pods, not to a percentage of
current replicas.
**Steps:** with F1 imported (it carries `maxSurge: 1`), read the **Rollout max surge** field.
**Expect:** the unit picker shows `pods` and the value is `1`, derived from the imported
config rather than stored separately.
**Origin:** P0.2 (Session B) ·
**Automated:** `frontend/e2e/import.spec.ts` ·
**Last walked manually:** 2026-08-20 (Session F)

### R13 — Same-named workloads of different kinds both survive
**Pins:** P0.4 — `namespace/name` alone let a Deployment and a StatefulSet silently replace
each other.
**Steps:** import fixture **F2**.
**Expect:** two workloads appear, keyed `demo/web (deployment)` and `demo/web (statefulset)`,
with exactly one warning explaining the rename.
**Origin:** P0.4 (Session A) ·
**Automated:** `frontend/e2e/import.spec.ts` — including "exactly one warning", counted the
way an operator counts them: one `Heads up.` callout ·
**Last walked manually:** 2026-08-20 (Session F, re-walked after F2 gained container names)

### R17 — A scenario from any other version is refused, not guessed at
**Pins:** the version check that closes E26. This branch used to accept *any* version, so a
file written under different field names was read with today's rules and silently
mis-imported. Since the Session E cleanup there is no upgrade path either: version 3 is the
only one that loads, and the refusal has to be legible rather than a downstream 422.
**Steps:** import fixture **F3** (a version-2 file). Then edit its `"version": 2` to
`"version": 999` and import again.
**Expect:** both refuse in the dialog — `Cannot import. Unsupported kcap-scenario version 2 —
expected 3.` and the same sentence for `999`. The configuration behind the dialog is untouched
in both cases, and the commit button never becomes available. R14 covers the version-3 file
that does load.
**Origin:** P1.3, rewritten by the Session E cleanup ·
**Automated:** `frontend/e2e/import.spec.ts` — both refusal sentences asserted verbatim, plus
the absence of a commit button. The test first pastes a valid version-3 file and asserts that
button *appears*, so "it is gone" cannot pass because the locator quietly stopped matching. ·
**Last walked manually:** 2026-08-20 (Session E, re-walked after the compat cleanup)

### R18 — Per-container detail arrives, or the dialog says why it did not
**Pins:** P1.6. Per-container requests, limits, and usage have no readout of their own — the
analysis that will use them is Phase 2 — so the only places the screen can lie are the import
dialog's two new lines and the saved scenario the config exports. A silent `containers: null`
would look exactly like a successful import.
**Steps:** import fixture **F4**, which mixes one workload whose containers are named with one
whose are not. Commit with **Replace workloads**. Then press **Export**, read the JSON, and paste
it straight back through **Import** with `Replace configuration`.
**Expect:** the dialog shows exactly one warning — `Containers in this export carry no names, so
these workloads imported pod-level only: demo/legacy.` — and **two** notes: the existing
point-in-time one (F4 has a single sample, so it carries no peak) and a new one naming
`istio-proxy` among containers no pod spec declares. Both workloads still import: `demo/web` at
**CPU request** `250` mCPU with a `500` mCPU limit, `demo/legacy` at `100` mCPU. `demo/web`'s
**Average CPU usage / pod** reads `510` — the proxy's 210m counts toward the pod even though it
has no container entry. In the exported JSON, `demo/web` carries a `containers` array whose `app`
entry has `observed_cpu.avg: 300`, and `demo/legacy` carries `"containers": null`. The re-import
returns to `0 changes` with the pill still `Live` — the field survives save/load, and the engine
accepts it without a 422.
**Origin:** P1.6 (Session F) · **Not yet promoted** — eligible, and the natural next
promotion. Left out to bound the first batch, not on any principle that separates it from R19,
which came out of the same session and was promoted. · **Last verified:** 2026-08-20 (Session F)

### R19 — A pod-level edit drops the breakdown it just contradicted
**Pins:** the C2 resolution. Per-container detail has no readout, so a stale breakdown is
invisible on screen — the exported scenario is the only place the contradiction shows. The bug
this replaces: a workload edited from `250` to `500` mCPU exported `cpu_request_m: 500` beside a
container entry still claiming `250`, with nothing able to say which was current.
**Steps:** import fixture **F4** and commit with **Replace workloads**. Select `demo/web`, press
**Export**, and confirm the `containers` array is there. Close, set **CPU request** to `500`,
blur, and press **Export** again. Then Reset, re-import F4, and this time edit **Average CPU
usage / pod** instead.
**Expect:** before the edit `demo/web` carries its `app` breakdown; after either edit it carries
`"containers": null`, while `resources.cpu_request_m` (or the usage summary) shows the new value.
`demo/legacy` reads `"containers": null` throughout — it never had one. Editing a field that does
not describe the pod's shape or load — **Current replicas**, the HPA fields, **Rollout max
surge** — leaves the breakdown intact. No 422, and the pill stays `Live`.
**Origin:** C2 resolution (Session F) ·
**Automated:** `frontend/e2e/import.spec.ts` — one test per edit, so a failure names which of
the three moved, and proven able to fail in both directions: making a pod-level edit keep the
breakdown turns the two "clears it" tests red, and making every edit drop it turns "leaves it
intact" red. This is the one promoted scenario that parses JSON, and deliberately: the
breakdown has no readout, so the exported scenario *is* what the operator reads. The test takes
that JSON off the Export modal, not from the API. ·
**Last walked manually:** 2026-08-20 (Session F; walked all three edits — CPU request 250 → 500
and average usage 510 → 900 both cleared it, replicas 2 → 5 left it whole)

### R14 — A saved scenario round-trips
**Pins:** save/load, including the surge unit mode, which is derived from the config rather
than stored.
**Steps:** set **Rollout max surge** to `1 pods`; press **Export**, then `Copy JSON` (or
`Download`); open **Import**, paste into the Step 2 box, and press `Replace configuration`.
**Expect:** every workload, the pool, and the surge field (`1 pods`) come back unchanged, and
the change chip returns to `0 changes`.
**Origin:** P0.2 follow-up (Session B) · **Not yet promoted** — eligible; R19 already
exercises the export half through the same modal. · **Last verified:** 2026-08-20 (Session D)

---

## Candidate scenarios — observed, not yet decided

Behavior a regression pass found questionable but nobody has ruled on. These pin nothing
until an owner decides what the screen *should* say; do not "fix" them silently, and promote
one to a numbered scenario in the same change that settles it.

**Never automated.** A test here would freeze an answer nobody has given, and then defend it.
C2 shows the intended path instead: observed, settled by the owner, promoted to numbered
scenario R19 — and only then automated.

### C1 — An oversized pool's density and placement tiles describe the other pods
**Observed:** 2026-08-20 (Session D pass, while running R7). With `api` at an 8000m request on
a 3600m-allocatable node, the verdict says `6 pods request more than one whole node. No node
count places them.` — while the same panel reads `7 pods fit per node at this shape` and
`Placement: 1 node`.
**Why it is not a wrong number:** confirmed against the engine — that pool returns
`oversized_pod_count: 6`, `pods_per_node: 7`, `nodes_required: 1`. Both figures describe the
*placeable* remainder (four 500m `worker` pods, seven of which fit a node); the verdict
describes the excluded pods. Every number is right about the pods it is about.
**The question:** whether one panel may narrate two pod populations without saying which is
which. This is the same class as the P0.3 follow-up that stopped suppressing `nodes_to_add` —
resolved there by showing both statements; the density and placement tiles were not part of
that change.
**Status:** open, needs owner sign-off before anything moves.

### ~~C2 — An imported per-container breakdown survives pod-level edits and goes stale~~
**RESOLVED 2026-08-20** (owner chose to drop the breakdown on a pod-level edit). Promoted to
**R19** below; the behavior it questioned is gone. Original observation kept for the record:

**Observed:** 2026-08-20 (Session F review, while shipping P1.6). Import F4, then change
`demo/web`'s **CPU request** from `250` to `500` and press **Export**. The saved scenario reads
`resources.cpu_request_m: 500` beside a `containers` array still saying `app` requests `250`.
`Duplicate` clones the stale breakdown onto the new workload too.
**Why it is not a wrong number:** the breakdown is a record of what the export said, and the
editor is pod-level — it neither produces nor edits containers, so there is nothing for it to
update them *to*. Nothing reads the breakdown today, so no result is affected.
**The question:** what an editor that cannot express containers should do to a breakdown it
cannot keep true. Null it on any `resources` or `observed_*` edit (simple, lossy, and consistent
with "the editor is pod-level"), or keep it and mark its provenance. This becomes load-bearing
the moment Phase 2's runtime-risk analysis reads the breakdown — which is what the
`_evaluate_pool_scenario(pool, pods, workloads)` seam was opened for — because it will then read
container numbers that contradict the pod totals with no marker saying which is stale.
**Status:** ~~open~~ settled — see R19.

---

## Fixtures

Paste as-is. **The promoted tests read these code fences directly** (see
`frontend/e2e/support/checklist.ts`), so the suite and the human paste identical bytes and
cannot drift apart. Editing a fixture here changes what the suite imports; renaming a heading
or changing a fence to something other than ```` ```json ```` fails the suite loudly, which is
the correct outcome.

F1, F2, and F4 are `kcap-cluster-export` version 1 with no node block, so the
importer derives a single default pool. F3 is a saved kcap scenario, not an export. F1 and F2
name their containers, as every real export does since P1.6 — a nameless one is a stale export
script, which is what F4's second workload exists to show.

### F1 — Guaranteed pod with a native sidecar, absolute maxSurge

```json
{"kind":"kcap-cluster-export","version":1,"nodes":null,"usage":null,"workloads":[
 {"kind":"Deployment","namespace":"demo","name":"web","replicas":3,"maxSurge":1,
  "containers":[{"name":"app","resources":{"requests":{"cpu":"500m","memory":"512Mi"},
                                           "limits":{"cpu":"500m","memory":"512Mi"}}}],
  "initContainers":[{"name":"sidecar","restartPolicy":"Always",
                     "resources":{"requests":{"cpu":"100m","memory":"128Mi"},
                                  "limits":{"cpu":"100m","memory":"128Mi"}}}]}]}
```

### F2 — Deployment and StatefulSet sharing one namespace/name

```json
{"kind":"kcap-cluster-export","version":1,"nodes":null,"usage":null,"workloads":[
 {"kind":"Deployment","namespace":"demo","name":"web","replicas":2,
  "containers":[{"name":"app","resources":{"requests":{"cpu":"250m","memory":"256Mi"}}}]},
 {"kind":"StatefulSet","namespace":"demo","name":"web","replicas":2,
  "containers":[{"name":"app","resources":{"requests":{"cpu":"250m","memory":"256Mi"}}}]}]}
```

### F3 — A scenario from a version kcap no longer reads

A version-2 file, carrying the scalar usage fields that predate the `{avg, p95, peak}` summary.
The body is deliberately well-formed: the refusal must come from the version, not from anything
downstream noticing the old field names.

```json
{"kind":"kcap-scenario","version":2,"exported_at":"2026-01-01T00:00:00.000Z","config":{
 "workloads":{
  "legacy":{"name":"legacy","resources":{"cpu_request_m":500,"memory_request_mib":512,
    "cpu_limit_m":null,"memory_limit_mib":null},"current_replicas":4,
   "observed_cpu_per_pod_m":300,"observed_memory_per_pod_mib":400,
   "hpa":{"min_replicas":2,"max_replicas":10,"cpu_target_percentage":70,
    "memory_target_percentage":null},"rollout":{"max_surge_percent":25},"pool":"primary"},
  "idle":{"name":"idle","resources":{"cpu_request_m":250,"memory_request_mib":256,
    "cpu_limit_m":null,"memory_limit_mib":null},"current_replicas":2,
   "observed_cpu_per_pod_m":null,"observed_memory_per_pod_mib":null,
   "hpa":null,"rollout":{"max_surge_percent":25},"pool":"primary"}},
 "node_pools":{"primary":{"name":"primary","machine":{"cpu_m":4000,"memory_mib":16384,
   "reserved_cpu_m":400,"reserved_memory_mib":1536,"max_pods":110},
  "min_nodes":1,"current_nodes":3,"max_nodes":10}}}}
```

### F4 — Named containers, an injected sidecar, and one workload from a stale export

`demo/web` names its container and carries pod metrics for two containers, only one of which the
spec declares. `demo/legacy` names nothing, as a script generated before P1.6 would have written
it.

```json
{"kind":"kcap-cluster-export","version":1,"nodes":null,
 "usage":{"window_seconds":0,
  "pods":[{"namespace":"demo","name":"web-1","labels":{"app":"web"},"phase":"Running"}],
  "samples":[[{"namespace":"demo","name":"web-1","containers":[
    {"name":"app","usage":{"cpu":"300m","memory":"256Mi"}},
    {"name":"istio-proxy","usage":{"cpu":"210m","memory":"64Mi"}}]}]]},
 "workloads":[
  {"kind":"Deployment","namespace":"demo","name":"web","replicas":2,
   "selector":{"app":"web"},
   "containers":[{"name":"app","resources":{"requests":{"cpu":"250m","memory":"256Mi"},
                                            "limits":{"cpu":"500m","memory":"512Mi"}}}],
   "initContainers":[]},
  {"kind":"Deployment","namespace":"demo","name":"legacy","replicas":1,
   "containers":[{"resources":{"requests":{"cpu":"100m","memory":"128Mi"}}}],
   "initContainers":[]}]}
```
