# Deterministic Pre-Execution Isolation for AI Agent Tool Calls

## Technical Brief — v0.2

---

## Problem Statement

Enterprise AI agents (autonomous LLM-driven systems) are gaining the ability to execute real operations: database queries, payments, emails, file access. These agents operate via tool-calling protocols (MCP, function calling) where the LLM generates structured intent and a runtime executes it.

Current enterprise security assumes human-initiated actions. Existing IAM systems authenticate users, not autonomous agents making sub-second tool calls. There is no deterministic interception layer between AI intent and real-world execution.

**The risk:** a prompt-injected, misconfigured, or over-permissioned AI agent can execute destructive operations (data exfiltration, unauthorized payments, table deletion) before any human reviews the action.

---

## Approach

We built a research prototype of a **pre-execution firewall** — a gateway that sits between AI agent intent and tool execution. Every tool call passes through a deterministic evaluation pipeline before any operation is executed against a real system.

The design principle: **decide, then execute.** Not: execute, then maybe audit.

---

## Architecture (v0.2 — Two-Process)

```
AI Agent
  ↓ MCP tool call
[Process A: Gateway]              [Process B: Enclave Worker]
  Authentication                    Ticket verification
  Tool registry validation          HMAC signature check
  RBAC/ABAC policy engine           Nonce + TTL enforcement
  Risk scoring (0-100)              Tool execution
  Audit logging (hash-chained)      Enterprise DB access
  ↓                                 ↑
  Signed IPC ticket ──────────────→ │
  (HMAC-SHA256, 2s TTL, nonce)      │
  ←──────────── Signed result ──────┘
```

Gateway and execution worker run as **separate OS processes**. No shared memory. No shared modules. The gateway process cannot import the execution layer. Communication is via HMAC-SHA256 signed tickets with replay protection.

---

## What We Validated

### Isolation Guarantee

We placed a real SQLite database behind the gateway containing:
- 10 customer records (names, emails, phones, dates of birth, addresses)
- 10 financial transactions (up to €320,000)
- 6 employee records (salaries, SSNs)
- 4 production API credentials (Stripe, AWS, Salesforce, SendGrid)

We then attacked it.

| Attack | Result |
|---|---|
| DROP TABLE customers | **DENIED.** Policy match. SQL never parsed by DB engine. |
| SELECT * FROM employees (SSN, salary) by low-trust agent | **DENIED.** Risk score 95/100 auto-blocked. |
| Unregistered tool (shell.execute) | **DENIED.** Tool not in signed registry. |
| €100K payment initiation | **ESCALATED.** Requires human approval. |
| Fake API key | **DENIED.** Authentication failed. |

**Forensic verification of DROP TABLE attack:**

```
BEFORE: enterprise.db mtime=01:56:36.427Z  size=4096  WAL=284312  rows=10
AFTER:  enterprise.db mtime=01:56:36.427Z  size=4096  WAL=284312  rows=10
```

Zero file modification. Zero WAL write. Zero lock acquired. The SQL string existed only as a JSON value in the audit log. It was never parsed, prepared, or executed as a database operation.

### Concurrency Under Attack

We fired 1,000 concurrent DROP TABLE requests simultaneously.

| Metric | Value |
|---|---|
| Requests sent | 1,000 |
| DENIED | 1,000 |
| APPROVED | 0 |
| Errors | 0 |
| DB rows after | 10 (unchanged) |
| DB integrity | ok |
| Throughput | 223 req/s |

**No race condition opened a bypass path.** The security boundary held under adversarial concurrency.

### Fail-Closed Behavior

Under connection exhaustion (5,000 total requests, mixed attack):
- 2,637 requests reached the gateway. All were logged. All decisions correct.
- 2,363 requests failed at the HTTP socket layer before reaching the application.
- **Zero requests defaulted to execution on failure.**
- Connection failure = no execution. Not: connection failure = allow.

### Audit Chain Integrity

Every request that reached the gateway produced a hash-chained audit entry (SHA-256, each entry includes previous entry's hash). After 2,637 entries under stress: chain valid, 0 tampered entries.

---

## Measured Performance

| Metric | Value |
|---|---|
| Single-request latency (gateway decision + IPC + execution) | ~9ms |
| Policy evaluation | <2ms |
| P50 under 1,000 concurrent | 1,009ms |
| P95 under 1,000 concurrent | 1,374ms |
| Denial throughput | 223 req/s |
| Approval throughput | 345 req/s |

Single-worker architecture. No connection pooling. No reverse proxy. Performance is not production-grade. Security boundary is.

---

## Known Limitations (Honest)

| Limitation | Status | Path to address |
|---|---|---|
| Compromised gateway can forge valid tickets | Open | Move signing authority to worker; worker validates policy independently |
| Both processes under same OS user | Open | Separate OS users + file ACLs |
| TEE is simulated (not hardware) | Open | Intel TDX / AMD SEV-SNP / AWS Nitro integration |
| Single execution worker | Open | Worker pool with shared nonce store |
| No connection-layer observability | Open | Reverse proxy (nginx/envoy) in front |
| SQLite (single-writer) | Open | PostgreSQL for production |
| IPC secret in environment variable | Open | HSM or sealed secret store |

These are expected for a research prototype at this stage. None compromise the validated security guarantee under current threat model.

---

## What This Is Not

- Not a replacement for IAM/RBAC systems (it complements them)
- Not an AI safety alignment solution (it controls execution, not reasoning)
- Not production-hardened infrastructure (it's a validated research prototype)
- Not a compliance certification (it demonstrates compliance-ready patterns)

## What This Is

A tested demonstration that deterministic pre-execution isolation for AI agent tool calls is architecturally viable, can hold under adversarial concurrency, fails closed under overload, and produces cryptographically verifiable audit trails.

---

## Contact

[Your details here]
