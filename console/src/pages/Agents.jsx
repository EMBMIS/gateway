import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PlusIcon, PauseIcon, PlayIcon, NoSymbolIcon, ClipboardIcon } from '@heroicons/react/20/solid'
import { PageHeader, Button, DataTable, RowAction, Badge, Code, DateText, Dialog, ConfirmDialog, Field, Input, Select, InlineNotice, EmptyState, ErrorSummary, notify } from '../components/ui'
import { api } from '../lib/api'
import { useAction, useResource } from '../lib/useResource'

/**
 * Agents. Suspend pauses an agent (reversible). Kill revokes it for good: its key stops working and every later
 * request from it is blocked, and that is a decision in the audit log like any other.
 */
const STATUS = {
  active: { tone: 'ok', glyph: 'dot', label: 'Active' },
  suspended: { tone: 'warn', glyph: 'clock', label: 'Suspended' },
  revoked: { tone: 'risk', glyph: 'cross', label: 'Revoked' },
}
const KEY = ['agents']
const ROLES = ['finance', 'engineering', 'hr', 'analytics', 'operations', 'security', 'compliance', 'sales', 'erp-operator']

function CreateDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', role: 'erp-operator', department: '' })
  const [errors, setErrors] = useState({})
  const create = useAction((body) => api.post('/api/agents', body), { invalidates: [KEY], silent: true })
  const submit = async (e) => {
    e.preventDefault()
    const errs = {}
    if (!form.name.trim()) errs.name = 'Give the agent a name.'
    if (!form.role.trim()) errs.role = 'Choose or type a role.'
    setErrors(errs)
    if (Object.keys(errs).length) return
    try {
      const r = await create.mutateAsync({ name: form.name.trim(), role: form.role.trim(), department: form.department.trim() || 'general', trustScore: 60 })
      onCreated(r)
    } catch (err) {
      setErrors({ form: /UNIQUE|already/i.test(err.message) ? 'An agent with this name already exists in the workspace.' : err.message })
    }
  }
  return (
    <Dialog open onClose={onClose} title="Create an agent" description="The key is shown once. The gateway stores only its hash." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} onClick={submit}>Create agent</Button></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <ErrorSummary errors={errors} title="Fix these first" />
        <Field label="Name" required error={errors.name} hint="For example finance-copilot."><Input id="agent-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
        <Field label="Role" required error={errors.role} hint="Roles group agents for policies. Pick one or type your own."><Input id="agent-role" list="roles" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} /><datalist id="roles">{ROLES.map((r) => <option key={r} value={r} />)}</datalist></Field>
        <Field label="Department" optional><Input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></Field>
      </form>
    </Dialog>
  )
}

function KeyDialog({ agent, onClose }) {
  const copy = async () => { try { await navigator.clipboard.writeText(agent.apiKey); notify.success('Key copied') } catch { notify.error('Copy failed. Select the key and copy it by hand.') } }
  return (
    <Dialog open onClose={onClose} title={`Key for ${agent.name}`} footer={<Button variant="primary" onClick={onClose}>I have stored it</Button>}>
      <InlineNotice tone="warn" title="This is the only time it is shown">Store it in your secret manager now. If it is lost, delete the agent and create another.</InlineNotice>
      <div className="mt-4 flex items-center gap-2 rounded-md border border-ink-200 bg-sunken p-2"><code className="min-w-0 flex-1 break-all text-xs text-fg select-all">{agent.apiKey}</code><Button size="sm" icon={ClipboardIcon} onClick={copy}>Copy</Button></div>
      <p className="mt-3 text-xs text-ink-600">Use it as <Code>Authorization: Bearer …</Code> on <Code>POST /api/gateway/execute</Code>. Platforms that run their own tools use the v1 API instead; see Connect.</p>
    </Dialog>
  )
}

