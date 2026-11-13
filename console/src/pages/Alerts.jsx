import { useMemo } from 'react'
import { CheckIcon } from '@heroicons/react/20/solid'
import { PageHeader, DataTable, Badge, DateText, RowAction, EmptyState, Segmented } from '../components/ui'
import { api } from '../lib/api'
import { useAction, useResource } from '../lib/useResource'
import { useState } from 'react'

const SEV = { critical: 'risk', high: 'risk', medium: 'warn', low: 'ink' }

export default function Alerts() {
  const [show, setShow] = useState('open')
  const q = useResource(['alerts'], () => api.get('/api/alerts', { limit: 200 }), { refetchInterval: 30000 })
  const resolve = useAction((id) => api.post(`/api/alerts/${id}/resolve`), { invalidates: [['alerts'], ['dashboard']], success: 'Alert resolved.' })
  const rows = useMemo(() => (q.data || []).filter((a) => (show === 'open' ? !a.resolved : show === 'resolved' ? !!a.resolved : true)), [q.data, show])

  const columns = useMemo(() => [
    { id: 'sev', header: 'Severity', accessor: 'severity', filter: 'select', width: 120, mobile: 'trailing', cell: (a) => <Badge tone={SEV[a.severity] || 'ink'} glyph={a.severity === 'low' ? 'ring' : 'triangle'}>{a.severity}</Badge> },
    { id: 'title', header: 'Alert', accessor: 'title', mobile: 'title', minWidth: 260, cell: (a) => <span><span className="font-medium text-fg">{a.title}</span><span className="block text-xs text-ink-600">{a.description}</span></span> },
    { id: 'agent', header: 'Agent', accessor: 'agent_name', width: 150, mobile: 'subtitle', cell: (a) => (a.agent_name ? <span className="font-mono text-xs">{a.agent_name}</span> : <span className="text-ink-400">—</span>) },
    { id: 'type', header: 'Type', accessor: 'type', filter: 'select', width: 190, defaultHidden: true, cell: (a) => <span className="font-mono text-2xs uppercase tracking-wide text-ink-600">{a.type}</span> },
    { id: 'when', header: 'When', accessor: 'created_at', width: 170, mobile: 'meta', cell: (a) => <DateText value={a.created_at} withTime relative /> },
    { id: 'state', header: 'State', accessor: (a) => (a.resolved ? 'Resolved' : 'Open'), width: 100, cell: (a) => (a.resolved ? <span className="text-ink-500">Resolved</span> : <span className="font-medium text-warn-700">Open</span>) },
  ], [])

  return (
    <>
      <PageHeader title="Alerts" description="Things the gateway noticed that a person should know about: kill-switch use, risk blocks, financial limits." />
      <div className="mb-3"><Segmented label="Show" value={show} onChange={setShow} options={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }]} /></div>
      <DataTable viewKey="console.alerts" caption="Alerts" noun="alert" rows={rows} columns={columns} loading={q.loading} error={q.error} onRetry={q.refetch} defaultSort={{ id: 'when', dir: 'desc' }}
        rowActions={(a) => !a.resolved && <RowAction icon={CheckIcon} label={`Resolve alert: ${a.title}`} onClick={() => resolve.mutate(a.id)} />}
        empty={<EmptyState compact title={show === 'open' ? 'No open alerts' : 'No alerts'} description="Alerts appear when an agent is killed, a financial limit is hit, or the risk score blocks an action." />} />
    </>
  )
}
