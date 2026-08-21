import { describe, expect, it } from 'vitest'
import { withAvg, withPeak } from './usage'

describe('withAvg', () => {
  it('creates a summary when the workload had no usage at all', () => {
    expect(withAvg(null, 620)).toEqual({ avg: 620, peak: null })
  })

  it('leaves an absent peak absent', () => {
    expect(withAvg({ avg: 100, p95: null, peak: null }, 250)).toEqual({ avg: 250, p95: null, peak: null })
  })

  it('keeps a peak that still clears the new average', () => {
    expect(withAvg({ avg: 100, p95: null, peak: 900 }, 250).peak).toBe(900)
  })

  it('raises a peak the new average overtook', () => {
    // The engine rejects peak < avg, so an average edit cannot be allowed to
    // strand a stale peak below it. Raising is the only move that neither
    // discards the measurement nor invents a larger one.
    expect(withAvg({ avg: 100, p95: null, peak: 200 }, 900)).toEqual({ avg: 900, p95: null, peak: 900 })
  })

  it('preserves p95, which the editor never writes', () => {
    expect(withAvg({ avg: 100, p95: 150, peak: 200 }, 120).p95).toBe(150)
  })
})

describe('withPeak', () => {
  it('records a peak above the average unchanged', () => {
    expect(withPeak({ avg: 620, p95: null, peak: null }, 900)).toEqual({ avg: 620, p95: null, peak: 900 })
  })

  it('clears the measurement at 0', () => {
    expect(withPeak({ avg: 620, p95: null, peak: 900 }, 0).peak).toBeNull()
  })

  it('lifts a peak typed below the average up to it', () => {
    expect(withPeak({ avg: 620, p95: null, peak: null }, 300).peak).toBe(620)
  })

  it('lifts a peak typed below p95 up to p95', () => {
    // peak >= p95 is the second ordering rule the engine enforces.
    expect(withPeak({ avg: 100, p95: 400, peak: null }, 250).peak).toBe(400)
  })

  it('works on a workload with no usage yet', () => {
    expect(withPeak(null, 900)).toEqual({ avg: 0, peak: 900 })
  })
})
