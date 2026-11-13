import { useMemo, useState } from 'react'
import { TrashIcon } from '@heroicons/react/20/solid'
import { PageHeader, Tabs, Card, Button, Field, Input, Select, Switch, InlineNotice, DescriptionList, Code, DataTable, RowAction, ErrorSummary, Badge, notify } from '../components/ui'
import { api, explain } from '../lib/api'
import { useAction, useResource } from '../lib/useResource'
import { useAuth } from '../lib/workspace'

function Workspace() {
  const { user, workspace } = useAuth()
  const sys = useResource(['system'], () => api.get('/api/system/status'))
  const s = sys.data
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Workspace">
        <DescriptionList columns={1} items={[
          { label: 'Name', value: workspace?.name },
          { label: 'Workspace id', value: <Code>{workspace?.id}</Code> },
          { label: 'Signed in as', value: user?.email },
          { label: 'Role', value: user?.role },
        ]} />
        <p className="mt-3 text-xs text-ink-500">Tenants that platforms register through the API each get their own workspace; they appear to an operator, not here.</p>
      </Card>
      <Card title="This gateway">
        {sys.loading ? <p className="text-sm text-ink-600">Loading…</p> : s ? (
          <DescriptionList columns={1} items={[
            { label: 'Version', value: s.version },
            { label: 'Mode', value: s.mode },
            { label: 'Environment', value: s.environment },
            { label: 'Database', value: s.database },
            { label: 'Policy bundle', value: s.bundle?.signatureVerified ? `v${s.bundle.version}, verified` : 'Not verified' },
          ]} />
        ) : <p className="text-sm text-ink-600">The system status could not be read.</p>}
      </Card>
    </div>
  )
}

