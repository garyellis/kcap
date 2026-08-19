import { useMemo, useState } from 'react'
import type { ClusterConfig } from '../api'
import { serializeScenario } from '../importers'
import { downloadFile } from './download'
import { Modal } from './Modal'

export function ExportModal({ config, onClose }: { config: ClusterConfig; onClose: () => void }) {
  const json = useMemo(() => JSON.stringify(serializeScenario(config), null, 2), [config])
  const [copied, setCopied] = useState(false)

  const copy = () => {
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <Modal title="Export scenario" onClose={onClose}>
      <p className="modal-lead">
        The current candidate configuration as a versioned kcap scenario. Paste it into the import dialog of any kcap
        instance to restore it.
      </p>
      <div className="modal-actions">
        <button type="button" className="button-primary" onClick={copy}>{copied ? 'Copied' : 'Copy JSON'}</button>
        <button type="button" className="button-secondary" onClick={() => downloadFile('kcap-scenario.json', json)}>
          Download
        </button>
      </div>
      <pre className="modal-code"><code>{json}</code></pre>
    </Modal>
  )
}
