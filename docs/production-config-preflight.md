# Production configuration preflight

The generic engine already has a documented Render preview and a dedicated Neon project. Use those **existing** destinations rather than creating another database or Render service.

Before applying migrations or accepting real sensitive submissions, supply the deployment settings in the provider's secret manager and run:

```sh
node scripts/verify-production-environment.mjs
```

The command is read-only. It checks the presence and **syntax** of required Neon/Render/S3/scanner configuration and that configured protected-data/webhook keys use the expected 64-character hexadecimal encoding. It prints only symbolic check names and does not emit database passwords, scanner tokens, encryption keys or object storage credentials. It rejects insecure plain-HTTP storage/scanner endpoints and PostgreSQL URLs missing explicit TLS requirements.

Missing encryption keys produce warnings only if the corresponding optional feature has not been enabled; using those features without a key remains unsupported. Operators must preserve encryption keys needed to read existing records and implement approved rotation/backup procedures.

**This is not a readiness certificate.** It does not test database access, migrations, malware detection, job workers, durable storage behavior, key custody, identity policy, cross-tenant isolation or backup restorability. Separate acceptance tests and infrastructure review are mandatory before handling real submissions. The public `/api/ready` only proves PostgreSQL reachability, not whole-system availability.

To run the regression checks without contacting external infrastructure:

```sh
node scripts/test-production-environment.mjs
```

Preflight rejects IP literals, local hostnames and ambiguous duplicate PostgreSQL `sslmode` parameters. This is syntactic defense only; resolve and enforce network egress policy at runtime to address DNS rebinding.

Before changing the existing Render service's image, download the release's `release-evidence.json` and run:

```sh
node scripts/verify-deployment-image.mjs --evidence release-evidence.json --source EXPECTED_40_CHARACTER_GIT_SHA --blueprint render.yaml
```

Run the same check against `deployment/worker.render.example.yaml` if deploying the separately authorized worker. This checks that each Blueprint pins the exact digest associated with the intended source commit. It does not contact Render/GHCR or prove that the image actually runs; verify the live deployment and attestation separately.

Before each migration, set `MIGRATION_EXPECTED_HOST` and `MIGRATION_EXPECTED_DATABASE` from the approved Neon target and run `node scripts/preflight-migrations.mjs`. The command prints only symbolic checks and rejects a mismatched host/database or insecure or ambiguous database TLS setting. Confirm the Neon project and branch, authorized maintenance window, and restorable backup independently before `npm run db:migrate`; this syntax check does not contact Neon or prove a backup.

## Release evidence input boundary

The image preflight accepts the exact version-1 record emitted by `scripts/write-release-evidence.mjs`: closed root, engine and container objects; an explicit `1.0.0` or `1.0.0-rc.<digits>` version (matching the release-contract validator); a matching tag; a nonzero exact source SHA and a nonzero SHA-256 image digest. Missing values, arrays masquerading as strings, unknown fields and newline-suffixed identifiers fail closed. The operator supplies the independently approved source SHA; the JSON record is not itself authentication.

CLI exit 0 means the source/digest text comparison passed, 1 means an explicit mismatch, and 2 means invalid arguments or unreadable/malformed/oversized input. Evidence files are limited to 64 KiB and Blueprint text to 1 MiB. Invalid input reports no raw JSON, secret value, local path or stack trace. Flags may be reordered but not repeated, omitted or supplied as values. The regression command above exercises both pure validation and actual CLI exit/output behavior using synthetic temporary files.

The Blueprint comparison inspects a single plain `image:` scalar. It is **not a YAML parser or full Render Blueprint validator** and must not be used to approve arbitrary YAML, aliases, templates or scripts. Validate the complete reviewed Blueprint with the authorized provider and independently read back the existing service's actual image before deployment. Neither this check nor CI performs or authorizes production deployment.
