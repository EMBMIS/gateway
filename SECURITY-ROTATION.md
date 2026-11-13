# Keys: generate your own, and how to rotate them

The Gateway's guarantees rest on keys only you hold: the Ed25519 keys that sign execution tickets and worker
responses, the mTLS certificate authority, and the policy-authority key that signs policy bundles. This repository
contains **no** private keys. Generate a set for development with `npm run keys:dev` and for production with
`npm run keys:prod` (see [DEPLOY.md](DEPLOY.md)).

## Keys the gateway refuses

Keys that existed during the Gateway's private development, before it was open-sourced, are treated as known to others.
Their fingerprints (SHA-256 of the SPKI public key) are listed in `src/keys.js` (`COMPROMISED_FINGERPRINTS`), and their
public halves are in `tests/fixtures/leaked/` for the key-guard test. In production (`NODE_ENV=production`) the gateway
and the enclave worker **refuse to start** if any key or certificate they load matches one, or if a key is missing.
The policy key id `alias/policy-authority-v0.4` is in `revocation_list.json` for the same reason. Do not remove entries
from either list.

## What the tree does to keep keys out

* `.gitignore` and `.dockerignore` keep keys, databases and logs out of commits and images.
* Keys come from environment variables or a mounted secrets directory (`SAG_SECRETS_DIR`, default `certs/`). See `.env.example`.
* `npm run keys:dev` generates a complete, throwaway development set (and a signed policy bundle). It refuses to run in production.
* `policy.bundle.json` is generated, not committed. In production it is produced by `sag compile` against your real KMS.

## How to rotate (production)

1. **Generate new keys** on a trusted machine. Never use a key you did not generate yourself.
   * Ticket/response keys: `openssl genpkey -algorithm ed25519 -out gateway-ed25519.key && openssl pkey -in gateway-ed25519.key -pubout -out gateway-ed25519.pub`, and the same for `worker-ed25519`.
   * mTLS: a new CA, then a server certificate (SAN must match the worker hostname the gateway dials) and a client certificate, signed by the new CA. `node scripts/generate-certs.js` is acceptable for a single-host setup if you run it once on the server with `SAG_SECRETS_DIR` pointing at a private directory.
   * Policy authority: create the key in a real KMS/HSM. Publish only its public half as `<key_id with / replaced by _>_public.pem` (or `SAG_POLICY_PUBLIC_KEY`).
2. **Revoke the old policy key id.** `alias/policy-authority-v0.4` is already in `revocation_list.json`; use a **new key id** (`SAG_POLICY_KEY_ID`, default `alias/policy-authority-dev` for development) so the revocation does not also revoke your new key. Raise the bundle version above the old one (workers enforce monotonic versions).
3. **Re-sign the policy bundle** with the new key: `sag compile`.
4. **Install the secrets** in the deployment: a read-only mounted directory (`SAG_SECRETS_DIR`) or the `SAG_*` environment variables listed in `.env.example`. Gateway and workers must receive keys from the same rotation.
5. **Roll gateway and workers together** (the old and new ticket keys are not interchangeable). Check `GET /api/health`.
6. **If a key or database may have been exposed**: invalidate all sessions, force password resets, regenerate every agent API key, and rotate the Redis password.
7. **Confirm** the old keys are gone: starting any service with an old key in production must fail with `KEY GUARD FAILED` (this is covered by `npm run test:keys`).
