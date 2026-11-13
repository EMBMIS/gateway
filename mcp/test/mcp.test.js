'use strict'
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PassThrough } = require('stream')
const { GatewayMcp, Gateway, classify, Peer } = require('../src')

let passed = 0, failed = 0
const assert = (n, ok, d) => { if (ok) { console.log('  ✅ ' + n); passed++ } else { console.error('  ❌ ' + n, d !== undefined ? JSON.stringify(d) : ''); failed++ } }

async function main() {
  const seen = []
  const gw = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = b ? JSON.parse(b) : {}; seen.push({ url: req.url, auth: req.headers.authorization, body })
      const j = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
      if (req.headers.authorization !== 'Bearer k1') return j(401, { code: 'INVALID_AGENT_KEY', error: 'bad key' })
      if (req.url === '/api/v1/decide') {
        if (/^delete_/.test(body.tool)) return j(200, { decision: 'deny', reason: 'delete tools are denied', traceId: 't-del' })
        if (body.action === 'PAYMENT') return j(200, { decision: 'escalate', reason: 'payments need approval', traceId: 't-pay' })
        return j(200, { decision: 'allow', reason: 'ok', traceId: 't-ok' })
      }
      if (req.url === '/api/v1/policies') return j(200, { policies: [{ name: 'ERP: payments need approval', enabled: true }] })
      if (req.url === '/api/v1/policies/test') return j(200, { decision: 'escalate' })
      if (req.url === '/api/v1/policy-proposals') return j(201, { policyId: 'p1', enabled: false, status: 'awaiting_review' })
      j(404, {})
    })
  })
  await new Promise((r) => gw.listen(0, r))
  const url = `http://127.0.0.1:${gw.address().port}`
  const callsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-')), 'calls')
  fs.writeFileSync(callsFile, '')
  const ran = () => fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean)

  const mcp = new GatewayMcp({ gateway: new Gateway({ url, key: 'k1', agentName: 'claude', tenantId: 'acme' }), upstreams: [{ name: 'erp', command: process.execPath, args: [path.join(__dirname, 'fake-upstream.js')], env: { CALLS_FILE: callsFile } }] })
  await mcp.start()
  const cin = new PassThrough(), cout = new PassThrough()
  mcp.serve(cin, cout)
  const client = new Peer(cout, cin, async () => ({}))
  const call = async (name, args) => client.request('tools/call', { name, arguments: args })
  const body = (r) => r.content[0].text

  console.log('\n  Gateway MCP tests\n')
  const init = await client.request('initialize', {})
  assert('initialize', init.serverInfo.name === 'embmis-gateway-mcp' && init.capabilities.tools)
  const names = (await client.request('tools/list', {})).tools.map((t) => t.name)
  assert('exposes the Gateway tools and the upstream tools, prefixed', ['gateway_check', 'gateway_propose_policy', 'erp__get_stock', 'erp__delete_supplier', 'erp__create_payment'].every((n) => names.includes(n)), names)
  assert('exposes no tool that enables, edits or deletes a policy', !names.some((n) => /enable|edit|update|delete_policy|apply/.test(n) && n.startsWith('gateway_')), names)

  console.log('\n  Governed upstream tools:')
  let r = await call('erp__get_stock', { sku: 1 })
  assert('allowed read runs upstream', body(r) === 'ran get_stock' && ran().join() === 'get_stock', [body(r), ran()])
  assert('Gateway saw the agent key, name, tenant and action READ', seen.at(-1).auth === 'Bearer k1' && seen.at(-1).body.action === 'READ' && seen.at(-1).body.agentName === 'claude' && seen.at(-1).body.context.tenantId === 'acme', seen.at(-1))
  r = await call('erp__delete_supplier', { id: 3 })
  assert('denied: nothing runs, the AI is told not to work around it', r.isError && /DENIED/.test(body(r)) && ran().length === 1, [body(r), ran()])
  r = await call('erp__create_payment', { amount: 25000 })
  assert('escalated: nothing runs, the AI is told to ask the person', r.isError && /ESCALATED/.test(body(r)) && /t-pay/.test(body(r)) && ran().length === 1, [body(r), ran()])
  assert('payment classified as PAYMENT with its amount', seen.at(-1).body.action === 'PAYMENT' && seen.at(-1).body.context.amount === 25000, seen.at(-1))

  console.log('\n  AI-configurable, but only by proposal:')
  r = await call('gateway_policies', {}); assert('can read its policies', /payments need approval/.test(body(r)))
  r = await call('gateway_test_policy', { tool: 'create_refund' }); assert('can dry-run a rule', /escalate/.test(body(r)))
  r = await call('gateway_propose_policy', { name: 'Refunds', action: 'escalate', conditions: [{ field: 'tool', operator: 'MATCHES', value: 'refund' }] })
  assert('a proposal is reported as disabled and awaiting a person', /awaiting_review/.test(body(r)) && /Do not assume it is active/.test(body(r)), body(r))
  r = await call('gateway_check', { tool: 'send_email', action: 'WRITE' }); assert('gateway_check returns the verdict', /allow/.test(body(r)))

  console.log('\n  Fail closed:')
  const bad = new GatewayMcp({ gateway: new Gateway({ url, key: 'wrong' }), upstreams: [] })
  bad.catalog.set('erp__get_stock', { upstream: 'erp', original: 'get_stock', tool: { name: 'get_stock' } }); bad.ups = mcp.ups
  r = await bad.callTool('erp__get_stock', {})
  assert('a rejected key means nothing runs', r.isError && ran().length === 1, [body(r), ran()])
  const down = new GatewayMcp({ gateway: new Gateway({ url: 'http://127.0.0.1:1', key: 'k1', timeoutMs: 500 }), upstreams: [] })
  down.catalog.set('erp__get_stock', { upstream: 'erp', original: 'get_stock', tool: { name: 'get_stock' } }); down.ups = mcp.ups
  r = await down.callTool('erp__get_stock', {})
  assert('an unreachable Gateway means nothing runs', r.isError && /Nothing was run/.test(body(r)) && ran().length === 1, [body(r), ran()])

  console.log('\n  Classification:')
  assert('names map to READ / WRITE / PAYMENT', classify('list_invoices') === 'READ' && classify('create_invoice') === 'WRITE' && classify('issue_refund') === 'PAYMENT' && classify('get_x', { get_x: 'WRITE' }) === 'WRITE')

  mcp.close(); gw.close()
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
