# sag-mcp-proxy

Drop-in MCP proxy that intercepts every `tools/call` request and enforces SAG's security gateway before forwarding to your real MCP server.

## Quickstart

```bash
npm install sag-mcp-proxy
```

```js
const { SAGMCPProxy } = require('sag-mcp-proxy');
const proxy = new SAGMCPProxy({
  upstream:      'http://localhost:3002',          // your real MCP server
  sagApiKey:     process.env.SAG_API_KEY,          // from SAG dashboard
  sagGatewayUrl: process.env.SAG_GATEWAY_URL || 'http://localhost:3000',
  port:          3001,
});
proxy.listen(3001);
// Now point your AI agents at http://localhost:3001 instead of 3002
```

## How it works

| Decision | HTTP | Action |
|---|---|---|
| `APPROVED` | 200 | Forwarded to upstream MCP server |
| `DENIED` | 403 | JSON-RPC error `-32600` returned; upstream never called |
| `ESCALATED` | 202 | JSON-RPC error `-32601` returned; request queued for human review |

All other MCP methods (`tools/list`, `resources/read`, etc.) pass through unchanged. Every interception is logged: `[SAG-MCP] tool=X decision=Y latency=Zms`.
