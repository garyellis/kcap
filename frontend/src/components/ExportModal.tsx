import { useMemo, useState } from 'react'
import type { ClusterConfig } from '../api'
import { serializeScenario } from '../importers'
import { copyTextToClipboard } from './clipboard'
import { downloadFile } from './download'
import { Modal } from './Modal'

export function ExportModal({ config, onClose }: { config: ClusterConfig; onClose: () => void }) {
  const json = useMemo(() => JSON.stringify(serializeScenario(config), null, 2), [config])
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null)

  const copy = () => {
    void copyTextToClipboard(json).then((ok) => {
      setCopied(ok ? 'ok' : 'fail')
      window.setTimeout(() => setCopied(null), 1500)
    })
  }

  return (
    <Modal title="Export scenario" onClose={onClose}>
      <p className="modal-lead">
        The current candidate configuration as a versioned kcap scenario. Paste it into the import dialog of any kcap
        instance to restore it.
      </p>
      <div className="modal-actions">
        <button type="button" className="button-primary" onClick={copy}>{copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy failed' : 'Copy JSON'}</button>
        <button type="button" className="button-secondary" onClick={() => downloadFile('kcap-scenario.json', json)}>
          Download
        </button>
      </div>
      <pre className="modal-code"><code>{json}</code></pre>
    </Modal>
  )
}
