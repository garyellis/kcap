import { describe, expect, it } from 'vitest'
import { contentionReadout } from './contention'
import type { ContentionFlag } from './contention'

function flag(overrides: Partial<ContentionFlag> = {}): ContentionFlag {
  return {
    workload: 'web/payments',
    container: null,
    cpu_request_m: 500,
    usage_cpu_m: 751,
    usage_basis: 'peak',
    replicas_affected: 3,
    replicas_total: 5,
    worst_case_share_m: 877,
    message: 'web/payments peaks at 751m against a 500m request.',
    ...overrides,
  }
}

function block(overrides: Partial<Parameters<typeof contentionReadout>[0]> = {}) {
  return contentionReadout({
    nodes_evaluated: 7,
    contended_node_count: 3,
    flags: [],
    basis_notes: [],
    ...overrides,
  })
}

// Null and empty-flags are the two states most easily confused, and confusing
// them is the one error that makes the panel lie: null means the packer opened
// no nodes, so nothing was examined at all.
describe('contentionReadout, on what was examined', () => {
  it('reports no evaluation when the pool packed no nodes', () => {
    expect(contentionReadout(null).kind).toBe('not-evaluated')
  })

  it('reports all clear only when nodes were examined and none was flagged', () => {
    expect(block().kind).toBe('clear')
  })

  it('reports borrowed CPU as soon as one flag fires', () => {
    expect(block({ flags: [flag()] }).kind).toBe('borrowed-cpu')
  })
})

describe('contentionReadout, on what the chip counts', () => {
  it('carries the two node counts the summary line reads, in that order', () => {
    // Swapping these renders "7 of 3 packed nodes contended", which is visible
    // nonsense on the one line an operator reads without expanding anything.
    expect(block({ nodes_evaluated: 7, contended_node_count: 3, flags: [flag()] })).toMatchObject({
      nodesEvaluated: 7,
      contendedNodeCount: 3,
    })
  })


  it('counts workloads, not flags', () => {
    // One workload borrowing through three containers is three rows and one
    // chip; the engine emits a flag per (workload, container).
    const readout = block({
      flags: [
        flag({ container: 'app' }),
        flag({ container: 'istio-proxy' }),
        flag({ container: 'vault-agent' }),
      ],
    })
    expect(readout.workloadCount).toBe(1)
    expect(readout.flags).toHaveLength(3)
  })

  it('counts each distinct workload once', () => {
    const readout = block({
      flags: [flag({ workload: 'web/payments' }), flag({ workload: 'web/checkout' })],
    })
    expect(readout.workloadCount).toBe(2)
  })

  it("leaves the engine's flags in the order and shape it emitted them", () => {
    const flags = [flag({ workload: 'a/one' }), flag({ workload: 'b/two' })]
    expect(block({ flags }).flags).toEqual(flags)
  })
})

// The caveat line in the expansion says a pod may be borrowing more than its
// rows account for. That is only true of a breakdown that named someone: a
// pod-level flag carries the pod's whole excess already.
describe('contentionReadout, on whether rows name containers', () => {
  it('says so when a flag names a container', () => {
    expect(block({ flags: [flag({ container: null }), flag({ container: 'app' })] }).namesContainers).toBe(true)
  })

  it('stays quiet when every flag is pod-level', () => {
    expect(block({ flags: [flag(), flag({ workload: 'web/checkout' })] }).namesContainers).toBe(false)
  })
})

describe('contentionReadout, on the basis notes', () => {
  it('renders nothing when the engine attached no note', () => {
    expect(block().basisNote).toBeNull()
  })

  it("joins the engine's wording rather than rewriting it", () => {
    expect(block({ basis_notes: ['Peak unavailable for 3 workloads.', '2 pods had no usage data.'] }).basisNote)
      .toBe('Peak unavailable for 3 workloads. 2 pods had no usage data.')
  })

  it('reports the basis of an all-clear too, since an all-clear on avg is a weaker one', () => {
    expect(block({ basis_notes: ['Peak unavailable for 3 workloads.'] })).toMatchObject({
      kind: 'clear',
      basisNote: 'Peak unavailable for 3 workloads.',
    })
  })

  it('has no note to report when nothing was evaluated', () => {
    expect(contentionReadout(null).basisNote).toBeNull()
  })
})
