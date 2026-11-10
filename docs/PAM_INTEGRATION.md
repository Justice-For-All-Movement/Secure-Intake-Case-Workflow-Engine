# Integration contract for downstream applications

This is the contract a downstream application (for example an orchestration
service) codes against. Everything here is generic: the engine has no
knowledge of any particular downstream application. Engine package version:
`1.0.0-rc.9`; capability document field `integrationContract: "2026-11-pam"`.

Sections: [local start](#1-local-start) · [auth](#2-authentication) ·
[conventions](#3-conventions) · [endpoints](#4-endpoints) ·
[events](#5-events) · [webhooks](#6-webhooks) ·
[identity mapping](#7-identity-mapping) · [uploads](#8-uploads-quarantine-and-release) ·
[participant surfaces](#9-participant-surfaces) · [limits](#10-not-implemented--not-verified)

## 1. Local start

Requirements: Node 22+ (tested on Node 24), PostgreSQL 14+, no Docker needed.

```bash
cp .env.example .env.local        # then edit; see the variable table below
createdb intake_dev               # or: psql -c 'create database intake_dev'
npm ci
npm run start:local               # migrate, bootstrap admin, build, web + worker
```

`npm run start:local` (`scripts/local-start.sh`) reads `.env.local` (or
`.env`), runs `npm run db:migrate`, runs `npm run auth:bootstrap` when the
`BOOTSTRAP_*` variables are set, builds if needed (`SKIP_BUILD=1` reuses an
existing `.next`), starts the worker and serves the app on
`http://127.0.0.1:$PORT` (default `3100`).

The same thing step by step:

```bash
export DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/intake_dev
npm ci
npm run db:migrate
BOOTSTRAP_ADMIN_EMAIL=admin@example.org BOOTSTRAP_ADMIN_PASSWORD='<16+ chars>' \
BOOTSTRAP_ORGANIZATION_NAME='Example Office' BOOTSTRAP_ORGANIZATION_SLUG=example-office \
  npm run auth:bootstrap
npm run build
npx next start --hostname 127.0.0.1 --port 3100 &   # web
npm run worker &                                     # scans, webhooks, deadline sweeps
curl http://127.0.0.1:3100/api/ready
```

Load the neutral example configuration (forms, workflow, queue, document
types, a multilingual pseudonymous report form):

```bash
npm run app:manifest -- --file examples/reporting-manifest.example.json \
  --organization example-office --actor-email admin@example.org
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string (dedicated database). |
| `PORT` | no (3100) | Port used by `start:local`. |
| `APP_BASE_URL` | yes | Public origin of the app, e.g. `http://127.0.0.1:3100`. |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ORGANIZATION_NAME`, `BOOTSTRAP_ORGANIZATION_SLUG` | first start | Creates the first organization and administrator (idempotent). |
| `PROTECTED_DATA_ENCRYPTION_KEY` | when a form has protected fields | 64 hex chars (AES-256-GCM). Keep stable. |
| `WEBHOOK_ENCRYPTION_KEY` | to create or deliver webhooks | 64 hex chars; encrypts signing secrets at rest. |
| `PLATFORM_API_TOKEN_SHA256` | to use `/api/v1/platform/*` | SHA-256 hex of a random token of 32+ chars. Unset = platform API answers 404. |
| `WEBHOOK_ALLOWED_PRIVATE_ORIGINS` | co-located receiver | Comma separated exact origins that may be private/HTTP, e.g. `http://127.0.0.1:8090`. All other webhook URLs must be public HTTPS on port 443. |
| `MALWARE_SCANNER_DRIVER` | to release uploads | `clamscan`, `http` or `none`. |
| `CLAMSCAN_PATH`, `CLAMSCAN_DATABASE_DIR` | clamscan driver | Binary (default `clamscan`) and signature database directory. |
| `MALWARE_SCANNER_URL`, `MALWARE_SCANNER_PROVIDER`, `MALWARE_SCANNER_TOKEN`, `MALWARE_SCANNER_TIMEOUT_MS` | http driver | HTTPS scanner endpoint. |
| `DOCUMENT_STORAGE_DRIVER`, `DOCUMENT_STORAGE_ROOT`, `DOCUMENT_MAX_BYTES`, `PUBLIC_UPLOAD_TOTAL_MAX_BYTES`, `DOCUMENT_S3_*` | no | Upload storage (local directory by default; web and worker must share it). |
| `API_DEFAULT_RATE_LIMIT_PER_MINUTE` | no (120) | Default per-credential rate limit. |
| `BACKGROUND_JOB_*`, `BACKGROUND_DEADLINE_SWEEP_SECONDS` | no | Worker tuning. |
| `AUTH_*`, `PARTICIPANT_SESSION_*` | no | Staff and participant session settings. |

Generate keys: `openssl rand -hex 32`. Generate a platform token and its
digest: `TOKEN=$(openssl rand -base64 48 | tr -d '\n=+/'); printf %s "$TOKEN" | sha256sum`.

## 2. Authentication

Base URL: `{APP_BASE_URL}/api/v1`. All requests and responses are JSON unless
stated. Two credential kinds exist.

### 2.1 Service credential (tenant scoped)

`Authorization: Bearer sicwe_<12 hex>_<43 chars>`. A credential belongs to
exactly one organization (tenant); the tenant is never taken from the request.
Only the SHA-256 of the token is stored. Mint one in any of three ways:

```bash
# CLI (needs DATABASE_URL). Prints the token once plus its SHA-256 fingerprint.
npm run api:create-client -- --organization example-office --name pam \
  [--permissions case:view,submission:view,...] [--with-protected] \
  [--expires-at 2027-01-01T00:00:00Z] [--json]
```

- Without `--permissions` the CLI grants the integration bundle:
  `application:manage application:view audit:view case:assign case:create
  case:update case:view correspondence:manage correspondence:view
  deadline:operate deadline:view document:view event:view form:view
  identity:manage note:create_internal note:view referral:manage referral:view
  review:view submission:create submission:view`.
- `--with-protected` adds `submission:view_protected` (protected identity
  fields). Grant it only to a service that must read identities.
- Platform API: `POST /api/v1/platform/organizations/{slug}/api-clients` (below).
- Admin UI: `/admin/integrations`.

`api:manage` and `webhook:manage` can never be delegated to a credential.
Wrong, expired or revoked credentials get `401`; a missing scope gets `403`
`{"error":{"code":"forbidden",...}}`; rate limiting gets `429` with
`Retry-After: 60`. Every authenticated response carries
`X-RateLimit-Limit/Remaining/Reset` and `Cache-Control: private, no-store`.

### 2.2 Platform credential (deployment scoped)

`Authorization: Bearer <platform token>` where the deployment sets
`PLATFORM_API_TOKEN_SHA256`. It can only create organizations, mint service
credentials and register webhooks. It cannot read any tenant data.

## 3. Conventions

- Success: `{"data": ...}`. Failure: `{"error":{"code","message","details"?}}`.
- Problem codes: `invalid_json` 400, `invalid_id` 400, `invalid_cursor` 400,
  `not_found` 404, `conflict` 409, `transition_unavailable` 409,
  `submission_not_submitted` 409, `content_unavailable` 409,
  `participant_messaging_unavailable` 409, `assignment_failed` 409,
  `validation_failed` 422, `transition_guard_failed` 422, `invalid_request` 422,
  `protected_data_unavailable` 503, `operation_failed` 400 (unclassified).
- A resource of another tenant is always `404`, never `403`.
- **Idempotency**: every `POST` under section 4 that uses the JSON envelope
  accepts `Idempotency-Key: <8-200 chars>`. Same key + same method, path and
  body replays the stored response with `Idempotent-Replay: true`. Same key
  with a different request is `422 idempotency_key_reused`. A concurrent
  duplicate is `409 idempotency_in_progress`. Failed requests are not stored.
  Keys are scoped to the credential. One-time secrets are never stored: a
  replay of `POST /submissions` returns `participantAccessSecret: null` and
  `participantAccessSecretWithheld: true`.
- List endpoints that existed before this contract use `limit`/`offset`
  (max 100 / 10000). The event feed uses a cursor.
- `GET /api/v1/capabilities` lists every operation, its scopes and whether the
  calling credential may use it.

## 4. Endpoints

`{B}` = `{APP_BASE_URL}/api/v1`. Scopes in brackets are all required.

### 4.1 Discovery

`GET {B}/capabilities` [none]

```json
{"data":{"schemaVersion":1,"apiVersion":"v1","integrationContract":"2026-11-pam",
 "engine":{"service":"secure-intake-case-workflow-engine","version":"1.0.0-rc.9"},
 "authentication":{"scheme":"bearer","tenantSource":"api_client","grantedScopes":["case:view","..."]},
 "endpoints":[{"id":"cases.open","method":"POST","path":"/api/v1/cases","requiredScopes":["case:create","submission:view"],"pagination":"none","available":true}],
 "limits":{"requestIdempotency":true,"idempotencyHeader":"Idempotency-Key","events":{"feed":"/api/v1/events","cursor":true,"ordered":true,"webhookSignature":"hmac-sha256","maxLimit":500}}}}
```

`GET {B}/openapi` (public) is the earlier machine-readable description of the
pre-existing read endpoints only; this document is authoritative for the rest.

### 4.2 Tenant provisioning (platform credential)

`POST {B}/platform/organizations` — create or return an organization (idempotent by slug).

```json
// request
{"slug":"second-office","name":"Second Office"}
// 201 (200 when it already existed)
{"data":{"id":"222ce357-...","slug":"second-office","name":"Second Office","status":"active","created":true}}
```

`POST {B}/platform/organizations/{slug}/api-clients` — mint a service credential.

```json
{"name":"pam","permissions":["case:view","submission:view","event:view"],"expiresAt":null}
// 201
{"data":{"id":"ec142573-...","name":"pam","keyPrefix":"7ba8ec9e122b","permissions":["case:view","event:view","submission:view"],"expiresAt":null,"token":"sicwe_7ba8ec9e122b_..."}}
```

`POST {B}/platform/organizations/{slug}/webhooks` — register a webhook (section 6).

```json
{"name":"pam","endpointUrl":"http://127.0.0.1:8090/hooks/intake","eventTypes":["submission.created","attachment.released","case.opened","case.transitioned"]}
// 201 — signingSecret is returned once and stored encrypted
{"data":{"id":"cc4bf718-...","name":"pam","endpointUrl":"http://127.0.0.1:8090/hooks/intake","eventTypes":["attachment.released","case.opened","case.transitioned","submission.created"],"status":"active","signingSecret":"IEuajzpb..."}}
```

`eventTypes` may contain `"*"`. Webhook names are unique per organization.

### 4.3 Configuration: forms, locales, workflows

`POST {B}/application/manifest` [`application:manage`] — apply a declarative
manifest (the request body is the manifest itself, or `{"manifest": {...}}`).
A manifest declares roles, document types, calendars, teams, queues,
communication templates, workflows, **forms with their translations**, routing
rules, review and referral policies. Reconciliation is non-destructive and
idempotent (`noChange: true` when the content hash is unchanged). Full example:
`examples/reporting-manifest.example.json`.

```json
// 200
{"data":{"revisionId":"91281c41-...","manifestHash":"6068...","noChange":false,
 "counts":{"document_type":2,"workflow":1,"form":2,"routing_rule":2}}}
```

`GET {B}/application/manifest` [`application:view`] — the active manifest revision or `null`.

`GET {B}/forms` [`form:view`] — forms of the tenant.

Form definition fields that matter to an integrator:

```json
{"schemaVersion":1,
 "defaultLocale":"en",
 "resumableDrafts":true,
 "participantPortal":{"enabled":true,"allowMessaging":true,
   "messagingCondition":{"fieldId":"participation","operator":"not_equals","value":"anonymous"}},
 "sections":[{"id":"about_you","title":"About you","fields":[
   {"id":"participation","type":"select","label":"How do you want to take part?","required":true,
    "options":[{"value":"anonymous","label":"Anonymously"},{"value":"pseudonymous","label":"With a pseudonym"},{"value":"named","label":"With my name"}]},
   {"id":"preferred_name","type":"short_text","label":"Name or pseudonym","required":false,
    "condition":{"fieldId":"participation","operator":"not_equals","value":"anonymous"},
    "protection":{"compartment":"identity","revealPolicy":"dual_control"}},
   {"id":"supporting_files","type":"file","label":"Files (optional)","maxFiles":3,
    "acceptedMimeTypes":["application/pdf"],
    "publicUpload":{"documentTypeKey":"supporting_material","visibility":"internal"}}]}],
 "translations":{"es":{"name":"Hacer un informe","intro":"...","submitLabel":"Enviar informe",
   "direction":"ltr",
   "sections":{"about_you":{"title":"Sobre usted"}},
   "fields":{"participation":{"label":"¿Cómo quiere participar?","options":{"anonymous":"De forma anónima"}}},
   "ui":{"saveDraft":"Guardar y continuar más tarde"}}}}
```

- Locales are data: any BCP 47 tag may appear under `translations`. Missing
  text falls back to the default-locale text. `ui` overrides the renderer's
  interface strings; keys are listed in `src/modules/forms/form-ui-strings.ts`.
- A field with `protection` is removed from the ordinary answers and stored in
  a separately encrypted compartment.
- Identity is never required by the engine: whether a form asks for a name is
  entirely the form's choice. The public form needs no account and no payment.

Public form URL for participants: `{APP_BASE_URL}/intake/{organizationSlug}/{formSlug}?lang=<locale>`.

### 4.4 Submissions and the original account

`POST {B}/submissions` [`submission:create`] — create a submission on behalf of
a participant (same validation as the public form; `channel` becomes `api`).

```json
// request (Idempotency-Key recommended)
{"formSlug":"report","locale":"es",
 "answers":{"participation":"pseudonymous","preferred_name":"River","narrative":"Something happened at the depot."}}
// 201
{"data":{"id":"0b6e5de7-...","status":"submitted","confirmationCode":"SCW-2A0E33F54782E872",
 "submittedAt":"2026-11-10T05:44:01.926Z","originalSha256":"a2219b89...",
 "participantAccessSecret":"7H9vHKzY-...","participantPortalPath":"/participant/example-office"}}
```

`participantAccessSecret` is present only when the form enables the participant
portal. It is returned once and is not stored: give it to the participant
together with `confirmationCode`. Files cannot be attached through this
endpoint (see section 10).

`GET {B}/submissions?status=&formId=&limit=&offset=` [`submission:view`] — list.

`GET {B}/submissions/{submissionId}` [`submission:view`] — the original account.

```json
{"data":{"id":"0b6e5de7-...","status":"submitted","channel":"api","locale":"es",
 "confirmationCode":"SCW-2A0E33F54782E872","submittedAt":"2026-11-10T05:44:01.926Z",
 "form":{"id":"a8e2ad34-...","slug":"report","name":"Make a report","versionId":"6524785d-...","versionNumber":1,
   "fields":[{"id":"participation","type":"select","label":"How do you want to take part?","protected":false},
             {"id":"preferred_name","type":"short_text","label":"Name or pseudonym","protected":true}]},
 "originalAccount":{"answers":{"narrative":"Something happened at the depot.","participation":"pseudonymous"},
   "sha256":"a2219b89...","recordedSha256":"a2219b89...","digestMatchesRecord":true,
   "canonicalization":"json-sorted-keys-utf8","immutable":true},
 "protectedCompartments":[{"compartment":"identity","fieldIds":["preferred_name"]}],
 "attachmentCount":0,
 "case":null,
 "participantPortal":{"enabled":true,"credentialActive":true}}}
```

- `originalAccount.answers` never contains protected values, only the names of
  the protected fields under `protectedCompartments`.
- `sha256` = SHA-256 of the answers serialized as JSON with object keys sorted
  (`localeCompare`) at every level, no whitespace, UTF-8. `recordedSha256` was
  stored when the account was submitted.
- **Immutability**: a database trigger rejects any change to a submitted
  submission's answers, form version, status, submission time, confirmation
  code, locale, channel or digest, and rejects its deletion. Later analysis
  lives in separate records (case fields, notes, tags, reviews, referrals).
- Drafts are invisible to the API: an unsubmitted draft is `404`.

`GET {B}/submissions/{submissionId}/protected`
[`submission:view`, `submission:view_protected`] — decrypted protected fields.
Every call writes a `protected_data.service_read` audit event naming the
credential. Without the explicit scope the answer is `403`.

```json
{"data":{"submissionId":"0b6e5de7-...","compartments":[{"compartment":"identity","fieldIds":["preferred_name"],"values":{"preferred_name":"River"}}]}}
```

### 4.5 Attachments

`GET {B}/submissions/{submissionId}/attachments` [`submission:view`, `document:view`]

```json
{"data":[{"versionId":"5f0c...","documentId":"9a1d...","versionNumber":1,"filename":"statement.pdf",
 "mimeType":"application/pdf","sizeBytes":18233,"sha256":"3b7e...","visibility":"internal",
 "documentTypeKey":"supporting_material","contentStatus":"available","malwareScanStatus":"clean",
 "malwareScanProvider":"clamscan","malwareScannedAt":"2026-11-10T05:50:02.000Z","uploadedAt":"2026-11-10T05:49:58.000Z",
 "released":true,"contentPath":"/api/v1/documents/5f0c.../content",
 "formFieldId":"supporting_files","attachedAt":"2026-11-10T05:49:58.000Z"}]}
```

`contentStatus` is `quarantined` (not yet scanned, or the scan failed),
`available` (clean) or `blocked` (infected). `released` is true only for
`available` + `clean`; only then is `contentPath` set. Documents with
visibility `restricted` are listed and readable only with `document:view_private`.

`GET {B}/documents/{versionId}/content` [`document:view`] — raw bytes.
`200 application/octet-stream` with headers `X-Content-SHA256: <hex>`,
`Digest: sha-256=<base64>`, `X-Declared-Content-Type` (URL-encoded, as declared
by the uploader — untrusted), `X-Original-Filename` (URL-encoded),
`Content-Length`. The stored bytes are re-hashed before every download; a
mismatch fails the request. A quarantined or blocked version answers
`409 content_unavailable`. Each download writes a `document.downloaded` audit
event.

`GET {B}/documents/{versionId}` [`document:view`] — metadata (pre-existing).

`GET {B}/documents/{versionId}/custody` [`document:view`]

```json
{"data":{"document":{"versionId":"5f0c...","sha256":"3b7e...","released":true,"...":"as in the attachment list"},
 "custody":[{"id":"...","action":"public_upload_quarantined","fromCustodian":null,"toCustodian":"system","location":null,"note":null,"occurredAt":"2026-11-10T05:49:58.000Z"}]}}
```

`GET {B}/cases/{caseId}/documents` [`case:view`, `document:view`] — case evidence
(a clean intake attachment is promoted to case evidence automatically).

### 4.6 Cases: open, triage, assign, transition

`POST {B}/cases` [`case:create`, `submission:view`] — open a case from a
submission. Idempotent by submission: a second call returns the existing case
with `created: false` and status `200`.

```json
{"submissionId":"0b6e5de7-...","title":"optional title","priority":"normal","route":true}
// 201
{"data":{"created":true,"routing":"applied",
 "case":{"id":"e3e3c366-...","caseNumber":"2026-000001","sourceSubmissionId":"0b6e5de7-...",
  "title":"Make a report — SCW-2A0E33F54782E872","summary":null,"status":"state_a","statusLabel":"State A",
  "priority":"normal","disposition":null,"assignedQueueId":null,"assignedMembershipId":null,"escalationLevel":0,
  "openedAt":null,"resolvedAt":null,"closedAt":null,"updatedAt":"2026-11-10T05:44:23.080Z","tags":[],
  "availableTransitions":[{"key":"advance_a_to_b","label":"Advance A to B","to":"state_b"}]}}}
```

`priority`: `low | normal | high | critical` (anything else is `422 invalid_request`). `routing`: `applied` (routing rules
ran), `skipped` (`route: false` or the case already existed), `unavailable`
(a rule matched but its queue has no available member; the case stays
unassigned), `failed`.

`GET {B}/cases/{caseId}/status` [`case:view`] — the case projection shown above
(`data` is the `case` object). `GET {B}/cases/{caseId}` returns the full stored
record; `GET {B}/cases?q=&status=&priority=&queue=&assignee=&tag=&focus=&sort=&limit=&offset=`
searches.

`POST {B}/cases/{caseId}/triage` [`case:view`, `case:update`] — set triage
fields; omitted fields keep their value.

```json
{"priority":"high","tags":["depot"],"summary":"Triage summary","title":"...","disposition":null}
```

`POST {B}/cases/{caseId}/assignment` [`case:view`, `case:assign`]

```json
{"queueSlug":"example_queue","userId":"793a40f5-...","reason":"triage"}
```

Give `queueId` or `queueSlug`, and/or `membershipId` or `userId` (a user id
returned by `/identity/staff`). Response: the case projection.

`POST {B}/cases/{caseId}/transitions` [`case:view`, `case:update`] — status change.

```json
{"transitionKey":"advance_a_to_b","comment":"ok","disposition":null}
```

Response: the case projection. `409 transition_unavailable` (with
`details.available`) when the key does not leave the current status;
`422 transition_guard_failed` (with `details` listing failed guards such as
`missing_permission`, `comment_required`, `missing_document`) when workflow
guards reject it. The credential's own scopes are the actor's permissions for
guard evaluation, so a transition that requires `case:close` needs that scope.

### 4.7 Deadlines, referrals, reviews

`GET {B}/cases/{caseId}/deadlines` [`case:view`, `deadline:view`]

`POST {B}/cases/{caseId}/deadlines` [`case:view`, `deadline:operate`]

```json
// set an ad hoc deadline
{"operation":"create","label":"First response","dueAt":"2027-01-01T00:00:00Z","key":"first_response","description":null}
// extend an existing deadline
{"operation":"extend","deadlineId":"b3fd5b4e-...","reason":"awaiting records","extensionValue":5,"extensionUnit":"business_days"}
```

Workflow-defined deadlines start automatically on case creation and on
transitions; the worker marks warnings, overdue state and escalations and emits
`deadline.*` events.

`GET|POST {B}/cases/{caseId}/referrals` [`case:view`, `referral:view` | `referral:manage`]

```json
{"policyKey":"example_external_referral","recipientKey":"agency-7","recipientName":"Example Agency","externalReference":null,"subject":"Referral","summary":"..."}
```

`GET|POST {B}/cases/{caseId}/referrals/{referralId}` — `POST` body
`{"operation":"send|acknowledge|response|complete|cancel", ...}` (response
types `preliminary_response | status_update | final_response`).

`GET {B}/cases/{caseId}/reviews` [`case:view`, `review:view`] — reviews and
appeals. Filing and deciding a review is available in the staff UI only.

### 4.8 Analysis kept apart from the original account

`GET|POST {B}/cases/{caseId}/notes` [`case:view`, `note:view` | `note:create_internal`]

```json
{"body":"Internal assessment ..."}
// 201
{"data":{"id":"0c43d895-...","visibility":"internal","body":"Internal assessment ...","createdAt":"2026-11-10T05:44:23.297Z"}}
```

Notes created through the API are always `internal`; they are never visible
to participants.

### 4.9 Safe participant follow-up

`GET {B}/cases/{caseId}/participant-messages` [`case:view`, `correspondence:view`]

```json
{"data":{"messaging":{"portalEnabled":true,"allowMessaging":true,"reason":"allowed"},
 "messages":[{"id":"55731ef9-...","threadId":"8c4bc194-...","direction":"outbound","from":"organization",
  "subject":"Hello","body":"We received your report.","status":"sent","sentAt":"2026-11-10T05:44:23.272Z","receivedAt":null,"createdAt":"2026-11-10T05:44:23.263Z"}]}}
```

`POST {B}/cases/{caseId}/participant-messages` [`case:view`, `correspondence:manage`]

```json
{"subject":"Hello","body":"We received your report.","threadId":null}
// 201 → the message object above
```

The message is published only inside the participant's private follow-up page;
nothing is sent to an email address or phone. `409
participant_messaging_unavailable` with `details.reason` =
`no_participant_portal | portal_disabled | credential_unavailable | status_only`
when the participant chose a mode without messaging or has no credential.
Participant replies arrive as `participant.message.received` events; read
them with the `GET` above (`direction: "inbound"`).

### 4.10 Events

`GET {B}/events?after=<cursor>&limit=<1-500>&types=a,b` [`event:view`]
`POST {B}/events/ack` [`event:view`] body `{"cursor":"..."}`. See section 5.

### 4.11 Identity mapping

See section 7: `GET|POST {B}/identity/staff`, `POST {B}/submissions/{id}/identity`,
`GET {B}/identity/participants`.

### 4.12 Audit

`GET {B}/audit-events?action=&resourceType=&resourceId=&limit=&offset=` [`audit:view`].

## 5. Events

Every state change writes one immutable audit event in the same transaction.
The feed and the webhooks expose those events with one envelope:

```json
{"id":"7b1e...-uuid","cursor":"djEuMTg3MzcuMTQ","sequence":14,
 "type":"case.opened","action":"case.created","occurredAt":"2026-11-10T05:44:23.080Z",
 "resource":{"type":"case","id":"e3e3c366-...","parentType":"submission","parentId":"0b6e5de7-..."},
 "actor":{"type":"user"},"source":"application","correlationId":"...",
 "previousState":null,"newState":{"status":"state_a"},"metadata":{}}
```

`type` is the stable public name; `action` is the internal audit action.

| `type` | Meaning | `resource` → `parent` |
|---|---|---|
| `submission.created` | A submission was received (public form, draft finalised, or API). | submission → intake_form |
| `attachment.released` | Scan clean; bytes are now readable. `metadata`: `documentId, sha256, sizeBytes, mimeType, provider, submissionIds, caseIds`. | document_version → submission |
| `attachment.blocked` | Scan found malware; bytes will never be served. | document_version → submission |
| `attachment.scan_failed` | Scanner error after retries; still quarantined. | document_version → submission |
| `case.opened` | Case created from a submission. | case → submission |
| `case.transitioned` | Status change (`previousState.status`, `newState.status`). | case |
| `case.updated`, `case.assigned`, `case.routed`, `case.escalated` | Triage / assignment changes. | case |
| `deadline.started`, `deadline.warning_reached`, `deadline.overdue`, `deadline.extended`, `deadline.completed`, `deadline.paused`, `deadline.resumed`, `deadline.cancelled`, `deadline.escalation_applied` | Deadline lifecycle. | case_deadline → case |
| `referral.created`, `referral.sent`, `referral.acknowledged`, `referral.completed`, `referral.cancelled` | Referral lifecycle. | case_referral → case |
| `review.filed`, `review.assigned`, `review.started`, `review.decided`, `review.withdrawn` | Review lifecycle. | case_review → case |
| `participant.message.received` | The participant wrote in the follow-up page. | correspondence_message → case |
| `correspondence.sent` | A message to the participant was published. | correspondence_message → case |
| `note.created` | Internal note added (body is not in the event). | case_note → case |
| `participant_portal.credential_issued`, `participant_portal.authenticated`, `participant_portal.secret_rotated` | Participant access lifecycle. | credential → submission |
| `document.public_upload_quarantined`, `document.downloaded`, `document.attached_to_case` | Upload custody. | document_version |
| `protected_data.service_read`, `identity.staff_linked`, `identity.participant_linked`, `application.manifest_applied`, `api.client_created`, ... | Administrative. | — |

Events never contain answers, message bodies, note bodies, filenames,
protected values or secrets. Fetch content with the read endpoints.

### Polling feed

```
GET {B}/events?limit=100                 → first page (or from the acknowledged cursor)
GET {B}/events?after=<cursor>&limit=100  → events strictly after the cursor
```

```json
{"data":[{"id":"...","cursor":"djEu...","type":"submission.created","...":"..."}],
 "cursor":{"next":"djEuMTg3MzcuMTQ","hasMore":false}}
```

- Total order per tenant, no gaps: events are ordered by (transaction id,
  sequence) and an event is published to the feed only when every older
  database transaction has finished, so resuming from `cursor.next` can never
  skip a late-committing event. Consequence: an event becomes visible shortly
  after its transaction commits (normally milliseconds; delayed while any
  older transaction on the database server is still open).
- When the page is empty `cursor.next` equals the cursor you sent.
- `types` filters by public type or internal action.
- `POST {B}/events/ack {"cursor": "..."}` stores the position for this
  credential; a later `GET {B}/events` without `after` resumes there. Acking is
  optional: a consumer may keep its own cursor.
- Delivery is at-least-once across feed and webhooks: de-duplicate on `id`.

## 6. Webhooks

Register through the platform API (section 4.2) or `/admin/integrations`.
The worker delivers each matching event as an HTTP `POST`:

```
Content-Type: application/json
User-Agent: SICWE-Webhook/1.0
X-SICWE-Delivery:  <delivery uuid>         unique per (subscription, event)
X-SICWE-Event:     <public type>            e.g. case.opened
X-SICWE-Event-Id:  <event uuid>             same id as in the feed
X-SICWE-Timestamp: <unix seconds>           time of this attempt
X-SICWE-Signature: sha256=<hex>
```

Body:

```json
{"id":"<delivery uuid>","eventId":"<event uuid>","type":"case.opened","action":"case.created",
 "cursor":"djEu...","sequence":14,"occurredAt":"2026-11-10T05:44:23.080Z","organizationId":"2b377c6d-...",
 "resource":{"type":"case","id":"e3e3c366-...","parentType":"submission","parentId":"0b6e5de7-..."},
 "actor":{"type":"user"},"correlationId":"...","source":"application",
 "previousState":null,"newState":{"status":"state_a"},"metadata":{}}
```

Signature: `hex(HMAC_SHA256(signingSecret, X-SICWE-Timestamp + "." + rawBody))`
over the exact bytes received. Verification a receiver must do:

1. recompute the HMAC over `timestamp + "." + rawBody` and compare in constant time;
2. reject when `|now - X-SICWE-Timestamp| > 300` seconds (replay window);
3. remember `eventId` (or `X-SICWE-Delivery`) and treat a repeat as already
   processed — answer `2xx` without acting again.

```js
const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig.replace(/^sha256=/, "")));
```

Any `2xx` acknowledges. Anything else is retried by the worker up to 8
attempts with exponential backoff (5 s doubling, capped at 15 min); each
attempt is re-signed with a fresh timestamp and keeps the same delivery and
event ids. Redirects are not followed; the timeout is 10 s. After the last
failure the delivery is `failed` (visible in `/admin/integrations`); the event
stays in the feed, so a consumer that also polls loses nothing. Webhook
ordering is not guaranteed — use `sequence`/`cursor` or the feed for order.

## 7. Identity mapping

### 7.1 Trusting this engine from an identity service

An external identity service that verifies a managed connection calls
`GET /api/v1/capabilities` with the service credential and checks:
`data.schemaVersion === 1`, `data.apiVersion === "v1"`,
`data.engine.service === "secure-intake-case-workflow-engine"`,
`data.engine.version` ∈ its supported versions, `data.authentication.scheme ===
"bearer"`, `tenantSource === "api_client"`, and that `grantedScopes` contains
its required scopes. The response is `application/json`, under 64 KiB, never
redirects, and contains no tenant or client identifiers.

What the intake deployment must provide for that:

1. A reachable **HTTPS origin** with no path (`https://intake.example.org`).
   A verifier that insists on HTTPS cannot use the plain-HTTP local start; put
   a TLS terminator in front, or use the verifier's own transport override in
   local development.
2. One service credential for the tenant (`npm run api:create-client ... --json`).
   Register its **`fingerprint`** (SHA-256 hex of the token) with the identity
   service and store the token in that service's secret store. The token is
   62 characters, within the 32–512 range such verifiers accept.
3. `supportedVersions` on the identity side must include this engine's version
   string exactly (currently `1.0.0-rc.9`).
4. `requiredScopes` must be a subset of the scopes granted to the credential.
   Scope names are exactly the permission names in this document.
5. One credential = one tenant. Mint one credential per organization.

### 7.2 Staff identities (so that cases can be assigned)

`POST {B}/identity/staff` [`identity:manage`] — map an external identity
provider subject to a staff member of this tenant (idempotent).

```json
{"provider":"pam","subject":"user-1","displayName":"Case Worker","email":null,"roleKeys":["case_worker"],"teamSlugs":["example_team"]}
// 200
{"data":{"provider":"pam","subject":"user-1","userId":"793a40f5-...","membershipId":"1d29fa6b-...","membershipStatus":"active","roleKeys":["case_worker"],"teamSlugs":["example_team"]}}
```

`provider`: lowercase identifier (`^[a-z0-9][a-z0-9_.:-]{0,99}$`); `subject`:
1–255 chars. `roleKeys` are this tenant's role keys (`supervisor`,
`case_worker`, `intake_reviewer`, `reviewer`, `auditor`, or manifest-defined);
`administrator` cannot be granted through the API (`403 role_not_delegable`).
`teamSlugs` adds the member to existing teams: a case can be assigned to a
person inside a queue only when that person belongs to the queue's team
(otherwise `409 assignment_failed`). Roles and teams are only ever added by
this call. The created user has no password and cannot sign in locally. An `email`
already used by another account is `409 email_in_use` (an external subject is
never bound to a pre-existing local account). Use `userId` with
`/cases/{id}/assignment`.

`GET {B}/identity/staff?provider=pam&subject=user-1` [`identity:manage`] — look up.

### 7.3 Participant identities

`POST {B}/submissions/{submissionId}/identity` [`identity:manage`] — record
that the participant behind a submission is external subject X (one subject
per provider per submission; re-posting replaces it).

```json
{"provider":"pam","subject":"participant-9"}
// 200
{"data":{"submissionId":"0b6e5de7-...","provider":"pam","subject":"participant-9","createdAt":"2026-11-10T05:44:23.366Z"}}
```

`GET {B}/identity/participants?provider=pam&subject=participant-9`
[`identity:manage`] → `{"data":[{"submissionId":"...","caseId":"...","createdAt":"..."}]}`.

The subject is never written to events or shown in the staff UI. Linking does
not sign the participant in to the follow-up page; that still needs the
tracking code and access secret.

## 8. Uploads: quarantine and release

1. A file uploaded with the public form is stored once (SHA-256 recorded),
   linked to the submission, with `contentStatus=quarantined`,
   `malwareScanStatus=pending`, a `public_upload_quarantined` custody event and a
   `document.scan` background job (same transaction as the submission).
2. The **worker** claims the job, re-reads the bytes, verifies the SHA-256 and
   calls the configured scanner.
3. Result: `clean` → `available` + `attachment.released` (and the file is
   promoted to case evidence when a case exists or is opened later);
   `infected` → `blocked` + `attachment.blocked`; scanner error → retried up
   to 5 attempts, then `attachment.scan_failed` and the file stays quarantined.
4. **No scanner configured** (`MALWARE_SCANNER_DRIVER` unset/`none` and no
   `MALWARE_SCANNER_URL`): the job fails and retries, the file stays
   `quarantined/pending` indefinitely and its bytes are never served. Nothing
   is ever assumed clean. Staff with `document:scan_manage` can record a scan
   result by hand on the case page of the staff UI.

Scanners: `clamscan` runs the local ClamAV binary against a private temporary
copy (`--database=$CLAMSCAN_DATABASE_DIR`; exit 0 clean, 1 infected, other =
failed — including a missing or empty signature database). `http` posts the
bytes to `MALWARE_SCANNER_URL` and expects `{"status":"clean|infected|failed"}`.

## 9. Participant surfaces

| URL | Purpose |
|---|---|
| `/intake/{org}/{form}?lang=xx` | Public form: language switcher, "Save and continue later", "Continue a saved draft". |
| `/participant/{org}` | Sign in with tracking code + access secret. |
| `/participant/{org}/portal` | Status, messages, replace access secret. |

- **Drafts**: saving returns a resume code (256-bit, shown once, only its hash
  is stored). Opening a draft with an unknown, used, malformed or other-form
  code gives one identical answer. Files and protected answers are not kept in
  drafts and are not returned on resume.
- **Recovery**: the tracking code plus access secret is the only way back in.
  Sign-in failures are identical whether or not the tracking code exists, use
  a constant-time comparison against a dummy hash and are throttled per code
  and per source. A signed-in participant can replace the secret (old secret
  and other sessions stop working). A lost secret cannot be recovered by
  staff, API clients or operators.
- **What a participant can see**: tracking code, submission time, case number,
  status label, status time, and portal-channel messages with visibility
  `participant` or `public`. Never: internal notes, staff names, assignment,
  priority, tags, summary, referrals, reviews, documents, other submissions.

## 10. Not implemented / not verified

- No binary upload through the service API (`POST /submissions` is answers
  only); files enter through the public form or the staff UI.
- Participant messages carry no attachments.
- Protected compartments cover structured fields, not files.
- Server-side validation messages other than "required" are English only.
- Filing/deciding reviews and creating teams/queues ad hoc have no service
  endpoint (use the manifest or the staff UI).
- Drafts and stored idempotency keys have no automatic expiry job; public
  draft creation is not rate limited beyond the deployment's edge controls.
- CI steps that install ClamAV and a browser for `npm run test:pg` were added
  but have not run on the hosted CI yet.
- Webhook delivery to a public HTTPS receiver and the HTTP malware-scanner
  adapter are implemented but were not exercised against a live third party;
  S3 storage likewise. ClamAV was exercised with a locally created signature
  database, not the official signature set.
- The identity service's HTTPS-only verifier was not run against this app over
  TLS; the capability document it reads is covered by tests.
