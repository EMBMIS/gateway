import { Link, useLocation } from 'react-router-dom'
import { CheckCircleIcon } from '@heroicons/react/20/solid'
import { PageHeader, InlineNotice, Button, Code } from '../components/ui'
import CodeBlock from '../components/CodeBlock'
import { api, BASE } from '../lib/api'
import { useResource } from '../lib/useResource'
import { useAuth } from '../lib/workspace'

/**
 * Get started. Each step is marked done from the workspace's real state, never from a stored "dismissed" flag,
 * so the list cannot claim progress that did not happen.
 */
function Step({ n, done, title, to, cta, children }) {
  return (
    <li className="flex gap-4 rounded-lg border border-ink-200 bg-surface p-4">
      <span className={done ? 'mt-0.5 shrink-0 text-ok-600' : 'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-ink-300 font-mono text-2xs text-ink-600'} aria-hidden={!done}>{done ? <CheckCircleIcon className="h-5 w-5" /> : n}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-fg">{title}{done && <span className="ml-2 font-mono text-2xs font-normal uppercase tracking-wide text-ok-700">Done</span>}</p>
        <div className="mt-1 text-sm text-ink-700">{children}</div>
        {to && !done && <div className="mt-3"><Button size="sm" variant="primary" to={to}>{cta}</Button></div>}
        {to && done && <div className="mt-3"><Button size="sm" to={to}>{cta}</Button></div>}
      </div>
    </li>
  )
}

export default function Onboarding() {
  const { state } = useLocation()
  const { workspace } = useAuth()
  const agents = useResource(['agents'], () => api.get('/api/agents'))
  const policies = useResource(['policies'], () => api.get('/api/policies'))
  const stats = useResource(['dashboard', 'stats'], () => api.get('/api/dashboard/stats'))
  const channels = useResource(['settings', 'notifications'], () => api.get(`/api/escalation/${workspace?.id}`), { enabled: !!workspace })
  const hasAgent = (agents.data || []).length > 0
  const hasPolicy = (policies.data || []).length > 0
  const hasDecision = (stats.data?.totalRequests || 0) > 0
  const hasChannel = (channels.data || []).length > 0
  const origin = `${window.location.origin}${BASE}`

  return (
    <>
      <PageHeader title="Get started" description="Five steps from an empty workspace to a decision you can explain." />
      {state?.workspaceKey && (
        <InlineNotice tone="warn" title="Your workspace key — shown once" className="mb-4">
          <p>Store it in your secret manager now; it cannot be shown again. You will mostly use agent keys instead.</p>
          <p className="mt-2 break-all rounded border border-warn-200 bg-surface px-2 py-1 font-mono text-xs text-fg select-all">{state.workspaceKey}</p>
        </InlineNotice>
      )}
      <ol className="space-y-3">
        <Step n={1} done title="Your workspace exists">{workspace?.name || 'Workspace'} is yours alone. Nothing in it is sample data.</Step>
        <Step n={2} done={hasAgent} title="Create an agent" to="/agents?new=1" cta={hasAgent ? 'Manage agents' : 'Create an agent'}>An agent is one AI that asks the gateway for decisions. You get its key once. Platforms like Business OS create theirs automatically.</Step>
        <Step n={3} done={hasPolicy} title="Write your first policy" to="/policies?new=1" cta={hasPolicy ? 'See policies' : 'Create a policy'}>Until a policy says otherwise, everything is denied. Start from what must always need a person, such as payments.</Step>
        <Step n={4} done={hasDecision} title="Send a request and read the decision" to="/decisions" cta="See decisions">
          <p>Try an action first without sending anything: <Link to="/policies/tester" className="font-medium text-brand-600 underline-offset-2 hover:underline">Policy tester</Link>. Then send a real one:</p>
          <div className="mt-2"><CodeBlock label="example request" code={`curl -X POST ${origin}/api/gateway/execute \\\n  -H "Authorization: Bearer $AGENT_KEY" -H "Content-Type: application/json" \\\n  -d '{"tool":"payment.initiate","action":"EXECUTE","args":{"amount":500,"currency":"USD"}}'`} /></div>
          <p className="mt-2 text-xs text-ink-500">Platforms that run their own tools use <Code>POST /api/v1/decide</Code> instead. See <Link to="/connect" className="underline underline-offset-2">Integration guides</Link>.</p>
        </Step>
        <Step n={5} done={hasChannel} title="Decide who is told when a person is needed" to="/settings" cta="Add Slack or email">Optional. Without it, escalations wait in the queue until someone looks.</Step>
      </ol>
    </>
  )
}
