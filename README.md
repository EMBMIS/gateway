# EMBMIS Gateway

> Formerly SAG. The `sag` command-line tool and the `SAG_*` environment variables keep their names for compatibility.

A deterministic pre-execution firewall for autonomous AI agents.

**Free and open source** under the [Apache License 2.0](LICENSE): no check limit, no paid tier, every feature included.
Need it set up, customised for your stack, or supported in production? [EMBMIS](https://embmis.com) offers setup,
customisation and support.

Every tool call an AI makes — payments, database queries, API calls — is intercepted and evaluated **before** it executes. The gateway returns one of three decisions: **ALLOW**, **DENY**, or **ESCALATE**. Core principle: **decide first, execute second.**

---

## Screenshots

The console, with demo traffic from `scripts/demo-traffic.js`:

![Dashboard: every decision, allowed, blocked or sent to a person](docs/screenshots/dashboard.png)
![Escalation queue: actions waiting for a person to approve or reject](docs/screenshots/escalation-queue.png)
![Policies: the rules that decide](docs/screenshots/policies.png)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  AI Agent (OpenAI / Anthropic / LangChain)              │
│  ↓  one import (sag-intercept)                          │
├─────────────────────────────────────────────────────────┤
│  Gateway Process  (HTTP :3000)                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  6-Step Security Pipeline                         │  │
│  │  1. Agent auth + plan limit + financial guard     │  │
│  │  2. Policy evaluation (signed bundle)             │  │
│  │  3. LLM intent analysis (semantic gap detection)  │  │
│  │  4. Risk scoring (heuristic + behavioral)         │  │
│  │  5. Behavioral analysis (cross-request patterns)  │  │
│  │  6. Usage tracking                                │  │
│  └────────────────────────┬─────────────────────────┘  │
│    DENY/ESCALATE ←────────┤                             │
│    ALLOW ─────────────────↓                             │
├─────────────────────────────────────────────────────────┤
│  Enclave Worker Pool  (gRPC :50051–:5005N)              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                │
│  │ Worker 0 │ │ Worker 1 │ │ Worker N │  round-robin   │
│  └──────────┘ └──────────┘ └──────────┘                │
│  Ed25519 ticket signing · mTLS · Redis nonce cache      │
└─────────────────────────────────────────────────────────┘
```

Two-process OS isolation. The gateway and enclave workers are separate processes. Tickets crossing the boundary are Ed25519-signed with a 2-second TTL. The enclave worker re-evaluates every decision independently — it does not trust the gateway.

---

## Quick Start

### Prerequisites

- Node.js 18+
- Redis (for replay protection in enclave workers)
- OpenSSL (for generating mTLS certs)

### 1. Clone and install

```bash
git clone https://github.com/EMBMIS/gateway
cd gateway
npm install
```

### 2. Generate development keys

```bash
npm run keys:dev
```

This writes mTLS certificates, the gateway/worker Ed25519 key pairs and a freshly signed policy bundle into `certs/`, `.kms-vault/` and `policy.bundle.json`. All three are gitignored. Keys are never committed: production reads them from environment variables or a mounted secrets directory (`SAG_SECRETS_DIR`), and refuses to start with missing keys or with any key that was once committed to this repository. See [SECURITY-ROTATION.md](SECURITY-ROTATION.md).

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

Required env vars:

```env
# Database (omit for SQLite dev mode)
DB_ADAPTER=postgres
DATABASE_URL=postgres://admin:password@localhost:5432/sag_db

# Redis (required by enclave workers for replay protection)
REDIS_URL=redis://localhost:6379

# mTLS enforcement (set to true in production)
ENABLE_MTLS=true

# Worker pool
ENCLAVE_POOL_SIZE=2        # number of enclave worker processes to spawn
ENCLAVE_BASE_PORT=50051    # first port; workers use 50051, 50052, ...

# LLM intent analysis (optional — gateway degrades gracefully without it)
OPENAI_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini

# App
APP_URL=https://gateway.qira.one
PORT=3000
```

### 4. Run

```bash
npm start
```

The gateway starts on `:3000` and automatically spawns `ENCLAVE_POOL_SIZE` enclave worker processes on consecutive gRPC ports.

---

## v1 API: for platforms that run their own tools

EMBMIS Business OS and any platform that executes its own tools asks the gateway **before** it acts. Nothing is executed by the gateway on this API. Full reference: [`docs/openapi.yaml`](docs/openapi.yaml) (also served at `/api/v1/openapi.yaml`).

```bash
# 1. Create a platform key (the gateway stores only the hash)
npm run platform-key            # prints the key and the SAG_PLATFORM_KEY_HASHES line for the gateway's environment

# 2. Provision a tenant and its agent (idempotent; seeds the default ERP policies)
curl -X PUT  $GW/api/v1/tenants/acme        -H "Authorization: Bearer $PLATFORM_KEY" -H 'content-type: application/json' -d '{"name":"Acme Ltd"}'
curl -X POST $GW/api/v1/tenants/acme/agents -H "Authorization: Bearer $PLATFORM_KEY" -H 'content-type: application/json' -d '{"name":"simeli","role":"erp-operator"}'
#    -> {"agentId":"ag_...","name":"simeli","role":"erp-operator","key":"sag_agent_..."}   (key shown once; ?rotate=true issues a new one)

# 3. Ask before acting
curl -X POST $GW/api/v1/decide -H "Authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' -d '{
  "agentName":"simeli","tool":"create_payment","action":"PAYMENT","args":{"supplier":"Northwind"},
  "resource":{"kind":"payment","module":"finance","classification":"financial"},
  "context":{"tenantId":"acme","userId":"u_81","amount":25000,"currency":"EUR"}}'
