import { useMemo } from 'react'
import { PageHeader, Stat, Card, InlineNotice, Button, BarChart } from '../components/ui'
import { api } from '../lib/api'
import { useResource } from '../lib/useResource'
import { useAuth } from '../lib/workspace'

const PLAN_NAME = { starter: 'Free' }

/** Usage: what this workspace used this month. The Gateway is free and has no limits or checkout. */
export default function Usage() {
  const { workspace } = useAuth()
  const usage = useResource(['usage', workspace?.id], () => api.get(`/api/workspaces/${workspace.id}/usage`), { enabled: !!workspace })
  const u = usage.data
  const used = u?.current?.used ?? 0
  const limit = u?.current?.limit
  const unlimited = limit == null || !Number.isFinite(Number(limit))
  const planKey = u?.workspace?.plan || 'starter'

  const history = useMemo(() => (u?.history || []).slice().reverse().map((h) => ({ x: h.period.slice(2), y: h.api_requests })), [u])


  return (
    <>
      <PageHeader title="Usage" description="What this workspace has used this month. Self-hosted workspaces have no limits." />
      {usage.error && <InlineNotice tone="risk" title="Usage could not be loaded" className="mb-4" action={<Button size="sm" onClick={usage.refetch}>Try again</Button>}>{usage.error.message}</InlineNotice>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Plan" value={PLAN_NAME[planKey] || 'Free'} loading={usage.loading} />
        <Stat label="Checks this month" value={u ? used.toLocaleString() : '—'} loading={usage.loading} reason={u ? (unlimited ? 'No limit on this plan' : `of ${Number(limit).toLocaleString()}`) : undefined} />
        <Stat label="Blocked this month" value={u ? (u.current.blocked_requests || 0).toLocaleString() : '—'} loading={usage.loading} />
        <Stat label="Intent-analysis calls" value={u ? (u.current.llm_calls || 0).toLocaleString() : '—'} loading={usage.loading} reason={u ? `${(u.current.cache_hits || 0).toLocaleString()} answered from cache` : undefined} />
      </div>

      {history.length > 0 && <div className="mt-6"><Card title="Checks per month"><BarChart points={history} title="Checks per month" height={160} /></Card></div>}

      <p className="mt-8 text-sm text-ink-600">EMBMIS Gateway is free: no check limit, no overage and no plans to choose between.</p>
    </>
  )
}
