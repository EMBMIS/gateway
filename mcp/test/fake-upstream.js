// A tiny MCP server over stdio with three tools; writes a line to $CALLS_FILE for every tool that actually ran.
const fs = require('fs')
let buf = ''
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
process.stdin.on('data', (d) => {
  buf += d; let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
    if (m.id === undefined) continue
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: ['get_stock', 'delete_supplier', 'create_payment'].map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) } })
    else if (m.method === 'tools/call') { fs.appendFileSync(process.env.CALLS_FILE, m.params.name + '\n'); send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ran ' + m.params.name }] } }) }
  }
})
