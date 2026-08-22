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
    await this.editorCaughtUp(this.workload(name), /(\d+) pods/, 'Current replicas')
  }

  async selectNodePool(name: string): Promise<void> {
    await this.nodePool(name).click()
    await expect(this.page.getByRole('heading', { level: 2, name })).toBeVisible()
    await this.editorCaughtUp(this.nodePool(name), /(\d+) nodes/, 'Current nodes')
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
    return (await this.page.getByText(/ · \d+ workloads$/).innerText()).trim()
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

  /** The pod count printed inside a scenario tab, as the operator reads it. */
  async podCount(label: string): Promise<number> {
    const reading = await this.scenarioTab(label).getByText(/^\d+ pods$/).innerText()
    return Number.parseInt(reading, 10)
  }

  /**
   * The CA-action tile beside the verdict, read as one line: `−3 nodes`,
   * `+2 nodes`, `Hold steady`, `None no fix`, `None no demand`.
   * (The minus is U+2212, not a hyphen — that is what the tile prints.)
   */
  async caAction(): Promise<string> {
    const tile = await this.page.getByRole('group', { name: 'CA action' }).innerText()
    return tile.replace(/\s+/g, ' ').replace(/^CA action /, '').trim()
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
