'use strict'
const { spawn } = require('child_process')

/** Newline-delimited JSON-RPC 2.0 over a pair of streams (the MCP stdio transport). */
class Peer {
  constructor(input, output, onRequest) {
    this.out = output; this.onRequest = onRequest; this.nextId = 1; this.pending = new Map(); this.buf = ''
    input.setEncoding('utf8')
    input.on('data', (d) => { this.buf += d; let i; while ((i = this.buf.indexOf('\n')) >= 0) { const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (line) this.#line(line) } })
    input.on('end', () => { for (const p of this.pending.values()) p.reject(new Error('closed')); this.pending.clear() })
  }
  #send(m) { this.out.write(JSON.stringify(m) + '\n') }
  async #line(line) {
    let m; try { m = JSON.parse(line) } catch { return this.#send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
    if (m.method === undefined) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error.message), m.error)) : p.resolve(m.result) } return }
    if (m.id === undefined) return this.onRequest?.(m, true)
    try { this.#send({ jsonrpc: '2.0', id: m.id, result: await this.onRequest(m) }) }
    catch (e) { this.#send({ jsonrpc: '2.0', id: m.id, error: { code: e.code || -32603, message: e.message } }) }
  }
  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }
  notify(method, params) { this.#send({ jsonrpc: '2.0', method, params }) }
}

/** A child MCP server we sit in front of. */
async function startUpstream({ command, args = [], env = {}, cwd }) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
  const peer = new Peer(child.stdout, child.stdin, async () => ({}))
  child.on('error', () => {})
  await peer.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'embmis-gateway-mcp', version: '0.1.0' } })
  peer.notify('notifications/initialized', {})
  return { peer, child, tools: async () => (await peer.request('tools/list', {})).tools || [], close: () => child.kill() }
}

module.exports = { Peer, startUpstream }
