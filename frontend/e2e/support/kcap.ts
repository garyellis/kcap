import { expect, type Locator, type Page } from '@playwright/test'
import type { Traffic } from './traffic'

/**
 * Selector policy for this suite — stated once here, followed everywhere.
 *
 * 1. **Address the app the way an operator does.** `getByRole`, `getByLabel`,
 *    `getByText`. No CSS, no XPath, no `data-testid`. A promoted test should read
 *    almost word for word like the manual scenario it came from, so that a human
 *    holding both can see they pin the same thing.
 *
 * 2. **Assert what the screen says, not what the app knows.** Never reach into
 *    React state or call the API to check a result. If the scenario says the field
 *    reads `1 pods`, the assertion reads the field. The whole reason
 *    `docs/ui-regression-scenarios.md` exists is to catch a correct engine wired to
 *    a wrong readout, and a test that queries the engine is blind to exactly that.
 *
 * 3. **If a control has no accessible name, fix the app, don't tag it.** Two
 *    controls needed naming for this suite — the import paste box, which is an
 *    unlabelled `<textarea>`, and the CA-action tile, whose label and value were
 *    unassociated siblings. Both were named with ARIA rather than a `data-testid`,
 *    because a name helps everyone using a screen reader and a test id helps only
 *    the test. Both changes are commented at their call sites. A `data-testid` is
 *    the last resort, is a UI change like any other, and must be justified.
 *
 * 4. **Anchor names at the start.** kcap composes accessible names out of stacked
 *    block elements, so a scenario tab is named `Rollout 31 pods` and a spinbutton
 *    carries its unit and hint. Matching on a `^prefix` keeps a locator from
 *    breaking every time the number beside the label moves — which, in a capacity
 *    simulator, is constantly.
 *
 * 5. **Counts agree with their nouns**, so every locator that matches a count
 *    matches the singular too: `pods?`, `nodes?`, `changes?`. One that knows
 *    only the plural fails as "element not found" the day a fixture reaches
 *    one, which reads as an unrelated breakage rather than a wrong value.
 */
export class Kcap {
  readonly page: Page
  readonly traffic: Traffic

  /** The connection pill, top right. Reads `Live`, `Calculating`, or `Engine offline`. */
  readonly connectionPill: Locator
  /** The `N changes` chip beside the Capacity projection heading. */
  readonly changeChip: Locator
  /** The import dialog, once opened. */
  readonly importDialog: Locator
  /**
   * One entry per `Heads up.` callout in the import dialog. Playwright's text
   * engine returns the deepest match, so this counts the callouts an operator
   * would count on screen, not their bodies.
   */
  readonly importWarnings: Locator

  constructor(page: Page, traffic: Traffic) {
    this.page = page
    this.traffic = traffic
    // `exact` is load-bearing: the results panel's eyebrow reads `Live impact`, and
    // a substring match would find both. The pill's own text is exactly `Live`.
    this.connectionPill = page.getByText('Live', { exact: true })
    this.changeChip = page.getByText(/^\d+ changes?$/)
    this.importDialog = page.getByRole('dialog', { name: 'Import' })
    this.importWarnings = this.importDialog.getByText('Heads up.', { exact: true })
  }

  /** Load the app on its shipped defaults and wait for the engine to answer. */
  async open(): Promise<void> {
    await this.page.goto('/')
    await expect(this.connectionPill).toBeVisible()
  }

  /**
   * Press Reset at the top of the Configuration panel — the checklist's own
   * "between scenarios" gesture. A test that presses it mid-scenario is making
   * the claim the row makes: the readout it is about goes back to what an
   * untouched configuration shows.
   */
  async reset(): Promise<void> {
    const mark = this.traffic.mark()
    await this.page.getByRole('button', { name: 'Reset', exact: true }).click()
    await this.settled(mark)
  }

  // --- the configuration catalog -------------------------------------------

  /** The catalog button for a workload, named `api 6 pods · 750m · 1 GiB` on screen. */
  workload(name: string): Locator {
    return this.page.getByRole('button', { name: startingWith(name) })
  }

