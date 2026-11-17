# Acceptance ledger

Status of every plan unit (`registry/prs.json`) as of 17 November 2026.
"Merged" means the source work is on `main`; live GitHub is the authority for
PR state. Operational acceptance with real providers is listed separately.

## SI-01 – SI-34

Merged through PRs #1–#34 (SI-28–SI-34 per ADRs 0028–0034, see
`docs/ENGINE_ROOM_RECONCILIATION_20261018.md`). Covered by the unit suite,
`npm run test:integration` and the end-to-end suite (`npm run test:pg`).

## SI-35 – SI-42

| Unit | PRs | Status | Evidence |
|---|---|---|---|
| SI-35 Reproducible builds and supply chain | #54 (+#30, #31, #33–#35) | Complete | Committed lockfile, `npm ci` in Docker and CI, `.dockerignore`, digest-pinned images, release workflow with SBOM/provenance, `scripts/verify-deployment-image.mjs` |
| SI-36 Production deployment | #53, #54 | Complete | Live `intake-pam` on Render: migrations, bootstrap, worker in `scripts/container-start.sh`; `/api/health` and `/api/ready` live; migration and environment preflight |
| SI-37 Data protection and durability | #54, #55 | Complete pending owner credentials | S3 create-only versions, quarantine-until-clean, retention sweep, restore drill script, key-custody runbook |
| SI-38 E2EESA-aligned security architecture | #54, #56 | Complete (independent review deferred) | ADR 0036, `security/e2eesa-inventory.json`; E2EESA stages tracked separately |
| SI-39 Notifications and downstream integration | #52, #55 | Complete pending owner credentials | Signed webhooks, event feed, capabilities, HTTPS email transport (tested on the real worker with a local API) |
| SI-40 Monitoring and production acceptance | #53, #55 | Complete pending owner credentials | Health workflow with cold-start wake, readiness diagnostics, runbook incl. rollback |
| SI-41 Release security/usability/load tests | #55 | Complete | Adversarial tenancy, axe + keyboard browser tests, 60 concurrent submissions, concurrent idempotency, worker recovery, clamscan |
| SI-42 Stable generic 1.0 release | #56 | Complete pending owner decision | This ledger, `docs/OPERATIONS_RUNBOOK.md`; release tag is an owner decision |

## Test counts on `main` after #55

- Unit: 57 files, 242 tests (`npm test`); before this completion work 54 / 225.
- End-to-end on real PostgreSQL, served app, worker, clamscan and browser:
  27 tests (`npm run test:pg`); before 21.
- Also in CI: typecheck, release contract, generic integration contract,
  preflight/probe/restore-drill script tests, production build, Docker build.

## Owner-only steps

Values go only into the Render service environment and GitHub repository
secrets; names only are listed here.

1. **Document storage (SI-37)**: a private S3-compatible bucket. Service:
   `DOCUMENT_STORAGE_DRIVER=s3`, `DOCUMENT_S3_ENDPOINT`, `DOCUMENT_S3_REGION`,
   `DOCUMENT_S3_BUCKET`, `DOCUMENT_S3_ACCESS_KEY_ID`,
   `DOCUMENT_S3_SECRET_ACCESS_KEY` (optional `DOCUMENT_S3_SESSION_TOKEN`,
   `DOCUMENT_S3_TIMEOUT_MS`). The service currently uses the ephemeral local
   disk (`DOCUMENT_STORAGE_DRIVER=local`).
2. **Malware scanner (SI-37)**: `MALWARE_SCANNER_DRIVER=http` with
   `MALWARE_SCANNER_URL`, `MALWARE_SCANNER_PROVIDER`, `MALWARE_SCANNER_TOKEN`;
   or `clamscan` with `CLAMSCAN_DATABASE_DIR` on an instance with at least
   2 GB (needs ClamAV added to the image). Currently `none`: uploads stay
   quarantined.
3. **Email (SI-39)**: `EMAIL_TRANSPORT_DRIVER=http`, `EMAIL_HTTP_URL`,
   `EMAIL_HTTP_TOKEN`, `EMAIL_FROM` (optional `EMAIL_PROVIDER`,
   `EMAIL_HTTP_TIMEOUT_MS`).
4. **Proxy headers (optional)**: set `AUTH_TRUST_PROXY_HEADERS=true` only
   after confirming the hosting edge overwrites `X-Real-IP` /
   `X-Forwarded-For` (a client must not be able to choose the value); the
   sign-in and draft throttles then also count per client source.
5. **Live verification (SI-37/39/40)**: add the same names as repository
   secrets, plus `LIVE_EMAIL_TEST_RECIPIENT`, `NEON_API_KEY`,
   `NEON_PROJECT_ID` (optional `NEON_SOURCE_BRANCH_ID`, `NEON_DATABASE_NAME`,
   `NEON_ROLE_NAME`); run "Live provider verification (opt-in)" with
   `require=s3,scanner,email`.
6. **Synthetic end-to-end acceptance (SI-40)**: with synthetic data only,
   submit the example form with one file, confirm the file is released after
   the scan, open a case, assign it, add a deadline, send an email
   correspondence to a test address, and confirm the downstream application
   received the signed webhooks.
7. **Stable release (SI-42)**: decide to release 1.0.0; one PR changes
   `package.json` and `release-request.json`; the downstream identity verifier
   adds `1.0.0` to `supportedVersions` first.
8. **Independent expert review**: deferred by owner policy; remains pending in
   `security/e2eesa-status.json`.

## Downstream compatibility

All changes in #55 are additive for API consumers: validation errors gain
`code` and `params`, idempotency responses expire after
`API_IDEMPOTENCY_RETENTION_HOURS` (default 7 days), and the engine version
string stays `1.0.0-rc.9`.
