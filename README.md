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

## Current milestone

**PR 34 — immutable release-request automation**

A reviewed change to `release-request.json` on `main` can now dispatch the
validated release workflow automatically.

The request must name the package version and an immutable 40-character source
commit SHA. Moving refs such as `main` are rejected.

The dispatcher has only Actions-write and repository-read permission; the
existing validated release workflow remains the sole authority for release
tests, tag creation, GHCR publication, provenance/SBOM and release evidence.

This makes releases triggerable through the same reviewed Git/PR path used for
source changes without introducing a personal access token.

PR 34 also includes the reviewed rc.9 release request pinned to source commit
`2fb452f23e5e5464db03a3ec95d36c4bc2db4fa4`. When this PR is merged to
`main`, the push matches the release-request workflow and dispatches the
validated rc.9 release automatically.

The runtime package version remains **1.0.0-rc.9**.

See
[docs/architecture/0034-immutable-release-request-dispatch.md](docs/architecture/0034-immutable-release-request-dispatch.md).

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