  /**
   * The catalog button for a node pool, named `primary 6 nodes · 4 · 16 GiB`.
   * The same control as a workload entry — one catalog, two groups — so it is
   * addressed the same way; only the editor it opens differs.
   */
  nodePool(name: string): Locator {
    return this.page.getByRole('button', { name: startingWith(name) })
  }

  async selectWorkload(name: string): Promise<void> {
    await this.workload(name).click()
    // The editor heading is how an operator confirms which workload they are on.
    await expect(this.page.getByRole('heading', { level: 2, name })).toBeVisible()
    await this.editorCaughtUp(this.workload(name), /(\d+) pods?/, 'Current replicas')
  }

  async selectNodePool(name: string): Promise<void> {
    await this.nodePool(name).click()
    await expect(this.page.getByRole('heading', { level: 2, name })).toBeVisible()
    await this.editorCaughtUp(this.nodePool(name), /(\d+) nodes?/, 'Current nodes')
  }

  /**
   * Wait for the editor's fields to catch up with the catalog entry that opened
   * them.
   *
   * kcap's number fields hold a draft copy of the value they show and sync it in
   * an effect, which lands one render *after* the heading changes — so for one
   * render the editor prints the previous selection's numbers under the new
   * selection's name. A human never sees it; a test that reads a value the
   * instant the heading appears does, and R14 caught exactly that under a loaded
   * parallel run. The catalog entry prints the same number the field does, so
   * their agreeing is the screen's own "this editor is the thing you clicked".
   */
  private async editorCaughtUp(entry: Locator, summary: RegExp, label: string): Promise<void> {
    const line = (await entry.innerText()).replace(/\s+/g, ' ')
    const match = summary.exec(line)
    expect(match, `the catalog entry "${line}" no longer prints ${label}`).not.toBeNull()
    await expect(this.field(label), `the editor still shows the previous selection's ${label}`).toHaveValue(
      match?.[1] ?? '',
    )
  }

  /**
   * The topbar's one-line summary of the configuration: `primary · 2 workloads`
   * — the pool name (or `N node pools`) and the workload count. It is how an
   * operator sees at a glance that nothing was gained or lost.
   */
  async configurationSummary(): Promise<string> {
    // Anchored at the end so the match is the summary line itself rather than
    // the whole header, which carries the buttons and the connection pill too.
    return (await this.page.getByText(/ · \d+ workloads?$/).innerText()).trim()
  }

  // --- the workload editor --------------------------------------------------

  /** A numeric editor field, addressed by the label printed above it. */
  field(label: string): Locator {
    return this.page.getByRole('spinbutton', { name: startingWith(label) })
  }

  /**
   * Type a value and commit it. kcap's number fields commit on blur or Enter —
   * typing alone changes nothing, exactly as the checklist's "blur the field" says.
   * Returns once the projection on screen answers the edit.
   */
  async setField(label: string, value: number): Promise<void> {
    // kcap only emits a change when the committed value differs, so setting a
    // field to what it already holds sends nothing and `settled` would sit there
    // blaming the engine. Say what actually happened instead.
    const current = await this.field(label).inputValue()
    expect(current, `${label} already reads ${current}, so this edit changes nothing`).not.toBe(String(value))

    const mark = this.traffic.mark()
    await this.field(label).fill(String(value))
    await this.field(label).blur()
    await this.settled(mark)
  }

  /**
   * Type a value and commit it, without assuming the model keeps what was
   * typed.
   *
   * `setField` waits for the edit to reach the engine, which a value the model
   * overrules back onto the one already stored never does — nothing changed, so
   * nothing is sent. R24 is exactly that: typing `400` into a peak that floors
   * at the average, twice in a row, where the second attempt is the one that
   * matters.
   */
  async proposeField(label: string, value: number): Promise<void> {
    await this.field(label).fill(String(value))
    await this.field(label).press('Enter')
    await this.quiet()
  }

  /**
   * The slider beside a numeric field. `NumberField` names it `<label> slider`,
   * which is the app's own accessible name and not a hook added for this suite.
   */
  slider(label: string): Locator {
    return this.page.getByRole('slider', { name: `${label} slider` })
  }

