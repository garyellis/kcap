import { describe, expect, it } from 'vitest'

import { describePopulations } from './populations'

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
