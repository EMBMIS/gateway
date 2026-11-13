import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRightIcon } from '@heroicons/react/20/solid'
import { PageHeader, Stat, Card, DataTable, EmptyState, ErrorState, InlineNotice, DateText, Code, Badge, Button } from '../components/ui'
import { DecisionBadge } from '../components/decision'
import { api } from '../lib/api'
import { useResource } from '../lib/useResource'
import { useLive } from '../lib/live'
import { useAuth } from '../lib/workspace'

const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—')

function LiveFeed() {
  const { status, events } = useLive()
  const rows = events.filter((e) => e.type === 'request').slice(0, 12)
  return (
    <Card title="Live decisions" description={status === 'live' ? 'Decisions appear here as they happen.' : 'The live feed is not connected. The table below still refreshes every half minute.'} padded={false}>
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-ink-600">{status === 'live' ? 'Waiting for the next decision. Nothing has arrived since you opened this page.' : 'No live feed.'}</p>
      ) : (
        <ul className="divide-y divide-ink-100" aria-live="polite">
          {rows.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <DecisionBadge decision={e.data.decision} />
              <span className="min-w-0 flex-1 truncate"><Code>{e.data.tool}</Code> <span className="text-ink-500">by</span> <span className="font-mono text-xs">{e.data.agent}</span></span>
              <span className="hidden font-mono text-xs tabular-nums text-ink-500 sm:inline" title="Risk score">risk {e.data.risk ?? '—'}</span>
              <span className="hidden text-xs text-ink-500 sm:inline"><DateText value={e.timestamp} withTime /></span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export default function Dashboard() {
  const { workspace } = useAuth()
  const stats = useResource(['dashboard', 'stats'], () => api.get('/api/dashboard/stats'), { refetchInterval: 30000 })
  const recent = useResource(['decisions', 'recent'], () => api.get('/api/audit', { limit: 8 }), { refetchInterval: 30000 })
  const queue = useResource(['escalations', 'count'], () => api.get('/api/escalations', { limit: 100 }), { refetchInterval: 30000 })
  const enclave = useResource(['dashboard', 'enclave'], () => api.get('/health/enclave').catch((e) => (e.status === 503 ? { status: 'degraded', healthyWorkers: 0, poolSize: 0 } : Promise.reject(e))), { refetchInterval: 30000, retry: false })
  const s = stats.data
  const open = queue.data?.open?.length || 0
  const empty = s && s.totalRequests === 0

  const columns = useMemo(() => [
    { id: 'when', header: 'When', accessor: 'timestamp', width: 170, mobile: 'meta', cell: (r) => <DateText value={r.timestamp} withTime /> },
    { id: 'decision', header: 'Decision', accessor: 'policy_decision', width: 170, mobile: 'trailing', cell: (r) => <DecisionBadge row={r} /> },
    { id: 'tool', header: 'Action', accessor: 'tool', mobile: 'title', cell: (r) => <Code>{r.tool}</Code> },
    { id: 'agent', header: 'Agent', accessor: 'agent_name', mobile: 'subtitle', cell: (r) => <span className="font-mono text-xs">{r.agent_name}</span> },
    { id: 'risk', header: 'Risk', accessor: 'risk_score', align: 'right', width: 80, cell: (r) => <span className="tabular-nums">{r.risk_score ?? 0}</span> },
  ], [])

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={workspace ? `Decisions for ${workspace.name}. Every action your AI agents propose is checked before it runs.` : 'Every action your AI agents propose is checked before it runs.'}
        secondary={<Button to="/policies/tester">Test an action</Button>}
        primary={<Button variant="primary" to="/onboarding">Get started</Button>}
      />

      {stats.error && <ErrorState error={stats.error} what="The dashboard figures" onRetry={stats.refetch} className="mb-4" />}

      {open > 0 && (
        <InlineNotice tone="warn" title={`${open} ${open === 1 ? 'action is' : 'actions are'} waiting for a person`} className="mb-4" action={<Button size="sm" to="/decisions/queue" iconRight={ArrowRightIcon}>Open the queue</Button>}>
          The platforms that asked are holding them until you approve or reject.
        </InlineNotice>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Decisions" value={s ? s.totalRequests.toLocaleString() : '—'} loading={stats.loading} to="/decisions" footnote="All time, this workspace" />
        <Stat label="Allowed" value={s ? s.approved.toLocaleString() : '—'} loading={stats.loading} reason={s ? `${pct(s.approved, s.totalRequests)} of decisions` : undefined} to="/decisions?decision=allow" />
        <Stat label="Blocked" value={s ? s.denied.toLocaleString() : '—'} loading={stats.loading} reason={s ? `${pct(s.denied, s.totalRequests)} of decisions` : undefined} to="/decisions?decision=deny" />
        <Stat label="Sent to a person" value={s ? s.escalated.toLocaleString() : '—'} loading={stats.loading} reason={s ? `${open} still waiting` : undefined} to="/decisions/queue" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active agents" value={s ? s.activeAgents.toLocaleString() : '—'} loading={stats.loading} to="/agents" />
        <Stat label="Average risk" value={s ? `${s.avgRiskScore} / 100` : '—'} loading={stats.loading} footnote="Across all decisions" />
        <Stat label="Average check time" value={s ? `${s.avgLatencyMs} ms` : '—'} loading={stats.loading} footnote="Gateway time per decision" />
        <Stat label="Open alerts" value={s ? s.activeAlerts.toLocaleString() : '—'} loading={stats.loading} to="/alerts" />
      </div>

      {empty && (
        <div className="mt-6">
          <EmptyState title="No decisions yet" description="As soon as an agent asks the gateway whether it may act, the decision shows up here with its reason. Create an agent and send a first request to see it." actionTo="/onboarding" actionLabel="Open the setup guide" />
        </div>
      )}

      {!empty && (
        <div className="mt-6 grid gap-4 xl:grid-cols-2">
          <LiveFeed />
          <Card title="Execution workers" description="The isolated processes that run approved actions on the execute path." >
            {enclave.error ? <p className="text-sm text-ink-600">Worker status could not be read.</p> : (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Badge tone={enclave.data?.status === 'ok' ? 'ok' : 'warn'} glyph={enclave.data?.status === 'ok' ? 'check' : 'triangle'}>{enclave.data?.status === 'ok' ? 'Healthy' : 'Degraded'}</Badge>
                <span className="text-ink-700">{enclave.data ? `${enclave.data.healthyWorkers} of ${enclave.data.poolSize} workers healthy` : '—'}</span>
                <span className="text-xs text-ink-500">Decide-only calls (the v1 API) do not use workers.</span>
              </div>
            )}
          </Card>
        </div>
      )}

      {!empty && (
        <section className="mt-6" aria-labelledby="recent-h">
          <div className="mb-2 flex items-center justify-between"><h2 id="recent-h" className="label-mono">Latest decisions</h2><Link to="/decisions" className="text-sm font-medium text-brand-600 underline-offset-2 hover:underline">See all</Link></div>
          <DataTable viewKey="console.dashboard.recent" caption="Latest decisions" noun="decision" search={false} rows={recent.data || []} columns={columns} loading={recent.loading} error={recent.error} onRetry={recent.refetch} onRowClick={() => {}} rowHref={() => '/decisions'} />
        </section>
      )}
    </>
  )
}