  /**
   * Drag a field's slider to a fraction of its track and release it, pressing
   * at wherever the thumb currently sits.
   *
   * The gesture matters, not just the resulting value: the slider commits
   * through `onChange` and never blurs, which is the path C5's stale readout
   * survived on while the typed path looked fine. A test that types cannot see
   * it — that is why R24's row asks for a drag by name.
   */
  async dragSlider(label: string, toFraction: number): Promise<void> {
    const slider = this.slider(label)
    const track = await slider.boundingBox()
    expect(track, `the ${label} field has no slider to drag`).not.toBeNull()
    if (track === null) return

    const min = Number(await slider.getAttribute('min'))
    const max = Number(await slider.getAttribute('max'))
    const from = (Number(await slider.inputValue()) - min) / (max - min)
    const y = track.y + track.height / 2
    const alongTrack = (fraction: number) => track.x + track.width * fraction

    await this.page.mouse.move(alongTrack(from), y)
    await this.page.mouse.down()
    // Stepped, so the field sees the positions a hand passes through rather than
    // only the one it lands on.
    await this.page.mouse.move(alongTrack(toFraction), y, { steps: 8 })
    await this.page.mouse.up()
    // Not `settled`: a drag that ends inside a coerced range stores the value
    // already held, which changes no configuration and sends no request.
    await this.quiet()
  }

  /**
   * Flip a labelled switch — `CPU limit`, `Memory limit`, `HPA`. Asserts it was
   * in the other position first, so a scenario that silently toggled nothing
   * fails here rather than three assertions later.
   */
  async setToggle(label: string, on: boolean): Promise<void> {
    const toggle = this.page.getByRole('switch', { name: startingWith(label) })
    await expect(toggle, `${label} is already ${on ? 'on' : 'off'}`).toHaveAttribute('aria-checked', String(!on))
    const mark = this.traffic.mark()
    await toggle.click()
    await this.settled(mark)
  }

  /** The `Rollout max surge` value and its `%` / `pods` unit picker. */
  get surge(): Locator {
    return this.field('Rollout max surge')
  }

  get surgeUnit(): Locator {
    return this.page.getByRole('combobox', { name: 'Rollout max surge unit' })
  }

  /** Switch the surge unit. The value converts, so this is an edit, not a view change. */
  async setSurgeUnit(unit: '%' | 'pods'): Promise<void> {
    const mark = this.traffic.mark()
    await this.surgeUnit.selectOption(unit)
    await this.settled(mark)
  }

  // --- the capacity projection ----------------------------------------------

  /** A scenario tab: `HPA min`, `Current`, `Desired`, `HPA max`, `Rollout`. */
  scenarioTab(label: string): Locator {
    return this.page
      .getByRole('navigation', { name: 'Capacity scenario' })
      .getByRole('button', { name: startingWith(label) })
  }

  /**
   * Switch to a scenario tab. Every scenario arrives in one result, so this is
   * a client-side switch with no round trip of its own — the assertions that
   * follow are what prove the tab took.
   */
  async selectScenario(label: string): Promise<void> {
    await this.scenarioTab(label).click()
    await this.quiet()
  }

  /** The pod count printed inside a scenario tab, as the operator reads it. */
  async podCount(label: string): Promise<number> {
    const reading = await this.scenarioTab(label).getByText(/^\d+ pods?$/).innerText()
    return Number.parseInt(reading, 10)
  }

  /**
   * The CA-action tile beside the verdict, read as one line: `−3 nodes`,
   * `+2 nodes`, `+1 node`, `Hold steady`, `None no fix`, `None no demand`.
   * (The minus is U+2212, not a hyphen — that is what the tile prints.)
   */
  async caAction(): Promise<string> {
    return this.tileReading('CA action')
  }

