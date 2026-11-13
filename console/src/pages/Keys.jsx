import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardIcon } from '@heroicons/react/20/solid'
import { PageHeader, Card, Button, Code, ConfirmDialog, Dialog, InlineNotice, DescriptionList, notify } from '../components/ui'
import CodeBlock from '../components/CodeBlock'
import { api, explain } from '../lib/api'
import { useResource } from '../lib/useResource'
import { useAuth } from '../lib/workspace'

/**
 * Three kinds of key, and who holds each:
 *   platform key  provisions tenants for a platform (Business OS). Lives in the gateway's environment as a hash.
 *   agent key     identifies one agent. Shown once when the agent is created.
 *   workspace key lets a client name an agent in its request and have it created on the fly (the SaaS routing mode).
 */
export default function Keys() {
  const { workspace } = useAuth()
  const agents = useResource(['agents'], () => api.get('/api/agents'))
  const sys = useResource(['system'], () => api.get('/api/system/status'))
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fresh, setFresh] = useState(null)

  const rotate = async () => {
    setBusy(true)
    try { const r = await api.post(`/api/projects/${workspace.id}/keys`); setFresh(r.newKey); setConfirm(false) } catch (e) { setConfirm(false); notify.error(`The workspace key was not changed. ${explain(e)}`) } finally { setBusy(false) }
  }
  const copy = async () => { try { await navigator.clipboard.writeText(fresh); notify.success('Key copied') } catch { notify.error('Copy failed. Select the key and copy it by hand.') } }
  const active = (agents.data || []).filter((a) => a.status === 'active').length

  return (
    <>
      <PageHeader title="API keys" description="Keys are secrets. The gateway keeps only their hashes, so a lost key is replaced, never recovered." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Agent keys" description="One per agent, shown once when you create the agent.">
          <p className="text-sm text-ink-700">{agents.loading ? 'Loading…' : `${active} active ${active === 1 ? 'agent' : 'agents'} in this workspace.`}</p>
          <div className="mt-3 flex gap-2"><Button to="/agents?new=1" variant="primary">Create an agent</Button><Button to="/agents">Manage agents</Button></div>
          <p className="mt-3 text-xs text-ink-500">To replace a lost key, kill the agent and create it again. Platforms using the v1 API rotate theirs with <Code>?rotate=true</Code>.</p>
        </Card>

        <Card title="Workspace key" description="Lets a client send an agent name with its request; unknown names are created on the fly.">
          <p className="text-sm text-ink-700">Used as <Code>Authorization: Bearer sag_live_…</Code> together with <Code>agentName</Code> on <Code>/api/gateway/execute</Code>. It cannot be shown again.</p>
          <div className="mt-3"><Button variant="destructive" onClick={() => setConfirm(true)} disabled={!workspace}>Replace the workspace key…</Button></div>
        </Card>

        <Card title="Platform keys" description="For platforms such as EMBMIS Business OS that register tenants through the v1 API.">
          <DescriptionList columns={1} items={[{ label: 'Configured on this gateway', value: sys.data ? (sys.data.platformKeys > 0 ? `${sys.data.platformKeys} ${sys.data.platformKeys === 1 ? 'key' : 'keys'}` : 'None') : '—' }]} />
          <p className="mt-3 text-sm text-ink-700">Platform keys are created on the gateway host, not here, so that no web session can mint one:</p>
          <div className="mt-2"><CodeBlock label="platform key command" code={'npm run platform-key\n# add the printed SAG_PLATFORM_KEY_HASHES=… line to the gateway environment, restart,\n# then give the key itself to the platform (EMBMIS_GATEWAY_PLATFORM_KEY in Business OS).'} /></div>
          <p className="mt-3 text-xs text-ink-500">Several hashes can be listed, comma separated, to rotate without downtime. See <Link to="/connect" className="underline underline-offset-2">Integration guides</Link>.</p>
        </Card>
      </div>

      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} title="Replace the workspace key?" consequence="The current workspace key stops working immediately. Anything still using it will be refused until it is given the new one." confirmLabel="Replace key" onConfirm={rotate} busy={busy} />
      {fresh && (
        <Dialog open onClose={() => setFresh(null)} title="Your new workspace key" footer={<Button variant="primary" onClick={() => setFresh(null)}>I have stored it</Button>}>
          <InlineNotice tone="warn" title="This is the only time it is shown">Put it in your secret manager now.</InlineNotice>
          <div className="mt-4 flex items-center gap-2 rounded-md border border-ink-200 bg-sunken p-2"><code className="min-w-0 flex-1 select-all break-all text-xs text-fg">{fresh}</code><Button size="sm" icon={ClipboardIcon} onClick={copy}>Copy</Button></div>
        </Dialog>
      )}
    </>
  )
}