#    -> {"decision":"escalate","code":"POLICY_ESCALATE","reason":"...","traceId":"...","riskScore":..,"riskFactors":[..],
#        "matchedPolicy":{..},"auditId":"..","latencyMs":..}

# 4. When a person answers an escalation, record it in the audit chain
curl -X POST $GW/api/v1/decisions/$TRACE_ID/resolve -H "Authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
     -d '{"outcome":"approved","by":"user:u_81","reason":"Checked the invoice"}'
```

Default ERP policies for a new tenant: reads allow; `delete_*` deny; ledger, journal, payment and approve tools escalate; amounts of 10,000 or more escalate; `export_*` of personal data escalate. Edit them per tenant in the console (Policies). Errors are always `{ "error", "code" }`.

## Drop-in Package: `sag-intercept`

The fastest path to securing an existing AI codebase. One import, zero code changes.

```bash
npm install sag-intercept
```

```js
// Add this as the very first import in your entrypoint
require('sag-intercept');

// Everything below is unchanged — all OpenAI / Anthropic / LangChain calls
// are now automatically gated through SAG.
const OpenAI = require('openai');
const client = new OpenAI();
```

### Learn mode (zero risk — just observe)

```bash
SAG_MODE=learn SAG_API_KEY=your_key node your_app.js
# Logs all tool calls to .sag-observations.jsonl
```

### Generate a policy from observations

```bash
npx sag-generate-policy
# Reads .sag-observations.jsonl → writes policy.bundle.json
```

### Enforce mode

```bash
SAG_MODE=enforce SAG_API_KEY=your_key SAG_GATEWAY_URL=http://localhost:3000 node your_app.js
```

---

## API Reference

All endpoints return JSON. Auth is via `Bearer <api_key>` header or `x-api-key` header.

### Gateway

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/gateway/execute` | Submit a tool call for evaluation |
| `POST` | `/api/gateway/simulate` | Test policy + risk without executing |
| `POST` | `/api/explain` | Full decision breakdown (policy + intent + risk) |

**Execute a tool call:**

```bash
curl -X POST http://localhost:3000/api/gateway/execute \
  -H "Authorization: Bearer sag_live_your_key" \
  -H "Content-Type: application/json" \
  -d '{
    "agentName": "finance-bot",
    "tool": "stripe.payment.create",
    "action": "EXECUTE",
    "args": { "amount": 500, "currency": "usd", "destination": "acct_123" }
  }'
```

