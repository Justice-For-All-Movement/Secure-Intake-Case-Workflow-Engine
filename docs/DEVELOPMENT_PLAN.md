> **Canonical PR roadmap:** [`registry/prs.json`](../registry/prs.json). Historical complete development specifications remain below; new PRs and counts belong only in the canonical registry.

# Secure Intake & Case Workflow Engine — recovered original development plan and independent-account handoff

**Historical source:** Original October 5 generic 20-milestone plan plus October 6-9 security and operational extensions. Numbered 20-milestone original roadmap recovered from the previous conversations and cross-checked with checked-in roadmap and technical documentation. This document preserves original scope and, where applicable, separates later extensions. Technical per-item acceptance language is an engineering elaboration rather than a purported verbatim transcript; a milestone ID is **not** a GitHub PR number.

## Product mandate and governing boundaries

Multi-tenant, configurable case and evidence workflow platform that supports varied statutory and administrative applications. Core owns reusable intake forms, case IDs, routing, roles, appeals, correspondence, deadlines, external participant access, append-only audit and release safety. National Secure Ideas is a separate thin app. No bill-specific terminology, eligibility or statutes are hardcoded into the upstream engine.

## Original milestone sequence

### SI-01 — Foundation and architecture

- **Deliverable:** TypeScript/Next.js/PostgreSQL structure, CI, migrations, README, health and generic contracts.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-02 — Organizations and tenancy

- **Deliverable:** Organization-scoped models, memberships, separation and no cross-tenant records.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-03 — Authentication and RBAC

- **Deliverable:** Secure account/session, role policy, delegated permission checks and incident audit.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-04 — Configurable intake/forms

- **Deliverable:** Versioned schemas, conditional fields, validation, consent and public/private availability.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-05 — Submission to case lifecycle

- **Deliverable:** Immutable submissions, generated case IDs, review, assignment and initial workflow states.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-06 — Configurable workflow and transitions

- **Deliverable:** Versioned state diagrams, roles/conditions, notices, reversible and terminal transitions.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-07 — Assignment and routing

- **Deliverable:** Queues, manual/automatic routing, workload, escalations and unauthorized assignment denial.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-08 — Documents, attachments and evidence

- **Deliverable:** Versioned metadata/content-addressed files, malware policy, provenance, redaction, audit.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-09 — Immutable audit events

- **Deliverable:** Actor, time, resource, action, old/new immutable history with tamper checks.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-10 — Deadlines, statutory clocks and escalation

- **Deliverable:** Per-policy clock rules, extensions, reminders and late escalation.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-11 — Notes, correspondence and communication

- **Deliverable:** Private/public-aware case notes, templates, outbound/inbound lifecycle and contact restrictions.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-12 — Notifications and jobs

- **Deliverable:** Durable queue, retries, idempotent scheduled notices, audited delivery.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-13 — Review, reconsideration and appeals

- **Deliverable:** Independent reviewer stages, evidence, decision notices, disputed outcomes and historical trace.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-14 — Public/private separation and redaction

- **Deliverable:** Publication projection, role-based compartments, review and sanitized public artifacts.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-15 — Search, queues and dashboards

- **Deliverable:** Scoped search, status/assignee queues and metric summaries.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-16 — Integration API and webhooks

- **Deliverable:** Scoped tokens, signed events, replay protection, endpoint hygiene and idempotency.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-17 — Declarative thin applications

- **Deliverable:** Application configuration/manifests, terminology, branding, approvals and SDK; no statutory rules upstream.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-18 — Security hardening

- **Deliverable:** Login throttling, secure sessions, headers, authz, audit, secrets, file and webhook controls.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-19 — Accessibility and public-sector usability

- **Deliverable:** Keyboard, reader, language clarity, responsive, errors, print and accessibility regression.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

### SI-20 — End-to-end reference application and 1.0 candidate

- **Deliverable:** Full verified neutral intake-to-closure use case, sample data, production acceptance and release boundary.
- **Acceptance:** Exercise correct transition/report/view, invalid data, permission denial, dependency failures and audit/provenance. Add deterministic unit/integration tests and document migrations, APIs and policy boundaries. Do not mark source/demo/SDK implementation as a live production integration.

## Subsequent explicitly separate roadmap extensions

### SI-21 — Generic 1.0 release contract

Compatibility policy, DB-backed integration, release manifest, downstream pinning.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-22 — Encrypted protected compartments

Separate submitter identity, dual-control one-time reveal and explicit immutable access audit.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-23 — External participant portal

Scoped high-entropy credentials separate from public tracking code; protected status access.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-24 — Conditional participant messaging

Status-only anonymity, secure messaging for eligible participant identity mode, no leakage.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-25 — Public attachment quarantine

Supported evidence files scanned and only promoted to trusted record on clean result.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-26 — Parallel referral and recipient deadlines

Independent receiving-agency referrals, acknowledgments, extensions and closures.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-27 — Operational views / thin app contracts

Queue/workflow metrics, a usable policy-driven staff interface, consumer-application boundaries.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-28–34 — Further production and security work

