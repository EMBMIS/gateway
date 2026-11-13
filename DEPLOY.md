# Deploying EMBMIS Gateway

How to run the Gateway in production on your own server with Docker Compose and a reverse proxy. The examples use
`gateway.example.com`; replace it with your host. Platforms such as [EMBMIS ERP](https://github.com/EMBMIS/erp) talk to
the Gateway only over its HTTP API.

## What runs

`docker-compose.prod.yml` starts:

| Service | What | Network |
|---|---|---|
| `gateway` | API, v1 decide API, console (port 3000, loopback only) | `edge` + `internal` |
| `worker` | enclave worker for the execute path (gRPC, mutual TLS) | `internal` only |
| `redis` | shared nonce store (replay protection), password required | `internal` only |
| `postgres` | optional (`--profile enterprise-db`): the demo database the execute-path workers protect | `internal` only |

`internal` has no route out and no published port.

**Where the gateway keeps its data.** Two supported choices; run **one gateway instance** either way (the audit chain is
written in strict order).

* *SQLite* on the `gateway_data` volume (default, `SAG_DATABASE_URL` empty). Back the volume up.
* *PostgreSQL*: set `SAG_DATABASE_URL=postgres://sag_gateway:<hex password>@<host>:5432/<database>`. The gateway keeps
  its tables in its own schema (`SAG_DB_SCHEMA`, default `gateway`). With `SAG_DB_DDL=off` (the compose default) the
  gateway's role never runs DDL and an administrator creates the schema once:

  ```bash
  # as a database administrator: the role, and a schema it owns
  psql -c "CREATE ROLE sag_gateway LOGIN PASSWORD '<hex password>'" \
       -c "CREATE SCHEMA gateway AUTHORIZATION sag_gateway" \
       -c "ALTER ROLE sag_gateway SET search_path = gateway"
  # the tables, rendered from the image you built
  docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --no-deps -T --entrypoint node \
    gateway scripts/print-pg-schema.js | { echo 'SET search_path TO gateway;'; cat; } | psql
  psql -c "DO \$\$ DECLARE t record; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'gateway' LOOP
             EXECUTE format('ALTER TABLE gateway.%I OWNER TO sag_gateway', t.tablename); END LOOP; END \$\$"
  ```

  If that PostgreSQL runs in another Docker Compose project, join its network with an override file next to
  `docker-compose.prod.yml` (`docker-compose.override.yml`, or pass it with a second `-f`):

  ```yaml
  services:
    gateway:
      networks: [edge, internal, dbnet]
  networks:
    dbnet:
      name: <the other project's network>
      external: true
  ```

  Or set `SAG_DB_DDL=on` and let the gateway create its schema itself. Each query is a blocking round trip (about a
  thousand decisions per second on one host instead of thousands: see the `npm test` benchmark), so keep the database
  close. Anyone with administrator rights on that database can alter gateway rows, which the audit chain's hashes would
  reveal but not prevent.

**Vault master key.** `npm run keys:prod` writes `gateway-secrets/vault-master.key` (32 random bytes, hex). Production will not
start without it, and every vault asset is unreadable without it: keep a copy with your database backups, separate from the
database. It is a file the gateway process reads, not a KMS or HSM, so anyone who can read the gateway's secrets can read the
vault. Erasure (GDPR Art. 17) destroys the assets stored for one person, matched by the `subject` given when the asset was stored.

Platforms that only ask for decisions (such as EMBMIS ERP) use the v1 API and never touch a worker; the worker is for
`/api/gateway/execute`.

**No secrets are baked into any image.** Keys, the signed policy and the environment are supplied at run time.

## 1. Generate keys (on a machine you trust, not the server)

```bash
npm ci
npm run keys:prod -- ./gateway-keys
```

This produces four directories, split by who may hold what:

| Directory | Goes to | Holds |
|---|---|---|
| `gateway-secrets/` | the gateway, read-only | its ticket-signing key, the worker's *public* key, the mTLS client identity, the CA certificate, the policy public key |
| `worker-secrets/` | each worker, read-only | its own response-signing key, the gateway's *public* key, the mTLS server identity, the CA certificate, the policy public key |
| `policy/` | gateway and workers, read-only | the signed `policy.bundle.json` and `revocation_list.json` (public) |
| `OFFLINE/` | **nowhere** | the policy-authority private key and the CA private key |

Move `OFFLINE/` somewhere only you can reach (password manager, encrypted drive, HSM) and delete it from the machine.
The gateway and a worker never see each other's private keys. Keys known from the Gateway's private development are refused
at startup by fingerprint ([SECURITY-ROTATION.md](SECURITY-ROTATION.md)).

mTLS certificates last one year: calendar the renewal (run the tool into a new directory, roll gateway and workers together).

Copy `gateway-secrets/`, `worker-secrets/` and `policy/` to the server, for example `/srv/gateway/keys/`, mode 700.

### Changing policy later

The bundle is signed offline and mounted read-only. After editing `src/policy-compiler.js`:

```bash
node scripts/sign-bundle.js --key OFFLINE/alias_policy-authority-<date>_private.pem \
     --key-id alias/policy-authority-<date> --version <previous + 1> --out policy/policy.bundle.json
```

Copy it to the server's `policy/` and restart. Versions must increase; workers refuse an older bundle. With a real KMS or
HSM use `sag compile` instead. (Tenant policies, the ones you edit in the console, are separate and need no signing.)

## 2. Configure

```bash
cp deploy/env.production.example .env.production && chmod 600 .env.production
```

Fill in: the three key directories, `REDIS_PASSWORD`, `SAG_ADMIN_EMAILS`, and `SAG_PLATFORM_KEY_HASHES` (next step).

### Issue a platform key (for a platform such as EMBMIS ERP)

```bash
npm run platform-key
```

It prints the key once and a `SAG_PLATFORM_KEY_HASHES=<hash>` line. Put the **hash** in the gateway's `.env.production`;
give the **key** to the platform (EMBMIS ERP reads it as `EMBMIS_GATEWAY_PLATFORM_KEY`). The gateway stores only the hash. To rotate: add the new
hash after the old (comma-separated), switch the platform to the new key, then remove the old hash.

## 3. Start

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml ps        # gateway, worker, redis: healthy
curl -fsS http://127.0.0.1:3000/api/v1/health       # {"ok":true,"version":"…","mode":"enforce"}
```

Put the reverse proxy in front (`deploy/Caddyfile.example`). Then open `https://gateway.example.com/`, **create the first
account with an email listed in `SAG_ADMIN_EMAILS`** (that account is the operator), and follow Get started.

If you run the gateway only for your own company, set `SAG_ALLOW_REGISTRATION=false` once the operator accounts exist.

In production the gateway starts only with valid keys, refuses the leaked ones, requires a console session for every
management call, scopes each user to their workspace, and seeds no demo agents or demo keys.

## Health checks

| Check | Command | Healthy |
|---|---|---|
| Liveness + version | `curl -fsS https://gateway.example.com/api/v1/health` | `{"ok":true,…}` |
| Containers | `docker compose -f docker-compose.prod.yml ps` | `healthy` |
| Execution plane | Dashboard → Execution workers (or `GET /health/enclave` from the host) | 1 of 1 healthy |
| Audit chain | Console → Decisions → Audit and chain → Verify | intact |
| Policy bundle | Console → Compliance | verified, version shown |

## Backups

What matters: the `gateway_data` volume (SQLite database and audit checkpoints), the key directories, and the offline
`OFFLINE/` directory. Redis holds only replay nonces and need not be backed up.

```bash
# consistent online copy of the database (SQLite WAL-safe), then the checkpoints
docker compose -f docker-compose.prod.yml exec -T gateway sh -c \
  'node -e "const D=require(\"better-sqlite3\");new D(process.env.SAG_DB_PATH).backup(\"/data/backup.db\").then(()=>console.log(\"ok\"))"'
docker run --rm -v embmis-gateway_gateway_data:/d -v /var/backups:/b alpine \
  sh -c 'cp /d/backup.db /b/gateway-$(date +%F).db && cp -r /d/logs /b/gateway-logs-$(date +%F)'
```

Keep a copy of `logs/audit-checkpoints.log` **off the server**: the chain proves nothing was edited *inside* the log;
a checkpoint held elsewhere proves the log was not rewritten from the start. Restore by stopping the gateway, putting
`gateway.db` back in the volume as `/data/gateway.db`, and starting it. Test a restore before you need one.

## Updating


```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

Take a backup first. The gateway creates new tables on start; there are no destructive migrations. Roll back by checking
out the previous tag and running the same command.

## Troubleshooting

* `KEY GUARD FAILED` at start: the message lists each missing or leaked key. Re-generate with `npm run keys:prod`.
* Compose stops with "Set REDIS_PASSWORD": a required variable is missing from `.env.production`.
* The worker restarts with "Refusing to start in production without REDIS_URL": the compose file sets it; check `REDIS_PASSWORD`.
* A platform gets `INVALID_PLATFORM_KEY`: the hash in `SAG_PLATFORM_KEY_HASHES` is not the hash of the key it sends.
