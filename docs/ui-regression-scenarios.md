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
P0.2 follow-up, and raised C1, C2, and C5 — none of which an automated check could have asked.
C5 is the sharpest case: the promoted test for that field passes, because it types rather than
drags, and the stale readout only appears on the gesture a person makes first. R24's promotion
now drags — but only because a person had already found what to look for, and walking it again
found the memory half of that same row saying something the screen does not do (C7).

A scenario is **promoted** to `frontend/e2e/` once its expectation is settled, so that it
cannot silently rot between passes. Promotion is an anti-rot guard for decisions already
made — it is not a discovery tool, and it does not retire the manual walk.

Every row carries exactly one status. Nineteen are **Automated**, naming their spec file and
keeping a separate **Last walked manually** date that CI never touches. Six are **manual
only**, each saying why automating it would be worse than not. Three are **not yet
promoted** — R26, R27, and R28 each carry an expectation written the session that shipped the
behavior, and wait a session for it to settle.

An automated row may still name a part of itself the suite deliberately leaves alone; R24 is
the standing example. That is a note inside the row, not a fourth status.

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
  field reads `1 pods`, the test reads the field — never app state, never a JSON blob. The two
  exceptions prove it: R19 and R18 both read the exported scenario, and only for the
  per-container breakdown, which has no readout of its own outside the Runtime risk table's
  borrowing rows — a breakdown on an uncontended pool still shows nowhere but the export, so there
  the exported JSON *is* what the operator reads. The selector
  policy is stated once, in `frontend/e2e/support/kcap.ts`, and followed everywhere.
- Pin the relationship the scenario claims, not the number it happened to show. R3's claim
  is "+1 surge pod at any replica count", so its test moves the replica ceiling and re-reads
  rather than asserting `30 → 31`.
- If a control has no accessible name, fix the app — an `aria-label` helps every user, a
  `data-testid` helps only the test. Either way it is a UI change: justify it in a comment
  and walk the affected scenarios.
- The same applies to a *reading* with no boundary. A tile whose label, number, and qualifying
  note are loose siblings is announced as three unrelated strings, and it is also unaddressable
  as the one line an operator reads it as. The results panel's metric tiles, the saturation bars,
  and the two runtime-limit totals were each given `role="group"` with `aria-labelledby` pointing
  at the label already on screen — following the CA-action tile, which needed it first. Naming
  from the visible label rather than a duplicate `aria-label` is what keeps the name from
  drifting away from the screen.

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
opening the page is the honest form of it. · **Last verified:** 2026-08-21 (Session J)

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
projected number — the five scenario tabs, the verdict, the CA action, the placement — is
identical before and after (a) and (b); only (c) moves them (12 → 18 pods, `−3` → `−2`), and it
moves them because the *average* changed. The hint under both peak fields states the floor the
coercion enforces — `Optional; 0 = not measured; never below the average` — so (a) is explained
on screen rather than looking like a field that ignored the entry. The **Runtime risk** section moves at both steps, which is
what P2.3 gave the peak a readout for: (a) rewrites the basis note from `2 workloads` to
`1 workload`, because `api` now has a peak; (b) raises the chip. Contention is additive context,
so it reads the peak without any node number reading it. No 422 anywhere. Setting a peak back to `0`
clears the measurement.
**Origin:** P1.3 (Session E), expectation extended by P2.3 (Session H) ·
**Automated:** `frontend/e2e/observed-usage.spec.ts` — the three edits and the ordering
`usage.ts` enforces, plus the invariance of every projected number across (a) and (b) ·
**Last walked manually:** 2026-08-21 (Session L, walked end to end again when the number field
stopped keeping rejected text; (a) 400 → 620 and the basis note moves to `1 workload`, (b) 900
holds and raises the chip, (c) average 1200 carries the peak up, 12 → 18 pods and `−3` → `−2`.
Setting the peak back to `0` clears it. Session K walked the same three steps when these fields
gained their floor hint)

### R24 — A field that has been overruled shows what was stored, not what was asked for
**Pins:** C5's repair, in the shared number field every numeric input in the editor is built
from. Several of those fields store something other than what was entered — the peak is raised
to the average, the surge unit picker converts, the commit rounds — and the box has to end each
edit on the value that was kept. The slider is where it shows: a whole span of the peak track
stores one value, so the positions inside it are not distinct entries.
**Steps:** select `api` (average CPU 620 on the shipped defaults). (a) Drag the **Peak CPU usage
/ pod** slider from `0` to anywhere left of the average, three times, releasing at a different
position each time. (b) Drag it well to the right of the average, then back down into that same
span. (c) Type `400` into the box and press Enter — twice in a row. (d) Repeat (a) on **Peak
memory usage / pod**.
**Expect:** the box and the thumb read `620` after every drag in (a) and after the return drag
in (b) — never a position the drag passed through. In (b) the value above the average is
addressable normally on the way out. In (c) the box reads `620` both times; the second attempt
is the one that matters, because nothing about the stored value changed and a readout that
resyncs only on change cannot see it. In (d) the memory box ends every drag on the value that
was stored, which is this scenario's claim — but the box and the thumb do **not** always agree
there, and the sentence that once said they did was wrong. That track steps in 16 MiB and the
780 average is not a multiple of 16, so a drag landing inside the coerced span reads `780` in
the box beside a thumb the browser snaps to `784`; a drag that happens to land on `784` itself
stores `784`, and then the two do agree. Which you get depends on the drag, not on the field.
The box is right either way — see **C7**. No number anywhere else on screen moves in (a), (c),
or (d) beyond what R16 already expects, and no 422.
**Origin:** C5 (Session L) ·
**Automated:** `frontend/e2e/observed-usage.spec.ts` — (a), (b), and (c) on the CPU peak, and
the test *drags*: `dragSlider` presses at the thumb and moves in steps, because the slider
commits through `onChange` and never blurs, which is the path C5 survived on while the typed
spec looked fine. The average is raised first so the coerced span covers half the track — the
claim is a span that stores one value, not the width the shipped average gives it, and on the
shipped 620 the three positions are close enough that the thumb's own width decides which one a
drag lands on. **(d) is deliberately not automated:** walking it found the expectation below is
wrong about the memory field — that track steps in 16 MiB, which cannot land on the 780 average,
so the box reads the stored `780` beside a thumb the browser snaps to `784`. The box is right
and this scenario's own claim holds; "box and thumb agree" does not. See **C7** ·
**Last walked manually:** 2026-08-22 (Session O, (a)–(c) walked on the CPU peak — three
sub-average drags all reading `620`, `1990` held above the average and `620` again on the way
back, `400` typed twice reading `620` both times; (d) walked on the memory peak and raised C7.
Previously walked 2026-08-21, Session L, on the fixed build; the same walk on the pre-fix build
reproduced C5 — box `470` beside a thumb at `620`)

---

## Manual runs

