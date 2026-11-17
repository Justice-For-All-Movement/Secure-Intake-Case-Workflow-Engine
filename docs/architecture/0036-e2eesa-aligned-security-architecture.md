# ADR 0036: E2EESA-aligned security architecture and achievable claims

## Status

Accepted for SI-38 (November 2026). Source-bound AI-assisted review under the
owner's 2026-10-13 policy. This is not an independent expert review and not an
E2EESA conformance or certification claim; `security/e2eesa-status.json`
keeps its three stages separately.

## Scope reviewed

Components and data flows are listed in `security/e2eesa-inventory.json`.
Reviewed source: `src/modules/protected-data`, `src/modules/webhooks`,
`src/modules/documents`, `src/modules/email`, `src/modules/auth`,
`src/modules/participant-portal`, `src/modules/integration`,
`src/modules/disclosures`, `next.config.ts`, `drizzle/0021_integration_contract.sql`.

## Endpoint encryption (what protects data, and from whom)

| Data | In transit | At rest | Who can read plaintext |
|---|---|---|---|
| Ordinary answers, cases, notes, audit | TLS at the hosting edge (HSTS set by the app); TLS to PostgreSQL (`sslmode=require` enforced by preflight) | Provider disk encryption only | The server and authorised staff/API scopes |
| Protected form fields | Same | AES-256-GCM with a server-held key (`PROTECTED_DATA_ENCRYPTION_KEY`), canonical envelope validation | The server; staff only through audited dual-control reveal; API only with `submission:view_protected` |
| Webhook signing secrets | Same | AES-256-GCM (`WEBHOOK_ENCRYPTION_KEY`) | The server |
| Documents | TLS to S3 (HTTPS only, no redirects) | Provider encryption; create-only versions, SHA-256 custody | The server after a clean scan; nothing before |
| Staff passwords, participant secrets, resume codes, API tokens | TLS | One-way hashes (bcrypt / SHA-256) | Nobody (not recoverable) |
| Outbound webhooks and email | HTTPS (public destinations only unless allow-listed) | Delivery ledgers keep categorical errors only | The receiver |

Every key is server-held. The engine therefore provides **transport and
at-rest protection with authorisation and audit**, not end-to-end encryption:
the server processes plaintext by design (validation, routing, deadlines,
search).

## Audited disclosure boundaries

- Protected values: two-person reveal (`pending -> approved -> consumed`),
  one-time, `no-store`, CSP `default-src 'none'`, every step in the
  append-only audit log.
- Participants: tracking code + access secret only; the portal shows status
  and participant-visible messages, never staff names, notes, documents or
  other submissions.
- Public projections: only fields classified `public` (disclosures policy).
- Service API: tenant from the credential only; another tenant's resource is
  always 404; `api:manage` / `webhook:manage` not delegable.
- Submitted original account: database trigger refuses update/delete.
- Uploads: quarantined until a recorded clean scan; bytes never served before.
- Event feed and webhooks: ordered, HMAC-signed, no protected values.

## Achievable claims

Supported by source and tests: tenant isolation, authorisation and audit of
every disclosure, encryption of protected fields and webhook secrets at rest
with server-held keys, TLS-only external transports, quarantine-until-clean,
immutable original accounts.

Not achievable with this architecture, and not claimed: end-to-end encrypted
content (the server must read submissions), operator-proof confidentiality
(an operator with the keys and database can read protected values),
certification of any kind.

## Remaining work outside this repository

- Owner-arranged independent expert review (deferred by owner policy).
- Key custody: a documented backup and rotation of the two server keys in the
  hosting provider's secret store (operator procedure, `docs/OPERATIONS_RUNBOOK.md`).
- The E2EESA status record's implementation/testing stages need the six gate
  reports bound to one source digest; they remain unchecked.
