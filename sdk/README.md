# @sag/node

**Prevent AI agents from doing things you didn't intend.**

EMBMIS Gateway SDK for Node.js. Zero dependencies. 3 lines to protect any tool call.

## Install

```bash
npm install @sag/node
```

## Quick Start

```js
const sag = require('@sag/node')({
  agent: 'FinanceAgent-7',
  key: 'your-agent-api-key',
});

// Every tool call goes through SAG
const result = await sag.execute('payment.initiate', {
  amount: 50000,
  currency: 'USD',
  recipient: 'vendor-account-id',
});

if (result.blocked) {
  console.log('🚫 Blocked:', result.reason);
  console.log('Risk Score:', result.riskScore);
} else {
  console.log('✅ Approved. Trace:', result.traceId);
}
```

## What It Does

When you call `sag.execute()`:

1. Your request hits the SAG Gateway
2. Gateway checks agent identity, policy, and risk score
3. If allowed → executes the tool and returns the result
4. If blocked → returns the reason and risk score
5. Everything is logged to a tamper-proof audit ledger

You don't write policy rules in code. You configure them in the dashboard.

## API

### `require('@sag/node')(config)`

| Option | Type | Default | Description |
|---|---|---|---|
| `agent` | string | *required* | Agent name |
| `key` | string | *required* | Agent API key |
| `endpoint` | string | `http://localhost:3000` | SAG Gateway URL |
| `timeout` | number | `5000` | Request timeout (ms) |
| `failOpen` | boolean | `false` | Allow actions when SAG is unreachable |
| `onDecision` | function | — | Callback on every allow/deny decision |

### `sag.execute(tool, args?, opts?)`

Execute a tool call through the enforcement layer.

```js
const result = await sag.execute('db.query', { sql: 'SELECT * FROM users' });

result.allowed    // true or false
result.blocked    // true or false
result.status     // 'APPROVED', 'DENIED', 'ESCALATED', 'ERROR'
result.riskScore  // 0-100
result.traceId    // UUID for audit trail
result.reason     // Why it was blocked (if blocked)
```

### `sag.check(tool, args?)`

Dry-run policy check. No execution.

```js
const check = await sag.check('payment.initiate', { amount: 100000 });
if (!check.allowed) {
  console.log('Would be blocked. Risk:', check.risk);
}
```

### `sag.history(limit?)`

Get recent audit entries.

```js
const logs = await sag.history(20);
```

## Fail-Open vs Fail-Closed

By default, if SAG is unreachable, your tool call **fails**. This is secure.

If you need availability over security:

```js
const sag = require('@sag/node')({
  agent: 'my-agent',
  key: 'xxx',
  failOpen: true,  // ⚠️ Allows actions when SAG is down
});
```

## Decision Logging

Track every decision in your own system:

```js
const sag = require('@sag/node')({
  agent: 'my-agent',
  key: 'xxx',
  onDecision: (result) => {
    myLogger.info({
      tool: result.tool,
      allowed: result.allowed,
      risk: result.riskScore,
      trace: result.traceId,
    });
  },
});
```

## Running SAG Locally

```bash
docker-compose up
```

Dashboard opens at `http://localhost:3000`.

## License

MIT
