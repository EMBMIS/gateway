import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader, DataTable, Segmented, Code, DateText, Button, InlineNotice, EmptyState } from '../components/ui'
import { DecisionBadge, DecisionSheet } from '../components/decision'
import { api } from '../lib/api'
import { useResource } from '../lib/useResource'
import { explanationOf } from '../lib/decisions'

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'allow', label: 'Allowed' },
  { value: 'escalate', label: 'Sent to a person' },
  { value: 'deny', label: 'Blocked' },
]

export default function Decisions() {
  const [params, setParams] = useSearchParams()
  const decision = params.get('decision') || ''
  const [limit, setLimit] = useState(200)
  const [open, setOpen] = useState(null)

  const q = useResource(['decisions', 'list', decision, limit], () => api.get('/api/audit', { kind: 'decision', decision: decision || undefined, limit }), { refetchInterval: 30000, placeholderData: (p) => p })
  const rows = q.data || []

  const columns = useMemo(() => [
    { id: 'when', header: 'When', accessor: 'timestamp', width: 170, mobile: 'meta', cell: (r) => <DateText value={r.timestamp} withTime /> },
    { id: 'decision', header: 'Decision', accessor: (r) => r.policy_decision, filter: 'select', width: 170, mobile: 'trailing', cell: (r) => <DecisionBadge row={r} /> },
    { id: 'tool', header: 'Action', accessor: 'tool', mobile: 'title', minWidth: 190, cell: (r) => <Code>{r.tool}</Code> },
    { id: 'kind', header: 'Type', accessor: 'action', filter: 'select', width: 100, cell: (r) => <span className="font-mono text-2xs uppercase tracking-wide text-ink-600">{r.action}</span> },
    { id: 'agent', header: 'Agent', accessor: 'agent_name', filter: 'select', width: 150, mobile: 'subtitle', cell: (r) => <span className="font-mono text-xs">{r.agent_name}</span> },
    { id: 'why', header: 'Why', accessor: (r) => explanationOf(r).reason || r.matched_policy_name || '', minWidth: 280, cell: (r) => <span className="line-clamp-2 text-ink-700">{explanationOf(r).reason || r.matched_policy_name || '—'}</span> },
    { id: 'policy', header: 'Policy', accessor: (r) => r.matched_policy_name || '', width: 220, defaultHidden: true, cell: (r) => r.matched_policy_name || <span className="text-ink-400">—</span> },
    { id: 'risk', header: 'Risk', accessor: 'risk_score', align: 'right', width: 80, filter: 'number', cell: (r) => <span className="tabular-nums">{r.risk_score ?? 0}</span> },
    { id: 'ms', header: 'Time', accessor: 'latency_ms', align: 'right', width: 90, defaultHidden: true, cell: (r) => <span className="tabular-nums">{Number(r.latency_ms || 0).toFixed(1)} ms</span> },
    { id: 'seq', header: 'Entry', accessor: 'seq', align: 'right', width: 80, defaultHidden: true, cell: (r) => <span className="font-mono text-xs tabular-nums">#{r.seq}</span> },
  ], [])

  return (
    <>
      <PageHeader
        title="Decisions"
        description="Everything the gateway decided for this workspace, newest first. Open one to see exactly why."
        secondary={<Button to="/decisions/audit">Audit and chain</Button>}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented label="Show" value={decision} onChange={(v) => { const n = new URLSearchParams(params); if (v) n.set('decision', v); else n.delete('decision'); setParams(n, { replace: true }) }} options={FILTERS} />
      </div>
      {q.error && <InlineNotice tone="risk" title="Decisions could not be loaded" className="mb-3" action={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</InlineNotice>}
      <DataTable
        viewKey="console.decisions"
        caption="Decisions"
        noun="decision"
        rows={rows}
        columns={columns}
        loading={q.loading}
        error={null}
        defaultSort={{ id: 'when', dir: 'desc' }}
        onRowClick={(r) => setOpen(r.id)}
        empty={<EmptyState compact title={decision ? 'No decisions of this kind yet' : 'No decisions yet'} description="Decisions appear as soon as an agent asks the gateway whether it may act." actionTo="/onboarding" actionLabel="Open the setup guide" />}
      />
      {rows.length >= limit && (
        <div className="mt-3 text-center"><Button onClick={() => setLimit((l) => Math.min(l + 200, 1000))} disabled={limit >= 1000}>{limit >= 1000 ? 'Showing the latest 1,000. Export the audit log for more.' : 'Load older decisions'}</Button></div>
      )}
      <DecisionSheet id={open} onClose={() => setOpen(null)} />
    </>
  )
}
