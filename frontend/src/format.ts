// Raw engine numbers as an operator reads them.
//
// kcap works in millicores and MiB end to end, because those are the units
// Kubernetes requests and limits are declared in and the units the engine
// packs with. These turn them into the units a human reads at a glance —
// and only at the edges: anywhere two figures are meant to be compared
// against each other, the raw number stays. A 750m request beside a
// "2 cores" usage is a comparison nobody can make.

/** Millicores as cores once there is a whole one to show: `750m`, `1 core`, `2.5 cores`. */
export function formatCpu(value: number): string {
  if (value < 1000) return `${value}m`
  const cores = (value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)
  // `cores` is a word, not a unit symbol like `MiB`, so it agrees in number —
  // a 1-core node and a 1-core request are both ordinary inputs.
  return `${cores} core${cores === '1' ? '' : 's'}`
}

/** MiB as GiB once there is a whole one to show: `768 MiB`, `2 GiB`, `2.5 GiB`. */
export function formatMemory(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} GiB`
  return `${value} MiB`
}

/**
 * A whole-number percentage of `total`, for printing beside a `%`.
 *
 * A zero or negative total reads as 0 rather than dividing: an empty pool has
 * no capacity to be a share of, and `Infinity%` or `NaN%` would reach the
 * screen. The engine's own percentages arrive already computed and do not
 * come through here.
 */
export function percent(value: number, total: number): number {
  return total <= 0 ? 0 : Math.round((value / total) * 100)
}
