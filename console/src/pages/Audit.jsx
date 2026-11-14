import { useState } from 'react'
import { ShieldCheckIcon, ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import { PageHeader, Card, Button, InlineNotice, DescriptionList, Code, Field, Input, Select, Stat, notify } from '../components/ui'
import { api, explain, withBase } from '../lib/api'
import { useResource } from '../lib/useResource'
import { useAuth } from '../lib/workspace'

/**
 * Audit and chain. Every decision is an entry whose hash includes the previous entry's, so editing or deleting
 * any of them breaks every hash after it. "Verify" recomputes the chain from the database; it does not trust a flag.
 */
export default function Audit() {
  const { projectId } = useAuth()
  const stats = useResource(['dashboard', 'audit-stats'], () => api.get('/api/audit/stats'))
  const [verifying, setVerifying] = useState(false)
  const [result, setResult] = useState(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [ex, setEx] = useState({ format: 'csv', from: '', to: '', decision: '' })

  const verify = async () => {
    setVerifying(true)
    setResult(null)
    try { setResult({ ...(await api.get('/api/audit/verify', { limit: 100000 })), at: new Date() }) } catch (e) { setResult({ error: explain(e) }) } finally { setVerifying(false) }
  }

  const doExport = async () => {
    setExportBusy(true)
    try {
      const params = new URLSearchParams({ format: ex.format, projectId })
      if (ex.from) params.set('from', new Date(ex.from).toISOString())
      if (ex.to) params.set('to', new Date(`${ex.to}T23:59:59`).toISOString())
      if (ex.decision) params.set('decision', ex.decision)
      const res = await fetch(withBase(`/api/audit/export?${params}`), { credentials: 'include' })
      if (res.status === 402) { const j = await res.json().catch(() => ({})); notify.error(j.error || 'Audit export is part of a paid plan. See Usage for plans.'); return }
      if (!res.ok) { notify.error(`The export failed (${res.status}). Try again, or narrow the dates.`); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `embmis-gateway-audit-${new Date().toISOString().slice(0, 10)}.${ex.format}`
      a.click()
      URL.revokeObjectURL(url)
    } finally { setExportBusy(false) }
  }

  const s = stats.data
  return (
    <>
      <PageHeader title="Audit and chain" description="A tamper-evident record of every decision and every answer a person gave." primary={<Button variant="primary" icon={ShieldCheckIcon} loading={verifying} onClick={verify}>Verify the chain</Button>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Entries" value={s ? s.totalActions.toLocaleString() : '—'} loading={stats.loading} footnote="Decisions in this workspace" />
        <Stat label="Allowed" value={s ? s.approved.toLocaleString() : '—'} loading={stats.loading} />
        <Stat label="Blocked" value={s ? s.denied.toLocaleString() : '—'} loading={stats.loading} />
        <Stat label="Sent to a person" value={s ? s.escalated.toLocaleString() : '—'} loading={stats.loading} />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card title="Chain verification" description="Recomputes every hash from the stored entries and checks each link.">
          {!result && !verifying && <p className="text-sm text-ink-600">Not run in this session. Verification reads the whole log, so it is on demand.</p>}
          {verifying && <p className="text-sm text-ink-600" role="status">Verifying…</p>}
          {result?.error && <InlineNotice tone="risk" title="Verification could not run">{result.error}</InlineNotice>}
          {result && !result.error && (
            <div className="space-y-3">
              <InlineNotice tone={result.valid ? 'ok' : 'risk'} icon={ShieldCheckIcon} title={result.valid ? 'The chain is intact' : `The chain is broken (${result.errors.length} ${result.errors.length === 1 ? 'problem' : 'problems'})`}>
                {result.valid ? `${result.entriesChecked.toLocaleString()} entries were checked and every hash matches the one before it.` : 'An entry was changed or removed after it was written. The first break is listed below; every entry after it can no longer be trusted.'}
              </InlineNotice>
              <DescriptionList columns={1} items={[
                { label: 'Entries checked', value: result.entriesChecked.toLocaleString() },
                { label: 'Head hash', value: <Code className="break-all">{result.lastHash}</Code> },
                { label: 'Checked at', value: result.at.toLocaleString() },
              ]} />
              {!result.valid && (
                <ul className="space-y-1 text-sm text-risk-800">
                  {result.errors.slice(0, 5).map((e, i) => <li key={i}>Entry #{e.seq}: {e.error}</li>)}
                </ul>
              )}
              <p className="text-xs text-ink-500">The whole gateway is verified, not only this workspace, because the chain is shared. Checkpoints are written every 100 entries to logs/audit-checkpoints.log; keep a copy outside the server to detect a rewritten log.</p>
            </div>
          )}
        </Card>

        <Card title="Export" description="For auditors. Includes each entry's hashes so the file can be checked independently.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Format"><Select value={ex.format} onChange={(e) => setEx({ ...ex, format: e.target.value })}><option value="csv">CSV</option><option value="json">JSON</option></Select></Field>
            <Field label="Decision"><Select value={ex.decision} onChange={(e) => setEx({ ...ex, decision: e.target.value })}><option value="">All</option><option value="allow">Allowed</option><option value="deny">Blocked</option><option value="escalate">Sent to a person</option></Select></Field>
            <Field label="From"><Input type="date" value={ex.from} onChange={(e) => setEx({ ...ex, from: e.target.value })} /></Field>
            <Field label="To"><Input type="date" value={ex.to} onChange={(e) => setEx({ ...ex, to: e.target.value })} /></Field>
          </div>
          <div className="mt-4"><Button icon={ArrowDownTrayIcon} loading={exportBusy} onClick={doExport}>Download</Button></div>
        </Card>
      </div>
    </>
  )
}
