# Architecture Overview (v0.2)
**Deterministic Pre-Execution Firewall for AI Agents**

---

### Slide 1: The AI Agent Security Gap
- **Current State:** AI agents (LLMs + Tools) operate autonomously, generating intent and executing structured commands (e.g., SQL queries, API calls, payments).
- **The Problem:** Existing IAM infrastructure authenticates human sessions, not sub-second machine intent. There is no deterministic boundary between LLM reasoning and real-world execution.
- **The Risk:** Prompt injection, excessive agency, or hallucination can cause destructive operations (e.g., `DROP TABLE`) to reach execution environments before a human is aware.
- **The Fix:** A deterministic execution firewall. Decide first, execute second.

---

### Slide 2: Two-Process OS Isolation Architecture
- The core principle is strictly separating the **Control Plane** from the **Execution Plane** using OS-level process boundaries.
- **Process A (Gateway):** Handles Agent Authentication, Tool Registry Validation, RBAC/ABAC Policy Evaluation, Risk Scoring, and Cryptographic Audit Logging. The Gateway *cannot* import execution modules or access protected resources.
- **Process B (Enclave Worker):** Standalone execution environment. Exclusively holds database access. Accepts only cryptographically authenticated execution tickets. No HTTP exposure.

---

### Slide 3: IPC Ticket Security Model
- Communication between Gateway and Enclave uses signed execution tickets transferring over Node.js IPC channels.
- **Security Properties:**
  - **Authenticity:** HMAC-SHA256 signature per ticket using a shared secret.
  - **Integrity:** Canonical JSON serialization ensures deterministic signing of payload.
  - **Replay Prevention:** In-memory LRU cache of cryptographic nonces.
  - **Staleness Protection:** 2-second strict TTL on all execution tickets.
  - **Side-Channel Defense:** Signatures verified using `crypto.timingSafeEqual()`.

---

### Slide 4: Empirical Validation (Adversarial Load)
- Tested under 5,000 requests, including 1,000 concurrent destructive attacks (`DROP TABLE`).
- **Results:**
  - 100% of unauthorized or malicious operations denied.
  - Zero contact with the enterprise database by blocked SQL (confirmed via forensics on file modification, WAL size, and row count).
  - No race-condition bypass paths opened under heavy concurrency.
  - The system fails closed. Under connection pool exhaustion, zero requests defaulted to an "allow" execution state.

---

### Slide 5: Cryptographic Observability & Known Limitations
- **Audit Logging:** Every processed request generates a hash-chained, tamper-evident log linking the agent, the intent, the policy decision, and the execution result. After our 5,000-request stress test, 0 tampered entries were found.
- **Known Limitations (v0.2):**
  - Gateway and Enclave currently run under the same OS user.
  - Throughput relies on a single Enclave worker (introducing IPC backpressure leading to timeouts at ~1000 requests/sec).
  - TCP-layer connection flooding is invisible to the application audit log (requires upstream reverse proxy).
