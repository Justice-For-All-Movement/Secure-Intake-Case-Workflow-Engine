# Deploying the generic engine (RC preview to production)

## Immutable artifact and service ownership

The checked-in `render.yaml` uses the published `v1.0.0-rc.9` OCI digest instead of a mutable branch or `latest` tag. It defines a **free-tier web preview only** and does not claim production readiness. This may create a new service: check existing Render services before applying it to avoid duplicates. Use the correct, explicitly authorized Render workspace; do not apply a Blueprint in an unrelated workspace. Subsequent releases must advance the reviewed image digest here through a PR.

The optional `deployment/worker.render.example.yaml` is **not auto-applied**. It documents a separate continuously running worker that requires a potentially billable plan. Never silently enable a paid worker to make this preview look operational. A free web process may sleep and cannot guarantee background jobs. An unattended or sleeping web process does not complete pending malware scanning or statutory sweeps.

## Before deploying

1. Confirm ownership of the target Render workspace and the existing preview service. Reuse, do not accidentally duplicate an existing deployment.
2. Choose an isolated Neon database dedicated to this deployment. Never point two unrelated apps at the same database, or point exploratory migrations at a production database.
3. Set `DATABASE_URL` (pooled for app traffic, migration connectivity as supported) and `APP_BASE_URL` (the canonical public HTTPS origin) as provider-managed secrets. Never put real values in this Git repository, PRs, Actions logs or Engine Room.
4. Configure a **private** durable S3-compatible bucket; grant only the required object rights. Provide all `DOCUMENT_S3_*` secrets. Files must not be written to ephemeral Render web disks.
5. Configure an approved HTTPS malware scanner that accepts the engine's scanner contract. Until a scanner and background worker both function, uploads remain quarantined; don't silently mark files clean.
6. If the application uses protected fields, set a securely generated **64 hexadecimal character** `PROTECTED_DATA_ENCRYPTION_KEY` and preserve it for the life of those records. Webhook integration uses a separate 64-hex `WEBHOOK_ENCRYPTION_KEY`. Store/rotate secrets using provider controls.
7. Arrange actual TLS, egress restrictions (including metadata/DNS rebinding mitigation), access control, backups, malware-service trust, provider alerts, and incident-response ownership. Never use the engine for classified information without separate accreditation.

## Initialize and validate

- Before receiving real data, run ordered Drizzle migrations with `npm run db:migrate` against the **intended** deployment database. Take a restorable snapshot before future upgrades; verify database URL and branch first.
- Bootstrap the administrator with the one-time `npm run auth:bootstrap` command and provider secret values, then remove bootstrap secrets.
- Start the web process and verify `GET /api/health` (liveness) and `GET /api/ready` (Postgres reachability). `/api/ready` must be HTTP 200 with `checks.database: ok`.
- Check with `node scripts/probe-public.mjs https://YOUR-AUTHORIZED-RENDER-DOMAIN`. This is a read-only remote probe. It does not test permissions, encryption, scanners, background workers, restore capability, or end-to-end case flows.
- Start a dedicated worker (`npm run worker`) and verify heartbeat/job activity, deadline sweeps, scan-clean promotion and failure/lease behavior with **synthetic** files and cases. Unconfigured transport handlers must not claim deliveries.
- Configure GitHub/Render/Neon integrations in Engine Room with scoped credentials and source timestamps. A GitHub PR merge count, HTTP 200, or static Render deployment snapshot is not sufficient evidence of production availability.

## Promotion gate

Do **not** call the deployment production-ready unless all are verified: deployed immutable image matches release evidence, DB migrations, secure operator access, tenant isolation, functional scanner and durable storage, persistent worker, key custody, controlled restore, live monitoring/alerts, and end-to-end acceptance. Keep preview/test data synthetic until this gate is met.

## Cost and dependency boundary

The Blueprint intentionally leaves the database in Neon and does not purchase Render databases. The free web preview does not promise continuous uptime. The optional worker requires a paid Render service (check current rates before approving it). A cheaper scheduled worker may trade latency and availability against cost but must preserve the quarantine and deadline guarantees of the specific deployment.

## Transport configuration hardening

The malware scanner URL must not contain a query string or fragment; provide its token through the provider-managed `MALWARE_SCANNER_TOKEN` secret. S3 and scanner redirects fail closed. For slow S3 providers, set `DOCUMENT_S3_TIMEOUT_MS` within 1000 to 300000 ms after measuring the largest supported upload; the default is 120000 ms. A timeout fails the operation and does not promote quarantined content.
Scanner requests also enforce a 1000 to 300000 ms timeout through `MALWARE_SCANNER_TIMEOUT_MS` (default 120000 ms).
