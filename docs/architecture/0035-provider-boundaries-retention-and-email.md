# ADR 0035: Provider boundaries, retention and outbound email

## Status

Accepted (SI-37, SI-39, SI-40, SI-41 completion work, November 2026).

## Context

The engine already had durable-storage and scanner adapters (ADR 0030), but no
outbound email transport, no expiry for unsubmitted drafts or stored
idempotency responses, no throttle on public draft creation, English-only
server validation messages, and no repeatable way to prove a configured
provider or a database restore actually works. The scheduled health check of
the free Render instance failed whenever the instance was asleep.

## Decision

- **Email**: one provider-neutral HTTPS JSON transport
  (`src/modules/email/http-email.ts`), enabled only by
  `EMAIL_TRANSPORT_DRIVER=http`. The worker registers `notification.deliver`
  and `correspondence.deliver` only then; otherwise those jobs stay pending.
  Redirects are refused, provider bodies are never stored, attachments are
  refused instead of silently dropped, and each message carries a stable
  `Idempotency-Key`.
- **Retention**: an hourly `retention.sweep` per tenant deletes unsubmitted
  drafts older than `DRAFT_RETENTION_DAYS` (default 30) that no case
  references, and idempotency responses older than
  `API_IDEMPOTENCY_RETENTION_HOURS` (default 168). Submitted accounts are out
  of scope (and protected by the existing trigger). One audit event with
  counts is written per sweep that deleted something.
- **Draft throttle**: new public drafts are counted per trusted client source
  in the existing throttle table (`PUBLIC_DRAFT_CREATE_LIMIT_PER_HOUR`); the
  participant sees a translated message.
- **Validation messages**: every error carries a language-neutral `code` and
  numeric `params`; the public form renders them from the form's per-locale
  UI strings. The English `message` stays for API compatibility.
- **Live verification**: `scripts/verify-live-providers.ts` and
  `scripts/neon-restore-drill.mjs`, run by a manual workflow from repository
  secrets, skip every provider that is not configured.
- **Health probe**: a bounded wake phase before the strict probe.

## Consequences

Provider-dependent behaviour is complete in source and exercised with local
fakes and the real database, worker and served app. Acceptance against the
real S3 bucket, scanner, email provider and Neon restore needs the owner's
credentials; the workflow above produces that evidence.