function Notifications() {
  const { projectId } = useAuth()
  const path = `/api/escalation/${projectId}`
  const q = useResource(['settings', 'notifications'], () => api.get(path))
  const [form, setForm] = useState({ channel: 'slack', slackWebhookUrl: '', smtpUrl: '', emailFrom: '', emailTo: '', minSeverity: 'high', enabled: true })
  const [errors, setErrors] = useState({})
  const save = useAction((body) => api.post(path, body), { invalidates: [['settings', 'notifications']], silent: true })
  const del = useAction((id) => api.del(`/api/escalation/config/${id}`), { invalidates: [['settings', 'notifications']], silent: true })
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const existing = (q.data || []).find((c) => c.channel === form.channel)

  const submit = async (e) => {
    e.preventDefault()
    const errs = {}
    if (form.channel === 'slack' && !existing?.has_slack_webhook && !/^https:\/\/hooks\.slack\.com\//.test(form.slackWebhookUrl)) errs.slack = 'Paste the Slack incoming webhook URL (it starts with https://hooks.slack.com/).'
    if (form.channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.emailTo)) errs.to = 'Enter the address that should receive alerts.'
    if (form.channel === 'email' && !existing?.has_smtp && !/^smtps?:\/\//.test(form.smtpUrl)) errs.smtp = 'Enter the SMTP URL, for example smtp://user:pass@mail.example.com:587.'
    setErrors(errs)
    if (Object.keys(errs).length) return
    try { await save.mutateAsync({ ...form, enabled: form.enabled }); notify.success('Notification channel saved.'); setForm({ ...form, slackWebhookUrl: '', smtpUrl: '' }) } catch (err) { notify.error(explain(err)) }
  }

  const columns = useMemo(() => [
    { id: 'channel', header: 'Channel', accessor: 'channel', mobile: 'title', cell: (c) => <span className="font-medium capitalize text-fg">{c.channel}</span> },
    { id: 'to', header: 'Goes to', accessor: (c) => (c.channel === 'slack' ? c.slack_webhook_url : c.email_to), mobile: 'subtitle', cell: (c) => <span className="font-mono text-xs">{c.channel === 'slack' ? c.slack_webhook_url || '—' : c.email_to || '—'}</span> },
    { id: 'sev', header: 'From severity', accessor: 'min_severity', width: 130, cell: (c) => c.min_severity },
    { id: 'on', header: 'State', accessor: (c) => (c.enabled ? 'On' : 'Off'), width: 90, mobile: 'trailing', cell: (c) => <Badge tone={c.enabled ? 'ok' : 'ink'}>{c.enabled ? 'On' : 'Off'}</Badge> },
  ], [])

  return (
    <div className="space-y-4">
      <DataTable viewKey="console.notifications" caption="Notification channels" noun="channel" search={false} rows={q.data || []} columns={columns} loading={q.loading} error={q.error} onRetry={q.refetch}
        rowActions={(c) => <RowAction icon={TrashIcon} tone="risk" label={`Remove the ${c.channel} channel`} onClick={() => del.mutate(c.id, { onSuccess: () => notify.success('Channel removed.') })} />}
        empty={{ title: 'No notification channels', description: 'Without one, escalations only appear in the queue. Add Slack or email to be told when something needs a person.' }} />
      <Card title="Add or change a channel" description="Secrets are write-only: once saved they are never shown again. Leave a secret blank to keep the stored one.">
        <form onSubmit={submit} className="grid max-w-xl gap-4" noValidate>
          <ErrorSummary errors={errors} title="Fix these first" />
          <Field label="Channel"><Select value={form.channel} onChange={set('channel')}><option value="slack">Slack</option><option value="email">Email</option></Select></Field>
          {form.channel === 'slack' ? (
            <Field label="Webhook URL" error={errors.slack} hint={existing?.has_slack_webhook ? 'One is stored. Paste a new one to replace it.' : undefined}><Input value={form.slackWebhookUrl} onChange={set('slackWebhookUrl')} placeholder="https://hooks.slack.com/services/…" autoComplete="off" /></Field>
          ) : (
            <>
              <Field label="Send to" error={errors.to}><Input type="email" value={form.emailTo} onChange={set('emailTo')} /></Field>
              <Field label="From" optional><Input type="email" value={form.emailFrom} onChange={set('emailFrom')} /></Field>
              <Field label="SMTP URL" error={errors.smtp} hint={existing?.has_smtp ? 'One is stored. Enter a new one to replace it.' : undefined}><Input value={form.smtpUrl} onChange={set('smtpUrl')} placeholder="smtp://user:pass@mail.example.com:587" autoComplete="off" /></Field>
            </>
          )}
          <Field label="Notify from severity"><Select value={form.minSeverity} onChange={set('minSeverity')}><option value="critical">Critical only</option><option value="high">High and above</option><option value="medium">Medium and above</option><option value="low">Everything</option></Select></Field>
          <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Enabled" />
          <div><Button type="submit" variant="primary" loading={save.isPending}>Save channel</Button></div>
        </form>
      </Card>
    </div>
  )
}

function Limits() {
  const { projectId } = useAuth()
  const path = `/api/financial-threshold/${projectId}`
  const q = useResource(['settings', 'limits'], () => api.get(path))
  const [form, setForm] = useState({ tool: '*', maxAmount: '', currency: 'USD' })
  const [error, setError] = useState('')
  const save = useAction((body) => api.post(path, body), { invalidates: [['settings', 'limits']], silent: true })
  const del = useAction((id) => api.del(`/api/financial-threshold/${id}`), { invalidates: [['settings', 'limits']], silent: true })
  const submit = async (e) => {
    e.preventDefault()
    setError('')
    const n = Number(form.maxAmount)
    if (!Number.isFinite(n) || n <= 0) { setError('Enter a limit greater than zero.'); return }
    try { await save.mutateAsync({ tool: form.tool.trim() || '*', maxAmount: n, currency: form.currency || 'USD' }); notify.success('Limit saved.'); setForm({ ...form, maxAmount: '' }) } catch (err) { setError(explain(err)) }
  }
  const columns = useMemo(() => [
    { id: 'tool', header: 'Applies to', accessor: 'tool', mobile: 'title', cell: (t) => (t.tool === '*' ? <span className="text-ink-700">Every tool</span> : <Code>{t.tool}</Code>) },
    { id: 'max', header: 'Hard limit', accessor: 'max_amount', align: 'right', width: 170, mobile: 'subtitle', cell: (t) => <span className="tabular-nums">{Number(t.max_amount).toLocaleString()} {t.currency}</span> },
    { id: 'on', header: 'State', accessor: (t) => (t.enabled ? 'On' : 'Off'), width: 90, mobile: 'trailing', cell: (t) => <Badge tone={t.enabled ? 'ok' : 'ink'}>{t.enabled ? 'On' : 'Off'}</Badge> },
  ], [])
  return (
    <div className="space-y-4">
      <InlineNotice tone="ink">A financial limit blocks outright any action whose amount is above it, before policies are even consulted. Policies decide what needs a person; limits are the ceiling nobody can approve past.</InlineNotice>
      <DataTable viewKey="console.limits" caption="Financial limits" noun="limit" search={false} rows={q.data || []} columns={columns} loading={q.loading} error={q.error} onRetry={q.refetch}
        rowActions={(t) => <RowAction icon={TrashIcon} tone="risk" label={`Remove the limit for ${t.tool}`} onClick={() => del.mutate(t.id, { onSuccess: () => notify.success('Limit removed.') })} />}
        empty={{ title: 'No financial limits', description: 'Add one to set a ceiling on the amount any action may carry.' }} />
      <Card title="Add a limit">
        <form onSubmit={submit} className="grid max-w-xl gap-4 sm:grid-cols-3" noValidate>
          {error && <div className="sm:col-span-3"><ErrorSummary errors={{ form: error }} title="That did not save" /></div>}
          <Field label="Tool" hint="* for every tool"><Input value={form.tool} onChange={(e) => setForm({ ...form, tool: e.target.value })} /></Field>
          <Field label="Limit" required><Input inputMode="decimal" value={form.maxAmount} onChange={(e) => setForm({ ...form, maxAmount: e.target.value })} /></Field>
          <Field label="Currency"><Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} maxLength={3} /></Field>
          <div className="sm:col-span-3"><Button type="submit" variant="primary" loading={save.isPending}>Save limit</Button></div>
        </form>
      </Card>
    </div>
  )
}