### R27 — A held run says its numbers are old, and stops counting while they are
**Pins:** with **Auto** off the panel goes on showing the last run while the operator edits, and
until now nothing on screen said so. Three separate reasons: the dim that was meant to say it was
written in the first commit and never rendered — the results body carries an entry animation
whose last frame is `opacity: 1`, and a *retained* animation value outranks every ordinary style
rule, so the finished animation went on deciding that opacity forever and only the scenario tabs
dimmed; the cluster-total strip was outside the rule that did the dimming; and the change chip
counts the engine's own configuration diff, which describes the configuration the engine was last
*given*, so with one edit waiting it read `0 changes` and with two it read `1 change`. The error
runs one way: a held panel always shows the smaller, pre-edit footprint, which for a capacity
advisor reads as under-provisioning and an over-eager scale-down.
**Steps:** Reset. Turn **Auto** off — nothing else. Then select `api` and set **Current
replicas** to `12`, committing the field. Then press ＋ beside **Node pools** to add a second
pool. Then press **Run simulation**.
**Expect:**
- turning **Auto** off on its own changes nothing on the panel: the numbers still describe the
  screen, so they are still shown as if they do. The `Run simulation` button appears, greyed out,
  because there is nothing to run.
- after the replica edit the whole panel goes pale below the Auto row — the scenario tabs, the
  verdict, the four tiles, the request bars, the node map, the workload table, the Runtime risk
  section, and the delta strip. The heading, the chip, and the **Run simulation** button stay at
  full contrast: they are the parts that explain the fading and undo it.
- the chip turns amber and reads `edited since last run`. It states no count — the count it used
  to print was about the previous run, and a panel that has just stopped describing the screen is
  the last place to assert a number about it.
- after adding the pool the `All pools · N nodes` strip and the pool tabs appear, and they are
  pale with everything else. This is the half that never faded: it is the cluster-wide headline
  figure, and it is the one an operator reads first.
- what the pale numbers say is the *old* configuration: `Placement 3 nodes`, `CA action −3
  nodes`, `All pools 3 nodes`.
- **Run simulation** brings the whole panel back to full contrast in one step, the chip returns
  to a plain count (`4 changes`), and every figure grows: `Placement 4 nodes`, `CA action −2
  nodes`, `All pools 4 nodes`. Reading the two states in that order is the point — the held panel
  under-counted nodes and over-stated the scale-down.
