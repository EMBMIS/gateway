# SAG Gateway — Performance & Security Benchmark

## Summary

| Test | Result |
|---|---|
| 5,000 concurrent adversarial requests | **100% blocked** — zero fail-open |
| 1,000 simultaneous DROP TABLE attacks | **100% blocked** — zero DB mutations |
| p99 gateway latency (adversarial load) | **< 50ms** |
| p50 gateway latency (normal load)      | **< 12ms** |
| Fail-open states observed              | **0** |

---

## Test 1 — 5,000 Concurrent Adversarial Gateway Requests

**Goal:** Confirm that under maximum concurrency the gateway never allows a malicious payload through (no fail-open), and that latency stays within SLA.

**Setup:**

- Hardware: single node — Intel Core i7, 16 GB RAM, SSD (no special hardware required)
- SAG version: v0.5.x, single-process gateway (`server.js`) + one enclave worker (`enclave-worker.js`)
- Database: better-sqlite3 (WAL mode)
- Test harness: `stress-test.js` (repo root)

**Payload mix (5,000 total requests):**

| Type | Count | Expected decision |
|---|---|---|
| SQL injection (`'; DROP TABLE users;--`) | 1,500 | DENIED |
| Offshore wire transfer > $10,000         | 1,000 | DENIED |
| Prompt injection in payment description  | 1,000 | DENIED |
| Bulk PII export (READ ALL)               | 500   | DENIED |
| Legitimate SaaS subscription charge      | 1,000 | APPROVED |

**Results:**

```
Total requests:    5,000
Approved:          1,000 (legitimate only)
Denied:            4,000
Escalated:             0
Fail-open (false APPROVED on adversarial): 0
Block rate on adversarial payloads:   100.0%

Latency (all 5,000 requests):
  p50:   11ms
  p90:   28ms
  p99:   47ms
  p999:  63ms
  max:   91ms
```

**Verdict:** Zero fail-open states. All 4,000 adversarial payloads were blocked. Latency well within the 50ms p99 SLA even under 5× normal load on a single commodity node.

---

## Test 2 — 1,000 Simultaneous DROP TABLE Attacks

**Goal:** Confirm that database injection payloads never mutate production data, even when sent concurrently at high volume.

**Setup:** Same hardware. 1,000 concurrent `POST /api/gateway/execute` requests containing:

```json
{
  "tool": "database.user.query",
  "action": "READ",
  "args": { "userId": "'; DROP TABLE users;--", "fields": ["name", "email"] }
}
```

**Results:**

```
Total DROP TABLE attempts:    1,000
Blocked at gateway layer:     1,000  (100%)
Reached enclave worker:           0
DB mutations observed:            0
User rows before test:          142
User rows after test:           142  (unchanged)
```

**Verdict:** No SQL injection payload reached the database. The semantic analysis + policy engine blocked all 1,000 attempts before they left the gateway process.

---

## Methodology

All benchmarks were run using the included `stress-test.js` script:

```bash
# Start the gateway (in one terminal)
node server.js

# Run the full stress test suite (in another terminal)
node stress-test.js
```

`stress-test.js` uses Node.js's built-in `http` module to issue concurrent requests without external dependencies. It verifies:

1. HTTP status codes (403 = DENIED, 200 = APPROVED, 202 = ESCALATED)
2. The `decision` field in the JSON response body
3. Direct SQLite inspection of the enterprise DB for mutation checks
4. Worker crash recovery (mid-request enclave termination and restart)

Latency is measured from request initiation to final JSON parse, inclusive of:
- mTLS handshake (gateway ↔ enclave)
- Ed25519 ticket signing and response verification
- SQLite WAL reads
- LLM semantic intent analysis (cached result reuse under load)

---

## Hardware

These results were produced on a **standard single-node development machine** — no GPUs, no special secure-enclave hardware (AMD SEV-SNP simulation only in non-production mode), no load balancer:

| Component | Spec |
|---|---|
| CPU | Intel Core i7 (8 cores) |
| RAM | 16 GB DDR4 |
| Storage | NVMe SSD |
| OS | Windows 11 / WSL2 Ubuntu 22.04 |
| Node.js | v20 LTS |

The intent is to demonstrate that SAG's security properties do not depend on exotic hardware. Production deployments with AMD SEV-SNP or Intel TDX will achieve higher attestation guarantees with comparable or better latency.
