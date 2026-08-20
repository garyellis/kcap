import { describe, expect, it } from 'vitest'
import { caAction } from './caAction'
import type { CaActionInput } from './caAction'

function input(overrides: Partial<CaActionInput> = {}): CaActionInput {
  return { nodesToAdd: 0, nodesToRemove: 0, blockedReason: null, ...overrides }
}

describe('caAction', () => {
  it('instructs an addition', () => {
    expect(caAction(input({ nodesToAdd: 3 }))).toEqual({ label: '+3', className: 'is-add', note: 'nodes' })
  })

  it('instructs a removal with a minus sign, not a hyphen', () => {
    expect(caAction(input({ nodesToRemove: 2 }))).toEqual({ label: '−2', className: 'is-remove', note: 'nodes' })
  })

  it('holds when the pool is already the right size', () => {
    expect(caAction(input())).toEqual({ label: 'Hold', className: 'is-hold', note: 'steady' })
  })
})

// The engine zeroes an unsafe `nodes_to_remove` and names why
// (`_evaluate_pool_scenario` in src/kcap/engine.py). "None" distinguishes a
// withheld instruction from the steady state "Hold" would imply.
describe('caAction with a withheld scale-down', () => {
  it('reports no fix when pods are too large for any node', () => {
    expect(caAction(input({ blockedReason: 'oversized_pods' }))).toEqual({
      label: 'None',
      className: 'is-hold',
      note: 'no fix',
    })
  })

  it('reports no demand when a pool running nodes has nothing to place', () => {
    expect(caAction(input({ blockedReason: 'no_placeable_demand' }))).toEqual({
      label: 'None',
      className: 'is-hold',
      note: 'no demand',
    })
  })
})

// An addition is an instruction for the demand that *can* be placed, so a block
// on the removal never hides it. The verdict paragraph beside the readout
// already states that no node count places the oversized pods.
describe('caAction never withholds an addition', () => {
  it('shows the addition for placeable demand beside an oversized pod', () => {
    expect(caAction(input({ nodesToAdd: 18, blockedReason: 'oversized_pods' }))).toEqual({
      label: '+18',
      className: 'is-add',
      note: 'nodes',
    })
  })

  it('shows an addition driven by min_nodes with nothing placeable', () => {
    expect(caAction(input({ nodesToAdd: 2, blockedReason: 'no_placeable_demand' }))).toEqual({
      label: '+2',
      className: 'is-add',
      note: 'nodes',
    })
  })

  // `validate` enforces min_nodes <= current_nodes, so a pool whose pods are
  // *all* oversized has nodes_required 0 and effective_nodes_required min_nodes:
  // it cannot produce an addition, and reads "None" with no special case.
  it('still reports None when every pod is oversized and there is nothing to add', () => {
    expect(caAction(input({ nodesToAdd: 0, nodesToRemove: 0, blockedReason: 'oversized_pods' }))).toEqual({
      label: 'None',
      className: 'is-hold',
      note: 'no fix',
    })
  })
})
