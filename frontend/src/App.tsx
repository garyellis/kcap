import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import './App.css'
import { compareClusters } from './api'
import type { ClusterConfig, CompareResponse, NodePool, PoolScenarioResult, UsageStat, Workload, WorkloadResult } from './api'
import { withPodEdit } from './breakdown'
import { caAction } from './caAction'
import { ExportModal } from './components/ExportModal'
import { NumberField, TextField, Toggle } from './components/Fields'
import { ImportModal } from './components/ImportModal'
import { RuntimeRisk } from './components/RuntimeRisk'
import { cloneBaseline, createPool, createWorkload, nextPoolName, nextWorkloadName } from './defaults'
import { formatCpu, formatMemory, percent } from './format'
import { SURGE_PERCENT_MAX, SURGE_PODS_MAX, SURGE_UNITS, surgeUnitOf, surgeUnitPatch } from './surge'
import { withAvg, withPeak } from './usage'

const SCENARIOS = [
  ['hpa_min', 'HPA min'],
  ['current', 'Current'],
  ['hpa_desired', 'Desired'],
  ['hpa_max', 'HPA max'],
  ['hpa_max_rollout', 'Rollout'],
] as const

type ScenarioName = (typeof SCENARIOS)[number][0]
type WorkloadUpdater = (workload: Workload) => Workload
// The editor panel shows either one node pool or one workload.
type Selection = { kind: 'pool'; name: string } | { kind: 'workload'; name: string }

function HelmMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      role="img"
      aria-label="KCAP"
    >
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.25" />
      <path d="M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.93 4.93l2.12 2.12 M16.95 16.95l2.12 2.12 M19.07 4.93l-2.12 2.12 M7.05 16.95l-2.12 2.12" />
    </svg>
  )
}

const SHORT_RESOURCE: Record<string, string> = { cpu: 'CPU', memory: 'MEM', pod_count: 'Pods' }

// The constraint tile is one short line in a four-column grid, so the verdict
// goes in the chip and the evidence goes in the note.
function describeConstraint(scenario?: PoolScenarioResult): { label: string; note: string; tone: 'neutral' | 'warn' } {
  if (!scenario) return { label: '—', note: 'dominant pressure', tone: 'neutral' }

  const perNode = scenario.pods_per_node
  const density = perNode === null ? '' : `${perNode} pod${perNode === 1 ? '' : 's'}/node`

  switch (scenario.limiting_resource) {
    case 'pod_too_large':
      return { label: 'Pod size', note: 'pod exceeds one whole node', tone: 'warn' }
    case 'fragmentation':
      return {
        label: `${SHORT_RESOURCE[scenario.fragmentation_resource ?? ''] ?? 'Shape'} frag`,
        note: density ? `${density} — shape, not volume` : 'pod shape, not total volume',
        tone: 'warn',
      }
    case 'pod_count':
      return { label: 'Pod count', note: 'max pods per node', tone: 'neutral' }
    case 'none':
      return { label: 'None', note: 'no pods in scenario', tone: 'neutral' }
    default:
      return {
        label: SHORT_RESOURCE[scenario.limiting_resource] ?? scenario.limiting_resource,
        note: density ? `${density} at this shape` : 'dominant pressure',
        tone: 'neutral',
      }
  }
}

// An oversized pod splits the panel across two pod populations: the verdict
// counts the pods no node can hold, and the node numbers beside it size only the
// rest. Both readings belong on screen — withholding one is the mistake
// `caAction.ts` describes — so each says which pods it is about, and only while
// there are two populations to tell apart.
function describePopulations(
  oversizedPodCount: number,
  minNodes: number,
): { placement: string; effectiveTarget: string; density: string } {
  if (oversizedPodCount === 0) {
    return { placement: 'nodes to hold the pods', effectiveTarget: `after CA minimum ${minNodes}`, density: '' }
  }
  return {
    placement: 'nodes for the pods that fit',
    // The tile sits beside Placement, which has just named the population.
    effectiveTarget: `same pods, after CA minimum ${minNodes}`,
    // Appended as its own sentence: the density claim is the only reading in
    // that section computed over the placeable pods, while the request bars
    // above it total every pod the pool asks for.
    density: ` That per-node figure counts only the pods that fit, not the ${oversizedPodCount} requesting more than one whole node.`,
  }
}

function Metric({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  )
}

function CapacityBar({
  label,
  value,
  capacity,
  stranded,
  blocked,
  display,
}: {
  label: string
  value: number
  capacity: number
  stranded: number
  blocked: boolean
  display: (value: number) => string
}) {
  const usage = percent(value, capacity)
  const strandedShare = percent(stranded, capacity)
  const trackState = blocked ? ' is-blocked' : usage > 90 ? ' is-hot' : ''
  return (
    <div className="capacity-bar">
      <div className="bar-head"><span>{label}</span><b className="num">{display(value)} / {display(capacity)}</b></div>
      <div className={`bar-track${trackState}`}>
        <em style={{ width: `${Math.min(100, usage)}%` }} />
        <u style={{ width: `${Math.min(100 - Math.min(100, usage), strandedShare)}%` }} />
      </div>
      <small>
        {usage}% requested
        {stranded > 0 && <> · <span className="stranded-note">{strandedShare}% ({display(stranded)}) stranded</span> at this pod shape</>}
      </small>
    </div>
  )
}

function BarScale() {
  return (
    <div className="bar-scale" aria-hidden="true">
      <span>0</span><span>25</span><span>50</span><span>75</span><span>100%</span>
    </div>
  )
}