  /**
   * A labelled tile of the results panel, read as the one line it is:
   * `1 nodes for the pods that fit`, `None no pods in scenario`, `−3 nodes`,
   * `Unbounded all pools`.
   *
   * Covers the four metric tiles (`Placement`, `Effective target`, `Headroom`,
   * `Constraint`), the CA-action tile, and the two runtime-limit totals. Every
   * one of them printed its label, its number, and the small line under it as
   * loose siblings, so a screen reader ran one tile straight into the next and
   * neither this suite nor a person navigating by group could address one. They
   * are now `role="group"` named from the label already on screen — an ARIA fix
   * rather than a test id, on the CA-action tile's precedent, and walked in the
   * browser as the UI change it is.
   *
   * The number and the note under it are read together on purpose: the note
   * says which pods that number is about, so a test that took the number alone
   * would stay green while the panel attributed it to the wrong population.
   *
   * `innerText`, so a chip uppercased in CSS reads as the operator sees it.
   */
  async tileReading(label: string): Promise<string> {
    const tile = await this.page.getByRole('group', { name: label, exact: true }).innerText()
    return tile.replace(/\s+/g, ' ').replace(new RegExp(`^${label} `), '').trim()
  }

  /**
   * One bar of the Request saturation section, `CPU` or `Memory`, read as one
   * line: `2 cores / 10.8 cores 19% requested · 81% (8.8 cores) stranded at
   * this pod shape`. A bar is a tile of the same kind and took the same
   * grouping fix; it is named separately because R25 needs both halves at once
   * — the ratio and the stranded figure beside it divide by the same capacity
   * and are only right or wrong as a pair.
   */
  async requestBarReading(label: string): Promise<string> {
    return this.tileReading(label)
  }

  /**
   * The Request saturation subhead: `3 × node allocatable` on an ordinary pool,
   * `the pods that fit · 3 × node allocatable` where the pool holds pods no
   * node can take. Anchored at the end, so it is the subhead itself that
   * matches and not the section around it.
   */
  get saturationSubhead(): Locator {
    return this.page.getByText(/× node allocatable$/)
  }

  /**
   * The paragraph under the saturation bars. Absent entirely when no pod fits a
   * node at all — there is no per-node figure to print — which is a reading in
   * its own right, so callers assert its count.
   */
  get densityNote(): Locator {
    return this.page.getByText(/^Provisioned capacity, not the live pool\./)
  }

  /**
   * The verdict paragraph a pool blocked by pods no node can hold prints:
   * `6 pods request more than one whole node. No node count places them. Their
   * 48 cores of CPU and 6 GiB of memory are left out of the node sizing below.`
   * Absent on any other pool, so its count is itself a reading. The match is
   * anchored at the opening count and left open at the end, so the sentence
   * naming the excluded demand may grow or reword without unhooking the
   * scenarios that only read the count.
   */
  get oversizedVerdict(): Locator {
    // Anchored at the count: the density paragraph names the same population in
    // the same words further down the panel, and an unanchored match finds both.
    return this.page.getByText(/^\d+ pods? requests? more than one whole node\./)
  }

  // --- runtime risk ---------------------------------------------------------

  /**
   * The Runtime risk section of the results panel.
   *
   * A landmark named by its own visible heading — the section had no accessible
   * name until this suite needed one, which is a real gap for anyone navigating
   * by region, so it was fixed with `aria-labelledby` rather than a test id.
   */
  get runtimeRisk(): Locator {
    return this.page.getByRole('region', { name: 'Runtime risk' })
  }

  /**
   * One finding chip, addressed by the class it reports: `Borrowed CPU`,
   * `Node exhaustible`, `Unlimited memory`. The chip carries a live count, so
   * the match is anchored at the label — and the text engine returns the
   * deepest match, which is the chip rather than the summary around it.
   */
  riskChip(label: string): Locator {
    return this.runtimeRisk.getByText(startingWith(label))
  }

  /** Open a finding's panel. Native `<details>`, so clicking the chip is the whole gesture. */
  async expandRisk(label: string): Promise<void> {
    await this.riskChip(label).click()
  }

  /** One row of the contention table, addressed by the workload it names. */
  contentionRow(workload: string): Locator {
    return this.runtimeRisk.getByRole('row').filter({ hasText: workload })
  }

  // --- import and export ----------------------------------------------------

  async openImport(): Promise<void> {
    await this.page.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(this.importDialog).toBeVisible()
  }

  /** Paste a document into the Step 2 box. Parsing is debounced, so callers assert on the preview. */
  async pasteImport(document: string): Promise<void> {
    await this.importDialog.getByLabel('Paste or upload the export').fill(document)
  }

