import { test, expect } from './support/fixture'
import { checklistFixture } from './support/checklist'
import type { ExportedContainer, ExportedScenario, Kcap } from './support/kcap'

/** Promoted from the "Import" group of `docs/ui-regression-scenarios.md`. */
test.describe('Import', () => {
  /** Press Import, paste a cluster export, and commit it with `Replace workloads`. */
  async function importClusterExport(kcap: Kcap, id: 'F1' | 'F2' | 'F4'): Promise<void> {
    await kcap.openImport()
    await kcap.pasteImport(checklistFixture(id))
    await kcap.chooseImportMode('Replace')
    await kcap.commitImport('Replace workloads')
  }

  test('R11 — a Guaranteed pod with a native sidecar imports cleanly', async ({ kcap }) => {
    await kcap.open()
    await importClusterExport(kcap, 'F1')

    await kcap.selectWorkload('demo/web')

    // 500 + 100 on both sides. The bug this pins counted the native sidecar toward
    // the pod request but not the pod limit, so the import hit the engine's
    // `request > limit` 422 and could not be fixed from the dialog.
    await expect(kcap.field('CPU request')).toHaveValue('600')
    await expect(kcap.field('CPU limit value')).toHaveValue('600')
    await expect(kcap.field('Memory request')).toHaveValue('640')
    await expect(kcap.field('Memory limit value')).toHaveValue('640')

    // "The evaluation is Live, and no 422 appears" needs no assertion here:
    // `commitImport` does not return until the pill reads `Live` again, and the
    // fixture fails the test on any non-2xx engine call. An `expect(pill)` at this
    // point would be satisfied by the `Live` that was already on screen before the
    // import, and would prove nothing.
  })

  test('R12 — an absolute maxSurge survives the import', async ({ kcap }) => {
    await kcap.open()
    await importClusterExport(kcap, 'F1') // F1 carries `maxSurge: 1`

    await kcap.selectWorkload('demo/web')

    // `pods`, not a percentage of current replicas — and derived from the imported
    // config rather than stored beside it.
    await expect(kcap.surgeUnit).toHaveValue('pods')
    await expect(kcap.surge).toHaveValue('1')
  })

  test('R13 — same-named workloads of different kinds both survive', async ({ kcap }) => {
    await kcap.open()

    await kcap.openImport()
    await kcap.pasteImport(checklistFixture('F2'))

    await expect(kcap.importWarnings).toHaveCount(1)
    await expect(kcap.importDialog).toContainText(
      'demo/web exists as Deployment and StatefulSet — imported as separate workloads with the kind appended.',
    )

    await kcap.chooseImportMode('Replace')
    await kcap.commitImport('Replace workloads')

    await expect(kcap.workload('demo/web (deployment)')).toBeVisible()
    await expect(kcap.workload('demo/web (statefulset)')).toBeVisible()
  })

  test('R17 — a scenario from any other version is refused, not guessed at', async ({ kcap }) => {
    await kcap.open()

    const version2 = checklistFixture('F3')
    const version999 = version2.replace('"version":2', '"version":999')
    expect(version999, 'F3 no longer carries the version this scenario edits').toContain('"version":999')

    // The control case. Every assertion below is that the commit button is
    // *absent*, which would also hold if its label were reworded and the locator
    // silently stopped matching — the version gate could then be wide open with
    // this test still green. So first prove the locator finds a real button, using
    // the app's own export, which is a version-3 scenario by construction.
    const version3 = await kcap.exportedScenarioText()
    await kcap.openImport()
    await kcap.pasteImport(version3)
    await expect(kcap.commitButton('Replace configuration')).toBeVisible()

    for (const [document, message] of [
      [version2, 'Cannot import. Unsupported kcap-scenario version 2 — expected 3.'],
      [version999, 'Cannot import. Unsupported kcap-scenario version 999 — expected 3.'],
    ]) {
      await kcap.pasteImport(document)

      // The refusal has to be legible in the dialog rather than arriving later as a
      // downstream 422 — there is no upgrade path, so version 3 is the only one
      // that loads.
      await expect(kcap.importDialog.getByText(message)).toBeVisible()
      await expect(kcap.commitButton('Replace configuration')).toHaveCount(0)
    }

    await kcap.importDialog.getByRole('button', { name: 'Close' }).click()

    // The configuration behind the dialog is untouched in both cases. The catalog
    // is rendered straight from the candidate config, so F3's `legacy` and `idle`
    // being absent is the assertion that actually bites — the change chip is
    // derived from the last engine answer and would read `0 changes` for a moment
    // even if something had landed.
    await expect(kcap.workload('api')).toBeVisible()
    await expect(kcap.workload('worker')).toBeVisible()
    await expect(kcap.workload('legacy')).toHaveCount(0)
    await expect(kcap.workload('idle')).toHaveCount(0)
    await expect(kcap.changeChip).toHaveText('0 changes')
  })

  test('R18 — per-container detail arrives, or the dialog says why it did not', async ({ kcap }) => {
    await kcap.open()

    await kcap.openImport()
    await kcap.pasteImport(checklistFixture('F4'))

    // F4 mixes one workload whose containers are named with one whose are not.
    // Per-container detail has no readout of its own, so a silent `containers:
    // null` would look exactly like a successful import — these two lines in the
    // dialog are the only place the screen can say it happened.
    await expect(kcap.importWarnings).toHaveCount(1)
    await expect(kcap.importDialog).toContainText(
      'Containers in this export carry no names, so these workloads imported pod-level only: demo/legacy.',
    )

    // The two notes: the point-in-time one, which F4 earns by carrying a single
    // sample, and the new one naming a container no pod spec declares. Their
    // *count* is deliberately not asserted — a note is a paragraph with no role
    // and no accessible name, so counting them would take a CSS class, which the
    // selector policy in support/kcap.ts rules out. Both sentences being on
    // screen is what the operator reads; the warning above is counted because a
    // `Heads up.` callout announces itself.
    await expect(kcap.importDialog).toContainText(
      'Observed per-pod usage is a point-in-time average from pod metrics captured at export time.',
    )
    await expect(kcap.importDialog).toContainText(
      'Pod metrics report containers no pod spec declares (istio-proxy).',
    )

    await kcap.chooseImportMode('Replace')
    await kcap.commitImport('Replace workloads')

    // Both workloads still import — a missing container name costs the breakdown,
    // never the pod-level numbers.
    await kcap.selectWorkload('demo/web')
    await expect(kcap.field('CPU request')).toHaveValue('250')
    await expect(kcap.field('CPU limit value')).toHaveValue('500')
    // 300 + 210: the injected proxy's usage counts toward the pod even though the
    // spec declares no container for it.
    await expect(kcap.field('Average CPU usage / pod')).toHaveValue('510')

    await kcap.selectWorkload('demo/legacy')
    await expect(kcap.field('CPU request')).toHaveValue('100')

    // From here the test reads JSON, on R19's justification and only for the
    // breakdown: per-container detail has no readout, so the exported scenario
    // *is* what the operator reads for it. The text comes off the Export modal.
    const savedText = await kcap.exportedScenarioText()
    const saved = JSON.parse(savedText) as ExportedScenario
    expect(container(saved, 'demo/web', 'app')?.observed_cpu?.avg).toBe(300)
    expect(saved.config.workloads['demo/legacy'].containers).toBeNull()

    // Straight back through Import, which is the half that proves the field
    // survives save/load rather than merely surviving the import. A 422 from the
    // engine would fail the test through the fixture's traffic guard.
    await kcap.openImport()
    await kcap.pasteImport(savedText)
    await kcap.commitImport('Replace configuration')

    await expect(kcap.changeChip).toHaveText('0 changes')
    const reloaded = await kcap.exportedScenario()
    expect(container(reloaded, 'demo/web', 'app')?.observed_cpu?.avg).toBe(300)
    expect(reloaded.config.workloads['demo/legacy'].containers).toBeNull()
  })

  /** One named entry of a workload's exported breakdown, or null if it has none. */
  function container(scenario: ExportedScenario, workload: string, name: string): ExportedContainer | null {
    const entries = scenario.config.workloads[workload]?.containers ?? []
    return entries.find((entry) => entry.name === name) ?? null
  }

  test.describe('R19 — a pod-level edit drops the breakdown it just contradicted', () => {
    /**
     * F4 gives `demo/web` a named container (so it imports with a breakdown) and
     * `demo/legacy` nameless ones (so it never had one). Per-container detail has
     * no readout of its own, so the exported scenario is the only place a stale
     * breakdown could show — see `Kcap.exportedScenario`.
     */
    async function importF4AndSelectWeb(kcap: Kcap): Promise<void> {
      await kcap.open()
      await importClusterExport(kcap, 'F4')
      await kcap.selectWorkload('demo/web')

      const imported = await kcap.exportedScenario()
      // Assert the export's shape before asserting anything about its contents.
      // Without this, `workloads['demo/web']?.containers` would be `undefined` if
      // the workload vanished — and `undefined` is not null, so every "the
      // breakdown survived" check below would pass on an export that lost it.
      expect(Object.keys(imported.config.workloads).sort()).toEqual(['demo/legacy', 'demo/web'])
      expect(imported.config.workloads['demo/web'].containers).toEqual(expect.any(Array))
      expect(imported.config.workloads['demo/legacy'].containers).toBeNull()
    }

    test('a CPU request edit clears it', async ({ kcap }) => {
      await importF4AndSelectWeb(kcap)

      await kcap.setField('CPU request', 500)

      const exported = await kcap.exportedScenario()
      expect(exported.config.workloads['demo/web'].resources.cpu_request_m).toBe(500)
      expect(exported.config.workloads['demo/web'].containers).toBeNull()
      expect(exported.config.workloads['demo/legacy'].containers).toBeNull()
    })

    test('an observed-usage edit clears it', async ({ kcap }) => {
      await importF4AndSelectWeb(kcap)

      await kcap.setField('Average CPU usage / pod', 900)

      const exported = await kcap.exportedScenario()
      expect(exported.config.workloads['demo/web'].observed_cpu_per_pod?.avg).toBe(900)
      expect(exported.config.workloads['demo/web'].containers).toBeNull()
    })

    test('an edit that does not describe the pod leaves it intact', async ({ kcap }) => {
      await importF4AndSelectWeb(kcap)

      await kcap.setField('Current replicas', 5)

      const exported = await kcap.exportedScenario()
      expect(exported.config.workloads['demo/web'].containers).toEqual(expect.any(Array))
    })
  })

  /**
   * Every field a workload editor can show. Read as a set rather than one by one
   * so that a round-trip which loses a *field* — a limit toggled off, an HPA
   * dropped — fails as loudly as one that loses a value; see `fieldsOnScreen`.
   */
  const WORKLOAD_FIELDS = [
    'Current replicas',
    'Average CPU usage / pod',
    'Average memory usage / pod',
    'Peak CPU usage / pod',
    'Peak memory usage / pod',
    'Rollout max surge',
    'CPU request',
    'CPU limit value',
    'Memory request',
    'Memory limit value',
    'Minimum replicas',
    'Replica ceiling',
    'CPU target',
    'Memory target',
  ]

  /** Every field a node pool editor can show. */
  const POOL_FIELDS = [
    'Node CPU',
    'Node memory',
    'Reserved CPU',
    'Reserved memory',
    'Minimum nodes',
    'Current nodes',
    'Maximum nodes',
    'Maximum pods',
  ]

  /** What the labelled fields read right now, for whichever editor is open. */
  async function fieldsOnScreen(kcap: Kcap, labels: string[]): Promise<Record<string, string>> {
    const readout: Record<string, string> = {}
    for (const label of labels) {
      // A field behind an off toggle is not on screen at all — `CPU limit value`
      // when the CPU limit is off, the HPA fields when the HPA is. Recording that
      // as a reading of its own is the point: a round-trip that came back without
      // an HPA would otherwise just have fewer fields to compare, and pass.
      readout[label] = (await kcap.field(label).count()) === 0 ? 'not shown' : await kcap.field(label).inputValue()
    }
    return readout
  }

  /**
   * Everything R14 says has to come back: every workload, the pool, and the surge
   * field — read off the fields an operator reads, not off the JSON that carried
   * them. The reading is compared against itself before and after the round trip,
   * because the claim is that save/load changes nothing, not that the shipped
   * defaults hold any particular number.
   */
  async function configurationOnScreen(kcap: Kcap): Promise<Record<string, unknown>> {
    const readout: Record<string, unknown> = {
      // Catches a workload the round trip dropped *or* invented; the loop below
      // only ever looks at the two it is told to select.
      summary: await kcap.configurationSummary(),
    }
    for (const name of ['api', 'worker']) {
      await kcap.selectWorkload(name)
      readout[name] = {
        ...(await fieldsOnScreen(kcap, WORKLOAD_FIELDS)),
        // The unit picker beside the surge value. Derived from the config rather
        // than stored, which is exactly what makes it losable.
        'Rollout max surge unit': await kcap.surgeUnit.inputValue(),
      }
    }
    await kcap.selectNodePool('primary')
    readout.primary = await fieldsOnScreen(kcap, POOL_FIELDS)
    return readout
  }

  test('R14 — a saved scenario round-trips', async ({ kcap }) => {
    await kcap.open()

    await kcap.selectWorkload('api')
    await kcap.setSurgeUnit('pods')
    await kcap.setField('Rollout max surge', 1)

    const before = await configurationOnScreen(kcap)
    // The Export modal's JSON is the file a human copies out with `Copy JSON`;
    // here it is what gets pasted back, not what gets asserted on.
    const saved = await kcap.exportedScenarioText()

    await kcap.openImport()
    await kcap.pasteImport(saved)
    await kcap.commitImport('Replace configuration')

    // Called out first, because it is the reading the row is about: the surge
    // unit is derived from the config, so a save/load that stored the value
    // without the mode brings `1 pods` back as a percentage of the ceiling.
    await kcap.selectWorkload('api')
    await expect(kcap.surge).toHaveValue('1')
    await expect(kcap.surgeUnit).toHaveValue('pods')

    expect(await configurationOnScreen(kcap)).toEqual(before)
    await expect(kcap.changeChip).toHaveText('0 changes')
  })
})