function NodeMap({ scenario, maxNodes }: { scenario: PoolScenarioResult; maxNodes: number }) {
  // Required nodes must always be drawn; only unused headroom collapses into
  // the overflow badge.
  const shown = Math.min(maxNodes, Math.max(24, scenario.effective_nodes_required))
  const deficit = scenario.effective_nodes_required - maxNodes
  return (
    <div className="node-map-wrap">
      <div className="node-map" aria-label={`${scenario.effective_nodes_required} of ${maxNodes} nodes required`}>
        {Array.from({ length: shown }, (_, index) => {
          const current = index < scenario.current_nodes
          const required = index < scenario.effective_nodes_required
          const state = current && required ? 'active' : current ? 'remove' : required ? 'add' : 'free'
          return <i className={`node node--${state}`} key={index} title={`Node ${index + 1}: ${state}`} />
        })}
        {maxNodes > shown && <span className="node-overflow">+{maxNodes - shown}</span>}
      </div>
      {deficit > 0 && (
        <div className="callout callout--bad node-deficit">
          <strong>Deficit.</strong> {deficit} node{deficit === 1 ? '' : 's'} beyond the CA maximum.
        </div>
      )}
    </div>
  )
}

function PoolEditor({
  pool,
  assignedWorkloads,
  poolCount,
  updatePool,
  updateMachine,
  rename,
  duplicate,
  remove,
}: {
  pool: NodePool
  assignedWorkloads: number
  poolCount: number
  updatePool: (patch: Partial<NodePool>) => void
  updateMachine: (patch: Partial<NodePool['machine']>) => void
  rename: (name: string) => boolean
  duplicate: () => void
  remove: () => void
}) {
  const machine = pool.machine
  const allocatableCpu = machine.cpu_m - machine.reserved_cpu_m
  const allocatableMemory = machine.memory_mib - machine.reserved_memory_mib
  // Deleting a referenced pool would orphan those workloads' assignments;
  // reassign first.
  const removeBlocked = poolCount <= 1 || assignedWorkloads > 0

  return (
    <div className="editor-view">
      <header className="editor-header">
        <div>
          <span className="eyebrow">Node pool</span>
          <h2>{pool.name}</h2>
          <p>Define raw node capacity, fixed platform overhead, and the autoscaler envelope.</p>
        </div>
        <div className="editor-actions">
          <button type="button" onClick={duplicate}>Duplicate</button>
          <button
            className="danger-button"
            type="button"
            disabled={removeBlocked}
            title={removeBlocked && poolCount > 1 ? `${assignedWorkloads} workload${assignedWorkloads === 1 ? '' : 's'} still assigned` : undefined}
            onClick={remove}
          >
            Remove
          </button>
        </div>
      </header>

      <section className="form-section">
        <div className="section-title">
          <h3>Machine capacity</h3>
          <p>Physical or virtual resources available on every node.</p>
        </div>
        <div className="field-grid field-grid--three">
          <TextField label="Pool name" value={pool.name} onCommit={rename} hint="Cluster autoscaler node group" />
          <NumberField label="Node CPU" sliderMin={1000} sliderMax={32000} value={machine.cpu_m} min={machine.reserved_cpu_m + 100} max={128000} step={100} unit="mCPU" onChange={(cpu_m) => updateMachine({ cpu_m })} hint="Raw capacity before reservation" />
          <NumberField label="Node memory" sliderMin={1024} sliderMax={131072} value={machine.memory_mib} min={machine.reserved_memory_mib + 128} max={1048576} step={128} unit="MiB" onChange={(memory_mib) => updateMachine({ memory_mib })} hint="Raw capacity before reservation" />
        </div>
      </section>

      <section className="form-section">
        <div className="section-title">
          <h3>Platform reservation</h3>
          <p>Per-node capacity removed before workload placement.</p>
        </div>
        <div className="note note--lead">
          <strong>Aggregate fixed overhead.</strong> Include the kernel and OS, kubelet, eviction reserve, CNI, cloud controllers, and platform DaemonSets that run on every node.
        </div>
        <div className="field-grid field-grid--two">
          <NumberField label="Reserved CPU" sliderMax={2000} value={machine.reserved_cpu_m} min={0} max={machine.cpu_m - 100} step={50} unit="mCPU" onChange={(reserved_cpu_m) => updateMachine({ reserved_cpu_m })} hint="Unschedulable on each node" />
          <NumberField label="Reserved memory" sliderMax={8192} value={machine.reserved_memory_mib} min={0} max={machine.memory_mib - 128} step={128} unit="MiB" onChange={(reserved_memory_mib) => updateMachine({ reserved_memory_mib })} hint="Unschedulable on each node" />
        </div>
        <div className="stat-strip stat-strip--3">
          <div><span>Allocatable CPU / node</span><strong>{formatCpu(allocatableCpu)}</strong><small>{percent(machine.reserved_cpu_m, machine.cpu_m)}% reserved</small></div>
          <div><span>Allocatable memory / node</span><strong>{formatMemory(allocatableMemory)}</strong><small>{percent(machine.reserved_memory_mib, machine.memory_mib)}% reserved</small></div>
          <div><span>Pod density</span><strong className="num">{machine.max_pods}</strong><small>hard pod ceiling</small></div>
        </div>
      </section>

      <section className="form-section">
        <div className="section-title">
          <h3>Fleet envelope</h3>
          <p>Current state and permitted cluster autoscaler bounds.</p>
        </div>
        <div className="field-grid field-grid--four">
          <NumberField label="Minimum nodes" sliderMax={50} value={pool.min_nodes} min={0} max={pool.current_nodes} unit="nodes" onChange={(min_nodes) => updatePool({ min_nodes })} />
          <NumberField label="Current nodes" sliderMax={50} value={pool.current_nodes} min={pool.min_nodes} max={pool.max_nodes} unit="nodes" onChange={(current_nodes) => updatePool({ current_nodes })} />
          <NumberField label="Maximum nodes" sliderMax={100} value={pool.max_nodes} min={pool.current_nodes} max={500} unit="nodes" onChange={(max_nodes) => updatePool({ max_nodes })} />
          <NumberField label="Maximum pods" sliderMax={250} value={machine.max_pods} min={1} max={500} unit="pods/node" onChange={(max_pods) => updateMachine({ max_pods })} />
        </div>
      </section>
    </div>
  )
}

