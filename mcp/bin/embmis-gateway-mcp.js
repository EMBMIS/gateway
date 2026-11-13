#!/usr/bin/env node
'use strict'
// Usage: embmis-gateway-mcp [--config sag-mcp.json]
// Env (alternative to a config file): EMBMIS_GATEWAY_URL, EMBMIS_AGENT_KEY, EMBMIS_AGENT_NAME, EMBMIS_TENANT_ID
const fs = require('fs')
const { GatewayMcp, Gateway } = require('../src')
const i = process.argv.indexOf('--config')
const cfg = i > 0 ? JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')) : {}
const g = cfg.gateway || {}
const gateway = new Gateway({
  url: g.url || process.env.EMBMIS_GATEWAY_URL || 'https://embmis.com/gateway',
  key: g.key || process.env.EMBMIS_AGENT_KEY,
  agentName: g.agentName || process.env.EMBMIS_AGENT_NAME,
  tenantId: g.tenantId || process.env.EMBMIS_TENANT_ID,
})
const server = new GatewayMcp({ gateway, upstreams: cfg.upstreams || [], actions: cfg.actions || {} })
server.start().then(() => server.serve()).catch((e) => { console.error(e.message); process.exit(1) })
process.on('exit', () => server.close())