  /** Pick `Merge` or `Replace` in the Step 3 mode picker. Cluster exports only; the default is Merge. */
  async chooseImportMode(mode: 'Merge' | 'Replace'): Promise<void> {
    await this.importDialog
      .getByRole('navigation', { name: 'Import mode' })
      .getByRole('button', { name: startingWith(mode) })
      .click()
  }

  /** The Step 3 commit button, whatever it currently offers to do. */
  commitButton(label: string): Locator {
    return this.importDialog.getByRole('button', { name: label, exact: true })
  }

  async commitImport(label: string): Promise<void> {
    await this.commitButton(label).click()
    await expect(this.importDialog).toBeHidden()
    // Committing is *two* round trips: the dialog validates through
    // `/v1/evaluate`, and applying the result re-baselines the config, which
    // schedules a fresh `/v1/compare`. Waiting only for the first would leave
    // that compare in flight for the next edit to abort. The pill covers both —
    // it goes to `Calculating` as soon as the config is applied.
    await this.quiet()
  }

  /**
   * Open Export, read the JSON off the screen, and close again.
   *
   * This is the one place the suite parses a blob, and it is not a shortcut around
   * the UI: R19's whole point is that per-container detail has no readout, so the
   * exported scenario *is* the readout. The text is taken from the modal an
   * operator reads, not from an API call.
   */
  async exportedScenarioText(): Promise<string> {
    await this.page.getByRole('button', { name: 'Export', exact: true }).click()
    const dialog = this.page.getByRole('dialog', { name: 'Export scenario' })
    // `textContent`, not `innerText`: the latter is CSS-dependent, and this block
    // wraps and scrolls. For something about to be JSON-parsed, take the text.
    const json = await dialog.getByText(/"kind": "kcap-scenario"/).textContent()
    expect(json, 'the Export dialog showed no scenario JSON').not.toBeNull()
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()
    return json ?? ''
  }

  async exportedScenario(): Promise<ExportedScenario> {
    return JSON.parse(await this.exportedScenarioText()) as ExportedScenario
  }

  // --- settling -------------------------------------------------------------

  /**
   * Wait until the screen has caught up with every edit made since `mark`.
   *
   * Two steps, because the network and the screen are not the same thing:
   *
   * 1. A request for this edit went out and came back (`Traffic.isSettled`).
   * 2. The pill reads `Live` again. kcap flips it to `Calculating` the instant a
   *    config changes and back to `Live` in the *same* React update that renders
   *    the new projection, so this is the app's own "the numbers on screen are
   *    current" signal — the one a human waits for before reading a tab.
   *
   * Step 1 is what makes step 2 trustworthy: immediately after a blur the pill can
   * still read `Live` from the previous answer, so waiting on it alone could pass
   * before the edit had gone anywhere.
   */
  async settled(mark: number): Promise<void> {
    await expect
      .poll(() => this.traffic.isSettled(mark), {
        message: 'the edit never reached the engine, or a request is still in flight',
      })
      .toBe(true)
    await expect(this.connectionPill, 'the pill never returned to Live after the edit').toBeVisible()
  }

  /**
   * Wait for the screen to be current without naming a particular edit: the pill
   * reads `Live` and nothing is outstanding. Use this after an action whose
   * round trips are not one-to-one with the click that started them.
   */
  async quiet(): Promise<void> {
    await expect(this.connectionPill, 'the pill never returned to Live').toBeVisible()
    await expect.poll(() => this.traffic.isIdle(), { message: 'an engine call is still in flight' }).toBe(true)
  }
}

/** The slice of an exported scenario the promoted scenarios assert on. */
export type ExportedScenario = {
  config: {
    workloads: Record<
      string,
      {
        resources: { cpu_request_m: number }
        observed_cpu_per_pod: { avg: number } | null
        containers: ExportedContainer[] | null
      }
    >
  }
}

/** One entry of a workload's per-container breakdown, as the export writes it. */
export type ExportedContainer = {
  name: string
  observed_cpu: { avg: number } | null
}

/**
 * Accessible names in kcap carry live numbers (`api 6 pods · 750m · 1 GiB`), so
 * locators match on the stable prefix. Regex-escaped, because labels are prose.
 */
function startingWith(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
}
