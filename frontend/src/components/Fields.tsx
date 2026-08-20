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
  const [draft, setDraft] = useState(String(value))

  useEffect(() => setDraft(String(value)), [value])

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const bounded = normalizeFieldValue(parsed, { min, max, step, fractional })
    setDraft(String(bounded))
    if (bounded !== value) onChange(bounded)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur()
    if (event.key === 'Escape') {
      setDraft(String(value))
      event.currentTarget.blur()
    }
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
          value={draft}
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
            setDraft(String(next))
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
