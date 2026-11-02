# ADR 0030: Durable object storage and automatic malware scanning

## Status

Accepted for PR 28.

## Context

The document subsystem already enforces quarantine, immutable version metadata,
SHA-256 provenance, trusted-download integrity checks, and an explicit malware
scan status. Public uploads also enqueue no implicit trust decision.

The remaining production gaps were deployment-critical:

- the only storage adapter was the local filesystem, which makes cloud
  deployments depend on a durable shared disk;
- the malware scanner interface had no production adapter;
- uploaded versions did not automatically enter a scanner work queue.

A production deployment must be able to use durable object storage and a real
scanner without weakening the rule that upload success never means clean.

## Decision

### S3-compatible document storage

The engine supports `DOCUMENT_STORAGE_DRIVER=s3`.

Configuration:

- `DOCUMENT_S3_ENDPOINT`
- `DOCUMENT_S3_REGION`
- `DOCUMENT_S3_BUCKET`
- `DOCUMENT_S3_ACCESS_KEY_ID`
- `DOCUMENT_S3_SECRET_ACCESS_KEY`
- optional `DOCUMENT_S3_SESSION_TOKEN`

The adapter:

- requires HTTPS;
- signs requests with AWS Signature Version 4;
- uses engine-generated object keys only;
- supports put/get/delete;
- does not expose presigned public download URLs;
- preserves the existing trusted-download SHA-256 verification.

The implementation intentionally uses Node's built-in crypto/fetch APIs and
does not add an SDK dependency.

### HTTP malware scanner adapter

When `MALWARE_SCANNER_URL` is configured, the engine POSTs raw document bytes
to the configured HTTPS scanner endpoint.

Request metadata includes:

- content type;
- encoded filename;
- expected SHA-256;
- optional bearer token.

The scanner must return JSON:

```json
{
  "status": "clean | infected | failed",
  "details": {}
}
```

Provider naming and timeout are configurable through:

- `MALWARE_SCANNER_PROVIDER`
- `MALWARE_SCANNER_TOKEN`
- `MALWARE_SCANNER_TIMEOUT_MS`

No scanner URL means no implicit clean scanner. Content remains quarantined.

### Automatic scan jobs

Every newly persisted document version enqueues a deduplicated
`document.scan` background job.

This applies to:

- staff case uploads;
- staff submission uploads;
- additional document versions;
- public intake uploads.

The job:

1. loads the document version in the tenant scope;
2. ignores versions already clean or infected;
3. requires a configured scanner;
4. reads bytes from the configured storage driver;
5. recomputes SHA-256 before scanning;
6. calls the scanner;
7. records clean/infected/failed through the existing document service.

Scanner or storage failures retry through the generic job engine. On the final
attempt, the version is recorded as failed and remains quarantined.

A SHA-256 mismatch is immediately recorded as failed.

### Evidence promotion

The existing rule remains unchanged:

- only a recorded `clean` result makes content available;
- clean intake attachments may be promoted into the source case evidence set;
- infected content is blocked;
- failed/pending content remains quarantined.

## Security considerations

Object-store credentials and scanner bearer tokens are deployment secrets.

The engine does not claim that every S3-compatible provider or scanner is
appropriate for a particular regulatory environment. The deployment authority
must select and configure approved services, network controls, retention,
encryption, backup, and logging.

The scanner endpoint receives the uploaded document content. Deployments must
treat that data transfer as part of the system's information-handling boundary.

## Scope

This PR adds generic adapters and automatic orchestration. It does not:

- provision an object-store account;
- provision an antivirus vendor;
- certify scanner efficacy;
- implement content-disarm-and-reconstruction;
- create a classified-information channel;
- make failed scans usable evidence.

## SI-37 transport and diagnostic hardening

S3 and scanner requests use manual redirect handling; a 3xx response fails instead of forwarding signed headers, bearer tokens or document bytes to a different destination. S3 errors report status only, without untrusted upstream body text. Scanner URLs reject query strings and fragments, and final scan failures store a categorical reason rather than an arbitrary exception message. Scanner JSON is bounded to 64 KiB before parsing. Scanner requests enforce a 1 to 300 second timeout. S3 operations use a bounded request timeout (default 120 seconds; `DOCUMENT_S3_TIMEOUT_MS` accepts 1000 through 300000).

These source safeguards do not establish provider key custody, encryption at rest, retention, backup restoration, actual scanner efficacy or production network egress restrictions. Verify those against the authorized deployment.

## SI-37 create-only version writes

S3 PUT now sends `If-None-Match: *`, included in the Signature Version 4 canonical headers and signed-header list. A preexisting key or competing create therefore fails instead of replacing version bytes when the approved provider supports conditional writes. HTTP 409/412 and provider rejection fail closed, with no unconditional retry, deletion or automatic replacement. GET and DELETE retain their separate existing behavior; this adds no deletion or retention authority.

Regression fixtures reproduced both overwrite and concurrent replacement before the fix. The corrected adapter passes the existing scanner/local/S3 suite plus collision, competing-write, conflict and unsupported-provider cases (19 component tests under Node 22/Vitest 3.2.7). These are isolated transport simulations, not proof of vendor behavior. Before production use, verify the exact provider's signed conditional-PUT semantics with synthetic objects, private bucket permissions, retention/versioning and backup restoration. A provider that ignores conditional headers is unsupported; no compatibility fallback may weaken create-only writes. The local adapter already rejects replacing a key with exclusive file creation.