export default function Agents() {
  const [params, setParams] = useSearchParams()
  const q = useResource(KEY, () => api.get('/api/agents'), { refetchInterval: 30000 })
  const [created, setCreated] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const creating = params.get('new') === '1'
  const closeCreate = () => { const n = new URLSearchParams(params); n.delete('new'); setParams(n, { replace: true }) }
  const act = useAction(({ id, verb }) => api.post(`/api/agents/${id}/${verb}`), { invalidates: [KEY, ['dashboard']], silent: true })
  const rows = q.data || []

  const run = async (agent, verb, done) => {
    try { await act.mutateAsync({ id: agent.id, verb }); notify.success(done); setConfirm(null) } catch (e) { setConfirm(null); notify.error(`${agent.name} was not changed: ${e.message}`) }
  }

  const columns = useMemo(() => [
    { id: 'name', header: 'Agent', accessor: 'name', mobile: 'title', minWidth: 180, cell: (a) => <span className="font-medium text-fg">{a.name}</span> },
    { id: 'status', header: 'Status', accessor: 'status', filter: 'select', width: 130, mobile: 'trailing', cell: (a) => { const s = STATUS[a.status] || { tone: 'ink', label: a.status }; return <Badge tone={s.tone} glyph={s.glyph}>{s.label}</Badge> } },
    { id: 'role', header: 'Role', accessor: 'role', filter: 'select', width: 140, mobile: 'subtitle', cell: (a) => <span className="font-mono text-xs">{a.role}</span> },
    { id: 'trust', header: 'Trust', accessor: 'trust_score', align: 'right', width: 80, filter: 'number', cell: (a) => <span className="tabular-nums" title="Low trust raises the risk score of everything this agent does">{a.trust_score}</span> },
    { id: 'req', header: 'Requests', accessor: 'total_requests', align: 'right', width: 100, cell: (a) => <span className="tabular-nums">{a.total_requests.toLocaleString()}</span> },
    { id: 'blocked', header: 'Blocked', accessor: 'blocked_requests', align: 'right', width: 100, cell: (a) => <span className="tabular-nums">{a.blocked_requests.toLocaleString()}</span> },
    { id: 'seen', header: 'Last seen', accessor: 'last_seen', width: 170, mobile: 'meta', cell: (a) => (a.last_seen ? <DateText value={a.last_seen} withTime relative /> : <span className="text-ink-500">Never</span>) },
  ], [])

  return (
    <>
      <PageHeader title="Agents" description="The AI agents allowed to ask this gateway for decisions." primary={<Button variant="primary" icon={PlusIcon} onClick={() => setParams({ new: '1' })}>New agent</Button>} />
      <DataTable
        viewKey="console.agents"
        caption="Agents"
        noun="agent"
        rows={rows}
        columns={columns}
        loading={q.loading}
        error={q.error}
        onRetry={q.refetch}
        defaultSort={{ id: 'name', dir: 'asc' }}
        rowClassName={(a) => (a.status === 'active' ? undefined : 'text-ink-500')}
        rowActions={(a) => (
          <>
            {a.status === 'active' && <RowAction icon={PauseIcon} label={`Suspend ${a.name}`} onClick={() => run(a, 'suspend', `${a.name} is suspended. Its requests are blocked until you reactivate it.`)} />}
            {a.status !== 'active' && <RowAction icon={PlayIcon} label={`Reactivate ${a.name}`} onClick={() => run(a, 'reactivate', `${a.name} is active again at trust 50.`)} />}
            {a.status !== 'revoked' && <RowAction icon={NoSymbolIcon} tone="risk" label={`Kill ${a.name}`} onClick={() => setConfirm(a)} />}
          </>
        )}
        empty={<EmptyState compact title="No agents yet" description="Create an agent for each AI that will ask the gateway for permission. Platforms such as Business OS create theirs automatically." actionLabel="Create an agent" onAction={() => setParams({ new: '1' })} />}
      />
      {creating && <CreateDialog onClose={closeCreate} onCreated={(r) => { closeCreate(); setCreated(r) }} />}
      {created && <KeyDialog agent={created} onClose={() => setCreated(null)} />}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Kill ${confirm?.name}?`}
        consequence="Its key stops working and every request from it is blocked from now on. You can reactivate it later; it comes back at trust 50."
        confirmLabel="Kill agent"
        reversible
        onConfirm={() => run(confirm, 'kill', `${confirm.name} was revoked.`)}
      />
    </>
  )
}