**Response:**

```json
{
  "status": "APPROVED",
  "code": "EXECUTED",
  "riskScore": 42,
  "audit": { "seq": 1041, "requestHash": "a3f2...", "chainHash": "91cc..." },
  "enclave": { "attestation": "tee-sim-...", "dataExposedToLLMProvider": false }
}
```

Possible `status` values: `APPROVED`, `DENIED`, `ESCALATED`.

### Agents

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents` | List all agents |
| `POST` | `/api/agents` | Register an agent |
| `POST` | `/api/agents/:id/kill` | Permanently revoke an agent |
| `POST` | `/api/agents/:id/reactivate` | Restore a revoked agent |
| `PATCH` | `/api/agents/:id/trust` | Update trust score |

### Policies

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/policies` | List policies |
| `POST` | `/api/policies` | Create a policy |
| `PUT` | `/api/policies/:id` | Update a policy |
| `DELETE` | `/api/policies/:id` | Delete a policy |

### Audit Log

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/audit` | Query log (filter: `agentId`, `tool`, `decision`, `projectId`) |
| `GET` | `/api/audit/stats` | Aggregate statistics |
| `GET` | `/api/audit/verify` | Verify cryptographic chain integrity |
| `GET` | `/api/audit/export` | **SOC2 export** — CSV or JSON download (Growth+ plan) |

**SOC2 export:**

```bash
# CSV export filtered by date range
curl "http://localhost:3000/api/audit/export?format=csv&from=2025-01-01&to=2025-12-31&projectId=proj_abc" \
  -o audit-export.csv

# JSON export
curl "http://localhost:3000/api/audit/export?format=json&agentId=ag_xyz" \
  -o audit-export.json
```

### Billing

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/billing/plans` | Available plans and pricing |
| `POST` | `/api/billing/checkout` | Create a Stripe checkout session |
| `POST` | `/api/billing/portal` | Open customer billing portal |
| `POST` | `/api/billing/webhook` | Stripe webhook handler |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Overall system health |
| `GET` | `/health/gateway` | Gateway process (uptime, memory) |
| `GET` | `/health/db` | Database query latency |
| `GET` | `/health/enclave` | gRPC worker pool connectivity |
| `GET` | `/api/workers/status` | Per-worker pool status |

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/workspaces/:id/usage` | Usage metrics + overage estimate |
| `GET/POST` | `/api/escalation/:projectId` | Slack/email escalation config |
| `GET/POST` | `/api/financial-threshold/:projectId` | Financial threshold guard config |
| `GET` | `/api/vault/assets` | Encrypted vault assets |
| `GET` | `/api/alerts` | Threat alerts |

---

## Worker Pool

By default SAG spawns one enclave worker. For higher throughput, set `ENCLAVE_POOL_SIZE`:

```env
ENCLAVE_POOL_SIZE=4
ENCLAVE_BASE_PORT=50051
# Workers start on :50051, :50052, :50053, :50054
```

The gateway round-robins execution tickets across healthy workers. Workers that fail three consecutive requests are temporarily removed from rotation and retried after 30 seconds with exponential back-off restart (up to 5 restarts).

To use externally managed workers (e.g. Kubernetes pods), skip auto-spawn and provide addresses directly:

```env
SKIP_WORKER_SPAWN=true
ENCLAVE_ADDRESSES=worker-0:50051,worker-1:50051,worker-2:50051
```

---

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Transport | Mutual TLS (local CA) |
| Ticket integrity | Ed25519 signatures (per-ticket) |
| Replay protection | Redis NX nonce + 2-second TTL |
| Clock skew | 500 ms maximum drift |
| Policy pinning | SHA-256 bundle hash in every ticket |
| Worker sovereignty | Independent re-evaluation — worker does not trust gateway decision |
| Risk ceiling | Hard block at configurable score threshold |
| Financial guard | Deterministic amount scan before policy evaluation |

---

## Free, and how to get help

EMBMIS Gateway is free: no check limit, no overage, every feature (including the audit export), for any use, under
Apache-2.0. Questions and bugs: [GitHub issues](https://github.com/EMBMIS/gateway/issues). Setup, customisation and
production support: [embmis.com](https://embmis.com).

---

## Development

```bash
npm install && npm run console:install   # gateway + console dependencies
npm run keys:dev                         # development keys and a signed policy bundle (git-ignored)
npm run console:build                    # builds console/dist, which the server serves
npm run dev                              # gateway with auto-reload on :3000  (npm run console:dev for hot reload on :5173)

