import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader, Tabs, InlineNotice, Code, Button } from '../components/ui'
import CodeBlock from '../components/CodeBlock'
import { BASE, withBase } from '../lib/api'

const origin = typeof window !== 'undefined' ? `${window.location.origin}${BASE}` : 'https://embmis.com/gateway'

const V1 = `# 1. On the gateway host: create a platform key (the gateway stores only its hash)
npm run platform-key
#    -> prints sag_platform_… and the SAG_PLATFORM_KEY_HASHES=… line to add to the gateway's environment

# 2. Register a tenant and its agent (idempotent; seeds the default ERP policies)
curl -X PUT  ${origin}/api/v1/tenants/acme \\
  -H "Authorization: Bearer $PLATFORM_KEY" -H "Content-Type: application/json" -d '{"name":"Acme Ltd"}'
curl -X POST ${origin}/api/v1/tenants/acme/agents \\
  -H "Authorization: Bearer $PLATFORM_KEY" -H "Content-Type: application/json" \\
  -d '{"name":"simeli","role":"erp-operator"}'
#    -> {"agentId":"ag_…","key":"sag_agent_…"}   shown once; add ?rotate=true to issue a new one

# 3. Ask before acting. Nothing is executed by the gateway.
curl -X POST ${origin}/api/v1/decide \\
  -H "Authorization: Bearer $AGENT_KEY" -H "Content-Type: application/json" -d '{
    "agentName": "simeli", "tool": "create_payment", "action": "PAYMENT",
    "args": { "supplier": "Northwind" },
    "resource": { "kind": "payment", "module": "finance", "classification": "financial" },
    "context": { "tenantId": "acme", "userId": "u_81", "amount": 25000, "currency": "EUR" } }'
#    -> { "decision": "escalate", "code": "POLICY_ESCALATE", "reason": "…", "traceId": "…", "riskScore": …, … }

# 4. When a person answers an escalation, record it in the audit chain
curl -X POST ${origin}/api/v1/decisions/$TRACE_ID/resolve \\
  -H "Authorization: Bearer $AGENT_KEY" -H "Content-Type: application/json" \\
  -d '{"outcome":"approved","by":"user:u_81","reason":"Checked the invoice"}'`

const NODE = `npm install @sag/node

const sag = require('@sag/node')({
  agent: 'FinanceAgent-7',
  key: process.env.SAG_AGENT_KEY,
  endpoint: '${origin}',
});

// Every tool call goes through the gateway first
const result = await sag.execute('payment.initiate', { amount: 50000, currency: 'USD', recipient: 'vendor-account-id' });

if (result.blocked) {
  console.log('Blocked:', result.reason, 'risk', result.riskScore);
} else {
  console.log('Approved. Trace:', result.traceId);
}

// Dry run: would it be allowed? Nothing is executed.
const check = await sag.check('payment.initiate', { amount: 100000 });`

const PY = `pip install ./sdk/python        # from the EMBMIS Gateway repository

# Set once, before anything else imports openai / anthropic / langchain
export SAG_API_KEY=your-agent-key
export SAG_GATEWAY_URL=${origin}

import sag_intercept            # first import in your entrypoint: patches the three libraries
# ... your existing code, unchanged ...

# or ask explicitly:
from sag_intercept import check_tool_call`

const INTERCEPT = `npm install sag-intercept

// Very first import in your entrypoint
require('sag-intercept');

// Learn first: observe without blocking, then generate a policy from what was seen
SAG_MODE=learn  SAG_API_KEY=… node your_app.js     # writes .sag-observations.jsonl
npx sag-generate-policy                             # reads it, writes policy.bundle.json

// Then enforce
SAG_MODE=enforce SAG_API_KEY=… SAG_GATEWAY_URL=${origin} node your_app.js`

const MCP = `npm install sag-mcp-proxy

const { SAGMCPProxy } = require('sag-mcp-proxy');
const proxy = new SAGMCPProxy({
  upstream:      'http://localhost:3002',            // your real MCP server
  sagApiKey:     process.env.SAG_API_KEY,
  sagGatewayUrl: '${origin}',
  port:          3001,
});
proxy.listen(3001);
// Point your agents at http://localhost:3001 instead of 3002.
// APPROVED is forwarded, DENIED returns a JSON-RPC error, ESCALATED returns a JSON-RPC error and waits for a person.`

function Guide({ title, intro, code, children }) {
  return (
    <div className="space-y-3">
      <div><h3 className="text-base font-semibold text-fg">{title}</h3><p className="mt-1 text-sm text-ink-700">{intro}</p></div>
      <CodeBlock code={code} label={title} />
      {children}
    </div>
  )
}

export default function Connect() {
  const [tab, setTab] = useState('v1')
  return (
    <>
      <PageHeader title="Integration guides" description="Four ways to put the gateway in front of an AI agent. Pick the one that matches how your agent runs its tools." secondary={<Button to="/connect/keys">API keys</Button>} />
      <Tabs
        value={tab}
        onChange={setTab}
        label="Integration guides"
        tabs={[{ id: 'v1', label: 'Platform API' }, { id: 'node', label: 'Node SDK' }, { id: 'python', label: 'Python SDK' }, { id: 'intercept', label: 'Intercept' }, { id: 'mcp', label: 'MCP proxy' }]}
      >
        {(t) => ({
          v1: <Guide title="Platform API (v1): you run your own tools" intro="For products such as EMBMIS Business OS that execute their own tools. The gateway only decides; your platform acts on the answer." code={V1}>
            <InlineNotice tone="ink">The full reference is the OpenAPI 3.1 document at <a className="font-medium text-brand-600 underline-offset-2 hover:underline" href={withBase('/api/v1/openapi.yaml')}>/api/v1/openapi.yaml</a>. Errors are always <Code>{'{ "error", "code" }'}</Code>.</InlineNotice>
          </Guide>,
          node: <Guide title="Node SDK: the gateway runs the tool" intro="Three lines around any tool call. The gateway decides, then executes approved calls in an isolated worker and returns the result." code={NODE} />,
          python: <Guide title="Python SDK: patch what is already there" intro="Importing the package patches OpenAI, Anthropic and LangChain tool calls so they pass through the gateway." code={PY} />,
          intercept: <Guide title="Intercept: one import, no code changes" intro="Watch first, enforce later. Learn mode never blocks; it records what your agent does so a starting policy can be generated." code={INTERCEPT} />,
          mcp: <Guide title="MCP proxy: sit in front of an MCP server" intro="Every tools/call passes through the gateway before it reaches the real server. Other MCP methods pass through unchanged." code={MCP} />,
        })[t]}
      </Tabs>
      <p className="mt-6 text-sm text-ink-600">Agents need a key: <Link to="/agents?new=1" className="font-medium text-brand-600 underline-offset-2 hover:underline">create one</Link>. Keys are shown once.</p>
    </>
  )
}
