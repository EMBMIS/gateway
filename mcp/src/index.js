'use strict'
const { Peer, startUpstream } = require('./rpc')

const VERSION = '0.1.0'
const READ = /^(get|list|read|search|find|fetch|describe|show|view|query|count|check)([_.-]|[A-Z]|$)/i
const PAYMENT = /(pay|payment|transfer|payout|refund|charge|wire)/i

/** READ / WRITE / PAYMENT from the tool name, unless the config says otherwise. */
function classify(name, overrides = {}) {
  if (overrides[name]) return overrides[name]
  if (PAYMENT.test(name)) return 'PAYMENT'
  if (READ.test(name)) return 'READ'
  return 'WRITE'
}

class Gateway {
  constructor({ url, key, agentName, tenantId, timeoutMs = 8000, fetchImpl = fetch }) {
    if (!url || !key) throw new Error('A Gateway url and agent key are required.')
    Object.assign(this, { base: url.replace(/\/+$/, ''), key, agentName, tenantId, timeoutMs, f: fetchImpl })
  }
  async #req(method, path, body) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.timeoutMs)
    try {
      const r = await this.f(this.base + '/api/v1' + path, { method, signal: ctl.signal, headers: { authorization: 'Bearer ' + this.key, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      const json = await r.json().catch(() => ({}))
      return { status: r.status, body: json }
    } finally { clearTimeout(t) }
  }
  decide({ tool, action, args = {}, resource = {}, context = {} }) {
    return this.#req('POST', '/decide', { agentName: this.agentName, tool, action, args, resource, context: { ...(this.tenantId ? { tenantId: this.tenantId } : {}), ...context } })
  }
  policies() { return this.#req('GET', '/policies') }
  test(b) { return this.#req('POST', '/policies/test', b) }
  propose(b) { return this.#req('POST', '/policy-proposals', b) }
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) })

const NATIVE = [
  { name: 'gateway_check', description: 'Ask the Gateway whether an action is allowed BEFORE doing it with a tool that is not routed through this server. Returns allow, deny or escalate. Do not proceed on deny or escalate.',
    inputSchema: { type: 'object', required: ['tool', 'action'], properties: { tool: { type: 'string' }, action: { type: 'string', enum: ['READ', 'WRITE', 'PAYMENT'] }, args: { type: 'object' }, resource: { type: 'object' }, context: { type: 'object', description: 'e.g. { amount: 25000, currency: "EUR" }' } } } },
  { name: 'gateway_policies', description: 'List the rules that govern you (read only).', inputSchema: { type: 'object', properties: {} } },
  { name: 'gateway_test_policy', description: 'Dry run: what would the Gateway answer for this action? Changes nothing and is not logged.',
    inputSchema: { type: 'object', required: ['tool'], properties: { tool: { type: 'string' }, action: { type: 'string', enum: ['READ', 'WRITE', 'PAYMENT'] }, args: { type: 'object' }, resource: { type: 'object' }, context: { type: 'object' } } } },
  { name: 'gateway_propose_policy', description: 'Propose a new rule. It is created DISABLED and has no effect until a person enables it in the console. You cannot enable, edit or delete policies. Use gateway_test_policy first to show what the rule would change.',
    inputSchema: { type: 'object', required: ['name', 'action', 'conditions'], properties: { name: { type: 'string' }, description: { type: 'string' }, priority: { type: 'integer' }, action: { type: 'string', enum: ['allow', 'deny', 'escalate', 'rate_limit'] }, conditions: { type: 'array', items: { type: 'object', required: ['field', 'operator', 'value'], properties: { field: { type: 'string', description: 'tool, action, context.amount, resource.classification, args.<path>, agent.role …' }, operator: { type: 'string', enum: ['=', '!=', '>', '<', '>=', '<=', 'IN', 'NOT_IN', 'CONTAINS', 'STARTS_WITH', 'MATCHES'] }, value: { type: 'string' } } } } } } },
]

/**
 * The server. Governed tools from upstream MCP servers are re-exposed as `<upstream>__<tool>`; every call is
 * decided by the Gateway first, and fails closed (a Gateway that cannot be reached means no tool runs).
 */
class GatewayMcp {
  constructor({ gateway, upstreams = [], actions = {} }) { this.gw = gateway; this.cfg = upstreams; this.actions = actions; this.ups = new Map(); this.catalog = new Map() }

  async start() {
    for (const u of this.cfg) {
      try {
        const up = await startUpstream(u); this.ups.set(u.name, up)
        for (const t of await up.tools()) this.catalog.set(`${u.name}__${t.name}`, { upstream: u.name, tool: t, original: t.name })
      } catch (e) { console.error(`[embmis-gateway-mcp] upstream '${u.name}' did not start: ${e.message}`) }
    }
  }
  close() { for (const u of this.ups.values()) u.close() }

  listTools() {
    const governed = [...this.catalog.entries()].map(([name, c]) => ({ ...c.tool, name, description: `[checked by the Gateway] ${c.tool.description || ''}`.trim() }))
    return [...NATIVE, ...governed]
  }

  async callTool(name, args = {}) {
    try {
      if (name === 'gateway_check') { const r = await this.gw.decide(args); return this.#verdict(r) }
      if (name === 'gateway_policies') return this.#plain(await this.gw.policies())
      if (name === 'gateway_test_policy') return this.#plain(await this.gw.test(args))
      if (name === 'gateway_propose_policy') {
        const r = await this.gw.propose(args)
        return r.status === 201 ? text({ ...r.body, note: 'Tell the user a rule is waiting for their review in the Gateway console. Do not assume it is active.' }) : this.#plain(r)
      }
      const c = this.catalog.get(name)
      if (!c) return text(`Unknown tool ${name}.`, true)
      const action = classify(c.original, this.actions)
      const amount = typeof args.amount === 'number' ? args.amount : undefined
      const r = await this.gw.decide({ tool: c.original, action, args, resource: { module: c.upstream }, context: amount !== undefined ? { amount } : {} })
      const d = r.body
      if (r.status !== 200) return text(`The Gateway could not check this action (${r.body?.code || r.status}). Nothing was run.`, true)
      if (d.decision !== 'allow') return this.#verdict(r)
      const out = await this.ups.get(c.upstream).peer.request('tools/call', { name: c.original, arguments: args }, 120000)
      return out
    } catch (e) {
      // Gateway unreachable, upstream failed: nothing runs.
      return text(`Nothing was run. ${e.message}`, true)
    }
  }

  #plain(r) { return r.status >= 200 && r.status < 300 ? text(r.body) : text(`${r.body?.code || r.status}: ${r.body?.error || 'request failed'}`, true) }
  #verdict(r) {
    const d = r.body
    if (r.status !== 200) return this.#plain(r)
    if (d.decision === 'allow') return text({ decision: 'allow', reason: d.reason, traceId: d.traceId })
    const msg = d.decision === 'deny'
      ? `The Gateway DENIED this action: ${d.reason}. It was not run. Do not retry or work around it; tell the user.`
      : `The Gateway ESCALATED this action to a person: ${d.reason}. It was NOT run. Tell the user it needs their approval (trace ${d.traceId}) and wait; do not retry.`
    return text({ decision: d.decision, reason: d.reason, traceId: d.traceId, instruction: msg }, true)
  }

  handler() {
    return async (m) => {
      if (m.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'embmis-gateway-mcp', version: VERSION } }
      if (m.method === 'tools/list') return { tools: this.listTools() }
      if (m.method === 'tools/call') return this.callTool(m.params?.name, m.params?.arguments)
      if (m.method === 'ping') return {}
      if (m.method?.startsWith('notifications/')) return undefined
      throw Object.assign(new Error(`Method not found: ${m.method}`), { code: -32601 })
    }
  }
  serve(input = process.stdin, output = process.stdout) { return new Peer(input, output, this.handler()) }
}

module.exports = { GatewayMcp, Gateway, classify, Peer }
