# Operations runbook

Short procedures for the operator of a deployment (for example the Render
service `intake-pam`). Every command prints names and categories, never secret
values.

## Health check failed

1. Open the failed run of "Existing Secure Intake preview health". A message
   `did not answer after 4 wake attempts` means the service did not start:
   check the Render dashboard events and logs for a failed deploy or crash.
2. `/api/ready` with `database=unavailable` means PostgreSQL is unreachable:
   check the Neon project status and that `DATABASE_URL` is unchanged.
3. `reports version X; expected Y` means the deployed commit lags `main`:
   check that the latest auto-deploy finished.

## Uploads stay quarantined

Expected while no scanner is configured (`MALWARE_SCANNER_DRIVER=none`).
Otherwise open `/admin/jobs`: dead `document.scan` jobs show a categorical
error. Fix the scanner configuration, then retry the dead jobs there. Never
mark files clean by hand without scanning them elsewhere.

## Email not delivered

- Jobs `notification.deliver` / `correspondence.deliver` pending with zero
  attempts: email is not enabled (`EMAIL_TRANSPORT_DRIVER`).
- Failed with `Email provider returned HTTP 401/403`: the token
  (`EMAIL_HTTP_TOKEN`) is wrong or revoked. `HTTP 422/400`: usually an
  unverified sender domain for `EMAIL_FROM`.
- Retry dead jobs from `/admin/jobs` after fixing the configuration.

## Verify providers after a change

Run the manual workflow "Live provider verification (opt-in)" (input
`require`, for example `s3,scanner`). See `docs/deployment-production.md`.

## Restore

1. Run the workflow's `restore-drill` job (or
   `node scripts/neon-restore-drill.mjs`) to confirm a point-in-time copy is
   usable.
2. For a real restore, create a Neon branch as of the chosen time, verify it
   the same way, then point `DATABASE_URL` of the service at it (or restore
   the default branch from it in the Neon console) during a maintenance
   window. Documents in S3 are create-only per version, so database and
   object store stay consistent for any restore point after the upload.

## Rotate secrets

- `PROTECTED_DATA_ENCRYPTION_KEY` and `WEBHOOK_ENCRYPTION_KEY` cannot be
  replaced without re-encrypting stored records; keep them in the provider's
  secret store and back them up separately from the database.
- Service API credentials: mint a new one (`npm run api:create-client`), switch
  the downstream application, then revoke the old one in `/admin/integrations`.
- `EMAIL_HTTP_TOKEN`, `DOCUMENT_S3_*`, `MALWARE_SCANNER_TOKEN`: replace in the
  provider, update the service's environment, redeploy, run the live
  verification workflow.