function WorkloadEditor({
  workload,
  result,
  workloadCount,
  poolNames,
  update,
  rename,
  duplicate,
  remove,
}: {
  workload: Workload
  result: WorkloadResult | undefined
  workloadCount: number
  poolNames: string[]
  update: (updater: WorkloadUpdater) => void
  rename: (name: string) => boolean
  duplicate: () => void
  remove: () => void
}) {
  const resources = workload.resources
  const hpa = workload.hpa

  // Editing the pod's shape or its observed load invalidates any imported
  // per-container breakdown, which this editor cannot restate — breakdown.ts
  // owns that rule and why it is enforced at the edit rather than by comparison.
  const updateResources = (patch: Partial<Workload['resources']>) => {
    update((current) => withPodEdit(current, { resources: { ...current.resources, ...patch } }))
  }

  const updateRequest = (kind: 'cpu' | 'memory', value: number) => {
    if (kind === 'cpu') {
      updateResources({
        cpu_request_m: value,
        cpu_limit_m: resources.cpu_limit_m === null ? null : Math.max(resources.cpu_limit_m, value),
      })
    } else {
      updateResources({
        memory_request_mib: value,
        memory_limit_mib: resources.memory_limit_mib === null ? null : Math.max(resources.memory_limit_mib, value),
      })
    }
  }

  const updateHpa = (patch: Partial<NonNullable<Workload['hpa']>>) => {
    update((current) => ({ ...current, hpa: current.hpa ? { ...current.hpa, ...patch } : null }))
  }

  // Observed usage is a summary per dimension, not a scalar. The editor writes
  // avg and peak; p95 is read from a file and preserved, never edited here.
  // usage.ts keeps the pair ordered the way the engine requires.
  const cpuUsage = workload.observed_cpu_per_pod
  const memoryUsage = workload.observed_memory_per_pod
  const updateUsage = (
    dimension: 'observed_cpu_per_pod' | 'observed_memory_per_pod',
    stat: UsageStat,
  ) => update((current) => withPodEdit(current, { [dimension]: stat }))

  // The surge unit is derived, never stored (see surgeUnitOf in surge.ts), so a
  // workload loaded from a scenario file or a cluster import opens in the unit
  // its data implies.
  const surgePods = workload.rollout.max_surge_pods
  const surgeMode = surgeUnitOf(workload.rollout)
  const updateRollout = (patch: Partial<Workload['rollout']>) => {
    update((current) => ({ ...current, rollout: { ...current.rollout, ...patch } }))
  }
  // Both directions convert through the replica count the engine surges at, so
  // the picker is a pure unit change: the modelled rollout is the same before
  // and after. surge.ts owns that arithmetic and why the percent is not rounded.
  const switchSurgeMode = (unit: string) => {
    const patch = surgeUnitPatch(workload, unit)
    if (patch) updateRollout(patch)
  }

  return (
    <div className="editor-view">
      <header className="editor-header">
        <div>
          <span className="eyebrow">Workload</span>
          <h2>{workload.name}</h2>
          <p>Configure pod shape, runtime bounds, replica policy, and observed load.</p>
        </div>
        <div className="editor-actions">
          <button type="button" onClick={duplicate}>Duplicate</button>
          <button className="danger-button" type="button" disabled={workloadCount <= 1} onClick={remove}>Remove</button>
        </div>
      </header>

      <section className="form-section">
        <div className="section-title">
          <h3>Deployment profile</h3>
          <p>Identity, current footprint, live observations, and rollout surge.</p>
        </div>
        <div className="field-grid field-grid--four">
          <TextField label="Workload name" value={workload.name} onCommit={rename} hint="Unique configuration key" />
          <NumberField label="Current replicas" sliderMax={50} value={workload.current_replicas} min={0} max={10000} unit="pods" onChange={(current_replicas) => update((current) => ({ ...current, current_replicas }))} />
          <NumberField label="Average CPU usage / pod" sliderMax={4000} value={cpuUsage?.avg ?? 0} min={0} max={128000} step={10} unit="mCPU" onChange={(avg) => updateUsage('observed_cpu_per_pod', withAvg(cpuUsage, avg))} hint="Feeds HPA" />
          <NumberField label="Average memory usage / pod" sliderMax={8192} value={memoryUsage?.avg ?? 0} min={0} max={1048576} step={16} unit="MiB" onChange={(avg) => updateUsage('observed_memory_per_pod', withAvg(memoryUsage, avg))} hint="Feeds HPA" />
        </div>
        <div className="field-grid field-grid--four field-grid--continuation">
          {/*
            Both peak sliders offer positions the field will not keep: usage.ts
            floors a peak at the higher of the average and an imported p95, so
            the bottom of each track collapses onto one value and a thumb
            dragged there looks stuck. The hint states that floor rather than
            leaving it looking broken, and says "never below the average"
            rather than naming a landing value, which the p95 case would make
            wrong. Starting the track at the floor, or marking the floor on it,
            were both weighed and rejected: 0 is how this field spells "not
            measured", so the track has to keep reaching it.
          */}
          <NumberField label="Peak CPU usage / pod" sliderMax={4000} value={cpuUsage?.peak ?? 0} min={0} max={128000} step={10} unit="mCPU" onChange={(peak) => updateUsage('observed_cpu_per_pod', withPeak(cpuUsage, peak))} hint="Optional; 0 = not measured; never below the average" />
          <NumberField label="Peak memory usage / pod" sliderMax={8192} value={memoryUsage?.peak ?? 0} min={0} max={1048576} step={16} unit="MiB" onChange={(peak) => updateUsage('observed_memory_per_pod', withPeak(memoryUsage, peak))} hint="Optional; 0 = not measured; never below the average" />
          <NumberField label="Rollout max surge" sliderMax={surgeMode === 'pods' ? 50 : 100} value={surgeMode === 'pods' ? surgePods ?? 0 : workload.rollout.max_surge_percent} min={0} max={surgeMode === 'pods' ? SURGE_PODS_MAX : SURGE_PERCENT_MAX} step={surgeMode === 'pods' ? 1 : 5} fractional={surgeMode === '%'} unit={surgeMode} unitOptions={SURGE_UNITS} onUnitChange={switchSurgeMode} onChange={(next) => updateRollout(surgeMode === 'pods' ? { max_surge_pods: next } : { max_surge_percent: next })} hint="Applied at HPA maximum" />
          {poolNames.length > 1 && (
            <label className="field">
              <span className="field-label">Node pool</span>
              <span className="field-input-wrap">
                <select
                  value={workload.pool ?? poolNames[0]}
                  onChange={(event) => {
                    const pool = event.target.value
                    update((current) => ({ ...current, pool }))
                  }}
                >
                  {poolNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </span>
              <span className="slider-spacer" aria-hidden="true" />
              <small>Pods pack onto this pool only</small>
            </label>
          )}
        </div>
      </section>

      <section className="form-section">
        <div className="section-title">
          <h3>Pod resource envelope</h3>
          <p>Requests drive placement. Limits describe runtime ceilings and do not reserve node capacity.</p>
        </div>
        <div className="resource-matrix">
          <div className="resource-axis"><span>Resource</span><b>Request</b><b>Limit</b></div>
          <div className="resource-row">
            <div className="resource-name"><b>CPU</b><small>compute</small></div>
            <NumberField label="CPU request" sliderMin={50} sliderMax={4000} value={resources.cpu_request_m} min={1} max={128000} step={50} unit="mCPU" onChange={(value) => updateRequest('cpu', value)} />
            <div className="limit-cell">
              <Toggle label="CPU limit" checked={resources.cpu_limit_m !== null} onChange={(enabled) => updateResources({ cpu_limit_m: enabled ? Math.max(resources.cpu_request_m * 2, resources.cpu_request_m) : null })} />
              {resources.cpu_limit_m !== null && <NumberField label="CPU limit value" sliderMax={8000} value={resources.cpu_limit_m} min={resources.cpu_request_m} max={256000} step={50} unit="mCPU" onChange={(cpu_limit_m) => updateResources({ cpu_limit_m })} />}
            </div>
          </div>
          <div className="resource-row">
            <div className="resource-name"><b>Memory</b><small>working set</small></div>
            <NumberField label="Memory request" sliderMin={64} sliderMax={16384} value={resources.memory_request_mib} min={1} max={1048576} step={64} unit="MiB" onChange={(value) => updateRequest('memory', value)} />
            <div className="limit-cell">
              <Toggle label="Memory limit" checked={resources.memory_limit_mib !== null} onChange={(enabled) => updateResources({ memory_limit_mib: enabled ? Math.max(resources.memory_request_mib * 2, resources.memory_request_mib) : null })} />
              {resources.memory_limit_mib !== null && <NumberField label="Memory limit value" sliderMax={32768} value={resources.memory_limit_mib} min={resources.memory_request_mib} max={2097152} step={64} unit="MiB" onChange={(memory_limit_mib) => updateResources({ memory_limit_mib })} />}
            </div>
          </div>
        </div>
        <div className="note">
          <strong>Placement rule.</strong> Kubernetes schedules against requests. An unset limit means unbounded runtime consumption; it does not change the node count in this model.
        </div>
      </section>

      <section className="form-section">
        <div className="section-title section-title--toggle">
          <div>
            <h3>Horizontal autoscaling</h3>
          </div>
          <Toggle
            label="HPA"
            checked={hpa !== null}
            detail={hpa ? 'policy active' : 'fixed replicas'}
            onChange={(enabled) => update((current) => ({
              ...current,
              hpa: enabled ? {
                min_replicas: Math.min(current.current_replicas, 2),
                max_replicas: Math.max(current.current_replicas, 8),
                cpu_target_percentage: 70,
                memory_target_percentage: null,
              } : null,
            }))}
          />
        </div>
        {hpa ? (
          <>
            <div className="stat-strip stat-strip--4 stat-strip--hpa">
              <div><span>Current CPU</span><strong className="num">{result?.cpu_utilization_percent === null || result === undefined ? '—' : `${Math.round(result.cpu_utilization_percent)}%`}</strong><small>{hpa.cpu_target_percentage === null ? 'metric inactive' : `target ${hpa.cpu_target_percentage}%`}</small></div>
              <div><span>Current memory</span><strong className="num">{result?.memory_utilization_percent === null || result === undefined ? '—' : `${Math.round(result.memory_utilization_percent)}%`}</strong><small>{hpa.memory_target_percentage === null ? 'metric inactive' : `target ${hpa.memory_target_percentage}%`}</small></div>
              <div>
                <span>Recommended</span>
                <strong className={`num${result?.clamped_by ? ' is-clamped' : ''}`}>
                  {result ? (result.clamped_by ? <><s>{result.raw_desired_replicas}</s> <span className="clamped-to">→ {result.desired_replicas}</span></> : result.desired_replicas) : '—'}
                </strong>
                <small>{result?.clamped_by ? <><em className="chip chip--warn">Clamped</em><span className="num">{hpa.min_replicas}–{hpa.max_replicas}</span></> : 'highest metric wins'}</small>
              </div>
              <div><span>Ceiling</span><strong className="num">{hpa.max_replicas}</strong><small>HPA hard maximum</small></div>
            </div>
            {result?.clamped_by && (
              <div className="callout callout--warn">
                <strong>HPA saturated.</strong> Metrics recommend {result.raw_desired_replicas} pods, held at {result.desired_replicas} by the
                {result.clamped_by === 'max' ? ' ceiling' : ' minimum'}. Requests and targets do not move the
                projection until the recommendation re-enters the {hpa.min_replicas}–{hpa.max_replicas} range.
              </div>
            )}
            <div className="field-grid field-grid--four hpa-fields">
              <NumberField label="Minimum replicas" sliderMax={50} value={hpa.min_replicas} min={0} max={hpa.max_replicas} unit="pods" onChange={(min_replicas) => updateHpa({ min_replicas })} />
              <NumberField label="Replica ceiling" sliderMax={100} value={hpa.max_replicas} min={hpa.min_replicas} max={10000} unit="pods" onChange={(max_replicas) => updateHpa({ max_replicas })} />
              <div className="metric-policy">
                <Toggle label="CPU metric" checked={hpa.cpu_target_percentage !== null} onChange={(enabled) => updateHpa({ cpu_target_percentage: enabled ? 70 : null })} />
                {hpa.cpu_target_percentage !== null && <NumberField label="CPU target" sliderMax={150} value={hpa.cpu_target_percentage} min={1} max={200} unit="% request" onChange={(cpu_target_percentage) => updateHpa({ cpu_target_percentage })} />}
              </div>
              <div className="metric-policy">
                <Toggle label="Memory metric" checked={hpa.memory_target_percentage !== null} onChange={(enabled) => updateHpa({ memory_target_percentage: enabled ? 75 : null })} />
                {hpa.memory_target_percentage !== null && <NumberField label="Memory target" sliderMax={150} value={hpa.memory_target_percentage} min={1} max={200} unit="% request" onChange={(memory_target_percentage) => updateHpa({ memory_target_percentage })} />}
              </div>
            </div>
            <div className="note">
              <strong>HPA model.</strong> ceil(current replicas × current utilization ÷ target). CPU and memory utilization are calculated against their requests; the highest active metric recommendation wins. A metric within 10% of its target holds steady, matching the Kubernetes tolerance band.
            </div>
          </>
        ) : (
          <div className="note">HPA scenarios retain this workload at its current replica count.</div>
        )}
      </section>
    </div>
  )
}

function ResultsPanel({
  comparison,
  candidate,
  scenarioName,
  setScenarioName,
  changeCount,
  autoRun,
  setAutoRun,
  stale,
  run,
}: {
  comparison: CompareResponse | null
  candidate: ClusterConfig
  scenarioName: ScenarioName
  setScenarioName: (scenario: ScenarioName) => void
  changeCount: number
  autoRun: boolean
  setAutoRun: (auto: boolean) => void
  stale: boolean
  run: () => void
}) {
  const scenario = comparison?.candidate_result.scenarios[scenarioName]
  const baselineScenario = comparison?.baseline_result.scenarios[scenarioName]
  const caActionLabelId = useId()

  const poolNames = Object.keys(candidate.node_pools)
  const multiPool = poolNames.length > 1
  const [selectedPool, setSelectedPool] = useState(poolNames[0])
  // A removed or renamed pool must not strand the tab selection.
  const activePool = poolNames.includes(selectedPool) ? selectedPool : poolNames[0]
  // A result can briefly describe the previous pool set while an edit is
  // inside the debounce window.
  const poolScenario = scenario ? scenario.pools[activePool] ?? Object.values(scenario.pools)[0] : undefined
  const activePoolConfig = candidate.node_pools[poolScenario?.pool ?? activePool] ?? candidate.node_pools[activePool]

  // Both readouts below map the engine's node deltas through `caAction`; see
  // that module for why a blocked pool reads "None" and why an addition is
  // never withheld.
  const { label: action, className: actionClass, note: actionNote } = caAction({
    nodesToAdd: poolScenario?.nodes_to_add ?? 0,
    nodesToRemove: poolScenario?.nodes_to_remove ?? 0,
    blockedReason: poolScenario?.scale_down_blocked_reason ?? null,
  })

  const constraint = describeConstraint(poolScenario)
  const oversizedPodCount = poolScenario?.oversized_pod_count ?? 0
  const populations = describePopulations(oversizedPodCount, activePoolConfig?.min_nodes ?? 0)
  const deltaNodes = scenario ? scenario.effective_nodes_required - (baselineScenario?.effective_nodes_required ?? scenario.effective_nodes_required) : 0
  // Cluster totals carry no blocked reason, so it is read off the pools: without
  // that, an idle cluster would total to "Hold" while every pool it sums says
  // "None". The first reason found is enough — one blocked pool withholds an
  // instruction from the sum, and this tile renders only the label.
  const totalBlockedReason = scenario
    ? Object.values(scenario.pools).find((pool) => pool.scale_down_blocked_reason)?.scale_down_blocked_reason ?? null
    : null
  const totalAction = !scenario
    ? '—'
    : caAction({
        nodesToAdd: scenario.nodes_to_add,
        nodesToRemove: scenario.nodes_to_remove,
        blockedReason: totalBlockedReason,
      }).label

  return (
    <aside className={`results-panel${stale ? ' is-stale' : ''}`}>
      <header className="results-header">
        <div><span className="eyebrow">{autoRun ? 'Live impact' : 'Simulation'}</span><h2>Capacity projection</h2></div>
        <span className={`change-chip num${stale ? ' is-stale' : ''}`}>{changeCount} change{changeCount === 1 ? '' : 's'}</span>
      </header>

      <div className="run-bar">
        <Toggle label="Auto" detail={autoRun ? 'recompute on edit' : 'manual runs'} checked={autoRun} onChange={setAutoRun} />
        {!autoRun && (
          <button className="run-button" type="button" disabled={!stale} onClick={run}>
            Run simulation<kbd>⌘↩</kbd>
          </button>
        )}
      </div>

      <nav className="segmented" aria-label="Capacity scenario">
        {SCENARIOS.map(([key, label]) => (
          <button key={key} className={scenarioName === key ? 'is-active' : ''} onClick={() => setScenarioName(key)} type="button">
            <span>{label}</span>
            <small>{comparison?.candidate_result.scenarios[key]?.pod_count ?? '—'} pods</small>
          </button>
        ))}
      </nav>

      {multiPool && (
        <>
          <div className="stat-strip stat-strip--3 pool-totals">
            <div><span>All pools</span><strong className="num">{scenario?.effective_nodes_required ?? '—'} nodes</strong><small>{scenario ? `${scenario.pod_count} pods · ${poolNames.length} pools` : 'summed target'}</small></div>
            <div><span>CA action</span><strong className="num">{totalAction}</strong><small>summed across pools</small></div>
            <div><span>Verdict</span><strong>{scenario ? (scenario.schedulable ? 'Clear' : 'Blocked') : '—'}</strong><small>{scenario && !scenario.schedulable ? 'a pool is blocked' : 'every pool fits'}</small></div>
          </div>
          <nav className="segmented segmented--pools" aria-label="Node pool">
            {poolNames.map((name) => (
              <button key={name} className={activePool === name ? 'is-active' : ''} onClick={() => setSelectedPool(name)} type="button">
                <span>{name}</span>
                <small>{scenario?.pools[name]?.effective_nodes_required ?? '—'} nodes</small>
              </button>
            ))}
          </nav>
        </>
      )}

      {scenario && poolScenario && activePoolConfig ? (
        <div className="result-content">
          <section className={`verdict verdict--${poolScenario.schedulable ? 'clear' : 'blocked'}`}>
            <div>
              <span>{multiPool ? `Verdict · ${poolScenario.pool}` : 'Scheduler verdict'}</span>
              <strong><i className="verdict-dot" />{poolScenario.schedulable ? 'Capacity clear' : 'Capacity blocked'}</strong>
              <p>{poolScenario.schedulable
                ? 'All pods fit within the autoscaler envelope.'
                : oversizedPodCount > 0
                  ? `${oversizedPodCount} pod${oversizedPodCount === 1 ? '' : 's'} request more than one whole node. No node count places them.`
                  : 'A placement constraint exceeds the configured envelope.'}</p>
            </div>
            {/* A labelled group, so the reading (`−3`, `nodes`) has a boundary a
                screen reader announces on entry instead of three loose strings after
                the verdict paragraph. `aria-labelledby` reuses the visible label, so
                the name can never drift from what is on screen — and it gives the
                end-to-end suite a way to address this tile without a test-id. */}
            <div className="verdict-action" role="group" aria-labelledby={caActionLabelId}>
              <span id={caActionLabelId}>CA action</span><b className={actionClass}>{action}</b><small>{actionNote}</small>
            </div>
          </section>

          <div className="metric-grid">
            <Metric label="Placement" value={poolScenario.nodes_required} note={populations.placement} />
            <Metric label="Effective target" value={poolScenario.effective_nodes_required} note={populations.effectiveTarget} />
            <Metric label="Headroom" value={poolScenario.node_headroom} note={`CA max ${activePoolConfig.max_nodes}`} />
            <Metric label="Constraint" value={<span className={`chip${constraint.tone === 'warn' ? ' chip--warn' : ''}`}>{constraint.label}</span>} note={constraint.note} />
          </div>

          <section className="result-section">
            <div className="result-section-heading"><span>Request saturation</span><small>{poolScenario.effective_nodes_required} × node allocatable</small></div>
            <CapacityBar label="CPU" value={poolScenario.cpu_requested_m} capacity={poolScenario.capacity_cpu_m} stranded={poolScenario.stranded_cpu_m} blocked={!poolScenario.schedulable} display={formatCpu} />
            <CapacityBar label="Memory" value={poolScenario.memory_requested_mib} capacity={poolScenario.capacity_memory_mib} stranded={poolScenario.stranded_memory_mib} blocked={!poolScenario.schedulable} display={formatMemory} />
            <BarScale />
            {poolScenario.pods_per_node !== null && (
              <p className="saturation-note">
                Provisioned capacity, not the live pool. {poolScenario.pods_per_node === 1
                  ? 'Only one pod fits per node'
                  : `${poolScenario.pods_per_node} pods fit per node`} at this shape, so the remainder cannot be
                filled without changing requests or node size.{populations.density}
              </p>
            )}
          </section>

          <section className="result-section">
            <div className="result-section-heading"><span>Node envelope</span><small>min {activePoolConfig.min_nodes} · now {poolScenario.current_nodes} · max {activePoolConfig.max_nodes}</small></div>
            <NodeMap scenario={poolScenario} maxNodes={activePoolConfig.max_nodes} />
            <div className="legend"><span><i className="node--active" /> retained</span><span><i className="node--add" /> add</span><span><i className="node--remove" /> remove</span><span><i className="node--free" /> headroom</span></div>
          </section>

          <section className="result-section">
            <div className="result-section-heading"><span>Workload projection</span><small>scenario replicas</small></div>
            <div className="projection-table">
              <div className="projection-head"><span>Workload</span><span>Now</span><span>Scenario</span></div>
              {Object.entries(candidate.workloads).map(([name, workload]) => (
                <div className="projection-row" key={name}>
                  <span>{name}</span>
                  <b>{workload.current_replicas}</b>
                  <strong>{scenario.replicas[name] ?? '…'}</strong>
                </div>
              ))}
            </div>
          </section>

          <RuntimeRisk pool={poolScenario} workloads={candidate.workloads} replicas={scenario.replicas} />

          <section className="delta-strip">
            <div><span>Baseline</span><strong>{baselineScenario?.effective_nodes_required ?? '—'} nodes</strong></div>
            <div className="delta-line"><i /><b>{deltaNodes >= 0 ? '+' : ''}{deltaNodes}</b><i /></div>
            <div><span>Candidate</span><strong>{scenario.effective_nodes_required} nodes</strong></div>
            <p className="delta-note">CA action compares this target against the {scenario.current_nodes}-node live pool; this strip compares it against the locked baseline.</p>
          </section>
        </div>
      ) : (
        <div className="loading-state"><i /><span>Running placement model…</span></div>
      )}
    </aside>
  )
}

function App() {
  // The locked comparison baseline. Reset restores the default; an import
  // promotes the imported configuration so change count starts at zero.
  const [baseline, setBaseline] = useState<ClusterConfig>(cloneBaseline)
  const [candidate, setCandidate] = useState<ClusterConfig>(baseline)
  // The config the engine last saw. Auto mode mirrors the candidate into it;
  // manual mode holds it until "Run simulation".
  const [submitted, setSubmitted] = useState<ClusterConfig>(candidate)
  const [modal, setModal] = useState<'export' | 'import' | null>(null)
  const [autoRun, setAutoRun] = useState(true)
  const [selection, setSelection] = useState<Selection>({ kind: 'workload', name: 'api' })
  const [comparison, setComparison] = useState<CompareResponse | null>(null)
  const [scenarioName, setScenarioName] = useState<ScenarioName>('hpa_desired')
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('connecting')
    // Keep the previous projection on screen while the next one computes —
    // sliders fire continuously, and flashing the loading state on every
    // tick turns the results panel into a strobe.
    const timer = window.setTimeout(() => {
      compareClusters(baseline, submitted, controller.signal)
        .then((result) => {
          setComparison(result)
          setError(null)
          setStatus('live')
        })
        .catch((reason: unknown) => {
          if (reason instanceof DOMException && reason.name === 'AbortError') return
          setError(reason instanceof Error ? reason.message : 'Unable to reach capacity engine')
          setStatus('error')
        })
    }, 160)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [baseline, submitted])

  // Auto mode: every candidate edit is submitted immediately. Turning auto
  // back on also flushes whatever accumulated while it was off.
  useEffect(() => {
    if (autoRun) setSubmitted(candidate)
  }, [autoRun, candidate])

  const stale = !autoRun && submitted !== candidate
  const runSimulation = () => setSubmitted(candidate)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !autoRun) {
        event.preventDefault()
        setSubmitted(candidate)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [autoRun, candidate])

  const updatePool = (poolName: string, patch: Partial<NodePool>) => {
    setCandidate((current) => ({
      ...current,
      node_pools: { ...current.node_pools, [poolName]: { ...current.node_pools[poolName], ...patch } },
    }))
  }

  const updateMachine = (poolName: string, patch: Partial<NodePool['machine']>) => {
    setCandidate((current) => {
      const pool = current.node_pools[poolName]
      return {
        ...current,
        node_pools: { ...current.node_pools, [poolName]: { ...pool, machine: { ...pool.machine, ...patch } } },
      }
    })
  }

  const renamePool = (oldName: string, newName: string): boolean => {
    if (newName !== oldName && newName in candidate.node_pools) return false
    if (newName === oldName) return true
    setCandidate((current) => {
      const node_pools = { ...current.node_pools }
      const pool = node_pools[oldName]
      delete node_pools[oldName]
      node_pools[newName] = { ...pool, name: newName }
      // Assignments follow the pool through a rename.
      const workloads = Object.fromEntries(
        Object.entries(current.workloads).map(([name, workload]) => [
          name,
          workload.pool === oldName ? { ...workload, pool: newName } : workload,
        ]),
      )
      return { ...current, node_pools, workloads }
    })
    setSelection({ kind: 'pool', name: newName })
    return true
  }

  const addPool = () => {
    const name = nextPoolName(candidate.node_pools)
    setCandidate((current) => {
      // Implicit single-pool assignments become explicit before a second pool
      // makes them ambiguous.
      const soleName = Object.keys(current.node_pools).length === 1 ? Object.keys(current.node_pools)[0] : null
      const workloads = soleName
        ? Object.fromEntries(
            Object.entries(current.workloads).map(([workloadName, workload]) => [
              workloadName,
              workload.pool === null ? { ...workload, pool: soleName } : workload,
            ]),
          )
        : current.workloads
      return { ...current, workloads, node_pools: { ...current.node_pools, [name]: createPool(name) } }
    })
    setSelection({ kind: 'pool', name })
  }

  const duplicatePool = (name: string) => {
    const nextName = nextPoolName(candidate.node_pools)
    setCandidate((current) => {
      const soleName = Object.keys(current.node_pools).length === 1 ? Object.keys(current.node_pools)[0] : null
      const workloads = soleName
        ? Object.fromEntries(
            Object.entries(current.workloads).map(([workloadName, workload]) => [
              workloadName,
              workload.pool === null ? { ...workload, pool: soleName } : workload,
            ]),
          )
        : current.workloads
      return {
        ...current,
        workloads,
        node_pools: {
          ...current.node_pools,
          [nextName]: { ...structuredClone(current.node_pools[name]), name: nextName },
        },
      }
    })
    setSelection({ kind: 'pool', name: nextName })
  }

  const removePool = (name: string) => {
    const poolNames = Object.keys(candidate.node_pools)
    if (poolNames.length <= 1) return
    if (Object.values(candidate.workloads).some((workload) => workload.pool === name)) return
    setCandidate((current) => {
      const node_pools = { ...current.node_pools }
      delete node_pools[name]
      return { ...current, node_pools }
    })
    setSelection({ kind: 'pool', name: poolNames.find((item) => item !== name) ?? poolNames[0] })
  }

  const updateWorkload = (name: string, updater: WorkloadUpdater) => {
    setCandidate((current) => ({
      ...current,
      workloads: { ...current.workloads, [name]: updater(current.workloads[name]) },
    }))
  }

  const renameWorkload = (oldName: string, newName: string): boolean => {
    if (newName !== oldName && newName in candidate.workloads) return false
    if (newName === oldName) return true
    setCandidate((current) => {
      const workloads = { ...current.workloads }
      const workload = workloads[oldName]
      delete workloads[oldName]
      workloads[newName] = { ...workload, name: newName }
      return { ...current, workloads }
    })
    setSelection({ kind: 'workload', name: newName })
    return true
  }

  const addWorkload = () => {
    const name = nextWorkloadName(candidate.workloads)
    const pool = selection.kind === 'pool' && selection.name in candidate.node_pools
      ? selection.name
      : Object.keys(candidate.node_pools)[0]
    setCandidate((current) => ({ ...current, workloads: { ...current.workloads, [name]: createWorkload(name, pool) } }))
    setSelection({ kind: 'workload', name })
  }

  const duplicateWorkload = (name: string) => {
    const nextName = nextWorkloadName(candidate.workloads)
    setCandidate((current) => ({
      ...current,
      workloads: { ...current.workloads, [nextName]: { ...structuredClone(current.workloads[name]), name: nextName } },
    }))
    setSelection({ kind: 'workload', name: nextName })
  }

  const removeWorkload = (name: string) => {
    if (Object.keys(candidate.workloads).length <= 1) return
    const nextSelected = Object.keys(candidate.workloads).find((item) => item !== name)
    setCandidate((current) => {
      const workloads = { ...current.workloads }
      delete workloads[name]
      return { ...current, workloads }
    })
    setSelection(nextSelected
      ? { kind: 'workload', name: nextSelected }
      : { kind: 'pool', name: Object.keys(candidate.node_pools)[0] })
  }

  const reset = () => {
    const next = cloneBaseline()
    setBaseline(next)
    setCandidate(next)
    setSubmitted(next)
    setSelection({ kind: 'workload', name: 'api' })
  }

  const applyImport = (next: ClusterConfig) => {
    setBaseline(next)
    setCandidate(next)
    setSubmitted(next)
    const firstWorkload = Object.keys(next.workloads)[0]
    setSelection(firstWorkload
      ? { kind: 'workload', name: firstWorkload }
      : { kind: 'pool', name: Object.keys(next.node_pools)[0] })
  }

  const configDiff = comparison?.configuration_diff
  const changeCount = configDiff
    ? Object.keys(configDiff.changes).length
      + configDiff.workloads_added.length
      + configDiff.workloads_removed.length
      + configDiff.node_pools_added.length
      + configDiff.node_pools_removed.length
    : 0
  const poolNames = Object.keys(candidate.node_pools)
  const selectedWorkload = selection.kind === 'workload' ? candidate.workloads[selection.name] : undefined
  // A stale selection (removed entry) falls back to the first pool.
  const selectedPool = selection.kind === 'pool'
    ? candidate.node_pools[selection.name] ?? candidate.node_pools[poolNames[0]]
    : candidate.node_pools[poolNames[0]]

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <HelmMark />
          <div className="brand-copy"><h1>KCAP</h1><p>Capacity planner</p></div>
        </div>
        <div className="topbar-center"><strong>{poolNames.length === 1 ? poolNames[0] : `${poolNames.length} node pools`}</strong> · {Object.keys(candidate.workloads).length} workloads</div>
        <div className="topbar-meta">
          <button className="topbar-button" type="button" onClick={() => setModal('export')}>Export</button>
          <button className="topbar-button" type="button" onClick={() => setModal('import')}>Import</button>
          <span className={`connection connection--${status}`}><i />{status === 'live' ? 'Live' : status === 'error' ? 'Engine offline' : 'Calculating'}</span>
          <span className="revision">Model v1.1</span>
        </div>
      </header>

      {modal === 'export' && <ExportModal config={candidate} onClose={() => setModal(null)} />}
      {modal === 'import' && <ImportModal current={candidate} onApply={applyImport} onClose={() => setModal(null)} />}

      {error && <div className="error-callout"><strong>Configuration rejected.</strong><span>{error}</span></div>}

      <main className="workspace">
        <aside className="catalog-panel">
          <div className="catalog-heading"><span>Configuration</span><button type="button" onClick={reset}>Reset</button></div>
          <div className="catalog-group">
            <div className="catalog-label-row"><span className="catalog-label">Node pools · {poolNames.length}</span><button type="button" onClick={addPool} aria-label="Add node pool">＋</button></div>
            <div className="workload-list">
              {Object.entries(candidate.node_pools).map(([name, pool]) => (
                <button
                  className={`catalog-item ${selection.kind === 'pool' && selection.name === name ? 'is-active' : ''}`}
                  type="button"
                  key={name}
                  onClick={() => setSelection({ kind: 'pool', name })}
                >
                  <strong>{name}</strong>
                  <small>{pool.current_nodes} nodes · {formatCpu(pool.machine.cpu_m)} · {formatMemory(pool.machine.memory_mib)}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="catalog-group">
            <div className="catalog-label-row"><span className="catalog-label">Workloads · {Object.keys(candidate.workloads).length}</span><button type="button" onClick={addWorkload} aria-label="Add workload">＋</button></div>
            <div className="workload-list">
              {Object.entries(candidate.workloads).map(([name, workload]) => (
                <button className={`catalog-item ${selection.kind === 'workload' && selection.name === name ? 'is-active' : ''}`} type="button" key={name} onClick={() => setSelection({ kind: 'workload', name })}>
                  <strong>{name}</strong>
                  <small>{workload.current_replicas} pods · {formatCpu(workload.resources.cpu_request_m)} · {formatMemory(workload.resources.memory_request_mib)}{poolNames.length > 1 && workload.pool ? ` · ${workload.pool}` : ''}</small>
                </button>
              ))}
            </div>
            <button className="add-workload" type="button" onClick={addWorkload}><span>＋</span>Add workload</button>
          </div>
          <div className="catalog-foot">Baseline locked — candidate edits are compared live.</div>
        </aside>

        <section className="editor-panel">
          {selectedWorkload ? (
            <WorkloadEditor
              workload={selectedWorkload}
              result={comparison?.candidate_result.workloads[selectedWorkload.name]}
              workloadCount={Object.keys(candidate.workloads).length}
              poolNames={poolNames}
              update={(updater) => updateWorkload(selectedWorkload.name, updater)}
              rename={(name) => renameWorkload(selectedWorkload.name, name)}
              duplicate={() => duplicateWorkload(selectedWorkload.name)}
              remove={() => removeWorkload(selectedWorkload.name)}
            />
          ) : (
            <PoolEditor
              pool={selectedPool}
              assignedWorkloads={Object.values(candidate.workloads).filter((workload) => workload.pool === selectedPool.name).length}
              poolCount={poolNames.length}
              updatePool={(patch) => updatePool(selectedPool.name, patch)}
              updateMachine={(patch) => updateMachine(selectedPool.name, patch)}
              rename={(name) => renamePool(selectedPool.name, name)}
              duplicate={() => duplicatePool(selectedPool.name)}
              remove={() => removePool(selectedPool.name)}
            />
          )}
        </section>

        <ResultsPanel comparison={comparison} candidate={candidate} scenarioName={scenarioName} setScenarioName={setScenarioName} changeCount={changeCount} autoRun={autoRun} setAutoRun={setAutoRun} stale={stale} run={runSimulation} />
      </main>

      <footer><span>First-fit-decreasing placement · requests drive scheduling, limits describe runtime risk.</span></footer>
    </div>
  )
}

export default App
