import { useEffect, useId, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { normalizeFieldValue } from './fieldValue'

type NumberFieldProps = {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  unit?: string
  // When a field's number can be entered in more than one unit, the unit label
  // becomes the picker for it (see the rollout surge field's pods/percent mode).
  unitOptions?: string[]
  onUnitChange?: (unit: string) => void
  // Opts this field out of the commit-time integer rounding (see fieldValue.ts).
  fractional?: boolean
  hint?: string
  disabled?: boolean
  sliderMin?: number
  sliderMax?: number
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  unitOptions,
  onUnitChange,
  fractional = false,
  hint,
  disabled = false,
  sliderMin,
  sliderMax,
}: NumberFieldProps) {
  const id = useId()
  // The box reads the stored value, and holds text of its own only while it is
  // being typed in. What a caller stores need not be what this field committed —
  // a peak is raised to the average, a surge percent lands on a different pod
  // count — so text that outlives its edit is text the model has already
  // overruled: dragging the slider across a span that all stores one value must
  // leave the box on that value, not on a position that stored nothing.
  // The caller therefore owns the number between edits and must apply `onChange`
  // into `value` synchronously — a deferred update would read as a revert.
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    // No draft means a focus and a blur with nothing typed, which still
    // normalizes: a value stranded outside bounds a sibling field moved is
    // corrected the same way a typed one is.
    const parsed = draft === null ? value : Number(draft)
    setDraft(null)
    if (!Number.isFinite(parsed)) return
    const bounded = normalizeFieldValue(parsed, { min, max, step, fractional })
    if (bounded !== value) onChange(bounded)
  }

  // Both keys leave the field, and leaving it commits. Escape does not abandon
  // the draft: the blur it triggers runs inside this same event, before React
  // has applied any state that would clear one. Spelling that out rather than
  // clearing the draft here, which would read as a cancel that does not happen.
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
  }

  // The rail starts on a practical tuning range and auto-ranges like a
  // multimeter: park the thumb at the top and release, and the range doubles
  // (up to the validation bound); drop back down and it contracts. Re-ranging
  // only happens between drags so the thumb never jumps mid-gesture.
  const lo = Math.max(min ?? Number.NEGATIVE_INFINITY, sliderMin ?? min ?? 0)
  const baseHi = Math.min(max ?? Number.POSITIVE_INFINITY, sliderMax ?? Number.NEGATIVE_INFINITY)
  const rangeFor = (target: number) => {
    let factor = 1
    while (
      target >= lo + (baseHi - lo) * factor * 0.95 &&
      lo + (baseHi - lo) * factor < (max ?? Number.POSITIVE_INFINITY) &&
      factor < 65536
    ) {
      factor *= 2
    }
    return factor
  }
  const [rangeFactor, setRangeFactor] = useState(() => rangeFor(value))
  const [sliding, setSliding] = useState(false)
  useEffect(() => {
    if (!sliding) setRangeFactor(rangeFor(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, sliding, min, max, sliderMin, sliderMax])

  const hi = Math.min(max ?? Number.POSITIVE_INFINITY, lo + (baseHi - lo) * rangeFactor)
  const hasSlider = sliderMax !== undefined && hi > lo
  const sliderValue = Math.min(hi, Math.max(lo, value))
  const fill = hasSlider ? ((sliderValue - lo) / (hi - lo)) * 100 : 0

  return (
    <label className={`field ${disabled ? 'field--disabled' : ''}`} htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className="field-input-wrap">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          value={draft ?? String(value)}
          min={min}
          max={max}
          // A fractional field keeps `step` for the slider's granularity but
          // must not report a stepMismatch for a legitimate decimal value.
          step={fractional ? 'any' : step}
          disabled={disabled}
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {unitOptions ? (
          <select
            className="field-unit-select"
            aria-label={`${label} unit`}
            value={unit}
            disabled={disabled}
            onChange={(event) => onUnitChange?.(event.target.value)}
          >
            {unitOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        ) : unit && <span className="field-unit">{unit}</span>}
      </span>
      {hasSlider && (
        <input
          type="range"
          className="field-slider"
          aria-label={`${label} slider`}
          min={lo}
          max={hi}
          step={step}
          value={sliderValue}
          disabled={disabled}
          style={{ '--fill': `${fill}%` } as CSSProperties}
          onPointerDown={() => setSliding(true)}
          onPointerUp={() => setSliding(false)}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (next !== value) onChange(next)
          }}
        />
      )}
      {hint && <small>{hint}</small>}
    </label>
  )
}

type TextFieldProps = {
  label: string
  value: string
  onCommit: (value: string) => boolean | void
  hint?: string
}

export function TextField({ label, value, onCommit, hint }: TextFieldProps) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const [invalid, setInvalid] = useState(false)

  // A name field can keep the mirrored draft the number field gave up, because
  // its commit is answered: a refusal comes back as `false` and resets the draft
  // here, rather than being inferred from the stored value not moving. The
  // untouched case is a caller that *accepts* a name and stores the one it
  // already had — a rename normalized back onto itself — which leaves the typed
  // text on screen for want of a change to resync from.
  useEffect(() => setDraft(value), [value])

  const commit = () => {
    const next = draft.trim()
    if (!next || onCommit(next) === false) {
      setDraft(value)
      setInvalid(true)
      return
    }
    setInvalid(false)
  }

  return (
    <label className={`field ${invalid ? 'field--invalid' : ''}`} htmlFor={id}>
      <span className="field-label">{label}</span>
      <span className="field-input-wrap">
        <input
          id={id}
          type="text"
          value={draft}
          aria-invalid={invalid}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              setDraft(value)
              event.currentTarget.blur()
            }
          }}
        />
      </span>
      <span className="slider-spacer" aria-hidden="true" />
      {hint && <small>{invalid ? 'Name must be unique and non-empty.' : hint}</small>}
    </label>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  detail,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  detail?: string
}) {
  return (
    <button
      className={`toggle ${checked ? 'is-on' : ''}`}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-track"><i /></span>
      <span className="toggle-copy"><b>{label}</b>{detail && <small>{detail}</small>}</span>
    </button>
  )
}
