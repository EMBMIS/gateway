import { useMemo, useState } from 'react'
import { PageHeader, DataTable, Badge, DateText, Button, InlineNotice, ConfirmDialog, Field, Input, Card, Code, EmptyState, notify } from '../components/ui'
import { api, explain } from '../lib/api'
import { useAction, useResource } from '../lib/useResource'
import { useAuth } from '../lib/workspace'

/**
 * Data vault. Assets are encrypted with AES-256-GCM under per-asset keys derived from a master key the operator
 * provides. The master key is held by the gateway process, not by a KMS or HSM: said on the page.
 */
const KEY = ['vault']

export default function Vault() {
  const { user } = useAuth()
  const assets = useResource([...KEY, 'assets'], () => api.get('/api/vault/assets'), { retry: false })
  const erasures = useResource([...KEY, 'erasures'], () => api.get('/api/vault/erasure'), { retry: false })
  const [who, setWho] = useState('')
  const [confirm, setConfirm] = useState(false)
  const erase = useAction((userIdentifier) => api.post('/api/vault/erasure', { userIdentifier }), { invalidates: [KEY], silent: true })

  const forbidden = assets.error?.status === 403
  const columns = useMemo(() => [
    { id: 'name', header: 'Asset', accessor: 'name', mobile: 'title', minWidth: 220, cell: (a) => <span className="font-medium text-fg">{a.name}</span> },
    { id: 'class', header: 'Classification', accessor: 'classification', filter: 'select', width: 150, mobile: 'subtitle', cell: (a) => <Badge tone={['PII', 'HEALTH', 'CREDENTIAL'].includes(a.classification) ? 'warn' : 'ink'}>{a.classification}</Badge> },
    { id: 'tee', header: 'Protected', accessor: (a) => (a.tee_protected ? 'Yes' : 'No'), width: 110, cell: (a) => (a.tee_protected ? 'Yes' : 'No') },
    { id: 'size', header: 'Encrypted size', accessor: 'encrypted_size', align: 'right', width: 130, cell: (a) => `${Number(a.encrypted_size).toLocaleString()} chars` },
    { id: 'created', header: 'Created', accessor: 'created_at', width: 170, mobile: 'meta', cell: (a) => <DateText value={a.created_at} withTime /> },
  ], [])

  const run = async () => {
    try { await erase.mutateAsync(who.trim()); notify.success('The erasure was carried out and recorded below.'); setWho('') } catch (e) { notify.error(explain(e)) }
    setConfirm(false)
  }

  return (
    <>
      <PageHeader title="Data vault" description="Encrypted assets the gateway holds for agents, and erasure requests." />
      <InlineNotice tone="ink" title="How this vault is protected" className="mb-4">Assets are encrypted with AES-256-GCM under keys derived from a master key set by whoever runs this gateway (SAG_VAULT_MASTER_KEY). That key lives in the gateway's secrets, not in a KMS or HSM: anyone who can read them can read the vault, and losing the key makes every asset unreadable. Back it up with the database.</InlineNotice>
      {forbidden ? (
        <InlineNotice tone="ink" title="The vault is a gateway-wide resource">Only an operator of this gateway can see it. Ask whoever runs it to add your email to SAG_ADMIN_EMAILS.</InlineNotice>
      ) : (
        <>
          <DataTable viewKey="console.vault" caption="Vault assets" noun="asset" rows={assets.data || []} columns={columns} loading={assets.loading} error={assets.error} onRetry={assets.refetch}
            empty={<EmptyState compact title="The vault is empty" description="Nothing has been stored." />} />
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <Card title="Erase personal data (GDPR Art. 17)" description="Destroys the assets stored for one person.">
              <InlineNotice tone="risk" title="Per person, and permanent" className="mb-3">Destroys every asset that was stored with this person as its subject, and nothing else. Assets stored without a subject cannot be matched and are not touched. It cannot be undone.</InlineNotice>
              <Field label="Who is the request for" hint="Recorded with the request."><Input value={who} onChange={(e) => setWho(e.target.value)} placeholder="person@example.com" /></Field>
              <div className="mt-3"><Button variant="destructive" disabled={!who.trim() || !user} onClick={() => setConfirm(true)}>Erase this person’s assets…</Button></div>
            </Card>
            <Card title="Erasure requests" padded={false}>
              {(erasures.data || []).length === 0 ? <p className="p-4 text-sm text-ink-600">No erasure requests have been made.</p> : (
                <ul className="divide-y divide-ink-100">
                  {(erasures.data || []).slice(0, 12).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"><Badge tone={r.status === 'completed' ? 'ok' : 'warn'} glyph={r.status === 'completed' ? 'check' : 'clock'}>{r.status}</Badge><span className="min-w-0 flex-1 truncate font-mono text-xs">{r.user_identifier}</span><Code>{String(r.id).slice(0, 8)}</Code></li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Erase this person’s assets?" consequence={`This destroys every vault asset stored for “${who.trim()}”.`} confirmLabel="Erase" confirmText="ERASE" onConfirm={run} busy={erase.isPending} />
    </>
  )
}
