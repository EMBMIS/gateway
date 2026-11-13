# Policy Bundle Specification (v0.3)

## 1. Overview
The Policy Bundle is an immutable, cryptographically signed JSON artifact that represents the absolute source of truth for all authorization and risk threshold decisions in the EMBMIS Gateway.

It is compiled offline by the Policy Authority (simulating CI/CD) and distributed to both the Gateway (Control Plane) and the Enclave Worker (Execution Plane).

## 2. Bundle Structure
A valid policy bundle file MUST match the following JSON schema:

```json
{
  "metadata": {
    "version": "1.0.0",
    "compiler_version": "0.3.0",
    "created_at": "2026-03-02T12:00:00.000Z"
  },
  "bundle": {
    "policies": [
      {
        "id": "uuid-string",
        "name": "Block All DELETE Operations",
        "description": "Deny all DELETE actions",
        "priority": 1,
        "effect": "deny",
        "conditions": {
          "action": "DELETE"
        }
      }
    ],
    "role_permissions": {
      "finance": {
        "db.query": "allow"
      }
    },
    "risk_thresholds": {
      "autoBlock": 85,
      "requiresHumanApproval": 60
    },
    "tool_registry": {
      "db.query": { "description": "Execute read-only SQL" },
      "db.write": { "description": "Execute mutating SQL" }
    }
  },
  "signature": "base64-ed25519-signature-string",
  "key_id": "policy-authority-v1"
}
```

## 3. Canonical Serialization Rules
To ensure the `policy_bundle_hash` is highly deterministic and survives cross-platform transit, logging, and evaluation, the `bundle` object MUST be serialized into a Canonical JSON string before hashing or signing.

The serialization MUST adhere to the following strict rules:
1. **UTF-8 Encoding:** All strings must be UTF-8.
2. **Stable Key Ordering (Recursive):** All object keys MUST be sorted alphabetically (lexicographically by Unicode code point). This sorting MUST be deeply recursive, applying to all nested objects and objects inside arrays. Array element order must be preserved exactly as defined by the policy input.
3. **No Whitespace:** The resulting string MUST NOT contain any unescaped whitespace outside of string values (no spaces after colons or commas, no newlines).
4. **No Runtime State:** The `bundle` object MUST NOT contain any fields that change dynamically at runtime (e.g., agent trust scores, request counters).
5. **Payload Isolation:** Only the pure `bundle` property is hashed and signed. `metadata` (including `created_at` and `compiler_version`) exists purely for logging and operational observability, and does NOT affect the cryptographic hash of the policy logic.

## 4. Hash and Signature Computation
- **Serialization Target:** Only the `bundle` object is serialized. The `signature` and `key_id` fields are excluded.
- **Hash Algorithm:** SHA-256 (`crypto.createHash('sha256')`).
- **Signature Algorithm:** Ed25519 (`crypto.sign(null, Buffer.from(canonicalString), privateKey)`).

## 5. Runtime Verification Flow
When the Enclave Worker receives an execution ticket from the Gateway, it MUST perform the following checks:
1. Extract the `policy_bundle_hash` from the IPC ticket.
2. Compute the SHA-256 hash of its locally loaded `bundle` (using Canonical Serialization).
3. Compare the two hashes using `crypto.timingSafeEqual()`.
4. If the hashes mismatch, the Worker MUST immediately reject the ticket with error code `POLICY_VERSION_MISMATCH` (which the Gateway translates to HTTP 409).
5. Extract the Gateway's proposed `risk_score` from the ticket. If the `risk_score` is missing or malformed, the Worker MUST default to DENY (fail closed).
6. Compare the `risk_score` against the immutable max threshold (`autoBlock`) in the bundle.
7. No tool execution can occur if hash verification fails, the signature is invalid, or the risk threshold is exceeded.

## 6. Threat Model Assumption: Advisory Risk
The Gateway dynamically computes the risk score using heuristics that require external state (velocity, history, context). The Worker enforces the hard ceiling (e.g., `if proposedScore > 85 DENY`). This inherently means the Worker trusts the Gateway's risk accuracy up to that boundary constraint. If a compromised Gateway underreports risk (e.g., reports 40 when it should be 90), it bypasses the dynamic warning, but it still cannot bypass the deterministic RBAC rules within the policy bundle.

## 7. Rollout Model (v0.3)
**Single Active Bundle:** To ensure absolute determinism and eliminate split-brain telemetry, v0.3 enforces a single active bundle per deployment. Backward compatibility (multiple concurrent valid hashes) is explicitly rejected in favor of strict, synchronous rollouts. Mismatches during the rollout window will deterministically fail closed.
