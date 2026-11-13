import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PlusIcon, TrashIcon, PencilSquareIcon } from '@heroicons/react/20/solid'
import { PageHeader, Button, DataTable, RowAction, Badge, Code, Dialog, ConfirmDialog, Field, Input, Textarea, Select, Switch, InlineNotice, EmptyState, ErrorSummary, notify } from '../components/ui'
import { api } from '../lib/api'
import { useAction, useResource } from '../lib/useResource'
import { safeJson } from '../lib/decisions'

/**
 * Policies. Evaluated lowest priority number first; the first match decides. If nothing matches the answer is deny:
 * the gateway never allows what nobody wrote a rule for.
 */
const KEY = ['policies']
const EFFECT = { allow: { tone: 'ok', glyph: 'check', label: 'Allow' }, deny: { tone: 'risk', glyph: 'cross', label: 'Deny' }, escalate: { tone: 'warn', glyph: 'clock', label: 'Send to a person' } }
const FIELDS = [
  ['tool', 'Tool name'], ['action', 'Action type (READ, WRITE, PAYMENT)'], ['context.amount', 'Amount'], ['context.currency', 'Currency'],
  ['resource.classification', 'Data classification'], ['resource.kind', 'Resource kind'], ['resource.module', 'Resource module'],
  ['agent.role', 'Agent role'], ['agent.name', 'Agent name'], ['agent.trust_score', 'Agent trust score'],
]
const OPERATORS = [['=', 'is'], ['!=', 'is not'], ['>=', 'is at least'], ['>', 'is more than'], ['<=', 'is at most'], ['<', 'is less than'], ['IN', 'is one of (comma list)'], ['NOT_IN', 'is none of'], ['CONTAINS', 'contains'], ['STARTS_WITH', 'starts with'], ['MATCHES', 'matches pattern']]

const blank = () => ({ name: '', description: '', priority: 100, action: 'escalate', enabled: true, conditions: [{ field: 'tool', operator: 'MATCHES', value: '' }] })

function describeCondition(c) {
  const f = FIELDS.find(([k]) => k === c.field)?.[1] || c.field
  const o = OPERATORS.find(([k]) => k === c.operator)?.[1] || c.operator
  return `${f} ${o} ${c.value}`
}

function PolicyDialog({ policy, onClose }) {
  const [form, setForm] = useState(() => policy ? { name: policy.name, description: policy.description || '', priority: policy.priority, action: policy.action, enabled: !!policy.enabled, conditions: safeJson(policy.conditions, []) } : blank())
  const [errors, setErrors] = useState({})
  const save = useAction((body) => (policy ? api.put(`/api/policies/${policy.id}`, body) : api.post('/api/policies', body)), { invalidates: [KEY], silent: true })
  const setCond = (i, patch) => setForm({ ...form, conditions: form.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) })

  const submit = async (e) => {
    e?.preventDefault()
    const errs = {}
    if (!form.name.trim()) errs.name = 'Name the policy so a decision can say which one applied.'
    const pr = Number(form.priority)
    if (!Number.isInteger(pr) || pr < 0 || pr > 1000) errs.priority = 'Use a whole number from 0 to 1000.'
    if (form.conditions.length === 0) errs.conditions = 'Add at least one condition. A policy with none would match nothing.'
    if (form.conditions.some((c) => String(c.value).trim() === '')) errs.conditions = 'Every condition needs a value.'
    for (const c of form.conditions) {
      if (c.operator === 'MATCHES') { try { new RegExp(c.value) } catch { errs.conditions = `“${c.value}” is not a valid pattern.` } }
    }
    setErrors(errs)
    if (Object.keys(errs).length) return
    try {
      await save.mutateAsync({ name: form.name.trim(), description: form.description.trim(), priority: pr, action: form.action, enabled: form.enabled, conditions: form.conditions.map((c) => ({ ...c, value: String(c.value).trim() })) })
      notify.success(policy ? 'Policy saved.' : 'Policy created.')
      onClose()
    } catch (err) { setErrors({ form: err.message }) }
  }

  return (
    <Dialog open onClose={onClose} size="lg" title={policy ? 'Edit policy' : 'New policy'} description="When every condition matches, the effect applies."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={submit}>{policy ? 'Save policy' : 'Create policy'}</Button></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <ErrorSummary errors={errors} title="Fix these first" />
        <Field label="Name" required error={errors.name}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
        <Field label="Description" optional><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Effect" required><Select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}><option value="allow">Allow</option><option value="escalate">Send to a person</option><option value="deny">Deny</option></Select></Field>
          <Field label="Priority" required error={errors.priority} hint="Lower runs first."><Input type="number" min="0" max="1000" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} /></Field>
          <Field label="Status"><div className="flex h-8 items-center"><Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label={form.enabled ? 'Enabled' : 'Disabled'} /></div></Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink-800">Conditions <span className="font-normal text-ink-500">(all must match)</span></legend>
          {form.conditions.map((c, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1.2fr_1fr_1.2fr_auto]">
              <Select aria-label={`Condition ${i + 1} field`} value={c.field} onChange={(e) => setCond(i, { field: e.target.value })}>{FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              <Select aria-label={`Condition ${i + 1} operator`} value={c.operator} onChange={(e) => setCond(i, { operator: e.target.value })}>{OPERATORS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              <Input aria-label={`Condition ${i + 1} value`} value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder={c.operator === 'MATCHES' ? '^delete_' : c.operator === 'IN' ? 'personal,pii' : '10000'} />
              <Button variant="ghost" aria-label={`Remove condition ${i + 1}`} onClick={() => setForm({ ...form, conditions: form.conditions.filter((_, j) => j !== i) })}><TrashIcon className="h-4 w-4" /></Button>
            </div>
          ))}
          {errors.conditions && <p className="text-sm text-risk-700" role="alert">{errors.conditions}</p>}
          <Button size="sm" icon={PlusIcon} onClick={() => setForm({ ...form, conditions: [...form.conditions, { field: 'tool', operator: '=', value: '' }] })}>Add condition</Button>
        </fieldset>
      </form>
    </Dialog>
  )
}

