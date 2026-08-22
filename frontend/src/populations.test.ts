import { describe, expect, it } from 'vitest'

import { describeOversizedVerdict, describePopulations } from './populations'

describe('describePopulations', () => {
  it('gives an ordinary pool no scoping words at all', () => {
    // The common case must gain nothing. A qualifier here would be noise, and
    // would train a reader to skip it on the pool where it carries meaning.
    const notes = describePopulations({ oversizedPodCount: 0, minNodes: 3, effectiveNodes: 3 })

    expect(notes).toEqual({
      placement: 'nodes to hold the pods',
      effectiveTarget: 'after CA minimum 3',
      saturation: '3 × node allocatable',
      density: '',
    })
    expect(notes.saturation).not.toContain('pods that fit')
  })

  it('scopes every reading once a pod cannot be placed', () => {
    const notes = describePopulations({ oversizedPodCount: 6, minNodes: 3, effectiveNodes: 3 })

    expect(notes.placement).toBe('nodes for the pods that fit')
    expect(notes.effectiveTarget).toBe('same pods, after CA minimum 3')
    expect(notes.saturation).toBe('the pods that fit · 3 × node allocatable')
    expect(notes.density).toBe(
      ' That per-node figure counts only the pods that fit, not the 6 requesting more than one whole node.',
    )
  })

  it('keeps the node target in the subhead rather than the population', () => {
    // The denominator is what the section divides by, so it must follow the
    // node target and not the oversized count.
    expect(
      describePopulations({ oversizedPodCount: 0, minNodes: 3, effectiveNodes: 7 }).saturation,
    ).toBe('7 × node allocatable')
    expect(
      describePopulations({ oversizedPodCount: 6, minNodes: 3, effectiveNodes: 7 }).saturation,
    ).toBe('the pods that fit · 7 × node allocatable')
  })

  it('counts the excluded pods in the density clause', () => {
    // The clause names a count, so it has to move with the count and read as
    // English at one.
    expect(describePopulations({ oversizedPodCount: 1, minNodes: 3, effectiveNodes: 3 }).density)
      .toBe(' That per-node figure counts only the pods that fit, not the 1 requesting more than one whole node.')
  })

  it('scopes a wholly oversized pool, where nothing is placeable at all', () => {
    // Placement reads 0 here and every provisioned core is stranded, so this is
    // the state the scoping matters most in — it must not fall back to the
    // unscoped wording just because the placeable population is empty.
    const notes = describePopulations({ oversizedPodCount: 3, minNodes: 3, effectiveNodes: 3 })

    expect(notes.placement).toBe('nodes for the pods that fit')
    expect(notes.saturation).toBe('the pods that fit · 3 × node allocatable')
  })
})

// The verdict names the population the density clause above it excludes, so it
// belongs to the same vocabulary. At one pod the verb and the pronoun have to
// agree as well as the noun.
describe('describeOversizedVerdict', () => {
  /** A pool whose oversized pods want 8 cores and 16 GiB of the demand on top. */
  function verdict(oversizedPodCount: number): string {
    return describeOversizedVerdict({
      oversizedPodCount,
      cpuRequestedM: 12_000,
      memoryRequestedMib: 24_576,
      placeableCpuM: 4_000,
      placeableMemoryMib: 8_192,
    })
  }

  it('reads as a sentence at a single oversized pod', () => {
    expect(verdict(1)).toBe(
      '1 pod requests more than one whole node. No node count places it.'
      + ' Its 8 cores of CPU and 16 GiB of memory are left out of the node sizing below.',
    )
  })

  it('reads as a sentence at more than one', () => {
    expect(verdict(4)).toBe(
      '4 pods request more than one whole node. No node count places them.'
      + ' Their 8 cores of CPU and 16 GiB of memory are left out of the node sizing below.',
    )
  })

  it('names the oversized pods in the same words the density clause does', () => {
    const density = describePopulations({ oversizedPodCount: 4, minNodes: 1, effectiveNodes: 2 }).density
    expect(verdict(4)).toContain('more than one whole node')
    expect(density).toContain('more than one whole node')
  })

  // The magnitude is the whole point of the sentence: the bars above are scoped
  // to the pods that fit, so without this an operator reading 74% cannot tell
  // whether the excluded pods wanted a rounding error or ten more nodes' worth.
  it('reports the excluded demand as the gap between the declared and the placeable', () => {
    expect(
      describeOversizedVerdict({
        oversizedPodCount: 2,
        cpuRequestedM: 9_500,
        memoryRequestedMib: 5_000,
        placeableCpuM: 500,
        placeableMemoryMib: 4_000,
      }),
    ).toContain('Their 9 cores of CPU and 1000 MiB of memory')
  })

  // A pod is oversized on whichever resource no node can hold, so the other one
  // can be tiny. It is still named: an unreported resource and a zero one look
  // the same on screen.
  it('names both resources even when the excluded pods barely asked for one', () => {
    expect(
      describeOversizedVerdict({
        oversizedPodCount: 1,
        cpuRequestedM: 750,
        memoryRequestedMib: 400_000,
        placeableCpuM: 500,
        placeableMemoryMib: 1_000,
      }),
    ).toContain('Its 250m of CPU and 389.6 GiB of memory')
  })

  // Nothing placeable at all: the excluded demand is the pool's whole demand,
  // and the sentence must still subtract rather than assume a remainder.
  it('reports the whole demand when no pod in the pool can be placed', () => {
    expect(
      describeOversizedVerdict({
        oversizedPodCount: 3,
        cpuRequestedM: 24_000,
        memoryRequestedMib: 49_152,
        placeableCpuM: 0,
        placeableMemoryMib: 0,
      }),
    ).toContain('Their 24 cores of CPU and 48 GiB of memory')
  })
})
