# Secure Your AI Agent in 5 Minutes

Add governance guardrails to any AI agent with 3 lines of code.

## What This Does

This is a simple Express API that wraps 3 tool functions through **EMBMIS Gateway**. Every tool call is evaluated for:

- **Policy compliance** — is this agent allowed to use this tool?
- **Risk scoring** — how dangerous is this specific request?
- **Payload analysis** — does the request contain high-risk content?

The tool function only executes if SAG approves. Otherwise it's blocked or held for human review.

## Setup

```bash
# 1. Start SAG (if not already running)
docker-compose up -d

# 2. Install dependencies
cd examples/secure-ai-agent
npm install

# 3. Start the example app
node index.js
```

## Try It

### Generate a report (low risk → APPROVED)
```bash
curl -X POST http://localhost:4001/generate-report \
  -H "Content-Type: application/json" \
  -d '{"type":"quarterly","department":"finance"}'
```

Response:
```json
{
  "toolResult": { "reportId": "RPT-...", "type": "quarterly", "pages": 12 },
  "sag": { "status": "APPROVED", "risk": 35 }
}
```

### Small payment (medium risk → ESCALATED)
```bash
curl -X POST http://localhost:4001/send-payment \
  -H "Content-Type: application/json" \
  -d '{"amount":500,"currency":"USD","recipient":"vendor-77"}'
```

Response:
```json
{
  "toolResult": null,
  "sag": {
    "status": "ESCALATED",
    "risk": 60,
    "message": "Payment held for human approval."
  }
}
```

### Large payment (high risk → DENIED)
```bash
curl -X POST http://localhost:4001/send-payment \
  -H "Content-Type: application/json" \
  -d '{"amount":50000,"currency":"USD","recipient":"vendor-acme"}'
```

Response:
```json
{
  "toolResult": null,
  "sag": {
    "status": "DENIED",
    "risk": 85,
    "reason": "Risk score 85/100 exceeded auto-block threshold"
  }
}
```

### Explain a decision
```bash
curl "http://localhost:4001/explain?tool=payment.initiate&amount=50000"
```

Shows exact risk factors and their weights.

## How It Works

```js
const sag = require('@sag/node')({
    agent: process.env.SAG_AGENT,
    key: process.env.SAG_KEY,
});

// Wrap any tool call
const decision = await sag.execute('payment.initiate', { amount: 50000 });

if (decision.blocked) {
    // SAG denied it — don't execute
    return res.status(403).json({ error: decision.reason });
}

// SAG approved — safe to execute
const result = sendPayment(50000);
```

## Configuration

Copy `.env.example` to `.env`:

| Variable | Description |
|---|---|
| `SAG_ENDPOINT` | SAG Gateway URL (default: `http://localhost:3000`) |
| `SAG_AGENT` | Agent name registered in SAG |
| `SAG_KEY` | Agent API key |