- no console errors, and no 422.
**Origin:** the held-run readout repair (Session P) · **Not yet promoted** — written and walked
this session; it waits one session for review. Two things to know when it is promoted. Manual
mode is pinned nowhere else: no other scenario and no promoted test touches **Auto**, the
**Run simulation** button, or a held run, so until then this row is the only thing holding any of
it. And only part of the row is assertable — the chip's wording and the numbers are text, but the
fading is opacity, and the selector policy in `frontend/e2e/support/kcap.ts` forbids asserting on
CSS, so a test can pin *that a held run shows the previous numbers* and never that it shows them
faintly. `kcap.changeChip` also matches `/^\d+ changes?$/`, which a stale chip no longer matches
at all: the locator has to learn the countless form, or the test fails as "element not found"
rather than as a wrong reading. ·
**Last verified:** 2026-08-22 (Session P, walked on a build of this working tree at one pool and
at two, and walked again on a build of the commit before the change to see it fail — there the
results body measured at full strength beside a faded tab strip, the cluster-total strip likewise,
and the chip read `0 changes` with one edit waiting and `1 change` with two)

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
**Last walked manually:** 2026-08-21 (Session L, re-walked because the field's readout changed:
`1 pods` → `5.55 %` at `api`'s ceiling of 18 → `1 pods`)

### R5 — A percent surge survives a focus-blur
**Pins:** the `NumberField` integer-rounding rule that once re-rounded a converted percent on
a bare focus + blur.
**Steps:** after R4, switch to `%` (leaving whatever fractional value the conversion
produced), click into the field and click away without typing.
**Expect:** the value is unchanged, and switching back to `pods` still reads `1`.
**Origin:** P0.2 follow-up (Session B) ·
**Automated:** `frontend/e2e/rollout-surge.spec.ts` — the test first asserts the conversion
really did leave a fraction, so it cannot quietly become a test of nothing ·
**Last walked manually:** 2026-08-21 (Session L, `5.55 %` unchanged by a focus and a blur, and
still `1 pods` on the way back — re-walked because the field's readout changed)

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
**Last walked manually:** 2026-08-21 (Session L; 30 / 34 / `−3 nodes` identical in all three
states, with `worker`'s own surge left alone, which is why `Rollout` reads 34 rather than 31.
The 2026-08-20 Playwright session read 30 / 31 / `−3 nodes`, and Session D saw the chip go
3 → 4 from a different starting config — which is exactly why the chip is not pinned.)

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
held *equal to itself* across a no-op — the one CA-action claim that needs no reading. R22, R23,
and R25 sit in this group for their subject but are not among the five: each claims a fixed
string, or a difference two fields decide, against a named state — which is exactly what a test
can hold still. R23's three readings differ arithmetically rather than rhetorically, so its test
computes the drain from the two fields it set rather than quoting `−5`.

### R6 — An ordinary pool instructs a real scale-down
**Pins:** the unblocked path, so the scenarios below prove something.
**Steps:** load the defaults, select the `Current` tab (the app opens on `Desired`), and read
the CA action.
**Expect:** `−N · nodes` (`−3` on the shipped defaults), or `Hold · steady` if the pool is
already right-sized. Never `None`.
**Origin:** P0.3 (Session C) · **Manual only:** see the group note above. · **Last verified:**
2026-08-21 (Session L, `−3` on the shipped defaults)

### R7 — An oversized pod withholds the scale-down, not the truth
**Pins:** P0.3 — `nodes_to_remove` is gated, and the panel says why.
**Steps:** select `api`, set **CPU request** above one node's allocatable (e.g. `8000` on the
default 4-core node).
**Expect:** verdict reads `Capacity blocked` with `N pods request more than one whole node. No
node count places them.`; CA action reads `None · no fix`; the constraint chip reads
`POD SIZE`. At exactly one oversized pod the whole sentence agrees — `1 pod requests more than
one whole node. No node count places it.` — verb and pronoun included; R26 covers that reading.
**Origin:** P0.3 (Session C) · **Manual only:** see the group note above. · **Last verified:**
2026-08-22 (Session N, re-walked at 3 and at 1 oversized pod — `Capacity blocked`,
`None · no fix`, `POD SIZE` at both, and the sentence agrees at one)

### R8 — A partly-oversized pool still reports its genuine addition
**Pins:** the P0.3 follow-up — the panel used to suppress `+N` whenever any pod was oversized,
so ninety placeable pods went unreported next to one that could not be placed.
**Steps:** from R7's state, raise `worker`'s **Current replicas** until the placeable demand
needs more nodes than the pool runs (e.g. `60`).
**Expect:** CA action reads `+N · nodes` (`+3` at 60 worker replicas) **beside** the unchanged
"no node count places them" paragraph. The two statements are about different pods and both
belong on screen.
**Origin:** P0.3 follow-up (Session C) · **Manual only:** see the group note above. · **Last verified:** 2026-08-20 (Session D)

### R22 — An oversized pool says which pods each node number is about
**Pins:** the panel narrates two pod populations at once — the verdict counts the pods no node
can hold, and the node numbers under it size only the rest. Every number was already right, and
none of them may be dropped, which is the mistake R8 pins. So each reading names the population
it is about, and only while there are two populations to tell apart. This scenario covers the
node numbers and the density sentence; R25 carries the same rule into the saturation bars, which
this one deliberately left alone.
**Steps:** select `api`, set **CPU request** to `8000` (above the default 4-core node's
allocatable) and press Enter. Let the **CPU limit** follow the request up — the API rejects a
limit below it, and typing the limit back down 422s the run.
**Expect:** the verdict still reads `6 pods request more than one whole node. No node count
places them.`, and beside it `Placement 1` now reads `nodes for the pods that fit` while
`Effective target 3` reads `same pods, after CA minimum 3`. The paragraph under the saturation
bars keeps its own sentence and gains a second one: `That per-node figure counts only the pods
that fit, not the 6 requesting more than one whole node.` Press **Reset** and re-read: with no
oversized pod the notes are back to `nodes to hold the pods` and `after CA minimum 3`, and the
paragraph ends at `…without changing requests or node size.` — an ordinary pool gains no extra
words, because there is only one population to describe.
**Origin:** C1 (Session J) ·
**Automated:** `frontend/e2e/oversized-pool.spec.ts` — the ordinary pool first, then the edit,
then **Reset**, so the test pins the *appearance and disappearance* of the scoping rather than
either state alone. The density clause is asserted against the count the verdict above prints,
read off the screen: two readings of one population that disagreed would be worse than neither.
The tile numbers themselves are matched as `\d+`, because the claim is which pods each number is
about. Reading a tile as one line needed the four metric tiles to become `role="group"` named
from the label already on screen — an ARIA fix, walked as the UI change it is ·
**Last walked manually:** 2026-08-22 (Session O, re-walked at 6 oversized pods after the tiles
gained their group role — verdict, `Placement 1 · nodes for the pods that fit`,
`Effective target 3 · same pods, after CA minimum 3`, and the density sentence all unchanged.
Previously walked 2026-08-21, Session M, at 6 oversized pods and with every pod oversized while
settling C4; and 2026-08-21, Session J, which also covered the single-oversized-pod wording
`not the 1 requesting more than one whole node`)

### R25 — The request bars are about the pods their capacity was sized for
**Pins:** the saturation section's own numerators, which R22 deliberately left alone. Both bars
divide by capacity sized from the pods that fit, so both numerators are now about those pods
too, and the section's subhead names them. The stranded readout beside the bar is measured
against the same capacity and is scoped with it — a scoped bar next to an unscoped stranded
figure would contradict itself one line lower. The excluded demand is still on screen: the
verdict above counts it, which is the mistake R8 pins. It lives in this group rather than with
the bars because it is the same two-population question R22 and R8 are about. The trap is the
ordinary pool — nothing may change there, because there is only one population to be about.
**Steps:** (a) select `api`, set **CPU request** to `8000` (above the default 4-core node's
allocatable) and press Enter. Read the **Request saturation** section. (b) Also set `worker`'s
**CPU request** to `8000`, so the pool has no placeable pod left at all. (c) Press **Reset** and
read the section again. Note that raising the request past the workload's **CPU limit** is what
the editor's own floor handles — the API rejects a limit below the request, so let the limit
follow rather than typing it back down, or the run 422s and the panel goes stale.
**Expect:**
- (a) the subhead reads `the pods that fit · 3 × node allocatable`. The **CPU** bar reads
  `2 cores / 10.8 cores` with `19% requested · 81% (8.8 cores) stranded at this pod shape`, and
  the **Memory** bar reads `3 GiB / 43.5 GiB` with `7% requested · 93% (40.5 GiB) stranded`.
  Neither ratio is above 100%, and both bars moved the same way — the memory one was never over
  100%, so it is the one that proves this is a scoping change and not a clamp. Nothing R22 pins
  moves: the verdict still reads `6 pods request more than one whole node. No node count places
  them.`, `Placement 1`, `Effective target 3`, `Headroom 17`, `CA action None · no fix`, and the
  density paragraph still ends `…not the 6 requesting more than one whole node.`
- (b) with nothing placeable the subhead still scopes — `the pods that fit · 3 × node
  allocatable` — and both bars read `0m / 10.8 cores` and `0 MiB / 43.5 GiB`, `0% requested ·
  100% stranded`, because the pool sits at its CA minimum of 3 and no pod claims any of it. This
  is the reading the old formula got exactly backwards: `capacity − everything requested` floored
  to `0 stranded`, so a pool holding no pod at all reported every provisioned core as spoken for.
  `Placement 0`, and the density paragraph is absent entirely — with no pod that fits there is no
  per-node figure to qualify, which is why the subhead has to carry the scoping on its own.
- (c) after **Reset** the subhead is back to `3 × node allocatable` with no scoping clause, and
  the bars read `8 cores / 10.8 cores`, `74% requested · 26% (2.8 cores) stranded` and
  `11 GiB / 43.5 GiB`, `25% requested · 75% (32.5 GiB) stranded` — the same figures as before
  this change, because an ordinary pool has nothing to scope away.

No console errors, and no 422 in any of the three.
**Origin:** C4 (Session M) ·
**Automated:** `frontend/e2e/oversized-pool.spec.ts` — both bars in all three states, and (a)
and (c) in one test so the reset figures are compared against the ones read off the pre-edit
screen, as the walk does. The pin is the relationship, not the printed figures: the capacity
each bar divides by is unchanged across the edit while both numerators fall, and each bar's
requested and stranded shares must account for its own capacity between them. That last check is
what catches scoping one bar and not the other — an unscoped memory numerator reads `21%
requested` beside `93% stranded`, which is 14 points of a population that is not there. Reading
a bar as one line needed the same `role="group"` fix the metric tiles took ·
**Last walked manually:** 2026-08-22 (Session O, all three reads walked again after the bars
gained their group role — `2 cores / 10.8 cores` at `19% · 81%` and `3 GiB / 43.5 GiB` at
`7% · 93%` scoped, `0m` / `0 MiB` at `0% · 100%` with nothing placeable, and the shipped
`74% · 26%` / `25% · 75%` back after **Reset**. Previously walked 2026-08-21, Session M, on the
fixed build, where the reset figures were read off the pre-edit screen first)

### R26 — Every count agrees with the noun beside it at one
**Pins:** nine readouts printed a count against a hardcoded plural, so a one-replica workload
read `1 pods · 8 cores · 1 GiB` in the catalog and a single oversized pod read `1 pod request
more than one whole node. No node count places them.` The engine was right in every case — this
is only what the screen says — which is the class of defect this file exists for. Counts now
agree in one place (`plural`/`counted` in `frontend/src/format.ts`), so the check is that each
site actually *reaches* the singular, not that the helper works: unit tests already hold that.
**Steps:** select `api` and set **Current replicas** to `1`. Drop **Average CPU usage** and
**Average memory usage** to `300` each, so the metrics recommend below the HPA minimum. Press
**Remove** on `worker`. Select the `Current` scenario tab. Then select `primary` and set
**Minimum nodes**, **Current nodes**, and **Maximum nodes** to `1`. Finally press ＋ beside
**Node pools** to add a second pool, which is what reveals the cluster-total tile.
**Expect:** every reading is singular, and none of them says `1 pods` or `1 nodes`.
- topbar `2 node pools · 1 workload`; catalog entries `primary 1 node · 4 cores · 16 GiB` and
  `api 1 pod · 750m · 1 GiB`
- the `Current` scenario tab reads `1 pod`; the `All pools` tile reads `1 node` over
  `1 pod · 2 pools`; the pool tabs read `primary 1 node` and the empty pool `0 nodes` — zero is
  plural, and only one is not
- the delta strip reads `Candidate 1 node` against a `Baseline 3 nodes`, so both forms are on
  screen together
- the node map's accessible name reads `1 of 1 node required` — it is a sentence a screen reader
  says aloud, so it agrees with the number it sits next to
- the HPA callout reads `Metrics recommend 1 pod, held at 3 by the minimum.`
- set **Current nodes** to `0` and the CA action reads `+1` over `node`; set **Maximum nodes**
  and **Current nodes** to `2` and it reads `−1` over `node`. The count and the noun are
  separate elements and are read as one line, which is how `+1 nodes` survived.
- with **CPU request** at `8000` on the one-replica workload, the verdict reads `1 pod requests
  more than one whole node. No node count places it.` — the verb and the pronoun agree too, which
  a plural `s` alone does not fix
- raise **Peak CPU usage** to `3800` with the **CPU limit** off and the Runtime risk chips read
  `Borrowed CPU · 1 workload` over `1 of 1 packed node contended`; switch the **Memory limit**
  off for `Unlimited memory · 1 pod`

Re-read each one above one — the shipped defaults give `6 pods`, `6 nodes`, `2 workloads` — since
a helper that returned the singular unconditionally would pass every check above.

**Not** part of this: the **Rollout max surge** field reads `1 pods`, and R4, R5, and R15 pin it
that way. `pods` there is the unit on a picker whose other option is `%`, not a noun agreeing
with a count — the same category as `MiB`. It is deliberately unchanged.

No console errors, and no 422.
**Origin:** the plural sweep (Session N) · **Not yet promoted** — written and walked this
session; it waits one session for review. When it is promoted, note that
`frontend/e2e/support/kcap.ts` already had to learn the singular for this change: `podCount()`
and the catalog and topbar locators matched `\d+ pods` and would have failed as "element not
found", not as a wrong value, the first time a fixture reached one. ·
**Last verified:** 2026-08-22 (Session N, every reading above walked at one and at n on a build
of this working tree; zero console messages and every request 200)

### R9 — An idle pool reads as no demand, not as steady state
**Pins:** the withheld scale-down on an idle pool, and the cluster-total tile that reads
blocked-ness off the pools it sums. The **Minimum nodes** step is what arms the withholding, not
incidental setup: a floor above zero makes the same idle pool instruct a real drain instead, which
is R23. Do not drop that step.
**Steps:** set **Current replicas** to `0` on every workload, and the pool's **Minimum nodes**
to `0`. Then press **Duplicate** on the pool — the cluster-total tile appears only with two or
more pools.
**Expect:** each pool's CA action reads `None · no demand`, and the `All pools` tile reads
`None` / `summed across pools`. An idle cluster that totals to `Hold` while every pool it sums
says `None` is the exact regression this pins.
**Origin:** P0.3 (Session C) · **Manual only:** see the group note above. · **Last verified:**
2026-08-21 (Session L, re-walked after the withholding narrowed — both pools read `None · no
demand` and the tile `None` / `summed across pools`, unchanged)

### R23 — An idle pool with a floor drains to it
**Pins:** the narrowing of that withholding — an idle pool is held only when the removal would
strip it bare. A pool that keeps a floor is drained to that floor, which is what a real
autoscaler does; reading `None · no demand` there understated a safe instruction.
**Steps:** set **Current replicas** to `0` on every workload, leave **Minimum nodes** at `3`,
and set **Current nodes** to `8`. Read the CA action on the `Current` tab (the app opens on
`Desired`, where the HPA minimum keeps the pods above zero). Then set **Minimum nodes** to `0`,
and finally set it back to `3` and **Current nodes** to `3`.
**Expect:** at min 3 of 8 nodes, `−5 · nodes` — beside a `NONE · no pods in scenario` constraint
chip, because the pool is genuinely idle and both statements belong on screen. At min `0`, the
same pool flips to `None · no demand`, and that single field is the whole of the difference. At
min 3 of 3 nodes it reads `Hold · steady`: there is no removal to withhold, so the pool reads as
the steady state it is, with the idleness still carried by the constraint chip.
**Origin:** narrowed scale-down gate (Session L) ·
**Automated:** `frontend/e2e/ca-action.spec.ts` — the three readings in one test, because the
claim is the difference between them and a failure should name which one moved. The drain is
computed as `current nodes − minimum nodes` read off the two fields, not asserted as `−5`: the
claim is that an idle pool drains *to its floor*, at whatever floor it has. The constraint chip
is read beside it in both idle readings, because "genuinely idle" and "drain 5 nodes" are two
true statements about the same pool and both belong on screen ·
**Last walked manually:** 2026-08-22 (Session O, all three readings re-walked after the metric
tiles gained their group role — `−5 · nodes` beside `NONE · no pods in scenario` at min 3 of 8,
`None · no demand` at min 0, `Hold · steady` at min 3 of 3. Previously walked 2026-08-21,
Session L, which also confirmed the oversized pool at `None · no fix` and the defaults at
`−3 · nodes`)

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

## Runtime risk

### R20 — The Runtime risk section says what was examined, not just what was found
**Pins:** P2.3. `cpu_contention` has three states the panel must not blur together, and two of
them look identical if the readout only ever renders flags. `null` means the packer opened no
nodes, so nothing was examined; an empty `flags` list means nodes were examined and none was
contended. Rendering the all-clear for `null` would claim kcap checked something it never
looked at. The section is additive context: no flag may move a node number.
**Steps:** (a) load the default configuration and read the **Runtime risk** section in the
results panel, on the `Desired` tab the app opens on — every number below is that tab's.
(b) Select `api` and set **Peak CPU usage / pod** to `2000`, blur.
Expand the chip. (c) Reset, then set **CPU request** to `8000` on both `api` and `worker`.
(d) Reset and import fixture **F5** with `Replace configuration`, then expand the chip.
**Expect:**
- (a) one neutral line, `No contention or exhaustion detected on this packing.`, and two muted
  lines beneath it — the engine's basis note, `Peak unavailable for 2 workloads — avg used;
  contention here is a lower bound.`, and the CPU reading R28 is about. No chip, no colour.
  Below them the section still carries the
  two limit tiles (`CPU runtime limit`, `Memory runtime limit`), which P2.3 moved into it, and now
  ends with the swapped caption `Requests alone drive placement; limits and usage drive the
  runtime risk read above.`
- (b) a warn-tone chip reading `BORROWED CPU · 1 WORKLOAD` — the app's chips are uppercased in
  CSS — with `2 of 3 packed nodes contended` beside it. Every projected number is unchanged from (a): the five scenario tabs, `Capacity
  clear`, `CA action −3`, `Placement 3`, and the baseline/candidate strip at `+0`. Expanded, one
  row: `api`, container `whole pod`, request `750m`, usage `2000m peak`, `8 of 8` replicas, and
  `771m`
  under a column headed exactly `worst case (bound)`. Hovering the row shows the engine's own
  sentence, which the panel never rewrites; it is a hover only, and deliberately carries no number
  the columns do not already show.
- (c) `No nodes were packed for this pool, so runtime risk was not evaluated.` — and no basis
  note, because a pool that packed nothing has nothing to disclose a basis for. No CPU reading
  either: there is no node to have declared anything against.
- (d) the chip still reads `1 WORKLOAD` while the table has **two** rows — flags are per
  (workload, container), and the chip counts workloads. `app` reads `500m` / `1700m peak` /
  `514m`; `istio-proxy` reads `19m` / `300m peak` / `19m`. A further muted line appears above the
  basis note: `Container rows name only the containers the import listed; a pod may be borrowing
  more than its rows account for.` It is absent in (b), where the flag is pod-level and carries
  the whole pod's excess already.
**Origin:** P2.3 (Session H), all-clear sentence widened and the container cell reworded by
P3.3 (Session I) ·
**Automated:** `frontend/e2e/runtime-risk.spec.ts` — the three states, the workload-vs-flag
count, and the caveat line. The container cell's own wording is deliberately not asserted:
`whole pod` was written this session and a test would freeze it a session early, so the test
reads the row by its workload and numbers instead ·
**Last walked manually:** 2026-08-22 (Session P, (a) and (c) re-walked — those are the two
states the CPU reading changed, and (c) is where it must stay silent. Previously walked
2026-08-21, Session I, all four steps, where the all-clear sentence and the container cell
both changed)

---

### R21 — Node exhaustion is read off declared limits, and moves no node number
**Pins:** P3.1–P3.3. Memory limits were inert before this; now they set a ceiling per packed
node, and `limit_exposure` carries the same three states `cpu_contention` does. Two traps:
`null` is "nothing was packed", not an all-clear, and the finding must be read off the engine's
flags rather than off the exhaustible node count — a pod with no memory limit alone on its node
claims exactly the node and no more, so the count stays 0 while the flag is real. The section is
additive context: no ceiling may move a node number.
**Steps:** (a) load the default configuration and read the **Runtime risk** section on the
`Desired` tab the app opens on. (b) Select `api`, set **Memory limit value** to `4096`, blur,
and expand the chip. (c) Reset. Select `api`, turn its **Memory limit** toggle off and set
**CPU request** to `3000`; select `worker` and set **Current replicas** to `0`; select the
`Current` tab and expand the chip.
**Expect:**
- (a) the neutral line `No contention or exhaustion detected on this packing.` — the wider
  sentence, now that exhaustion is something kcap actually checked. No chip.
- (b) a warn-tone chip `NODE EXHAUSTIBLE · 2 OF 3 NODES` — chips are uppercased in CSS — with
  `memory ceilings reach 120.7% of allocatable on the most exposed node` beside it. Every
  projected number is unchanged from (a): the five scenario tabs (`5 / 10 / 12 / 30 / 38` pods),
  `Capacity clear`, `CA action −3`, `Placement 3`, `Headroom 17`, and the strip at `+0`. The one
  number that moves is the `Memory runtime limit` tile, `22 GiB` → `38 GiB`, which is the sum of
  the limits themselves. Expanded: prose, not a table — the engine's sentence `Memory ceilings
  on the most exposed node reach 120.7% of allocatable — 2 of 3 nodes can be exhausted by pods
  behaving within their limits.` Beneath the expansion, not inside it, a muted `CPU limits reach
  263.9% of allocatable on the node that declares the most. CPU is compressible, so a node over
  100% throttles rather than runs out.` The CPU ratio never gets a chip of its own, and it is not
  a consequence of the memory finding either — it reads the same here as it does on the all-clear
  in (a), which is what R28 is about.
- (c) the chip reads `UNLIMITED MEMORY · 6 PODS` with `memory ceilings reach 100% of allocatable
  on the most exposed node`. This is the state a node-count chip would misreport: at 3000m per
  pod one pod holds a node alone, so no node is *over* its allocatable and `0 of 6 nodes` would
  be the reading. Expanded: `6 pods carry no memory limit; each can claim its whole node, so any
  node they share can be exhausted.`, and beneath the expansion the CPU line at `83.3%` — the
  request edit raised the CPU limit with it, so the ratio is still reported. The `Memory runtime
  limit` tile reads `Unbounded`.
**Origin:** P3.3 (Session I) ·
**Automated:** `frontend/e2e/runtime-risk.spec.ts` — two tests, one per chip label, because they
are two different decisions and a failure should say which. (b) reads the all-clear first, so
the chip it then asserts is one the edit raised; the ratio is read as a number and held above
100% rather than quoted as `120.7%`, since "a node whose ceilings exceed it" is the claim. (c)
holds the ratio at exactly 100% and asserts the `Node exhaustible` chip is *absent* — that is
the state a node-count chip misreports as `0 of 6 nodes`. The chips' warn tone is not asserted:
the selector policy keeps CSS out, so the test pins their words. Reading the `Memory runtime
limit` tile needed it and its CPU sibling to become `role="group"`, the same ARIA fix the metric
tiles took ·
**Last walked manually:** 2026-08-22 (Session P, (a)–(c) re-walked after the CPU line moved out
of the expansion — `NODE EXHAUSTIBLE · 2 OF 3 NODES` at 120.7% with the five tabs at
`5 / 10 / 12 / 30 / 38`, `−3`, `Placement 3`, `Headroom 17` all unmoved and the memory tile at
`22 GiB` → `38 GiB`; `UNLIMITED MEMORY · 6 PODS` at 100% with the tile reading `Unbounded` and
the CPU line at 83.3%, now readable without expanding either chip. Previously walked
2026-08-22, Session O, and 2026-08-21, Session I)

---

### R28 — A CPU-overcommitted pool says so even when its memory is clean
**Pins:** the CPU reading used to live inside the memory expansion, so it appeared only when the
memory chip fired. A pool with unremarkable memory and CPU limits at nearly three times
allocatable therefore showed nothing at all — and a section that shows nothing reads as a
section with nothing to report. The reading is not a finding: CPU throttles under pressure
where memory kills, so it may not arrive as a chip, a colour, or anything an operator would
page on. It just has to be *there*.
**Steps:** (a) load the default configuration and read the **Runtime risk** section on the
`Desired` tab the app opens on, without expanding anything. (b) Select `api` and turn its
**CPU limit** toggle off; select `worker` and turn its **CPU limit** toggle off. (c) Reset,
then set **CPU request** to `8000` on both `api` and `worker`.
**Expect:**
- (a) under the all-clear line and the basis note, a third muted line in the same grey as the
  other two: `CPU limits reach 263.9% of allocatable on the node that declares the most. CPU is
  compressible, so a node over 100% throttles rather than runs out.` No chip, no warn tone,
  nothing to expand — and the memory side still says the pool is clear, because it is. Every
  projected number is the one R20 (a) reads: the five tabs at `5 / 10 / 12 / 30 / 38`,
  `Capacity clear`, `CA action −3`, `Placement 3`, `Headroom 17`, the strip at `+0`.
- (b) the CPU line is gone and the section is back to the all-clear and the basis note. Nothing
  declares a CPU limit, so there is no ratio, and an absent reading is left unsaid rather than
  announced. The `CPU runtime limit` tile reads `Unbounded`, which is where that fact belongs.
- (c) `No nodes were packed for this pool, so runtime risk was not evaluated.` and nothing else:
  a pool that packed nothing was not examined, and a CPU ratio would be a reading about nodes
  that do not exist.
**Origin:** Session P ·
**Not yet promoted:** the wording of the line was decided this session. It waits a session to
settle before `frontend/e2e/runtime-risk.spec.ts` freezes it; R21's own CPU assertion already
guards that the line exists ·
**Last walked manually:** 2026-08-22 (Session P, all three steps, on a build of this working
tree — (a) at 263.9% with no node number moved from the pre-change reading)

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
**Pins:** P1.6. Per-container requests, limits, and usage reach the screen only through P2.3's
Runtime risk table, and only for a container borrowing CPU on a contended node — for this fixture,
which contends nowhere, they have no readout at all — so the only places the screen can lie are the import
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
**Origin:** P1.6 (Session F) ·
**Automated:** `frontend/e2e/import.spec.ts` — the dialog's warning is counted the way an
operator counts them (one `Heads up.` callout) and quoted verbatim; both notes are asserted by
their sentences, but their *count* is not, because a note is a paragraph with no role or
accessible name and counting them would need a CSS class the selector policy forbids. The
breakdown assertions read the exported JSON, on R19's justification and for the breakdown only —
every pod-level number (`250` / `500` / `100` mCPU, the `510` average) is read off the fields.
Proven able to fail in both halves: suppressing the injected-sidecar note turns the dialog
assertion red, and dropping `containers` from the export turns the breakdown assertion red ·
**Last walked manually:** 2026-08-20 (Session F)

### R19 — A pod-level edit drops the breakdown it just contradicted
**Pins:** the C2 resolution. Per-container detail reaches the screen only as a Runtime risk row
for a borrowing container on a contended node, so on this fixture a stale breakdown is invisible — the exported scenario is the only place the contradiction shows. The bug
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
breakdown has no readout on an uncontended pool, so the exported scenario *is* what the
operator reads. The test takes
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
**Origin:** P0.2 follow-up (Session B) ·
**Automated:** `frontend/e2e/import.spec.ts` — the round-trip is read off the *fields*, not the
exported JSON: every workload editor field and every pool field is read before and after and
compared with itself, so the test pins "save/load changes nothing" rather than any particular
default. A field hidden behind an off toggle is recorded as `not shown`, so a round trip that
lost an HPA or a limit fails as loudly as one that lost a value, and the topbar's
`primary · 2 workloads` line catches a workload dropped or invented. The surge unit is asserted
on its own because it is the reading the row is about. Proven able to fail: an export that drops
`max_surge_pods` brings the field back as `25 %`, and one that resets `min_nodes` fails the
field-by-field comparison ·
**Last walked manually:** 2026-08-20 (Session D)

---

## Candidate scenarios — observed, not yet decided

Behavior a regression pass found questionable but nobody has ruled on. These pin nothing
until an owner decides what the screen *should* say; do not "fix" them silently, and promote
one to a numbered scenario in the same change that settles it.

**Never automated.** A test here would freeze an answer nobody has given, and then defend it.
C2 shows the intended path instead: observed, settled by the owner, promoted to numbered
scenario R19 — and only then automated.

### ~~C1 — An oversized pool's density and placement tiles describe the other pods~~
**RESOLVED 2026-08-21** — settled in favour of labelling both readings rather than suppressing
either, on the precedent of the withheld `+N` addition R8 pins. Promoted to **R22** above; the
panel now names the population each node number is about, and the wording R22 quotes is the
owner-visible part still open to veto. Original observation kept for the record:

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
**Status:** ~~open~~ settled — see R22.

### ~~C3 — The peak sliders have a dead zone the length of the average~~
**RESOLVED 2026-08-21** — the owner chose the cheapest of the four options: say the coercion
out loud in the field's existing hint, which changes nothing an operator can express. Both peak
fields now read `Optional; 0 = not measured; never below the average`. The other three were
rejected: raising the slider's `min` to the average and starting the track at the average both
put `0` out of reach of the control, and `0` is how this field spells "not measured"; marking
the coerced floor on the track adds an affordance to explain a range the operator still cannot
address. Leaving it altogether was rejected because the typed field is only authoritative once
someone types — the slider is what a first-time reader reaches for. `usage.ts` is unchanged; the
hint says "never below the average" rather than naming the average as the landing value, because
the floor is the higher of the average and an imported p95. No numbered scenario is promoted:
this settles what a field *says*, not what the screen computes, and R16 already pins the
coercion. Original observation kept for the record:

**Observed:** 2026-08-21 (Session H, while walking R16 end to end for the first time). **Peak
CPU usage / pod** has a slider track running `0`–`4000`, and `withPeak` raises any value below
the average up to the average. On the shipped `api` (average 620) that makes the bottom ~15% of
the track a dead zone: every position between the first step and the average reads `620`, so the
thumb appears stuck and the control appears broken. Only `0` itself stays distinct, because it is
how the field spells "not measured". **Peak memory usage / pod** has the same shape against its own average.
**Why it is not a wrong number:** the coercion is correct and deliberate — `usage.ts` raises
rather than rejects because a peak at least equal to the average is true of every distribution,
and R16 pins that behavior. The typed field shows it plainly (type `400`, watch it become `620`).
Only the *slider* misrepresents it, by offering positions that are not distinct values.
**The question:** what a slider should do over a range whose lower part is not addressable.
Raising the slider's `min` to the current average is the obvious fix and is wrong as stated: `0`
is a meaningful value on this field — it is how the editor spells "not measured" — so it must
stay reachable. Options worth weighing: say the coercion out loud in the field's existing
hint (`Optional; 0 = not measured`), which changes nothing an operator can express; leave it
altogether, since the typed field is authoritative and shows the coercion plainly; start the track
at the average and keep `0` reachable only by typing; or mark the coerced floor on the track. The
last two change what the control can express, which is why this is an owner call rather than a
CSS tweak.
**Status:** ~~open~~ settled — the hint now states the floor; the track is unchanged.

### ~~C4 — The request bars total every pod against capacity sized for only some of them~~
**RESOLVED 2026-08-21** (Session M) — settled in favour of *scoping the bar to the placeable
pods and labelling it so it says so*, which is C1's resolution taken one section lower and in
C1's own vocabulary: the section's subhead now reads `the pods that fit · 3 × node allocatable`
on a pool that has two populations, and reads exactly as before on one that does not. Dropping
the oversized pods from the numerator does not hide them — the verdict directly above still
counts them, and the density sentence R22 added still names them — so the objection that killed
this option in the entry below turns out to be answered by the labelling R22 already shipped.
Two repairs were rejected: keeping every pod in the numerator and only labelling it, which
leaves a bar reading `463%` for a pool with no failing placement left to fix; and printing both
readings as two figures, which asks the operator to reconcile a ratio the panel could have
resolved itself.
`stranded` moved with it, because the entry below is right that the choice decides what
`stranded` means. It was `capacity − everything requested`, which on this pool is
`max(0, 10.8 − 50)` = nothing stranded — a full node reported as spoken for by pods that will
never occupy it. It is now `capacity − the placeable requests` = `10.8 − 2` = 8.8 cores, which
is both the truthful figure and the one the bar beside it is now about. Leaving it unscoped
would have put a scoped bar next to an unscoped stranded readout and rebuilt the contradiction
one line lower.
The engine already knew the scoped totals but only as locals inside its pool evaluation, so the
fix is an engine, schema, and contract change as well as a UI one: `placeable_cpu_m` and
`placeable_memory_mib` are now fields on the pool result. Re-deriving them in the frontend would
have put the packer's fit test in the panel. No node number moved. Promoted to **R25** above.
Original observation kept for the record:

**Observed:** 2026-08-21 (Session J, while settling C1). In C1's own state — `api` at an 8000m
request on a 3600m-allocatable node — the **CPU** bar reads `50 cores / 10.8 cores` and
`463% requested`, a figure no node count in the pool's envelope can bring under 100%.
**Why it is not a wrong number:** the numerator is what the pool asks for, all ten pods; the
denominator is the `3 × node allocatable` the heading names, and that 3 was sized from the four
pods a node can hold. Each figure is true of what it measures, and the stranded readout beside
it is computed the same way.
**The question:** C1's question again, one section lower — whether a *ratio* may mix the two
populations. R22 labelled the node numbers and the density sentence and deliberately left the
bars alone, because the two honest repairs are not equivalent: dropping the oversized pods from
the numerator hides demand the operator has actually declared, while keeping them means the bar
reads as failure for a pool that has no failing placement left to fix. Whichever is chosen also
decides what `stranded` means beside it, which is why this is an owner call and not a wording
tweak.
**Status:** ~~open, needs owner sign-off before anything moves.~~ settled — see R25.

### ~~C5 — A slider dragged into a coerced range leaves the number box showing a rejected value~~
**RESOLVED 2026-08-21** (Session L) — settled in favour of *the box always showing what was
stored*. The number field now keeps text of its own only while it is being typed in; between
edits it reads the caller's value, so a commit the caller overrules can no longer leave a
rejected number on screen. One change in the shared component, which is why it is right for
every field that coerces: the peak's floor, the surge unit picker's conversion, and the
commit-time rounding all end the same way. Promoted to **R24** above. Three alternatives were
rejected: re-syncing the draft on every *commit* (the obvious repair, and insufficient — the
slider never commits, so the drag path would still have gone stale); raising the slider's `min`
to the average (already rejected in C3, because `0` is how the field spells "not measured");
and leaving it on the grounds that the typed field is authoritative (rejected because the typed
path was not actually sound — see below).
Two things the repair settled that the entry below left open. An operator may keep typing over a
rejected value for as long as the field has focus — nothing rewrites the box mid-entry, which
is the constraint the old effect existed to protect and which the fix keeps by construction —
but the edit ends at the stored value. And the typed path had the same defect one step further
in: typing `400` a *second* time left the box reading `400`, because the stored value did not
change and so the effect did not fire. R16 never saw it, because it types each value once.
Original observation kept for the record:

**Observed:** 2026-08-21 (Session K, while settling C3's hint and walking R16). Reset, then drag
the **Peak CPU usage / pod** slider from `0` to anywhere below the average. The thumb parks at
the average, correctly — but the number box beside it keeps the last raw drag position (`270`,
`290`, `320` across three attempts) and never catches up. Blurring the field does not clear it;
only an edit that lands on a *different* stored value does. Reproduced three times from a clean
state. The typed path is unaffected: type `400` from a cleared field and the box shows `620`,
which is what R16 walks and what the promoted test asserts.
**Why it is not a wrong number:** the stored peak is the coerced one. The slider's own `value`
reads `620` throughout, and `/v1/compare` is sent the coerced figure — every projected number on
screen is right. Only the box is stale. `NumberField` resyncs its draft from an effect keyed on
the committed value, and inside a coerced range that value never changes between drag positions,
so the effect never fires. It is a display desync in a shared field component, not a usage or
engine fault, and it predates C3's hint.
**The question:** whether a field that has just been overruled must show what was stored, and
where that belongs. Resyncing the draft on every commit is the obvious repair and touches every
number field in the editor, several of which coerce for their own reasons — so it is a change to
shared editor behavior with its own blast radius, not a fix to the peak fields. It also decides
whether an operator may keep typing over a value the model has already rejected. Worth weighing
against C3's resolution: the hint now promises `never below the average` beside a box that, on
the drag path, can read `290`.
**Status:** ~~open, needs owner sign-off before anything moves. Logged rather than fixed because
C3's task was scoped to hint text, and this is a shared-component behavior change.~~ settled —
see R24.

### C6 — Escape leaves a number field by committing what was typed, not by abandoning it
**Observed:** 2026-08-21 (Session L, while walking C5's repair). Click into **Peak CPU usage /
pod**, type `900`, press Escape. The field commits `900` — the thumb moves, the projection
recomputes, and nothing is abandoned. Reproduced on the build before this session's change too,
so it is not something the change introduced.
**Why it is not a wrong number:** the value stored is the one that was typed, and every readout
downstream of it is right. What is wrong is the promise: Escape is the key that means "forget
this", and the field's own code reads as though it does. The reason it does not is timing —
Escape blurs the field, and a blur commits, so the commit runs inside the same event as the
keystroke, before the state that would have cleared the draft has been applied.
**The question:** whether these fields should have a cancel at all, and what it costs. A working
Escape needs the commit to be told the edit was abandoned, which means a piece of state that
survives the same-event ordering — a small, deliberate addition to a component every field in the
editor shares. The cheaper answer is that a number field with a live projection under it has no
meaningful "cancel": the previous value is one more edit away, and the operator can see it. The
workload-name field is written the same way and has not been walked.
**Status:** open, needs owner sign-off before anything moves. Logged rather than fixed: this
session's task was the display desync, and Escape is a separate behavior with its own decision.

### C7 — A slider whose step cannot land on the value it coerces to parks beside a different number
**Observed:** 2026-08-22 (Session O, while promoting R24). Reset, then drag **Peak memory usage
/ pod** from `0` to a position below the 780 average. The box reads `780` — the stored value,
which is what C5's repair promises — while the thumb sits at `784`. Reproduced repeatedly, and
*not* on every drag: a drag that happens to land on `784` stores `784`, and then the two agree.
R24's expectation said they always agree at `784`, which is why that half of the row is not
automated; the row now says what actually happens instead.
**Why it is not a wrong number:** the stored peak is `780`, `/v1/compare` is sent `780`, and the
box shows `780`. Nothing computed is wrong and C5 is not back — the box no longer holds text of
its own. The `<input type="range">` is what cannot represent it: that track carries
`step={16}` from `0`, so `780` is not a position it has, and the browser snaps the thumb to the
nearest one it does. **Peak CPU usage / pod** steps in 10 and the 620 average is a multiple of
10, which is why the same drag reads cleanly there — the CPU field is not better behaved, it is
luckier.
**The question:** what a slider should show for a value its own step cannot express, and whether
this is worth anything. Four MiB is invisible on a 8192-wide track, so the thumb is not *misplaced*
— it is one step from where the value is. Options worth weighing: leave it, on the grounds that
the box is authoritative and the gap is a rendering rounding; snap the *stored* value to the
step so the two always agree, which changes what the field can hold to suit how it is drawn;
or derive `step` from the values the field must be able to land on, which is the same trade
one layer down. It is a shared-component question like C5 before it — every field with a step
and a coercing caller has it — which is why it is logged rather than fixed here.
**Status:** open, needs owner sign-off before anything moves. Logged rather than fixed: this
session's task was promotion, and R24's automated half passes on the field that is unaffected.

### C8 — A held results panel says its numbers are old only in colour
**Observed:** 2026-08-22 (Session P, while shipping R27). With **Auto** off and an edit waiting,
everything the panel says is now pale and the chip beside the heading reads `edited since last
run`. Both signals are real, and between them they are the whole message: there is no sentence
anywhere on the panel saying the reading is out of date. An operator who has scrolled down to the
node map or the Runtime risk table has left the chip behind in the header, and is looking at a
screenful of numbers whose only remaining marker is that they are a little lighter than usual.
**Why it is not a wrong number:** every figure in a held panel is a true reading of the
configuration the engine was last given, and R27 now stops the one element that asserted something
false about the screen it sits on. What is absent is a statement of *which* configuration the
numbers are about — the one thing the panel has never said in words.
**What R27 already covers**, so this is not a re-litigation of it: the fading now reaches the
whole panel body, including the `All pools` cluster-total strip that used to stay bright; the
heading, the chip, and the **Run simulation** button deliberately stay at full contrast; and the
chip states no count while a run is held. The decision left is only whether prose is needed *on
top of* those, not whether they were the right first move.
**The question:** whether the panel should carry a written "these results are out of date" line.
It is the only option that survives a scroll and the only one that works without colour, which is
why it is worth asking — but it is a new element, and where it sits changes what it does. Options
worth weighing: put it in the run bar beside **Run simulation**, the one strip that stays bright
and holds the control that fixes it, at the cost of crowding a bar that is already a toggle and a
button; put it at the top of the results body, where it is with the numbers it is about but
scrolls away with them exactly as the chip does; or leave it, on the grounds that a faded panel,
an amber chip, and a live Run button are three signals already and a fourth is noise. The wording
is the real content of the decision and it is not a CSS choice, which is why this is logged rather
than fixed.
**Adjacent, observed and also not fixed:** `ExportModal` is handed `config={candidate}` while the
panel beside it renders `submitted`. Press **Export** from a held panel and the saved scenario is
the *edited* configuration, while the numbers that were printed beside it when it was saved are
the previous run's. Load that scenario back and it evaluates to different figures than the ones
the operator was reading when they saved it. Nothing in the export is wrong on its own terms — it
saves a configuration, and the candidate is the configuration — but it is this same desync one
layer over, and it needs the same owner call: export what was run, export the candidate and label
it, or refuse to export while a run is held. R14 pins the round-trip and passes, because it never
holds a run.
**Status:** open, needs owner sign-off before anything moves. Logged rather than fixed: this
session's task was to make the designed fading render and to stop the chip asserting a count about
a previous run. A new element with wording and placement, and a second desync at the export
boundary, are each their own decision.

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
importer derives a single default pool. F3 and F5 are saved kcap scenarios, not exports. F1 and F2
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

### F5 — A per-container breakdown whose containers both borrow CPU

A saved scenario, not a cluster export, so it commits with **Replace configuration**.
`web/payments` carries a two-container breakdown with peaks: `app` peaks at `1700m` against a
`500m` request, and the injected-style `istio-proxy` peaks at `300m` against `19m`. Both
borrow, so the expansion shows two rows for one workload. `worker` has no peak at all, which is
what produces the avg-fallback basis note beside them.

```json
{"kind":"kcap-scenario","version":3,"exported_at":"2026-08-21T00:00:00.000Z","config":{
 "workloads":{
  "web/payments":{"name":"web/payments","current_replicas":6,"pool":"primary",
   "resources":{"cpu_request_m":750,"memory_request_mib":1024,
    "cpu_limit_m":2000,"memory_limit_mib":2048},
   "observed_cpu_per_pod":{"avg":620,"p95":null,"peak":2000},
   "observed_memory_per_pod":{"avg":780,"p95":null,"peak":null},
   "usage_window_seconds":60,"usage_source":"metrics-server-samples",
   "containers":[
    {"name":"app","cpu_request_m":500,"memory_request_mib":768,"cpu_limit_m":1500,
     "memory_limit_mib":1536,"observed_memory":null,
     "observed_cpu":{"avg":500,"p95":null,"peak":1700}},
    {"name":"istio-proxy","cpu_request_m":19,"memory_request_mib":128,"cpu_limit_m":null,
     "memory_limit_mib":null,"observed_memory":null,
     "observed_cpu":{"avg":120,"p95":null,"peak":300}}],
   "hpa":{"min_replicas":3,"max_replicas":18,
    "cpu_target_percentage":70,"memory_target_percentage":75},
   "rollout":{"max_surge_percent":25,"max_surge_pods":null}},
  "worker":{"name":"worker","current_replicas":4,"pool":"primary","containers":null,
   "resources":{"cpu_request_m":500,"memory_request_mib":768,
    "cpu_limit_m":1500,"memory_limit_mib":1536},
   "observed_cpu_per_pod":{"avg":310,"p95":null,"peak":null},
   "observed_memory_per_pod":{"avg":520,"p95":null,"peak":null},
   "usage_window_seconds":0,"usage_source":"metrics-server-snapshot",
   "hpa":{"min_replicas":2,"max_replicas":12,
    "cpu_target_percentage":70,"memory_target_percentage":null},
   "rollout":{"max_surge_percent":25,"max_surge_pods":null}}},
 "node_pools":{"primary":{"name":"primary","min_nodes":3,"current_nodes":6,"max_nodes":20,
  "machine":{"cpu_m":4000,"memory_mib":16384,"reserved_cpu_m":400,
   "reserved_memory_mib":1536,"max_pods":110}}}}}
```
