import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { evaluateCluster } from '../api'
import type { ClusterConfig } from '../api'
import { buildExportScript, parseImport, planClusterImport, UNPINNED_GROUP } from '../importers'
import type { ClusterImportPlan, ParsedImport, SelectorGroup } from '../importers'
import { copyTextToClipboard } from './clipboard'
import { downloadFile } from './download'
import { Toggle } from './Fields'
import { Modal } from './Modal'

function describeSelector(group: SelectorGroup): string {
  if (group.key === UNPINNED_GROUP) return 'No node selector'
  return Object.entries(group.selector ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')
}

function GroupRow({
  group,
  plan,
  onAssign,
}: {
  group: SelectorGroup
  plan: ClusterImportPlan
  onAssign: (groupKey: string, pool: string) => void
}) {
  const resolved = plan.groupPools[group.key]
  const needsChoice = resolved === null
  // A silently resolved sole pool reads as text; only an open choice renders
  // the dropdown.
  return (
    <div className="import-group">
      <div className="import-group-copy">
        <strong>{describeSelector(group)}</strong>
        <small>{group.workloads.length} workload{group.workloads.length === 1 ? '' : 's'}</small>
      </div>
      {needsChoice ? (
        <select value="" onChange={(event) => onAssign(group.key, event.target.value)} aria-label={`Pool for ${describeSelector(group)}`}>
          <option value="" disabled>Choose pool…</option>
          {plan.poolChoices.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      ) : (
        <span className="chip">{resolved}</span>
      )}
    </div>
  )
}

function ClusterPreview({
  current,
  plan,
  hasNodes,
  createPools,
  setCreatePools,
  mode,
  setMode,
  onAssign,
}: {
  current: ClusterConfig
  plan: ClusterImportPlan
  hasNodes: boolean
  createPools: boolean
  setCreatePools: (value: boolean) => void
  mode: 'merge' | 'replace'
  setMode: (value: 'merge' | 'replace') => void
  onAssign: (groupKey: string, pool: string) => void
}) {
  const workloadCount = Object.keys(plan.transform.workloads).length
  return (
    <>
      <div className="import-controls">
        <nav className="segmented segmented--modal" aria-label="Import mode">
          <button type="button" className={mode === 'merge' ? 'is-active' : ''} onClick={() => setMode('merge')}>
            <span>Merge</span><small>upsert by name</small>
          </button>
          <button type="button" className={mode === 'replace' ? 'is-active' : ''} onClick={() => setMode('replace')}>
            <span>Replace</span><small>swap workloads</small>
          </button>
        </nav>
        {hasNodes && (
          <Toggle
            label="Create node pools from cluster"
            detail={createPools ? `${Object.keys(plan.derived?.pools ?? {}).length} pool${Object.keys(plan.derived?.pools ?? {}).length === 1 ? '' : 's'} derived` : 'assign to existing pools'}
            checked={createPools}
            onChange={setCreatePools}
          />
        )}
      </div>

      <div className="import-groups">
        {plan.transform.groups.map((group) => (
          <GroupRow key={group.key} group={group} plan={plan} onAssign={onAssign} />
        ))}
      </div>

      {plan.transform.carried.length > 0 && (
        <div className="note">
          <strong>No requests in the export.</strong> Kept the values already configured
          for {plan.transform.carried.join(', ')}.
        </div>
      )}
      {plan.transform.bestEffort.length > 0 && (
        <div className="callout callout--warn">
          <strong>BestEffort workloads.</strong> {plan.transform.bestEffort.join(', ')} request no resources anywhere,
          so they import at 1m CPU / 1 MiB memory — a pod slot with no reserved capacity. Adjust the requests if they
          should claim real capacity.
        </div>
      )}
      {plan.warnings.map((warning) => (
        <div className="callout callout--warn" key={warning}><strong>Heads up.</strong> {warning}</div>
      ))}
      {plan.notes.map((note) => <div className="note" key={note}>{note}</div>)}

      {plan.counts && (
        <div className="stat-strip stat-strip--4 import-counts">
          <div><span>Adds</span><strong className="num">{plan.counts.adds.length}</strong><small>new workloads</small></div>
          <div><span>Updates</span><strong className="num">{plan.counts.updates.length}</strong><small>upserted by name</small></div>
          <div><span>Removes</span><strong className="num">{plan.counts.removes.length}</strong><small>{mode === 'replace' ? 'not in the export' : 'merge keeps all'}</small></div>
          <div><span>Pools created</span><strong className="num">{plan.counts.poolsCreated.length}</strong><small>of {Object.keys(current.node_pools).length} existing</small></div>
        </div>
      )}
      {workloadCount > 0 && plan.unassigned.length > 0 && (
        <div className="note">Assign a pool to every workload group above to enable the import.</div>
      )}
    </>
  )
}

function ScenarioPreview({ current, config }: { current: ClusterConfig; config: ClusterConfig }) {
  const incomingWorkloads = Object.keys(config.workloads ?? {})
  const incomingPools = Object.keys(config.node_pools ?? {})
  return (
    <>
      <div className="note">
        <strong>Scenario import replaces everything.</strong> The current {Object.keys(current.workloads).length} workload{Object.keys(current.workloads).length === 1 ? '' : 's'} and {Object.keys(current.node_pools).length} pool{Object.keys(current.node_pools).length === 1 ? '' : 's'} are
        swapped for the imported configuration.
      </div>
      <div className="stat-strip stat-strip--4 import-counts">
        <div><span>Workloads in</span><strong className="num">{incomingWorkloads.length}</strong><small>{incomingWorkloads.slice(0, 3).join(', ')}{incomingWorkloads.length > 3 ? '…' : ''}</small></div>
        <div><span>Pools in</span><strong className="num">{incomingPools.length}</strong><small>{incomingPools.slice(0, 3).join(', ')}{incomingPools.length > 3 ? '…' : ''}</small></div>
        <div><span>Workloads out</span><strong className="num">{Object.keys(current.workloads).length}</strong><small>replaced</small></div>
        <div><span>Pools out</span><strong className="num">{Object.keys(current.node_pools).length}</strong><small>replaced</small></div>
      </div>
    </>
  )
}

export function ImportModal({
  current,
  onApply,
  onClose,
}: {
  current: ClusterConfig
  onApply: (next: ClusterConfig) => void
  onClose: () => void
}) {
  const [namespace, setNamespace] = useState('')
  const [selector, setSelector] = useState('')
  const [skipZeroReplicas, setSkipZeroReplicas] = useState(true)
  const [scriptCopied, setScriptCopied] = useState<'ok' | 'fail' | null>(null)

  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<ParsedImport | null>(null)

  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [createPools, setCreatePools] = useState(true)
  const [assignments, setAssignments] = useState<Record<string, string>>({})
  const [commitError, setCommitError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  const script = useMemo(
    () => buildExportScript(namespace, selector, skipZeroReplicas),
    [namespace, selector, skipZeroReplicas],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setParsed(text.trim() ? parseImport(text) : null)
      setCommitError(null)
    }, 200)
    return () => window.clearTimeout(timer)
  }, [text])

  const plan = useMemo(
    () => (parsed?.kind === 'cluster' ? planClusterImport(current, parsed.data, { mode, createPools, assignments }) : null),
    [parsed, current, mode, createPools, assignments],
  )

  const copyScript = () => {
    void copyTextToClipboard(script).then((ok) => {
      setScriptCopied(ok ? 'ok' : 'fail')
      window.setTimeout(() => setScriptCopied(null), 1500)
    })
  }

  const readFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) file.text().then(setText)
    event.target.value = ''
  }

  const commit = (next: ClusterConfig) => {
    setApplying(true)
    setCommitError(null)
    // The evaluate endpoint is the validation gate: nothing is applied until
    // the backend accepts the configuration.
    evaluateCluster(next)
      .then(() => {
        onApply(next)
        onClose()
      })
      .catch((reason: unknown) => {
        setCommitError(reason instanceof Error ? reason.message : 'Import rejected by the capacity engine')
      })
      .finally(() => setApplying(false))
  }

  const commitConfig = parsed?.kind === 'scenario' ? parsed.config : plan?.config ?? null
  const commitLabel = parsed?.kind === 'scenario' ? 'Replace configuration' : mode === 'merge' ? 'Merge into configuration' : 'Replace workloads'

  return (
    <Modal title="Import" onClose={onClose}>
      <section className="import-step">
        <div className="import-step-head"><span className="chip">Step 1</span><h3>Generate a capacity export script</h3></div>
        <p className="modal-lead">
          Run this against your cluster to capture workload shapes, HPAs, scheduling constraints, node capacity, and
          observed pod usage when metrics-server is available.
          It reads no env vars, images, annotations, or secrets, and writes <code>kcap-export.json</code>.
          Zero-replica workloads (e.g. originals parked at 0 by Flagger) and their HPAs are skipped unless
          the toggle below is off.
        </p>
        <div className="import-inputs">
          <label className="field">
            <span className="field-label">Namespace</span>
            <span className="field-input-wrap">
              <input type="text" value={namespace} placeholder="all namespaces" onChange={(event) => setNamespace(event.target.value)} />
            </span>
          </label>
          <label className="field">
            <span className="field-label">Label selector</span>
            <span className="field-input-wrap">
              <input type="text" value={selector} placeholder="e.g. team=payments" onChange={(event) => setSelector(event.target.value)} />
            </span>
          </label>
          <Toggle
            label="Skip zero-replica workloads"
            detail={skipZeroReplicas ? 'drops workloads at 0 and their HPAs' : 'capture everything'}
            checked={skipZeroReplicas}
            onChange={setSkipZeroReplicas}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="button-primary" onClick={copyScript}>{scriptCopied === 'ok' ? 'Copied' : scriptCopied === 'fail' ? 'Copy failed' : 'Copy script'}</button>
          <button type="button" className="button-secondary" onClick={() => downloadFile('kcap-export.sh', script, 'text/x-shellscript')}>
            Download .sh
          </button>
        </div>
        <pre className="modal-code modal-code--script"><code>{script}</code></pre>
      </section>

      <section className="import-step">
        <div className="import-step-head"><span className="chip">Step 2</span><h3>Paste or upload the export</h3></div>
        <textarea
          className="import-text"
          // The heading above it is the only thing naming this box, and a heading is
          // not a label — the control announced nothing. Naming it also gives the
          // end-to-end suite a real `getByLabel` handle instead of a placeholder match.
          aria-label="Paste or upload the export"
          value={text}
          placeholder="Paste kcap-export.json or a kcap scenario here…"
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
        />
        <label className="import-file">
          <input type="file" accept=".json,application/json" onChange={readFile} />
          <span>…or choose a file</span>
        </label>
      </section>

      <section className="import-step">
        <div className="import-step-head"><span className="chip">Step 3</span><h3>Preview and commit</h3></div>
        {parsed === null && <div className="note">The preview appears once something is pasted above.</div>}
        {parsed?.kind === 'error' && (
          <div className="callout callout--bad"><strong>Cannot import.</strong> {parsed.message}</div>
        )}
        {parsed?.kind === 'scenario' && <ScenarioPreview current={current} config={parsed.config} />}
        {parsed?.kind === 'cluster' && plan && (
          <ClusterPreview
            current={current}
            plan={plan}
            hasNodes={parsed.data.nodes !== null && parsed.data.nodes.length > 0}
            createPools={createPools}
            setCreatePools={setCreatePools}
            mode={mode}
            setMode={setMode}
            onAssign={(groupKey, pool) => setAssignments((rest) => ({ ...rest, [groupKey]: pool }))}
          />
        )}
        {commitError && <div className="callout callout--bad"><strong>Configuration rejected.</strong> {commitError}</div>}
        {commitConfig && (
          <div className="modal-actions modal-actions--commit">
            <button type="button" className="button-primary" disabled={applying} onClick={() => commit(commitConfig)}>
              {applying ? 'Validating…' : commitLabel}
            </button>
            <span className="import-commit-note">Validated by the engine, then locked in as the new baseline.</span>
          </div>
        )}
      </section>
    </Modal>
  )
}
