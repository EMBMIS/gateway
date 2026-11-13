import { Link } from 'react-router-dom'
import { CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid'
import { PageHeader, Card, Stat, DescriptionList, Code, DateText, Button, InlineNotice, Skeleton } from '../components/ui'
import { api } from '../lib/api'
import { useResource } from '../lib/useResource'

function Control({ ok, title, children, to }) {
  const Icon = ok ? CheckCircleIcon : ExclamationTriangleIcon
  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon className={ok ? 'mt-0.5 h-5 w-5 shrink-0 text-ok-600' : 'mt-0.5 h-5 w-5 shrink-0 text-warn-600'} aria-hidden="true" />
      <div className="min-w-0 flex-1"><p className="text-sm font-medium text-fg">{title}<span className="sr-only"> — {ok ? 'in place' : 'needs attention'}</span></p><p className="mt-0.5 text-sm text-ink-600">{children}</p></div>
      {to && <Link to={to} className="shrink-0 text-sm font-medium text-brand-600 underline-offset-2 hover:underline">Open</Link>}
    </li>
  )
}

/**
 * Compliance, honestly: what this gateway is actually doing, read from its own configuration,
 * and the evidence an auditor can export. No certification is claimed on its behalf.
 */
export default function Compliance() {
  const sys = useResource(['system'], () => api.get('/api/system/status'))
  const stats = useResource(['dashboard', 'audit-stats'], () => api.get('/api/audit/stats'))
  const s = sys.data
  const a = stats.data

  return (
    <>
      <PageHeader title="Compliance" description="What this gateway is enforcing right now, and the evidence you can hand to an auditor." secondary={<Button to="/compliance/vault">Data vault</Button>} primary={<Button variant="primary" to="/decisions/audit">Verify and export</Button>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Audit entries" value={a ? a.totalActions.toLocaleString() : '—'} loading={stats.loading} footnote="Hash-chained, append-only" to="/decisions/audit" />
        <Stat label="Blocked" value={a ? a.denied.toLocaleString() : '—'} loading={stats.loading} reason={a && a.totalActions ? `${((a.denied / a.totalActions) * 100).toFixed(1)}% of decisions` : undefined} />
        <Stat label="Sent to a person" value={a ? a.escalated.toLocaleString() : '—'} loading={stats.loading} reason={a && a.totalActions ? `${((a.escalated / a.totalActions) * 100).toFixed(1)}% of decisions` : undefined} to="/decisions/queue" />
        <Stat label="Average risk" value={a ? `${a.averageRiskScore} / 100` : '—'} loading={stats.loading} />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title="Controls in force" description="Read from the running gateway, not from a checklist." padded={false}>
          {sys.loading && <div className="space-y-2 p-4"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-3/5" /></div>}
          {sys.error && <div className="p-4"><InlineNotice tone="risk" title="The system status could not be read">{sys.error.message}</InlineNotice></div>}
          {s && (
            <ul className="divide-y divide-ink-100">
              <Control ok={!!s.bundle?.signatureVerified} title="Policy bundle is signed and verified">{s.bundle?.signatureVerified ? 'The gateway refuses to start if the signature, the revocation list or the version check fails.' : `The bundle did not verify: ${s.bundle?.error || 'unknown'}.`}</Control>
              <Control ok title="Fail closed">An action that matches no policy is denied. A platform that cannot reach the gateway decides its own fail mode; Business OS defaults to closed.</Control>
              <Control ok title="Every decision is audited">Each decision, and each answer a person gives to an escalation, is appended to a hash chain you can verify.</Control>
              <Control ok={s.accessControl} title="The console API requires a sign-in">{s.accessControl ? 'Management calls need a session and are scoped to the workspace.' : 'This gateway is running without access control (development). Production turns it on automatically.'}</Control>
              <Control ok={s.platformKeys > 0} title="Platform key issued" to="/connect">{s.platformKeys > 0 ? `${s.platformKeys} platform ${s.platformKeys === 1 ? 'key is' : 'keys are'} configured. Only a platform key can register tenants.` : 'None configured. Platforms such as Business OS cannot register until you run npm run platform-key.'}</Control>
              <Control ok={s.llm?.configured} title="Intent analysis">{s.llm?.configured ? `A language model (${s.llm.model}) reads each request for intent the rules cannot see.` : 'Off: no language model is connected. Decisions use policies and risk scoring only.'}</Control>
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Signed policy bundle">
            {s?.bundle?.signatureVerified ? (
              <DescriptionList columns={1} items={[
                { label: 'Version', value: <span className="tabular-nums">v{s.bundle.version}</span> },
                { label: 'Hash', value: <Code className="break-all">{s.bundle.hash}</Code> },
                { label: 'Signing key', value: <Code>{s.bundle.keyId}</Code> },
                { label: 'Compiled', value: s.bundle.createdAt ? <DateText value={s.bundle.createdAt} withTime /> : null },
              ]} />
            ) : <p className="text-sm text-ink-600">{sys.loading ? 'Loading…' : 'No verified bundle.'}</p>}
          </Card>
          <Card title="Evidence">
            <ul className="space-y-2 text-sm text-ink-700">
              <li>Audit export (CSV or JSON) with every entry's hashes: <Link to="/decisions/audit" className="font-medium text-brand-600 underline-offset-2 hover:underline">Audit and chain</Link>.</li>
              <li>Chain checkpoints are written every 100 entries to <Code>logs/audit-checkpoints.log</Code>. Keep a copy off the server.</li>
              <li>Each decision explains itself: policy, risk factors, intent, audit hash.</li>
            </ul>
            <p className="mt-3 text-xs text-ink-500">EMBMIS does not claim a certification on this page. Whether your use meets a regulation is for you and your auditor.</p>
          </Card>
        </div>
      </div>
    </>
  )
}
