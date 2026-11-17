# Existing production destinations and monitoring

This engine is deployed on Render (workspace `tea-dbp24r3m8hqs73dtq660`) as service `intake-pam`: **https://intake-pam.onrender.com**, linked to PAM (https://pam-em80.onrender.com). The earlier preview `secure-intake-preview.onrender.com` is not in this workspace and is no longer probed. Do not create a duplicate service merely because `render.yaml` is checked in. Verify the correct Render workspace and existing service before changing its deployment.

The dedicated Neon project is named **Secure Intake Case Workflow Engine**. It is separate from the National Secure Ideas Submission database. Database migrations require an authorized target database, backup/restore plan, and confirmed secrets; the engine does not silently provision a second database.

## Independent public health check

`.github/workflows/existing-preview-health.yml` runs a read-only check of the existing preview every 15 minutes (GitHub scheduling is best-effort), on pushes to `main`, and by manual dispatch. No Render or Neon access token is required for the check. The endpoints are public and return only coarse information.

The free instance sleeps when idle and its first request waits for a cold start. The probe therefore first wakes the service with up to four bounded liveness requests (`PROBE_WAKE_ATTEMPTS`; only timeouts, connection errors and HTTP 502/503/504 are retried), then runs the strict checks.

The check verifies:
- HTTPS liveness at `/api/health`;
- HTTPS PostgreSQL readiness at `/api/ready`;
- two identical runtime version claims matching the checked-out `package.json`.

If the preview lags the released engine or lacks `DATABASE_URL`, the check will **fail**, and GitHub Actions will display the failure. This is a useful *detection* result, not a proof of an outage or a substitute for a real production acceptance test. A sleeping free-tier service or upstream connectivity issue can also fail a scheduled check. The health workflow does not deploy code, apply migrations, release documents, scan malware, or configure a worker.

## Engine Room

Engine Room already lists the existing service's repository and Render URL. Provider refresh and public-site checks are separate from this GitHub Actions monitor. For full monitoring, the Engine Room deployment must run its own scheduler/ingestion and show source timestamps and freshness. This workflow provides a GitHub-accessible smoke-check result in the meantime.

## Deployment boundary

The root `render.yaml` is a **new-install template** and is not an instruction to apply a second Blueprint on top of the existing preview. Prefer updating the existing authorized Render service's pinned release image and current variables after confirming its ownership and deployment credentials. Follow `docs/deployment-production.md` before handling live, confidential or sensitive submissions.