Refer to architecture ADRs 0028–0034 for referral, app operations, durable object storage/scanning, readiness and immutable release dispatch contracts; verify actual PR mappings, since architecture ADR numbers are not guaranteed identical to GitHub PRs.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-35 — Reproducible builds and supply chain

Pinned dependencies, immutable images, SBOM/attestations and release verification.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-36 — Production deployment

Render/Neon web and job workers, migration preflight, health/readiness and safe secrets.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-37 — Data protection and durability

Object storage/scanning, backups, restore, retention and compartment key controls.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-38 — E2EESA aligned security architecture

Review endpoint encryption, audited disclosure boundaries and achievable conformance claims.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-39 — Notifications and downstream integration

Reliable authorized queues, email/events, signed delivery and escalation.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-40 — Monitoring and production acceptance

Traceable metrics, alerts, security audit, Engine Room evidence, deployment and rollback.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-41 — Release security/usability/load tests

Penetration, accessibility, adversarial tenancy, stress and end-to-end recovery.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

### SI-42 — Stable generic 1.0 release

Complete acceptance ledger, downstream compatibility, deploy, support runbooks.. Acceptance requires demonstrable executable behavior or deployment evidence, not only written docs.

## Dependencies and source-of-truth documents

- [docs/development.md](../docs/development.md)
- [docs/downstream-application-contract.md](../docs/downstream-application-contract.md)
- [docs/deployment-production.md](../docs/deployment-production.md)
- [docs/production-config-preflight.md](../docs/production-config-preflight.md)
- [docs/existing-deployment-monitoring.md](../docs/existing-deployment-monitoring.md)

The original 20-stage baseline has changed through many later releases and separate downstream National Secure Ideas work. PR32 was reported closed/superseded in a later conversation and equivalent work in another PR; do not mark numbered tasks merged solely from position. Current Render health and Neon readiness must be tested independently.

## Source reconciliation — 18 October 2026

See [the source-bound reconciliation](ENGINE_ROOM_RECONCILIATION_20261018.md) for explicit ADR-to-PR definitions of SI-28–34, disclosed overlap, partial production contributions and the stable-release dependency gate. The canonical plan retains all stable IDs and records actual PR identities rather than treating ordinal numbers as GitHub numbers.

## Execution / release / status rules

1. Read this plan plus the checked-in policy/data model, ADRs, current README and linked runbooks. Discover open and merged actual PRs, CI, image versions, migration versions, release tags, live Render/Neon state and dependent app contract versions; never trust outdated conversational status.
2. Create and maintain a mapping **roadmap ID → GitHub PR(s) → tests → release/deployment evidence**, preserving historical 2026 plan numbering and app-specific changes as separately versioned additions. Only verified merged functionality counts toward development; production evidence is independent.
3. Keep the engine reusable where applicable. Enforce documented negative paths, role/tenant leakage, audit integrity and source validity. Avoid unreviewed policy in upstream code, mock approval of legal obligations, and claims of real-world regulatory compliance from fictional cases.
4. Continue implementation in small chained PRs with required tests, migrations, review of security implications and rollback plan; stop when permissions, credentials, external provider/legal requirements or failing gates make it necessary. Consult the user only for material product and real credentials/authorization decisions.
5. Require real environment health/readiness, DB migrations, backup restoration, media/document storage and malware scanning where applicable, accessibility/security review and demonstrated end-to-end consumer flows before calling a production release complete.

## Completion status — 17 November 2026

All 42 plan units have merged source work on `main`; the canonical status is
`registry/prs.json` and the evidence table is
[ACCEPTANCE_LEDGER.md](ACCEPTANCE_LEDGER.md).

- Complete: SI-01–SI-36, SI-38 (independent expert review deferred by owner
  policy), SI-41.
- Complete pending owner credentials: SI-37 (S3 bucket, malware scanner,
  Neon restore drill), SI-39 (email provider), SI-40 (live synthetic
  acceptance after providers exist).
- Complete pending owner decision: SI-42 (cutting the stable 1.0.0 release
  together with the downstream verifier's `supportedVersions`).

Owner-only inputs (names only; values go to the Render service environment
and GitHub repository secrets): `DOCUMENT_STORAGE_DRIVER`,
`DOCUMENT_S3_ENDPOINT`, `DOCUMENT_S3_REGION`, `DOCUMENT_S3_BUCKET`,
`DOCUMENT_S3_ACCESS_KEY_ID`, `DOCUMENT_S3_SECRET_ACCESS_KEY`,
`MALWARE_SCANNER_DRIVER`, `MALWARE_SCANNER_URL`, `MALWARE_SCANNER_PROVIDER`,
`MALWARE_SCANNER_TOKEN`, `EMAIL_TRANSPORT_DRIVER`, `EMAIL_HTTP_URL`,
`EMAIL_HTTP_TOKEN`, `EMAIL_FROM`, optionally `AUTH_TRUST_PROXY_HEADERS`, and for the
verification workflow `LIVE_EMAIL_TEST_RECIPIENT`, `NEON_API_KEY`,
`NEON_PROJECT_ID`. The ledger lists the steps.

## Recovery confidence

**The original 20 ordered milestones are recovered** and supported by the previous conversation and current repository docs. Current code/CI/live deployment evidence is not established by creating this document.
