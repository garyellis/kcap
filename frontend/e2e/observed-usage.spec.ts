import { test, expect } from './support/fixture'

/** Promoted from the "Baseline" group of `docs/ui-regression-scenarios.md`. */
test.describe('Baseline', () => {
  test('R2 — observed usage moves the HPA recommendation', async ({ kcap }) => {
    await kcap.open()
    await kcap.selectWorkload('api')

    const desiredBefore = await kcap.podCount('Desired')

    await kcap.setField('Average CPU usage / pod', 900)

    // The claim is the direction — more CPU burned per pod, more pods
    // recommended — not the shipped defaults' 12 → 15. The scenario has been
    // walked at other usage values (Session E, at 1200 mCPU: 12 → 18) and the
    // pin held; an equality here would have failed that walk for no reason.
    expect(await kcap.podCount('Desired')).toBeGreaterThan(desiredBefore)

    await expect(kcap.changeChip).toHaveText('1 change')

    // "No 422 in the console or the server log" is enforced for every test by the
    // guard in support/traffic.ts, which is the whole reason R2 exists: the editor
    // posts the `observed_cpu_per_pod` summary, and since the Session E cleanup
    // that is the only form the API accepts at all.
  })

  test('R16 — a peak can be entered, and cannot be entered below the average', async ({ kcap }) => {
    await kcap.open()
    await kcap.selectWorkload('api')

    const peak = kcap.field('Peak CPU usage / pod')
    const average = Number(await kcap.field('Average CPU usage / pod').inputValue())
    // Read off the screen rather than hard-coded: the claim is the ordering the
    // engine enforces, not the shipped default's 620.
    expect(average, 'the fixture should carry an average to order the peak against').toBeGreaterThan(0)

    const projection = async () => ({
      desired: await kcap.podCount('Desired'),
      caAction: await kcap.caAction(),
    })
    const before = await projection()

    // Below the average, the peak snaps up to it. A maximum cannot sit under its
    // own mean, and the engine returns that violation as a message-only 422 — so
    // a UI that let it through would show an unexplained error banner.
    await kcap.setField('Peak CPU usage / pod', Math.round(average / 2))
    await expect(peak).toHaveValue(String(average))

    // Above it, held exactly.
    await kcap.setField('Peak CPU usage / pod', average * 2)
    await expect(peak).toHaveValue(String(average * 2))

    // Neither edit is a sizing input: the HPA reads the average and nothing else.
    expect(await projection()).toEqual(before)

    // An average that overtakes the peak carries the peak up with it, rather than
    // stranding a measurement below its own mean.
    await kcap.setField('Average CPU usage / pod', average * 3)
    await expect(peak).toHaveValue(String(average * 3))
  })

  test('R24 — a field that has been overruled shows what was stored', async ({ kcap }) => {
    await kcap.open()
    await kcap.selectWorkload('api')

    const label = 'Peak CPU usage / pod'
    const box = kcap.field(label)
    const thumb = kcap.slider(label)

    // Raised so the coerced span covers half the track. The claim is about a
    // span of the track that stores one value, not about how wide the shipped
    // average happens to make it — and on the shipped 620 the positions inside
    // it are a few pixels apart, close enough that the thumb's own width
    // decides which one a drag lands on.
    await kcap.setField('Average CPU usage / pod', 2000)
    const average = Number(await kcap.field('Average CPU usage / pod').inputValue())
    const trackTop = Number(await thumb.getAttribute('max'))

    // Three positions well inside that span — distinct places on the track that
    // all store one value, which is what makes this a readout problem rather
    // than a value problem. Kept clear of both ends: `0` is how this field
    // spells "not measured", and the average itself is addressable.
    const insideTheSpan = [0.2, 0.4, 0.6].map((share) => (average * share) / trackTop)

    const projection = async () => ({ desired: await kcap.podCount('Desired'), caAction: await kcap.caAction() })
    const before = await projection()

    for (const position of insideTheSpan) {
      await kcap.dragSlider(label, position)
      await expect(box, 'the box kept a drag position the model overruled').toHaveValue(String(average))
      await expect(thumb, 'the thumb and the box disagree about the stored peak').toHaveValue(String(average))
    }

    // Above the average the field is addressable normally, and the way back
    // down lands on the stored value again rather than on a position the drag
    // passed through.
    await kcap.dragSlider(label, 0.75)
    const measuredPeak = await box.inputValue()
    expect(Number(measuredPeak), 'a peak above the average should be held as entered').toBeGreaterThan(average)
    await expect(thumb).toHaveValue(measuredPeak)

    await kcap.dragSlider(label, insideTheSpan[0])
    await expect(box).toHaveValue(String(average))
    await expect(thumb).toHaveValue(String(average))

    // Typed, twice in a row. The second attempt is the one that matters:
    // nothing about the stored value changed, so a box that resynced only when
    // the stored value moved could not see it. R16 types each value once and
    // never did.
    for (const attempt of [1, 2]) {
      await kcap.proposeField(label, Math.round(average / 2))
      await expect(box, `attempt ${attempt} left a rejected value in the box`).toHaveValue(String(average))
    }

    // None of it is a sizing input, so nothing projected moved while the box
    // was being argued with.
    expect(await projection()).toEqual(before)

    // `Peak memory usage / pod` is deliberately not walked here. Its track
    // steps in 16 MiB and the shipped average is 780, which that step cannot
    // land on, so the box reads the stored `780` beside a thumb the browser
    // snaps to `784`. The stored value is right and the box shows it — this
    // component's whole claim — but "box and thumb agree" is not true of that
    // field, and a test that asserted it would be freezing a wrong
    // expectation. See C7 in `docs/ui-regression-scenarios.md`.
  })
})
