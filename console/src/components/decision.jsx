import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ShieldCheckIcon } from '@heroicons/react/20/solid'
import { Badge, Button, Code, DateText, DescriptionList, InlineNotice, Sheet, Skeleton, Field, Textarea } from './ui'
import { api, explain } from '../lib/api'
import { useAction, useResource } from '../lib/useResource'
import { CODE_TEXT, decisionOf, explanationOf, safeJson } from '../lib/decisions'

export function DecisionBadge({ row, decision }) {
  const d = decisionOf(row || { policy_decision: decision })
  return <Badge tone={d.tone} glyph={d.glyph}>{d.label}</Badge>
}

const Section = ({ title, children }) => (
  <section className="space-y-2">
    <h3 className="label-mono">{title}</h3>
    {children}
  </section>
)

/**
 * One click, the whole story: what was asked, which policy decided, the risk factors, the intent analysis,
 * and where the decision sits in the hash chain. An open escalation can be answered right here.
 */
export function DecisionSheet({ id, onClose }) {
  const qc = useQueryClient()
  const { data, loading, error, refetch } = useResource(['decisions', 'entry', id], () => api.get(`/api/audit/entry/${id}`), { enabled: !!id })
  const [note, setNote] = useState('')
  const answer = useAction(
    ({ traceId, outcome }) => api.post(`/api/escalations/${traceId}/resolve`, { outcome, reason: note || undefined }),
    {
      invalidates: [['decisions'], ['escalations']],
      success: (r) => (r.outcome === 'approved' ? 'Approved. The answer is in the audit chain.' : 'Rejected. The answer is in the audit chain.'),
      onSuccess: () => { qc.invalidateQueries({ queryKey: ['decisions', 'entry', id] }); setNote('') },
    }
  )

  const entry = data?.entry
  const ex = entry ? entry.explanation || explanationOf({ ...entry, response_summary: JSON.stringify(entry.summary || {}) }) : null
  const open = entry && entry.policy_decision === 'escalate' && !data.resolution
  const resolution = data?.resolution && safeJson(data.resolution.args, {})

  return (
    <Sheet open={!!id} onClose={onClose} width="lg" title={entry ? <span className="flex items-center gap-2"><DecisionBadge row={entry} /><Code>{entry.tool}</Code></span> : 'Decision'} description={ex?.reason || undefined}>
      <div className="space-y-6 p-4">
        {loading && <div className="space-y-2" role="status"><span className="sr-only">Loading the decision</span><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-24 w-full" /></div>}
        {error && <InlineNotice tone="risk" title="This decision could not be loaded" action={<Button size="sm" onClick={refetch}>Try again</Button>}>{explain(error)}</InlineNotice>}
        {entry && (
          <>
            <Section title="What was asked">
              <DescriptionList
                items={[
                  { label: 'Agent', value: <span className="font-mono text-xs">{entry.agent_name}</span> },
                  { label: 'Action', value: entry.action },
                  { label: 'Resource', value: entry.context?.resource ? `${entry.context.resource.kind || '—'} · ${entry.context.resource.module || '—'} · ${entry.context.resource.classification || '—'}` : entry.resource_classification },
                  { label: 'When', value: <DateText value={entry.timestamp} withTime /> },
                  entry.context?.amount != null ? { label: 'Amount', value: `${Number(entry.context.amount).toLocaleString()} ${entry.context.currency || ''}`.trim() } : null,
                  entry.context?.userId ? { label: 'On behalf of', value: <span className="font-mono text-xs">{entry.context.userId}</span> } : null,
                  entry.context?.actor ? { label: 'Asked by', value: <span className="font-mono text-xs">{entry.context.actor}</span> } : null,
                ]}
              />
              {Object.keys(entry.args || {}).length > 0 && (
                <details className="rounded-md border border-ink-200 bg-sunken">
                  <summary className="cursor-pointer px-3 py-2 text-xs text-ink-600">Arguments as received</summary>
                  <pre className="overflow-x-auto px-3 pb-3 font-mono text-xs text-ink-800">{JSON.stringify(entry.args, null, 2)}</pre>
                </details>
              )}
            </Section>

            <Section title="Why">
              <DescriptionList
                columns={1}
                items={[
                  { label: 'Outcome', value: <span className="flex flex-wrap items-center gap-2"><DecisionBadge row={entry} />{ex?.code && <span className="text-ink-700">{CODE_TEXT[ex.code] || ex.code}</span>}</span> },
                  { label: 'Reason', value: ex?.reason },
                  { label: 'Policy that decided', value: ex?.matchedPolicy?.name || (entry.matched_policy_name && entry.matched_policy_name !== 'DEFAULT_ALLOW' ? entry.matched_policy_name : 'None matched; risk scoring decided') },
                  { label: 'Risk score', value: `${entry.risk_score ?? 0} / 100` },
                  ex?.policyBundleHash ? { label: 'Signed policy bundle', value: <Code className="break-all">{ex.policyBundleHash}</Code> } : null,
                ]}
              />
              {(ex?.riskFactors || []).length > 0 ? (
                <ul className="space-y-1 text-sm text-ink-800">
                  {ex.riskFactors.map((f, i) => (
                    <li key={i} className="flex gap-2"><span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-ink-500">+{f.weight}</span><span>{f.detail || f.factor}</span></li>
                  ))}
                </ul>
              ) : <p className="text-sm text-ink-600">No risk factors were added to this score.</p>}
            </Section>

            <Section title="Intent analysis">
              {ex?.intent && !ex.intent.skipped ? (
                <DescriptionList items={[
                  { label: 'Suspicion score', value: `${ex.intent.score} / 100` },
                  { label: 'Source', value: ex.intent.source },
                  { label: 'Flags', value: (ex.intent.flags || []).length ? ex.intent.flags.join(', ') : 'None' },
                  { label: 'Reasoning', value: ex.intent.reasoning, wide: true },
                ]} />
              ) : <p className="text-sm text-ink-600">Not run. Intent analysis needs a language model; connect one in Settings and it is added to the score.</p>}
            </Section>

            <Section title="Audit chain">
              <DescriptionList columns={1} items={[
                { label: 'Entry', value: <span className="font-mono text-xs">#{entry.seq}</span> },
                { label: 'Entry hash', value: <Code className="break-all">{data.entryHash}</Code> },
                { label: 'Previous hash', value: <Code className="break-all">{entry.prev_hash}</Code> },
                { label: 'Trace', value: entry.trace_id ? <Code>{entry.trace_id}</Code> : null },
              ]} />
              <p className={data.chain.intact ? 'flex items-center gap-1.5 text-sm text-ok-700' : 'text-sm text-risk-700'}>
                {data.chain.intact && <ShieldCheckIcon className="h-4 w-4" aria-hidden="true" />}
                {data.chain.intact ? 'This entry links correctly to the entries before and after it.' : 'This entry does not match its neighbours in the chain. Treat the log as tampered with and run a full verification.'}
              </p>
            </Section>

            {open && (
              <Section title="Waiting for a person">
                <p className="text-sm text-ink-700">The platform that asked is holding this action until someone decides. Your answer is appended to the audit chain and sent back to it.</p>
                <Field label="Note (optional)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you approved or rejected it" /></Field>
                <div className="flex gap-2">
                  <Button variant="primary" loading={answer.isPending} onClick={() => answer.mutate({ traceId: entry.trace_id, outcome: 'approved' })}>Approve</Button>
                  <Button variant="destructive" disabled={answer.isPending} onClick={() => answer.mutate({ traceId: entry.trace_id, outcome: 'rejected' })}>Reject</Button>
                </div>
              </Section>
            )}
            {resolution && (
              <Section title="Answered">
                <DescriptionList items={[
                  { label: 'Outcome', value: resolution.outcome === 'approved' ? 'Approved' : 'Rejected' },
                  { label: 'By', value: <span className="font-mono text-xs">{resolution.by}</span> },
                  { label: 'When', value: <DateText value={resolution.resolvedAt} withTime /> },
                  { label: 'Note', value: resolution.reason, wide: true },
                ]} />
              </Section>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}
