# EMBMIS Gateway for AI clients (MCP)

Put the Gateway in front of an AI. Any MCP client (Claude Desktop, Cursor, an agent framework) connects to this server instead of directly to your tools. Every tool call is checked by the Gateway first.

```jsonc
// claude_desktop_config.json (or any MCP client config)
{ "mcpServers": { "embmis": {
  "command": "npx", "args": ["@embmis/gateway-mcp", "--config", "/path/sag-mcp.json"] } } }
```

```jsonc
// sag-mcp.json
{
  "gateway": { "url": "https://embmis.com/gateway", "key": "sag_agent_…", "agentName": "claude", "tenantId": "acme" },
  "upstreams": [ { "name": "erp", "command": "node", "args": ["erp-mcp-server.js"] } ],
  "actions": { "issue_credit_note": "PAYMENT" }      // optional: override READ / WRITE / PAYMENT
}
```
(or `EMBMIS_GATEWAY_URL`, `EMBMIS_AGENT_KEY`, `EMBMIS_AGENT_NAME`, `EMBMIS_TENANT_ID`). Get the agent key from the console or `POST /api/v1/tenants/{id}/agents`.

## What the AI sees

* **Your tools, governed.** Each upstream tool appears as `<upstream>__<tool>`. Before it runs, the Gateway decides:
  `allow` runs it; `deny` and `escalate` do **not** run it, and the AI is told not to work around the verdict (for escalations: ask the person, trace id included). If the Gateway cannot be reached, nothing runs.
* **`gateway_check`** for tools that are not routed through this server.
* **Configuration the AI can do itself:** `gateway_policies` (read the rules), `gateway_test_policy` (dry run, changes nothing), `gateway_propose_policy`.

## The limit that matters

An AI can **propose** a rule; it cannot apply one. A proposal is stored **disabled**, marked "Proposed by <agent>", written to the audit chain, and shown in the console's Policies page. It does nothing until a person turns it on. There is no endpoint, for an agent key, that enables, edits or deletes a policy, so an AI cannot loosen its own rules. At most 20 proposals can wait for review.

## Known limits

* An escalated action is not executed after a person approves it: the person (or the AI, asked again) has to issue it again. The approval is recorded in the audit chain.
* Action type (READ/WRITE/PAYMENT) is inferred from the tool name unless you override it in `actions`.
* stdio transport only.
