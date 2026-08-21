import { test, expect } from './support/fixture'
import { checklistFixture } from './support/checklist'
import type { Kcap } from './support/kcap'

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
})
