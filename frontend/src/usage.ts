import type { UsageStat } from './api'

// Editing one statistic of an observed-usage summary while keeping the summary
// coherent.
//
// `peak >= avg` and `peak >= p95` are domain invariants the engine enforces — a
// maximum cannot sit below the mean or the percentile it summarizes — and a
// violation comes back as a 422 carrying a message with no field location. So
// the editor must not be able to compose the pair that trips it.
//
// Both helpers resolve a conflict the same way, by raising the peak. It is the
// only move that neither discards a measurement nor invents one: a peak at
// least equal to the average is true of every distribution, so raising it to
// the floor states the weakest thing that is still certainly true.

function peakFloor(stat: UsageStat | null, avg: number): number {
  return Math.max(avg, stat?.p95 ?? 0)
}

export function withAvg(stat: UsageStat | null, avg: number): UsageStat {
  const peak = stat?.peak ?? null
  // An existing peak already clears p95, so lifting it to the new average
  // cannot break the other ordering rule.
  return { ...stat, avg, peak: peak === null ? null : Math.max(peak, avg) }
}

// 0 (or less) clears the measurement: a peak of zero says nothing a null does
// not, and it is how the editor's single number field spells "not measured".
export function withPeak(stat: UsageStat | null, peak: number): UsageStat {
  const avg = stat?.avg ?? 0
  return { ...stat, avg, peak: peak <= 0 ? null : Math.max(peak, peakFloor(stat, avg)) }
}
