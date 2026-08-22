// How the results panel names the pod population each of its readings is about.
//
// A pool can hold two populations at once: the pods no node can hold, and the
// rest. The engine sizes every node number from the rest alone and reports the
// impossible ones separately, so several readings in the panel are true of one
// population and several of the other — and a panel that narrates both without
// saying which is which reads as a contradiction.
//
// Every reading that is scoped to the placeable pods says so, and only while
// there are two populations to tell apart. A pool with nothing oversized gets
// no extra words, because there is nothing to distinguish: the qualifier would
// be noise on the common case and would train a reader to ignore it on the
// case that matters. The one reading about the *other* population — the verdict
// paragraph — says how many those pods are and how much they asked for, so the
// demand the scoped readings leave out is stated somewhere rather than implied
// by its absence.
//
// This lives outside the panel because it is four coordinated strings driving
// four readouts that have to agree with each other, which is exactly the shape
// that has gone wrong before by drifting apart inline.

import { counted, formatCpu, formatMemory } from './format'

export interface PopulationInput {
  /** Pods too large for an empty node; 0 means one population and no scoping. */
  oversizedPodCount: number
  /** The pool's configured CA minimum, named in the effective-target note. */
  minNodes: number
  /** The node target the saturation section divides by. */
  effectiveNodes: number
}

export interface PopulationNotes {
  /** The Placement tile's note, rendered verbatim. */
  placement: string
  /** The Effective target tile's note, rendered verbatim. */
  effectiveTarget: string
  /** The Request saturation subhead, complete and rendered verbatim. */
  saturation: string
  /**
   * A trailing clause for the density paragraph, or empty. Unlike the others
   * this continues a sentence already on screen rather than filling a slot of
   * its own, so it carries its own leading space.
   */
  density: string
}

/** The population-scoping notes for one pool's readings. */
export function describePopulations({
  oversizedPodCount,
  minNodes,
  effectiveNodes,
}: PopulationInput): PopulationNotes {
  const allocatable = `${effectiveNodes} × node allocatable`

  if (oversizedPodCount === 0) {
    return {
      placement: 'nodes to hold the pods',
      effectiveTarget: `after CA minimum ${minNodes}`,
      saturation: allocatable,
      density: '',
    }
  }

  return {
    placement: 'nodes for the pods that fit',
    // The tile sits beside Placement, which has just named the population.
    effectiveTarget: `same pods, after CA minimum ${minNodes}`,
    // Both bars in that section divide by capacity sized from the pods that
    // fit, so both numerators are about those pods too. The demand left out is
    // not hidden — the verdict above counts it.
    saturation: `the pods that fit · ${allocatable}`,
    // Appended as its own sentence, naming the population the section is about.
    density: ` That per-node figure counts only the pods that fit, not the ${oversizedPodCount} requesting more than one whole node.`,
  }
}

export interface OversizedVerdictInput {
  /**
   * Pods too large for an empty node. The caller renders this verdict only
   * above 0 — with one population there is no excluded demand to report.
   */
  oversizedPodCount: number
  /** The pool's whole declared demand, oversized pods included. */
  cpuRequestedM: number
  memoryRequestedMib: number
  /** The part of that demand the packer could place: what the node count was sized from. */
  placeableCpuM: number
  placeableMemoryMib: number
}

/**
 * The verdict paragraph for a pool blocked by pods no node can hold.
 *
 * The fifth string of the same vocabulary — it names the population the density
 * clause above excludes, in the same words — so it lives beside the other four
 * rather than inline in the panel, and gets the same test.
 *
 * It is also the only place the panel says how *much* those pods wanted. Every
 * other reading is scoped to the pods that fit, deliberately: a saturation bar
 * that totalled both populations against capacity sized for one read past 100%,
 * which is the defect that scoping fixed. So the magnitude is reported here, as
 * a sentence, where it is attached to the population it belongs to and to no
 * capacity at all — nothing on screen invites the reader to add it back into a
 * ratio.
 *
 * Written out at both counts because the verb and the pronoun agree as well as
 * the noun: a plural `s` on its own leaves "1 pod request … places them".
 */
export function describeOversizedVerdict({
  oversizedPodCount,
  cpuRequestedM,
  memoryRequestedMib,
  placeableCpuM,
  placeableMemoryMib,
}: OversizedVerdictInput): string {
  // The gap between the two totals is the oversized pods' own demand. The
  // engine reports both because it sized the node count from the second, so
  // this subtraction reads its answer rather than re-running its fit test.
  //
  // Both resources are always named, including a resource the excluded pods
  // barely asked for: a pod is oversized on whichever one no node can hold, and
  // printing only that one would leave a reader guessing whether the other was
  // zero or merely unreported.
  const excluded = `${formatCpu(cpuRequestedM - placeableCpuM)} of CPU and ${formatMemory(memoryRequestedMib - placeableMemoryMib)} of memory`

  return oversizedPodCount === 1
    ? `${counted(1, 'pod')} requests more than one whole node. No node count places it. Its ${excluded} are left out of the node sizing below.`
    : `${counted(oversizedPodCount, 'pod')} request more than one whole node. No node count places them. Their ${excluded} are left out of the node sizing below.`
}
