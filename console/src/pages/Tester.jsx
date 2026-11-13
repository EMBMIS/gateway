import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader, Card, Button, Field, Input, Select, Textarea, InlineNotice, DescriptionList, Code, ErrorSummary } from '../components/ui'
import { DecisionBadge } from '../components/decision'
import { api, explain } from '../lib/api'
import { useResource } from '../lib/useResource'
import { CODE_TEXT } from '../lib/decisions'

/** Ask the gateway what it would say, without writing anything to the audit chain. */
export default function Tester() {
  const agents = useResource(['agents'], () => api.get('/api/agents'))
  const [form, setForm] = useState({ agentId: '', tool: 'create_payment', action: 'PAYMENT', amount: '25000', currency: 'EUR', classification: 'financial', args: '' })
  const [out, setOut] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  const run = async (e) => {
    e.preventDefault()
    setError('')
    setOut(null)
    let args = {}
    if (form.args.trim()) { try { args = JSON.parse(form.args) } catch { setError('The arguments are not valid JSON. Fix them or leave the box empty.'); return } }
    setBusy(true)
    try {
      setOut(await api.post('/api/policies/test', {
        agentId: form.agentId || undefined, tool: form.tool.trim(), action: form.action, args,
        resource: { classification: form.classification || undefined },
        context: { amount: form.amount === '' ? undefined : form.amount, currency: form.currency || undefined },
      }))
    } catch (err) { setError(explain(err)) } finally { setBusy(false) }
  }

  return (
    <>
      <PageHeader title="Policy tester" description="See what the gateway would decide for an action, and why. Nothing is executed and nothing is written to the audit log." />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Card title="The action">
          <form onSubmit={run} className="space-y-4" noValidate>
            {error && <ErrorSummary errors={{ form: error }} title="That did not run" />}
            <Field label="Agent" hint="Optional. Its role and trust score feed the risk score."><Select value={form.agentId} onChange={set('agentId')}><option value="">A typical agent (trust 75)</option>{(agents.data || []).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}</Select></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tool" required><Input value={form.tool} onChange={set('tool')} /></Field>
              <Field label="Action type" required><Select value={form.action} onChange={set('action')}><option>READ</option><option>WRITE</option><option>PAYMENT</option></Select></Field>
              <Field label="Amount" optional><Input inputMode="decimal" value={form.amount} onChange={set('amount')} /></Field>
              <Field label="Currency" optional><Input value={form.currency} onChange={set('currency')} maxLength={8} /></Field>
              <Field label="Data classification" optional hint="For example personal, financial, internal."><Input value={form.classification} onChange={set('classification')} /></Field>
            </div>
            <Field label="Arguments" optional hint="JSON, as the agent would send them."><Textarea rows={3} className="font-mono" value={form.args} onChange={set('args')} placeholder='{"supplier": "Northwind"}' /></Field>
            <Button type="submit" variant="primary" loading={busy}>Test</Button>
          </form>
        </Card>
        <Card title="What the gateway would say">
          {!out && <p className="text-sm text-ink-600">Run a test to see the decision here.</p>}
          {out && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2"><DecisionBadge decision={out.decision} /><span className="text-sm text-ink-800">{CODE_TEXT[out.code] || out.code}</span></div>
              <p className="text-sm text-ink-800">{out.reason}</p>
              <DescriptionList columns={1} items={[
                { label: 'Policy that decided', value: out.policy.matchedPolicy ? <Link to="/policies" className="underline-offset-2 hover:underline">{out.policy.matchedPolicy.name}</Link> : 'None matched' },
                { label: 'Policy said', value: out.policy.decision },
                { label: 'Risk score', value: `${out.risk.score} / 100 (blocks at ${out.risk.thresholds.autoBlock}, sends to a person at ${out.risk.thresholds.escalation})` },
                { label: 'Agent', value: <span className="font-mono text-xs">{out.agent.name} · {out.agent.role} · trust {out.agent.trustScore}</span> },
              ]} />
              {out.risk.factors.length > 0 ? (
                <ul className="space-y-1 text-sm text-ink-800">{out.risk.factors.map((f, i) => <li key={i} className="flex gap-2"><span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-ink-500">+{f.weight}</span><span>{f.detail}</span></li>)}</ul>
              ) : <p className="text-sm text-ink-600">No risk factors were added.</p>}
              <InlineNotice tone="ink">The real decision also checks the signed policy bundle, the plan limit, financial limits, and intent analysis when a language model is connected. <Code>POST /api/v1/decide</Code> runs all of it.</InlineNotice>
            </div>
          )}
        </Card>
      </div>
    </>
  )
}