function Intent() {
  const q = useResource(['settings', 'llm'], () => api.get('/api/settings/llm'), { retry: false })
  const [form, setForm] = useState({ provider: 'disabled', model: '', endpoint: '', apiKey: '' })
  const save = useAction((body) => api.post('/api/settings/llm', body), { invalidates: [['settings', 'llm'], ['system']], silent: true })
  const forbidden = q.error?.status === 403
  const d = q.data
  const submit = async (e) => {
    e.preventDefault()
    const body = { provider: form.provider, ...(form.model ? { model: form.model } : {}), ...(form.endpoint ? { endpoint: form.endpoint } : {}), ...(form.apiKey ? { apiKey: form.apiKey } : {}) }
    try { await save.mutateAsync(body); notify.success('Intent analysis settings saved.'); setForm({ ...form, apiKey: '' }) } catch (err) { notify.error(explain(err)) }
  }
  if (forbidden) return <InlineNotice tone="ink" title="This is a gateway-wide setting">Only an operator can change it. Ask whoever runs this gateway (SAG_ADMIN_EMAILS).</InlineNotice>
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Intent analysis" description="A language model reads each request for intent the rules cannot see, and adds to the risk score. Optional.">
        {q.loading ? <p className="text-sm text-ink-600">Loading…</p> : d ? (
          <DescriptionList columns={1} items={[
            { label: 'Status', value: <Badge tone={d.status === 'configured' ? 'ok' : 'ink'}>{d.status === 'configured' ? 'On' : d.status === 'missing_key' ? 'Needs a key' : 'Off'}</Badge> },
            { label: 'Provider', value: d.provider }, { label: 'Model', value: d.model }, { label: 'Timeout', value: `${d.timeoutMs} ms` },
          ]} />
        ) : null}
      </Card>
      <Card title="Change">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <Field label="Provider"><Select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}><option value="disabled">Off</option><option value="openai">OpenAI-compatible</option><option value="ollama">Ollama (local)</option></Select></Field>
          <Field label="Model" optional><Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></Field>
          <Field label="API key" optional hint="Write-only. Applies to this running process; set LLM_API_KEY in the environment to keep it across restarts."><Input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></Field>
          <div><Button type="submit" variant="primary" loading={save.isPending}>Save</Button></div>
        </form>
      </Card>
    </div>
  )
}

export default function Settings() {
  const [tab, setTab] = useState('workspace')
  return (
    <>
      <PageHeader title="Settings" description="Who hears about escalations, the ceilings on amounts, and how intent is analysed." />
      <Tabs value={tab} onChange={setTab} label="Settings sections" tabs={[{ id: 'workspace', label: 'Workspace' }, { id: 'notifications', label: 'Notifications' }, { id: 'limits', label: 'Financial limits' }, { id: 'intent', label: 'Intent analysis' }]}>
        {(t) => ({ workspace: <Workspace />, notifications: <Notifications />, limits: <Limits />, intent: <Intent /> })[t]}
      </Tabs>
    </>
  )
}
