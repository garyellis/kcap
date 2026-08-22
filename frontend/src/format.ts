// Raw engine numbers as an operator reads them.
//
// kcap works in millicores and MiB end to end, because those are the units
// Kubernetes requests and limits are declared in and the units the engine
// packs with. These turn them into the units a human reads at a glance —
// and only at the edges: anywhere two figures are meant to be compared
// against each other, the raw number stays. A 750m request beside a
// "2 cores" usage is a comparison nobody can make.
//
// Number agreement lives here too, for the same reason: a count and the noun
// beside it are one reading, and `1 pods` is a reading an operator does not
// trust. It stays a formatting utility — the singular and the plural are the
// words the call site wants on screen, not a lookup anything else resolves.

/**
 * The noun a count of `count` calls for: `plural(1, 'pod')` is `pod`.
 *
 * Returns only the word. Most readouts want the number beside it and reach for
 * `counted`; this is the primitive underneath, exported for the two places
 * where the number is not adjacent — `3 of 4 nodes` agrees with the second, and
 * the CA-action tile prints `+1` and `node` in separate elements.
 *
 * The plural is always the singular plus `s`, and there is deliberately no
 * argument to override it: every noun kcap counts is regular, and "the plural
 * is data the caller supplies" is one step from a message catalog. Add the
 * argument the day an irregular noun actually reaches a readout.
 *
 * A noun *phrase* works as long as it ends in its head noun — `packed node`
 * pluralizes correctly, `pod per node` would not. Anything else interpolates
 * around the helper, as the constraint tile's `${counted(n, 'pod')}/node` does.
 *
 * The return type is the words themselves rather than `string`, so a caller
 * holding a closed union of readouts keeps it.
 */
export function plural<S extends string>(count: number, singular: S): S | `${S}s` {
  return count === 1 ? singular : `${singular}s`
}

/** A count and its noun, agreeing: `counted(1, 'pod')` is `1 pod`. */
export function counted(count: number, singular: string): string {
  return `${count} ${plural(count, singular)}`
}

/** Millicores as cores once there is a whole one to show: `750m`, `1 core`, `2.5 cores`. */
export function formatCpu(value: number): string {
  if (value < 1000) return `${value}m`
  const cores = value / 1000
  // `cores` is a word, not a unit symbol like `MiB`, so it agrees in number —
  // a 1-core node and a 1-core request are both ordinary inputs.
  return `${cores.toFixed(cores % 1 === 0 ? 0 : 1)} ${plural(cores, 'core')}`
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