npm test                                 # every suite (see below)
npm run test:keys                        # one suite
npm run console:build && npm --prefix console run check:ui   # real-browser check of the console
node scripts/demo-traffic.js             # a demo user and a spread of real decisions to look at
```

`npm test` runs: the key guard, the v1 API (tenants, agents, decide allow / deny / escalate / bad key, resolve), access
control, the console API, the live feed, and the original stack suites (against a gateway it starts on :3000 with a
throw-away database).

The gateway's store is SQLite (`dwi.db`, or `SAG_DB_PATH`) by default, or PostgreSQL when `SAG_DATABASE_URL` is set (its own
schema, `SAG_DB_SCHEMA`, default `gateway`; see DEPLOY.md). The pipeline is synchronous, so `src/db-pg-sync.js` gives
PostgreSQL a better-sqlite3-shaped handle (a worker thread owns the connection; the caller blocks until the answer arrives)
and translates the small SQLite dialect the gateway uses. `npm test` passes on both stores (`SAG_DATABASE_URL=… npm test`).
Run one gateway instance per database. `DB_ADAPTER=postgres` (the old, unwired adapter) is refused.
The vault's master key comes from `SAG_VAULT_MASTER_KEY` or `vault-master.key` in the secrets directory (`npm run keys:dev` / `keys:prod` create it).

Production: [DEPLOY.md](DEPLOY.md).

---

## Repository Structure

```
server.js               Gateway HTTP server (control plane), serves the console
enclave-worker.js       Enclave gRPC server (execution plane)
console/                The console: React + Vite + Tailwind, EMBMIS design system
src/
  gateway.js            One pipeline (runPipeline) for the execute path and the decide-only path
  v1-api.js             /api/v1: tenants, agents, decide, resolve, health, OpenAPI
  decisions.js          Escalations and their resolution (audit chain)
  tenant-policy.js      Per-tenant policies and the default ERP set
  access.js             Console API access control (sessions, workspace scoping, operators)
  keys.js               Key material from env or a secrets dir; production guard (refuses missing or leaked keys)
  policy-engine.js      RBAC/ABAC policy evaluation
  risk-engine.js        Heuristic risk scoring
  intent-analyzer.js    LLM semantic gap detection
  behavioral-engine.js  Cross-request anomaly detection
  audit-logger.js       Append-only hash-chained audit log
  worker-pool.js        Enclave worker spawn + supervision
  grpc-client.js        gRPC client pool (round-robin)
  billing.js            Plans (one free plan, no limit)
  escalation.js         Slack + email notifications
  financial-guard.js    Deterministic financial threshold guard
  usage-tracker.js      Per-workspace metering
  vault.js              Encrypted credential store (preview)
  auth.js               Session-based authentication
  database.js           SQLite store
  bundle-loader.js      Policy bundle load + signature verify
  policy-evaluator.js   Authorization evaluation (used in both processes)
docs/openapi.yaml       OpenAPI 3.1 for the v1 API
intercept/ sdk/ sag-mcp-proxy/   Drop-in packages and SDKs
scripts/                keys:dev, keys:prod, platform-key, sign-bundle, demo-traffic, test runner
deploy/                 Environment and Caddy examples
```

---

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in
[SECURITY.md](SECURITY.md), not in public issues.

## License

Copyright 2026 Rashad Yusubov and Truong Nguyen. Licensed under the [Apache License, Version 2.0](LICENSE). "EMBMIS" is a trademark of
its owner and is not licensed under Apache-2.0: forks must use a different name.
