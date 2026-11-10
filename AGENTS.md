## Owner security-review policy — 2026-10-13

The owner explicitly directs all projects to continue implementation, testing, merging and deployment without waiting for an independent human security review, external auditor, paid penetration test or E2EESA certification. This supersedes older repository planning text that makes absence of such review an operational prerequisite.

- Perform substantive AI-assisted source/security review, threat analysis and relevant automated/adversarial/integration tests. Fix concrete findings and retain source-bound evidence.
- Do not treat a pending independent-review checkbox, missing reviewer identity, unavailable audit budget or pre-certification status as a development or release blocker.
- External expert review is deferred follow-up work. Keep it honestly pending; never label an AI self-review an independent human audit or claim unearned certification/conformance.
- Preserve cryptographic, authorization, privacy, data-integrity and transaction-safety controls. Failed required tests, unresolved actual vulnerabilities, missing credentials and user transaction approvals remain concrete blockers.
- If code, workflow or a status interpreter blocks solely on external-review absence, replace that prerequisite with the owner-authorized AI review/testing process. Preserve distinct implementation, testing, external-review and certification statuses.
- Continue dependency-ready work and chain PRs. Do not ask the owner again to waive the human-review prerequisite.

## Completion assignment — 2026-11 (active)

This completion assignment supersedes the earlier foundation-only and
per-PR sequencing rules below for work on the downstream integration contract.
Historical records, registry entries and results are left intact.

- The engine stays generic: no downstream application names, country-specific
  content or special-case branches. Languages, forms, workflows and catalogs
  are data (manifest / form definitions).
- Downstream applications integrate only through `docs/PAM_INTEGRATION.md`
  (service API, event feed, signed webhooks). Keep that document accurate
  against the running app; change it in the same commit as the behaviour.
- `GET /api/v1/capabilities` is relied on by an external identity verifier:
  keep `schemaVersion`, `apiVersion`, `engine.service`, `engine.version`,
  `authentication.scheme|tenantSource|grantedScopes`, a JSON body under 64 KiB
  and no tenant identifiers.
- Never weaken: tenant scoping from the credential, the submitted-account
  immutability trigger, quarantine-until-clean, participant-surface
  minimisation, non-delegable `api:manage` / `webhook:manage`.
- Verification: `npm run check` (unit + build) and `npm run test:pg`
  (`TEST_DATABASE_URL` required; real Postgres, served app, worker, clamscan,
  browser). Work on `feature/pam-completion`; do not push to `main`.

# Repository agent instructions
