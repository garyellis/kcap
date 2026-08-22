// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NumberField } from './Fields'
import { withPeak } from '../usage'
import { SURGE_PERCENT_MAX, SURGE_PODS_MAX, SURGE_UNITS, surgePercentFromPods, surgePodsFromPercent } from '../surge'
import type { SurgeUnit } from '../surge'
import type { UsageStat } from '../api'

// The other tests in this directory exercise the field's pure commit rule. These
// render it, because what is under test is the box's text — which of the value
// asked for and the value stored the operator is left looking at. No pure
// function holds that; it lives in the draft state, the slider, and the caller's
// answer, and only a rendered field puts the three together.
afterEach(cleanup)

const box = () => screen.getByRole('spinbutton') as HTMLInputElement
const slider = () => screen.getByRole('slider') as HTMLInputElement

// The peak usage field, standing in for the coercing caller: it calls the real
// `withPeak`, which stores a peak below the average raised to it, so a whole
// span of the slider's track maps to one stored value. The props are App.tsx's
// at the time of writing, copied rather than shared — this is a field wired like
// that one, not a guarantee that it stays identical to it.
function PeakField({ avg }: { avg: number }) {
  const [stat, setStat] = useState<UsageStat | null>({ avg })
  return (
    <NumberField
      label="Peak CPU usage / pod"
      value={stat?.peak ?? 0}
      min={0}
      max={128000}
      step={10}
      sliderMax={4000}
      unit="mCPU"
      onChange={(peak) => setStat(withPeak(stat, peak))}
    />
  )
}

// A field whose caller stores exactly what it is given, for the behavior that
// must not change: most of the editor's fields coerce nothing.
function PlainField() {
  const [value, setValue] = useState(500)
  return <NumberField label="CPU request" value={value} min={1} max={128000} step={50} sliderMax={4000} onChange={setValue} />
}

describe('NumberField against a caller that coerces', () => {
  it('leaves the box on the stored value when the slider is dragged below it', () => {
    render(<PeakField avg={620} />)

    // Each of these is a position the drag passes through, and all of them store
    // 620. The box used to keep the last one, beside a thumb parked at 620.
    fireEvent.change(slider(), { target: { value: '270' } })
    expect(box().value).toBe('620')
    fireEvent.change(slider(), { target: { value: '290' } })
    expect(box().value).toBe('620')
    fireEvent.change(slider(), { target: { value: '320' } })
    expect(box().value).toBe('620')
    expect(slider().value).toBe('620')

    // Above the floor the slider addresses distinct values again.
    fireEvent.change(slider(), { target: { value: '900' } })
    expect(box().value).toBe('900')
  })

  it('shows the stored value again when the same rejected entry is typed twice', () => {
    render(<PeakField avg={620} />)

    fireEvent.change(box(), { target: { value: '400' } })
    fireEvent.blur(box())
    expect(box().value).toBe('620')

    // The second attempt stores 620 again, so nothing about the field's value
    // changes — and the box still may not be left reading 400.
    fireEvent.change(box(), { target: { value: '400' } })
    fireEvent.blur(box())
    expect(box().value).toBe('620')
  })

  it('still lets 0 clear the measurement', () => {
    render(<PeakField avg={620} />)

    fireEvent.change(slider(), { target: { value: '900' } })
    fireEvent.change(box(), { target: { value: '0' } })
    fireEvent.blur(box())
    expect(box().value).toBe('0')
  })

  it('does not rewrite a number being typed', () => {
    render(<PeakField avg={620} />)

    // Nothing is committed until blur, so every intermediate the operator types
    // has to survive — including the ones below the floor and the bare '1' that
    // is on its way to 1200.
    for (const typed of ['1', '12', '120', '1200']) {
      fireEvent.change(box(), { target: { value: typed } })
      expect(box().value).toBe(typed)
    }
    fireEvent.blur(box())
    expect(box().value).toBe('1200')
  })
})

// The rollout surge field, whose `value` prop changes meaning — not just
// magnitude — when the unit picker moves.
function SurgeField({ at }: { at: number }) {
  const [rollout, setRollout] = useState<{ pods: number | null; percent: number }>({ pods: 1, percent: 25 })
  const unit: SurgeUnit = rollout.pods === null ? '%' : 'pods'
  return (
    <NumberField
      label="Rollout max surge"
      value={unit === 'pods' ? rollout.pods ?? 0 : rollout.percent}
      min={0}
      max={unit === 'pods' ? SURGE_PODS_MAX : SURGE_PERCENT_MAX}
      step={unit === 'pods' ? 1 : 5}
      fractional={unit === '%'}
      unit={unit}
      unitOptions={SURGE_UNITS}
      onUnitChange={(next) =>
        setRollout((current) =>
          next === '%'
            ? { pods: null, percent: surgePercentFromPods(current.pods ?? 0, at) }
            : { pods: surgePodsFromPercent(current.percent, at), percent: current.percent },
        )
      }
      onChange={(next) => setRollout((current) => (unit === 'pods' ? { ...current, pods: next } : { ...current, percent: next }))}
    />
  )
}

describe('NumberField against a caller that stores what it is given', () => {
  it('tracks the slider position by position', () => {
    render(<PlainField />)

    fireEvent.change(slider(), { target: { value: '750' } })
    expect(box().value).toBe('750')
    fireEvent.change(slider(), { target: { value: '800' } })
    expect(box().value).toBe('800')
  })

  it('commits nothing on a focus and a blur with nothing typed', () => {
    // The rollout surge field in percent mode, holding the fraction a pods →
    // percent conversion produced. A bare focus and blur must not disturb it.
    const onChange = vi.fn()
    render(<NumberField label="Rollout max surge" value={2.5} min={0} max={100} step={5} fractional unit="%" onChange={onChange} />)

    fireEvent.blur(box())
    expect(onChange).not.toHaveBeenCalled()
    expect(box().value).toBe('2.5')
  })

  it('follows the unit picker in both directions, and survives a bare blur in between', () => {
    render(<SurgeField at={40} />)
    expect(box().value).toBe('1')

    // The conversion of 1 pod at 40 replicas is fractional, which is the
    // conversion working; a focus and a blur must not round it back.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '%' } })
    expect(box().value).toBe('2.5')
    fireEvent.blur(box())
    expect(box().value).toBe('2.5')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pods' } })
    expect(box().value).toBe('1')
  })

  it('does not rewrite a number being typed when the stored value moves under it', () => {
    // The guard on the effect this field used to resync with: a value that moves
    // for its own reasons mid-entry may not take the box away from the operator.
    const props = { label: 'Node CPU', min: 1, max: 128000, step: 50, onChange: () => {} }
    const { rerender } = render(<NumberField {...props} value={500} />)

    fireEvent.change(box(), { target: { value: '12' } })
    rerender(<NumberField {...props} value={4000} />)
    expect(box().value).toBe('12')
  })

  it('normalizes a value stranded outside its bounds on a bare blur', () => {
    // A sibling field can raise this field's min under it — the CPU limit's
    // floor is the request. Blurring the stranded field lifts it, as before.
    const onChange = vi.fn()
    render(<NumberField label="CPU limit value" value={200} min={500} max={128000} step={50} onChange={onChange} />)

    fireEvent.blur(box())
    expect(onChange).toHaveBeenCalledWith(500)
  })
})
