# Contributing to EMBMIS Gateway

Thank you for helping. Bug reports, fixes, new policies, SDK improvements, documentation and tests are all welcome.

## Before you start

* **Small fix** (typo, obvious bug, missing test): open a pull request directly.
* **Anything bigger** (a new feature, a change to the decision pipeline, the policy format, the API or the security
  model): open an issue first and describe what you want to do, so we can agree on the approach before you spend time on
  it.
* **Security problems**: never in a public issue. See [SECURITY.md](SECURITY.md).
* Looking for something to do? Issues labelled [`good first issue`](https://github.com/EMBMIS/gateway/labels/good%20first%20issue)
  are small and self-contained.

## Development setup

Node.js 20 or later and Redis (for the enclave workers' replay protection).

```bash
git clone https://github.com/EMBMIS/gateway
cd gateway
npm install && npm run console:install   # gateway + console dependencies
npm run keys:dev                         # throw-away development keys and a signed policy bundle (git-ignored)
npm run console:build                    # the console the server serves
npm run dev                              # gateway with auto-reload on :3000 (npm run console:dev: console on :5173)
```

## Before you open a pull request

```bash
npm run lint      # server-side syntax check + console ESLint
npm test          # every suite, against a throw-away database
```

To run the suites on PostgreSQL as well: `SAG_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test`.

* Add or update tests for what you change. A change to a decision (allow / deny / escalate) needs a test that shows it.
* Keep the guarantees intact: the gateway decides before anything executes, the audit chain stays append-only and
  verifiable, and no key, database or log is ever committed.
* Update the documentation (README, DEPLOY.md, `docs/openapi.yaml`) when behaviour or the API changes.
* One topic per pull request, with a description of what and why.

## Sign your commits (DCO)

Every commit must be signed off, certifying the [Developer Certificate of Origin](https://developercertificate.org/):
that you wrote the change, or otherwise have the right to submit it under this project's licence.

```bash
git commit -s -m "Explain what this commit does"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line. To sign off commits you already made:
`git rebase --signoff main`.

## Licence

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the licence of
this project.

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
