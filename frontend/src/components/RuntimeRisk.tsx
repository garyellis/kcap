import { useId, useMemo } from 'react'
import type { ClusterConfig, PoolScenarioResult } from '../api'
import { contentionReadout } from '../contention'
import { exposureReadout } from '../exposure'
import { formatCpu, formatMemory } from '../format'

// The results panel's runtime-risk readout for the selected pool and scenario.
//
// Requests decide placement, and nothing here moves a node number: this section
// says what the packing above looks like once usage and declared limits are
// taken into account. Both engine blocks are null when the packer opened no
// nodes, which is not an all-clear — see `contention.ts` and `exposure.ts`.

export function RuntimeRisk({
  pool,
  workloads,
  replicas,
}: {
  /** Undefined only before the first result arrives. */
  pool: PoolScenarioResult | undefined
  workloads: ClusterConfig['workloads']
  replicas: Record<string, number>
}) {
  // The section is a landmark with no name of its own, which leaves it
  // unreachable by name to a screen reader moving between regions. Named from
  // its own visible heading rather than a duplicate `aria-label`, so the two
  // cannot drift apart and it is not announced twice.
  const headingId = useId()
  const contention = contentionReadout(pool?.cpu_contention ?? null)
  const exposure = exposureReadout(pool?.limit_exposure ?? null)
  const found = contention.kind === 'borrowed-cpu' || exposure.kind === 'exhaustible'
  // The engine nulls both blocks on the same condition, but the neutral line is
  // read off both rather than either: were that ever to change, a finding must
  // not end up hidden behind "nothing was evaluated".
  const evaluated =
    contention.kind !== 'not-evaluated' && exposure.kind !== 'not-evaluated'

  const limits = useMemo(() => {
    let cpu = 0
    let memory = 0
    let cpuUnbounded = false
    let memoryUnbounded = false
    for (const [name, count] of Object.entries(replicas)) {
      if (count === 0) continue
      // A result can briefly represent the previous candidate while a newly
      // edited configuration is inside the debounce window.
      const workload = workloads[name]
      if (!workload) continue
      const resource = workload.resources
      if (resource.cpu_limit_m === null) cpuUnbounded = true
      else cpu += resource.cpu_limit_m * count
      if (resource.memory_limit_mib === null) memoryUnbounded = true
      else memory += resource.memory_limit_mib * count
    }
    return { cpu, memory, cpuUnbounded, memoryUnbounded }
  }, [workloads, replicas])

  return (
    <section className="runtime-risk" aria-labelledby={headingId}>
      <div className="result-section-heading"><span id={headingId}>Runtime risk</span></div>
      {/* One chip per finding class, and only when the class fires. An operator
          who expands nothing reads at most two short lines. */}
      {found ? (
        <div className="risk-chips">
          {contention.kind === 'borrowed-cpu' && (
            <details className="risk-detail">
              <summary>
                <span className="chip chip--warn">Borrowed CPU · {contention.workloadCount} workload{contention.workloadCount === 1 ? '' : 's'}</span>
                <small>{contention.contendedNodeCount} of {contention.nodesEvaluated} packed node{contention.nodesEvaluated === 1 ? '' : 's'} contended</small>
              </summary>
              <div className="risk-table-scroll">
                {/* The engine composes one sentence per flag so that every API
                    consumer reports contention identically; these columns render
                    the same numbers. The sentence rides along as the row's tooltip
                    rather than being recomposed here — if the table ever needs
                    wording the engine does not supply, that is a gap in the
                    engine's flag, not one to fill in TSX. The tooltip is a
                    mouse-only convenience, deliberately: it carries no number the
                    columns do not already show, so a reader who cannot hover loses
                    phrasing, not information. */}
                <table className="risk-table">
                  <thead>
                    <tr>
                      <th scope="col">Workload</th>
                      <th scope="col">Container</th>
                      <th scope="col">Request</th>
                      <th scope="col">Usage</th>
                      <th scope="col">Replicas</th>
                      <th scope="col">worst case (bound)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Millicores, not `formatCpu`: these three columns are read against
                        one another, and a 750m request beside a "2 cores" usage is the
                        one comparison the row exists to make.

                        The key pairs the two fields the engine aggregates on, and `/` cannot
                        collide: a container name is a DNS label, so everything after the last
                        slash is the container and everything before it is the workload. */}
                    {contention.flags.map((flag) => (
                      <tr key={`${flag.workload}/${flag.container ?? ''}`} title={flag.message}>
                        <td>{flag.workload}</td>
                        {/* A dash would read as missing data. A pod-level flag is
                            not missing anything: the borrower is the pod itself. */}
                        <td>{flag.container ?? <small>whole pod</small>}</td>
                        <td className="num">{flag.cpu_request_m}m</td>
                        <td className="num">{flag.usage_cpu_m}m <small>{flag.usage_basis}</small></td>
                        <td className="num">{flag.replicas_affected} of {flag.replicas_total}</td>
                        <td className="num">{flag.worst_case_share_m}m</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {contention.namesContainers && (
                <p className="risk-note">Container rows name only the containers the import listed; a pod may be borrowing more than its rows account for.</p>
              )}
            </details>
          )}
          {exposure.kind === 'exhaustible' && (
            <details className="risk-detail">
              <summary>
                {/* The chip names nodes when nodes are what fired. A pod with no
                    memory limit sitting alone on its node is flagged while putting
                    that node at exactly its allocatable, so there the finding is
                    about the pods and the chip says so rather than reading "0 of 4". */}
                <span className="chip chip--warn">{exposure.exhaustibleNodeCount > 0
                  ? `Node exhaustible · ${exposure.exhaustibleNodeCount} of ${exposure.nodesEvaluated} node${exposure.nodesEvaluated === 1 ? '' : 's'}`
                  : `Unlimited memory · ${exposure.unlimitedPodCount} pod${exposure.unlimitedPodCount === 1 ? '' : 's'}`}</span>
                {/* "Most exposed", not "fullest": this is the highest-ceiling node,
                    which is routinely not the one carrying the most requests. And the
                    CPU line below reports its own maximum, so the two can legitimately
                    be describing different nodes — hence neither says "the" node. */}
                <small>memory ceilings reach {exposure.memoryMaxLimitPercent}% of allocatable on the most exposed node</small>
              </summary>
              {/* Prose, not a table: the engine composes whole sentences here rather
                  than the structured rows contention emits, so every consumer of the
                  API reports exhaustion in the same words. */}
              <ul className="risk-flags">
                {exposure.flags.map((flag) => <li key={flag}>{flag}</li>)}
              </ul>
              {/* Informational, and inside the expansion for that reason: CPU
                  throttles under pressure where memory kills, so its ratio never
                  earns a chip of its own. */}
              <p className="risk-note">{exposure.cpuMaxLimitPercent !== null
                ? `CPU limits reach ${exposure.cpuMaxLimitPercent}% of allocatable on the most overcommitted node. CPU is compressible, so such a node throttles rather than runs out.`
                : 'No placed pod declares a CPU limit, so there is no CPU overcommit ratio to report.'}</p>
            </details>
          )}
        </div>
      ) : (
        <p className="risk-note">{evaluated
          ? 'No contention or exhaustion detected on this packing.'
          : 'No nodes were packed for this pool, so runtime risk was not evaluated.'}</p>
      )}
      {contention.basisNote !== null && <p className="risk-note">{contention.basisNote}</p>}
      {/* Cluster-wide, not per-pool — these sum every workload in the scenario.
          The sums are kept as they shipped, so the tiles say whose they are rather
          than quietly re-scoping a shipped number under a per-pool heading. */}
      <div className="limit-summary">
        <div><span>CPU runtime limit</span><strong className={limits.cpuUnbounded ? 'is-unbounded' : 'num'}>{limits.cpuUnbounded ? 'Unbounded' : formatCpu(limits.cpu)}</strong><small>all pools</small></div>
        <div><span>Memory runtime limit</span><strong className={limits.memoryUnbounded ? 'is-unbounded' : 'num'}>{limits.memoryUnbounded ? 'Unbounded' : formatMemory(limits.memory)}</strong><small>all pools</small></div>
      </div>
      <p className="risk-note">Requests alone drive placement; limits and usage drive the runtime risk read above.</p>
    </section>
  )
}
