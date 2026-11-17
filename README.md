# Secure Intake & Case Workflow Engine

**Full development plan and handoff:** [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md).

Reusable open-source infrastructure for secure intake, case management, workflow routing, deadlines, review, and administrative due process.

## Design goals

- Statute-neutral core primitives
- Organization-scoped data and deny-by-default authorization
- Configurable intake, workflows, deadlines, reviews, and terminology
- Explicit public/private information boundaries
- Append-only audit history for material actions
- Stable REST/OpenAPI and event interfaces
- Thin downstream applications for legislation-specific workflows

## Current status

All 42 plan units have merged source work (runtime version **1.0.0-rc.9**).
Live acceptance of the S3 bucket, malware scanner and email provider waits for
the owner's credentials, and the stable 1.0.0 release for the owner's
decision. See [docs/ACCEPTANCE_LEDGER.md](docs/ACCEPTANCE_LEDGER.md) for the
evidence and the owner-only steps, and
[docs/OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md) for operations.

## Security status

This repository is an open-source engine and is **not** an accredited system for classified information. Deployments handling sensitive information require additional controls, review, and authorization appropriate to their use.

## End-to-End Everywhere progress

The canonical [security/e2eesa-status.json](security/e2eesa-status.json) records standard implementation, complete testing and independent expert review separately. Engine Room reads it automatically from GitHub. All initial stages are pending; existing profile locks and approved decisions remain authoritative. Read [adoption and independent-account instructions](docs/E2EESA_ADOPTION.md), and run `python3 scripts/validate_e2eesa_status.py`. Record validation does not establish product security or certification.

## Service layer (downstream integration)

A downstream application integrates through a versioned, authenticated service
API, an ordered event feed and HMAC-signed webhooks. The full contract, with
request/response examples, is in [docs/PAM_INTEGRATION.md](docs/PAM_INTEGRATION.md).

Run locally without Docker (Node 22+, PostgreSQL):

```bash
cp .env.example .env.local   # set DATABASE_URL, keys, BOOTSTRAP_* (see the doc)
npm ci
npm run start:local          # migrate, bootstrap, build, web on :3100 + worker
npm run api:create-client -- --organization <slug> --name <name>   # service credential
```

Test:

```bash
npm run check                                             # typecheck, unit tests, build
TEST_DATABASE_URL=postgresql://user:pw@127.0.0.1:5432/postgres npm run test:pg
```

`npm run test:pg` creates a throw-away database, serves the built app, runs the
real worker and `clamscan` (with a locally created signature), and drives the
public form and participant pages in a browser when Playwright is installed.

What the service layer covers: tenant provisioning, manifest-driven forms with
per-locale translations, resumable drafts, pseudonymous submission, the
immutable original account with digest, protected identity fields behind an
explicit scope, upload quarantine → scan → release with digests and custody,
case opening, triage, assignment, deadlines, referrals, status transitions,
internal notes, safe participant follow-up messages, and identity mapping.

