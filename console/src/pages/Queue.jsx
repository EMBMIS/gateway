import { useMemo, useState } from 'react'
import { PageHeader, DataTable, Code, DateText, Button, InlineNotice, EmptyState, Badge, Card } from '../components/ui'
import { DecisionSheet } from '../components/decision'
import { api } from '../lib/api'
import { useAction, useResource } from '../lib/useResource'
import { explanationOf } from '../lib/decisions'

/**
 * The escalation queue: actions the gateway sent to a person. The platform that asked (for example
 * EMBMIS Business OS) is holding each one; the answer is appended to the audit chain and sent back to it.
 */
export default function Queue() {
  const q = useResource(['escalations', 'list'], () => api.get('/api/escalations'), { refetchInterval: 30000 })
  const [open, setOpen] = useState(null)
  const answer = useAction(({ traceId, outcome }) => api.post(`/api/escalations/${traceId}/resolve`, { outcome }), {
    invalidates: [['escalations'], ['decisions'], ['dashboard']],
    success: (r) => (r.outcome === 'approved' ? 'Approved. The answer is in the audit chain.' : 'Rejected. The answer is in the audit chain.'),
  })
  const rows = q.data?.open || []
  const resolved = q.data?.resolved || []

  const columns = useMemo(() => [
    { id: 'when', header: 'Asked', accessor: 'timestamp', width: 140, mobile: 'meta', cell: (r) => <DateText value={r.timestamp} withTime relative /> },
    { id: 'tool', header: 'Action', accessor: 'tool', mobile: 'title', minWidth: 170, cell: (r) => <Code>{r.tool}</Code> },
    { id: 'amount', header: 'Amount', accessor: (r) => r.context?.amount ?? null, align: 'right', width: 120, cell: (r) => (r.context?.amount != null ? <span className="tabular-nums">{Number(r.context.amount).toLocaleString()} {r.context.currency || ''}</span> : <span className="text-ink-400">—</span>) },
    { id: 'agent', header: 'Agent', accessor: 'agent_name', width: 130, defaultHidden: true, cell: (r) => <span className="font-mono text-xs">{r.agent_name}</span> },
    { id: 'why', header: 'Why a person is needed', accessor: (r) => explanationOf({ ...r, response_summary: JSON.stringify(r.summary || {}) }).reason || '', minWidth: 200, maxWidth: 320, mobile: 'subtitle', cell: (r) => <span className="line-clamp-2 text-ink-700">{r.explanation?.reason || r.summary?.reason || r.matched_policy_name || '—'}</span> },
    { id: 'risk', header: 'Risk', accessor: 'risk_score', align: 'right', width: 60, cell: (r) => <span className="tabular-nums">{r.risk_score ?? 0}</span> },
    // Visible, not hover-only: answering is the point of this screen. On a phone, tapping the card opens the same buttons.
    { id: 'answer', header: 'Answer', sortable: false, hideable: false, width: 180, cell: (r) => (
      <span className="flex gap-1" onClick={(e) => e.stopPropagation()} role="group" aria-label={`Answer ${r.tool}`}>
        <Button size="xs" variant="primary" loading={answer.isPending && answer.variables?.traceId === r.trace_id && answer.variables?.outcome === 'approved'} disabled={answer.isPending} onClick={() => answer.mutate({ traceId: r.trace_id, outcome: 'approved' })}>Approve</Button>
        <Button size="xs" variant="destructive" loading={answer.isPending && answer.variables?.traceId === r.trace_id && answer.variables?.outcome === 'rejected'} disabled={answer.isPending} onClick={() => answer.mutate({ traceId: r.trace_id, outcome: 'rejected' })}>Reject</Button>
      </span>
    ) },
  ], [answer])

  return (
    <>
      <PageHeader title="Escalation queue" description="Actions the gateway will not let through on its own. Someone has to decide." />
      {q.error && <InlineNotice tone="risk" title="The queue could not be loaded" className="mb-3" action={<Button size="sm" onClick={q.refetch}>Try again</Button>}>{q.error.message}</InlineNotice>}
      <DataTable
        viewKey="console.queue"
        caption="Escalations waiting for a person"
        noun="escalation"
        rows={rows}
        columns={columns}
        loading={q.loading}
        error={null}
        defaultSort={{ id: 'when', dir: 'desc' }}
        onRowClick={(r) => setOpen(r.id)}
        empty={<EmptyState compact title="Nothing is waiting for you" description="When a policy or the risk score says an action needs a person, it appears here until someone decides." />}
      />
      <section className="mt-8" aria-labelledby="answered-h">
        <h2 id="answered-h" className="label-mono mb-2">Recently answered</h2>
        {resolved.length === 0 ? <p className="text-sm text-ink-600">No escalations have been answered yet.</p> : (
          <Card padded={false}>
            <ul className="divide-y divide-ink-100">
              {resolved.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <Badge tone={r.outcome === 'approved' ? 'ok' : 'risk'} glyph={r.outcome === 'approved' ? 'check' : 'cross'}>{r.outcome === 'approved' ? 'Approved' : 'Rejected'}</Badge>
                  <Code>{r.tool}</Code>
                  <span className="text-ink-600">by <span className="font-mono text-xs">{r.by}</span></span>
                  {r.reason && <span className="text-ink-600">“{r.reason}”</span>}
                  <span className="ml-auto text-xs text-ink-500"><DateText value={r.resolved_at} withTime /></span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
      <DecisionSheet id={open} onClose={() => setOpen(null)} />
    </>
  )
}