export default function Policies() {
  const [params, setParams] = useSearchParams()
  const q = useResource(KEY, () => api.get('/api/policies'))
  const [edit, setEdit] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const toggle = useAction(({ id, enabled }) => api.put(`/api/policies/${id}`, { enabled }), { invalidates: [KEY], silent: true })
  const del = useAction((id) => api.del(`/api/policies/${id}`), { invalidates: [KEY], silent: true })
  const starter = useAction(() => api.post('/api/policies/starter-erp'), { invalidates: [KEY], success: (r) => `${r.created} starter policies added. Review them, then adjust to your business.` })
  const rows = useMemo(() => (q.data || []).map((p) => ({ ...p, conds: safeJson(p.conditions, []) })), [q.data])
  const creating = params.get('new') === '1'
  const closeNew = () => { const n = new URLSearchParams(params); n.delete('new'); setParams(n, { replace: true }) }

  const columns = useMemo(() => [
    { id: 'priority', header: 'Order', accessor: 'priority', align: 'right', width: 80, cell: (p) => <span className="font-mono text-xs tabular-nums">{p.priority}</span> },
    { id: 'name', header: 'Policy', accessor: 'name', mobile: 'title', minWidth: 240, cell: (p) => <span><span className="font-medium text-fg">{p.name}</span>{String(p.created_by || '').startsWith('ai:') && !p.enabled && <span className="ml-2 align-middle"><Badge tone="warn">Proposed by {String(p.created_by).slice(3)}</Badge></span>}{p.description && <span className="block text-xs text-ink-600">{p.description}</span>}</span> },
    { id: 'effect', header: 'Effect', accessor: 'action', filter: 'select', width: 170, mobile: 'trailing', cell: (p) => { const e = EFFECT[p.action] || { tone: 'ink', label: p.action }; return <Badge tone={e.tone} glyph={e.glyph}>{e.label}</Badge> } },
    { id: 'when', header: 'When', accessor: (p) => p.conds.map(describeCondition).join(' and '), minWidth: 320, mobile: 'subtitle', cell: (p) => <span className="text-ink-700">{p.conds.length ? p.conds.map(describeCondition).join(' and ') : <span className="text-ink-400">No conditions</span>}</span> },
    { id: 'hits', header: 'Matched', accessor: 'hit_count', align: 'right', width: 90, cell: (p) => <span className="tabular-nums">{(p.hit_count || 0).toLocaleString()}</span> },
    { id: 'enabled', header: 'On', accessor: (p) => (p.enabled ? 'On' : 'Off'), filter: 'select', width: 90, mobile: 'meta', cell: (p) => <Switch checked={!!p.enabled} onChange={(v) => toggle.mutate({ id: p.id, enabled: v })} label={<span className="sr-only">{`${p.enabled ? 'Disable' : 'Enable'} ${p.name}`}</span>} /> },
  ], [toggle])

  const run = async () => { const p = confirm; try { await del.mutateAsync(p.id); notify.success('Policy deleted.') } catch (e) { notify.error(`${p.name} was not deleted: ${e.message}`) } setConfirm(null) }

  return (
    <>
      <PageHeader title="Policies" description="Rules your workspace applies to every action an agent proposes. The first matching rule decides; no match means deny." primary={<Button variant="primary" icon={PlusIcon} onClick={() => setParams({ new: '1' })}>New policy</Button>} secondary={<Button to="/policies/tester">Test an action</Button>} />
      {rows.some((p) => String(p.created_by || '').startsWith('ai:') && !p.enabled) && <InlineNotice tone="warn" className="mb-4">An AI agent proposed {rows.filter((p) => String(p.created_by || '').startsWith('ai:') && !p.enabled).length} rule(s). They are off and change nothing until you turn them on. Review the conditions first.</InlineNotice>}
      <InlineNotice tone="ink" className="mb-4">The signed policy bundle is checked first and applies to every workspace. These policies are yours, and they only ever narrow what the bundle allows.</InlineNotice>
      <DataTable
        viewKey="console.policies"
        caption="Policies"
        noun="policy"
        rows={rows}
        columns={columns}
        loading={q.loading}
        error={q.error}
        onRetry={q.refetch}
        defaultSort={{ id: 'priority', dir: 'asc' }}
        rowActions={(p) => (<><RowAction icon={PencilSquareIcon} label={`Edit ${p.name}`} onClick={() => setEdit(p)} /><RowAction icon={TrashIcon} tone="risk" label={`Delete ${p.name}`} onClick={() => setConfirm(p)} /></>)}
        empty={<EmptyState compact title="No policies in this workspace" description="Until a policy says otherwise, everything is denied. Platforms that register a tenant through the v1 API get the ERP starter set automatically; you can add it here too, or write your own." action={<span className="inline-flex flex-wrap justify-center gap-2"><Button variant="primary" loading={starter.isPending} onClick={() => starter.mutate()}>Add the ERP starter set</Button><Button onClick={() => setParams({ new: '1' })}>Write my own</Button></span>} />}
      />
      {(creating || edit) && <PolicyDialog policy={edit} onClose={() => { setEdit(null); closeNew() }} />}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} title={`Delete “${confirm?.name}”?`} consequence="Actions it used to cover will be decided by the remaining policies, or denied if none match." confirmLabel="Delete policy" onConfirm={run} busy={del.isPending}><Code>{confirm?.id}</Code></ConfirmDialog>
    </>
  )
}
