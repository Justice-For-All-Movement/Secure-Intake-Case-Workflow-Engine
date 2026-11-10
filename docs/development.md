# Development

## Prerequisites
- Node.js 22+
- Docker with Compose, or a local PostgreSQL (see `npm run start:local` in
  [PAM_INTEGRATION.md](PAM_INTEGRATION.md#1-local-start) for the non-Docker path)

## Local setup

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:migrate
npm run dev
```

Open http://localhost:3000. Health check: http://localhost:3000/api/health.

## Bootstrap the first administrator

Set these environment variables locally:

```bash
export BOOTSTRAP_ADMIN_EMAIL="admin@example.gov"
export BOOTSTRAP_ADMIN_PASSWORD="use-a-long-unique-password"
export BOOTSTRAP_ORGANIZATION_NAME="Example Office"
export BOOTSTRAP_ORGANIZATION_SLUG="example-office"
```

Then run:

```bash
npm run auth:bootstrap
```

The bootstrap operation creates or reuses the organization and user, stores a bcrypt password hash, initializes the default organization roles, and assigns the administrator role. It is idempotent for the same organization/user.

## Database changes

Update `src/db/schema.ts`, then generate and review a migration:

```bash
npm run db:generate
npm run db:migrate
```

Tenant-owned tables must carry an explicit `organization_id` and application queries must obtain that value from a trusted server-side tenant scope.

## Authentication model

The session cookie contains an opaque random token. Only a SHA-256 hash of that token is stored in the database. Local passwords are bcrypt-hashed. External SSO/OIDC identities can later bind through the `auth_identities` table without changing the authorization model.

Identity alone does not establish tenant access:

```text
authenticated user
  -> active organization membership
  -> trusted tenant scope
  -> assigned roles
  -> permissions
```

## Form definitions

Intake forms are stored as versioned JSON definitions. The first implementation supports sections, common field types, validation rules, conditional visibility, attestations, and attachment references.

Use the protected `/admin/forms` screen to create a form and draft definition. Publishing a draft makes it the active public/authenticated version and supersedes the prior published version without altering historical submissions.

Public forms are rendered at:

```text
/intake/<organization-slug>/<form-slug>
```

The document/evidence subsystem supports immutable submission-linked files. The generic anonymous browser renderer still does not enable binary upload by default; deployments may connect a vetted public-upload transport to the submission attachment service.

## Case lifecycle

Staff with case access can work from the protected case console:

```text
/admin/cases
```

Submitted intake appears in the review queue for users with both `submission:view` and `case:create`. Starting review allocates a tenant/year case number and creates an `intake_review` case linked to the immutable source submission.

New cases use a versioned workflow definition. If an intake form is not bound to a custom workflow, the built-in default workflow is snapshotted into the case. If a form is bound, the currently published workflow version is snapshotted and its version ID is retained.

Manage workflows at:

```text
/admin/workflows
```

Workflow definitions support named states, keyed transitions, required permissions, required/forbidden comments, required case fields, required submission fields, required document types/counts, and safe automatic case actions.

Existing installations should synchronize newly introduced default-role permissions after migration:

```bash
npm run auth:sync-roles
```

Document guards are enforced from trusted case evidence. Only active case-linked versions that are scan-clean, available, and carry valid SHA-256 metadata count toward required-document guards.

## Assignment and routing

Operational routing is configured at:

```text
/admin/routing
```

The model separates offices, teams, queues, and individual assignments. Routing rules are evaluated in ascending priority order and the first active match wins.

Supported queue strategies:

- `manual`: assign the queue only;
- `round_robin`: select the next active, available member of the queue's team.

Creating a case immediately invokes routing. If no rule matches, the case remains unassigned. If routing fails because the target configuration is unavailable, the case remains durable and staff can correct or manually assign it.

Users with `case:assign` can manually reassign and escalate cases from the case detail page. Escalations may change queue and priority, increment the escalation level, and are recorded in assignment history.

Existing installations should synchronize the new routing permissions:

```bash
npm run auth:sync-roles
```

## Documents and evidence

Configure document storage:

```env
DOCUMENT_STORAGE_DRIVER=local
DOCUMENT_STORAGE_ROOT=.data/documents
DOCUMENT_MAX_BYTES=26214400
```

The bundled local adapter writes immutable content beneath the configured root. Use a persistent volume if this adapter is used outside local development; production object storage should implement the same `DocumentStorageAdapter` contract.

Manage stable document types at:

```text
/admin/documents
```

Case staff can upload evidence from the case detail page. Every upload starts quarantined with a pending malware-scan status. The engine intentionally has no implicit scanner that calls unknown content clean.

Authorized staff with `document:scan_manage` can record a trusted external scanner result. Only exact versions that are `available` and scan `clean` can be downloaded or satisfy workflow required-document guards.

Downloads recompute SHA-256 against the stored bytes and fail on mismatch. Custody events and access/download events are retained per immutable version.

Existing installations should synchronize the new document permissions:

```bash
npm run auth:sync-roles
```

## Immutable audit log

Material operational events are projected into the tenant-scoped append-only audit stream and can be reviewed at:

```text
/admin/audit
```

The audit viewer requires `audit:view`.

The database migration installs a trigger that rejects `UPDATE` and `DELETE` against `audit_events`. Feature-specific histories such as case status, assignment history, document custody, and document access remain in place; the audit stream provides one uniform oversight envelope across them.

Audit state is intentionally data-minimized. Do not place passwords, session/resume tokens, binary document content, malware samples, full intake answers, or other secret material in audit metadata. Use resource identifiers, statuses, hashes, version numbers, and bounded operational deltas instead.

Where the domain operation is already transactional, its audit insert occurs in the same transaction so a failed audit write rolls back the state mutation.

## Deadlines and statutory clocks

Workflow definitions may include versioned `deadlinePolicies`. A policy can start at case creation or on a named transition, use hours/calendar/business days, issue a warning before due time, permit manual pause/resume, complete on named transitions, and configure overdue escalation.

Example:

```json
{
  "key": "initial-review",
  "label": "Initial review deadline",
  "trigger": { "type": "case_created" },
  "duration": { "value": 30, "unit": "calendar_days" },
  "warningBefore": { "value": 5, "unit": "calendar_days" },
  "pausable": false,
  "completeOnTransitions": ["accept_intake", "reject_intake"],
  "escalation": { "priority": "high", "queueSlug": "supervisory-review" }
}
```

Business-day policies require `calendarKey`. Calendars are configured at:

```text
/admin/deadlines
```

Each calendar explicitly defines its IANA timezone, weekend weekdays, and excluded local dates. The engine does not assume which holidays or closures count for a deployment.

The dashboard also shows all instantiated case clocks and their warning, overdue, and escalation state.

Authorized case staff may pause, resume, complete, or cancel eligible clocks from the case detail page. Pause/resume requires a reason and is retained in deadline history and immutable audit.

Time-dependent evaluation is performed by the reusable sweep:

```bash
npm run deadline:sweep
```

The sweep processes all active organizations, issues warnings, marks clocks overdue, and applies configured priority/queue escalation through the existing case escalation service. A protected manual sweep control is also available at `/admin/deadlines`.

PR 12 provides a durable scheduler and worker for this sweep. The built-in `deadline-sweep` schedule invokes the same service on the cadence configured by `BACKGROUND_DEADLINE_SWEEP_SECONDS`.

Existing installations should synchronize the new deadline permissions:

```bash
npm run auth:sync-roles
```

## Notes, correspondence, and communication

Case detail pages now support notes and threaded correspondence.

Communication visibility is explicit:

```text
internal
case_participants
public
```

Case access does not automatically grant note/correspondence access. Default roles can be synchronized after migration with:

```bash
npm run auth:sync-roles
```

Organization communication templates and the outbound queue are available at:

```text
/admin/communications
```

Templates support only these deterministic placeholders:

```text
{{case_number}}
{{case_title}}
{{case_status}}
{{case_type}}
```

Outbound correspondence follows:

```text
draft -> queued -> sent
                 -> failed -> queued
```

PR 11 provides the provider-neutral `CommunicationTransport` and `deliverQueuedCorrespondence` service boundary but does not hard-code a mail vendor. Transport adapters receive the message ID as an idempotency key. PR 12 background jobs can process/retry the same queued-message model.

Staff may also record a queued message as externally sent, supporting letters, external portals, or existing email systems.

Inbound messages can be manually recorded and linked to a prior message/thread. External message IDs are deduplicated within the organization.

Correspondence attachments must already be case-linked, immutable document versions that are scan-clean and available. Participant/public communications may only attach participant-visible documents.

Case notes may attach existing case documents. External-visible notes apply the same participant-safe document rule.

Immutable audit events deliberately record message status/metadata but do not duplicate message bodies, sender/recipient addresses, or attachment content.

The case detail page includes a unified timeline combining workflow status, assignments, deadline activity, document attachments, notes, and correspondence.

## Notifications and background jobs

PR 12 adds a PostgreSQL-backed durable queue with leases, retries, dead-letter state, attempt history, and recurring interval schedules.

Worker configuration:

```env
BACKGROUND_JOB_LEASE_SECONDS=60
BACKGROUND_JOB_POLL_MS=1000
BACKGROUND_JOB_BATCH_SIZE=10
BACKGROUND_DEADLINE_SWEEP_SECONDS=60
```

Synchronize built-in schedules:

```bash
npm run jobs:seed-schedules
```

Run one worker iteration:

```bash
npm run worker:once
```

Run the long-lived worker:

```bash
npm run worker
```

The bundled worker handles `deadline.sweep` and `review.sweep`. It does not claim external-delivery job types unless a deployment explicitly registers the relevant transport handler.

This is intentional. A missing email/webhook provider should leave those jobs visibly pending rather than falsely converting them into delivery failures.

Provider-enabled workers can extend the core registry with:

- `createNotificationDeliveryJobHandler(...)` for `notification.deliver`;
- `createCorrespondenceDeliveryJobHandler(...)` for `correspondence.deliver`.

Both delivery contracts use stable resource IDs as idempotency keys.

In-app notifications require no external provider and are available at:

```text
/notifications
```

Default delivery behavior:

- in-app: enabled;
- email: disabled;
- webhook: disabled.

Ordinary users may enable email only for their authenticated account address. Arbitrary email destinations and HTTPS webhooks require `notification:manage`.

The engine currently emits notifications for case assignment, routing assignment, escalation, deadline warnings, overdue deadlines, and terminal correspondence delivery failures.

The protected operations surface is:

```text
/admin/jobs
```

It shows recurring schedules, recent jobs, leases, retry/dead state, and—when authorized—notification-delivery state. Interactive controls are always restricted to the active organization, even though the standalone worker may process all organizations.

Queued correspondence now creates a durable `correspondence.deliver` job. Transient automatic delivery failures leave the message queued while the job retries; only the final attempt marks the correspondence failed. Staff may still record an external/manual send, and a later stale delivery job treats an already-sent message as an idempotent success.

Existing installations should synchronize the new notification/job permissions:

```bash
npm run auth:sync-roles
```

## Review, reconsideration, and appeals

Review policy administration and the organization review queue are available at:

```text
/admin/reviews
```

Review policies configure:

- hierarchy level;
- eligible current case states;
- optional filing windows;
- optional decision deadlines and warnings;
- optional business-day/calendar behavior;
- configurable outcome keys;
- reviewer-independence requirements;
- prerequisite lower-level review policies.

A policy with no prerequisites reviews the current case decision. A policy with prerequisites requires a decided parent review under one of those prerequisite policies.

No default review policy is installed. A downstream application must explicitly configure the review rights and hierarchy granted by its governing authority.

Each filing stores an immutable snapshot of both the review policy and the challenged decision. Later policy edits or case changes do not rewrite what was actually under review.

Review lifecycle:

```text
filed -> assigned -> under_review -> decided
   \-> withdrawn
assigned/under_review -> withdrawn
```

The assigned reviewer must issue a written decision. Outcome keys are validated against the filed policy snapshot but otherwise remain semantically configurable.

When reviewer independence is required, the assigned reviewer cannot be the filer or the user responsible for the challenged decision.

Decision clocks are swept by the core background worker through:

```text
review-sweep -> review.sweep
```

The review sweep uses the existing background-worker cadence and emits warning/overdue notifications to the assigned reviewer without duplicating events under concurrent workers.

A decided review does not silently alter the original case. Authorized staff can explicitly apply it to a declared workflow state from the case page. This operation records the review effect, case status history, and immutable audit event while preserving the challenged decision snapshot.

The engine intentionally does not infer that a particular configurable outcome key must reopen a case, nor does it infer which statutory workflow deadlines restart after review. Downstream workflow configuration remains authoritative for those substantive effects.

Permissions introduced by this milestone:

```text
review:view
review:file
review:assign
review:decide
review:manage
```

For compatibility, legacy `case:appeal` permission also authorizes filing. New configurations should use `review:file`.

Existing installations should synchronize default roles:

```bash
npm run auth:sync-roles
```

## Public/private separation, redaction, and disclosure publication

The canonical stored classifications are:

```text
public
participant
internal
restricted
```

The legacy communication value `case_participants` is migrated to `participant`. Parsers remain backward compatible for imported historical communication data.

Classification and publication are deliberately separate. Marking a source record or derivative `public` does not make it anonymously accessible.

Disclosure operations are available at:

```text
/admin/disclosures
```

Permissions:

```text
disclosure:view
disclosure:prepare
disclosure:review
disclosure:publish
```

Preparing a release also requires ordinary permission to view the source record. `disclosure:prepare` never grants access to a case, submission, note, correspondence, review, or restricted document by itself.

A publication is a stable slug plus immutable content revisions:

```text
draft -> submitted -> approved -> published -> superseded
                   \-> rejected
```

The reviewer must be a different user from the preparer.

A currently published revision stays live while a replacement is drafted/reviewed. Publishing the replacement supersedes the old revision atomically.

Corrections never edit released content in place. A database trigger makes public title, summary, public JSON, redaction summary, preparer, publication identity, and version number immutable.

Public JSON is structurally bounded and has an object root. Human disclosure review remains responsible for determining whether the material is actually lawful and appropriate to release.

Redacted files are separate document derivatives. The source document is never overwritten. A derivative records its exact source version, output version, audience, redaction summary, creator, and hash-backed storage metadata.

Public derivatives must be scan-clean and available before a disclosure revision can be approved or published.

The public route is:

```text
/public/disclosures/<organization-slug>/<publication-slug>
```

Anonymous reads begin from a publication whose status is `published` and a version whose status is `published`. They never query a case, submission, note, review, correspondence, or arbitrary document version directly.

Withdrawing a publication removes anonymous access immediately; publication-scoped document responses use `Cache-Control: no-store`.

Existing installations should run the migration and synchronize default roles:

```bash
npm run db:migrate
npm run auth:sync-roles
```


## Protected form compartments

A form field may declare:

```json
{
  "id": "protected_value",
  "type": "short_text",
  "label": "Protected value",
  "protection": {
    "compartment": "identity",
    "revealPolicy": "dual_control"
  }
}
```

Protected fields are validated with the rest of the form, then removed from the ordinary `intake_submissions.answers` JSON before any draft or final submission is written. Values are grouped by compartment key and encrypted in `submission_protected_compartments`.

Configure a 32-byte AES key as 64 hexadecimal characters before accepting a form that uses protected fields:

```env
PROTECTED_DATA_ENCRYPTION_KEY=<64 hex characters>
```

The key is optional for deployments whose forms contain no protected fields. A protected-form submission fails rather than falling back to plaintext if the key is absent.

Encryption uses AES-256-GCM. The organization ID, submission ID, and compartment key are authenticated as additional data so ciphertext cannot be moved between tenants, submissions, or compartments and still decrypt successfully.

Protected field names may be listed as metadata, but protected values are not displayed in the normal case page or copied into audit events.

Permissions:

```text
protected_data:view_metadata
protected_data:request_reveal
protected_data:approve_reveal
```

Reveal lifecycle:

```text
request -> approved -> one-time consumed
        \-> rejected
```

The requester cannot decide their own request. Approval is valid for 15 minutes. Only the original requester may consume it, and the database update makes the reveal one-time under concurrency.

The case console exposes request/decision controls. The plaintext reveal is served only from a same-origin-checked POST endpoint with `Cache-Control: no-store`; it is never embedded in the ordinary case page.

Protected file fields are deliberately rejected. Binary evidence requires a separate protected-document storage design rather than hiding a document reference while leaving the underlying file under ordinary document authorization.

A protected field may control conditional visibility only for another field in the same protected compartment. This avoids persisting an ordinary answer whose presence itself leaks a protected value.

Existing installations should run:

```bash
npm run db:migrate
npm run auth:sync-roles
```


## External participant portal

A published form can opt into a protected external-participant portal:

```json
{
  "schemaVersion": 1,
  "participantPortal": {
    "enabled": true,
    "allowMessaging": true
  },
  "sections": []
}
```

The `sections` example above is abbreviated; normal form validation still requires at least one section and field.

When a portal-enabled form is finalized, the engine issues:

- the normal confirmation/tracking code, which is **not** a secret; and
- an independent 256-bit access secret.

The access secret is shown only in the immediate successful form action state. It is not placed in a query string, redirect, confirmation URL, database column, or audit event. PostgreSQL stores only its SHA-256 hash.

Participant login is available at:

```text
/participant/<organization-slug>
```

Login requires both the tracking code and access secret. Successful authentication creates a separate participant session token whose raw value is stored only in an HttpOnly, SameSite=Strict browser cookie; PostgreSQL stores only the session-token hash.

Session defaults:

```env
PARTICIPANT_SESSION_COOKIE_NAME=sicwe_participant_session
PARTICIPANT_SESSION_TTL_HOURS=8
```

Participant login uses the existing persistent login-throttle table with a distinct participant credential bucket. Source-IP throttling is used only when `AUTH_TRUST_PROXY_HEADERS=true` behind a trusted proxy, following the same trust rule as staff login.

The portal deliberately exposes a bounded view:

- tracking code;
- submitted timestamp;
- case number, once a case exists;
- the human workflow-state label;
- case updated timestamp;
- sent/received portal correspondence with `participant` or `public` visibility.

It does **not** expose submission answers, protected compartments, case title/summary, assignments, deadlines, notes, reviews, audit events, internal correspondence, or arbitrary documents.

Portal messages reuse the existing correspondence subsystem:

```text
staff portal draft -> publish -> sent
participant reply   -> received
```

Portal publication does not use an email/letter delivery transport or background delivery job.

Portal messages cannot use `internal` visibility. Attachments are intentionally rejected until a participant-safe document delivery/download contract exists.

Participant pages are explicitly `private, no-store` and carry `noindex` metadata.

The current credential is intentionally a one-submission external credential, not a general user account. Account-based external identity, credential recovery, participant document downloads, and public uploads are separate capabilities.

## Verification

```bash
npm run typecheck
npm run test
npm run build
```

## Pull request rule
Each milestone is delivered through a focused pull request. Core abstractions must remain reusable and must not encode one bill's terminology or workflow.


## Integration API and webhooks

PR 16 adds the versioned integration API at:

```text
/api/v1
```

OpenAPI documentation:

```text
/api/v1/openapi
```

Manage credentials and webhook subscriptions at:

```text
/admin/integrations
```

Existing installations should run:

```bash
npm run db:migrate
npm run auth:sync-roles
```

The new human-session permissions are:

```text
api:manage
webhook:manage
```

API credentials are shown once when created and should be stored in a secrets manager.

To enable webhook subscription creation and delivery, configure a 32-byte AES key as 64 hexadecimal characters:

```bash
WEBHOOK_ENCRYPTION_KEY=<64 hex characters>
```

Webhook deliveries are processed by the normal worker:

```bash
npm run worker
```

Webhook receivers verify:

```text
HMAC-SHA256(secret, "<X-SICWE-Timestamp>.<raw request body>")
```

against the hexadecimal value in `X-SICWE-Signature`.


## Declarative thin applications

PR 17 adds the portable application-manifest layer.

A thin downstream project can keep its domain policy in a JSON manifest rather than forking engine behavior. A complete example is available at:

```text
examples/application-manifest.example.json
```

Validate a manifest without a database:

```bash
npm run app:manifest -- \
  --file ./examples/application-manifest.example.json \
  --validate-only
```

Apply it to an organization:

```bash
npm run app:manifest -- \
  --file ./examples/application-manifest.example.json \
  --organization example-office \
  --actor-email admin@example.gov
```

The actor must be an active member of the target organization with:

```text
application:manage
```

The administration surface is:

```text
/admin/application
```

Existing installations should run:

```bash
npm run db:migrate
npm run auth:sync-roles
```

The portable manifest may configure:

- application name, short name, description, logo/accent, and public copy;
- singular/plural terminology overrides;
- application-specific roles using core permissions;
- document types;
- deadline calendars;
- routing teams and queues;
- communication templates;
- workflows, transition guards/actions, and deadline policies;
- intake forms and workflow bindings;
- routing rules;
- review policies and prerequisite hierarchy.

The apply operation is intentionally non-destructive. It creates or updates declared manifest-owned resources but does not delete resources omitted from later manifests.

If a stable key already exists but was not previously manifest-managed, reconciliation fails instead of taking that resource over.

Forms and workflows keep immutable version histories. A changed definition creates a new published version; an unchanged definition does not.

Staff membership in routing teams is deliberately not portable. A bill/application package can define the team and queue, while each deployment assigns its own people.

Do not place secrets in application manifests. API keys, webhook signing secrets, provider credentials, object-storage credentials, or sensitive operational data belong in deployment configuration.

The generic case type created from an intake is the intake form slug, so stable form slugs also provide portable routing keys without introducing a second case-type registry.


## Security hardening baseline

PR 18 adds a reusable application-layer hardening baseline.

### Canonical public origin

Set the exact public origin:

```env
APP_BASE_URL=https://casework.example.gov
```

It must be an HTTP(S) origin only: no credentials, path, query string, or
fragment.

Cookie-authenticated custom POST routes compare browser `Origin`/`Referer`
against this value. An incorrect production value can therefore cause secure
mutations such as document upload or API-key creation to be rejected.

### Login throttling

Defaults:

```env
AUTH_LOGIN_FAILURE_LIMIT=5
AUTH_LOGIN_WINDOW_MINUTES=15
AUTH_LOGIN_BLOCK_MINUTES=15
AUTH_TRUST_PROXY_HEADERS=false
```

The account bucket is always enabled and is stored only as a SHA-256 identifier.

Enable proxy source buckets only when the application is behind a trusted proxy
that overwrites (rather than merely appends attacker-controlled values to)
`X-Real-IP`/`X-Forwarded-For`:

```env
AUTH_TRUST_PROXY_HEADERS=true
```

Do not enable this setting on a directly reachable application server.

Run the migration before deploying:

```bash
npm run db:migrate
```

### Session cookies

Browser sessions use `HttpOnly`, `SameSite=Strict`, production `Secure`,
root path scope, and high priority.

HTTPS-only deployments may choose:

```env
AUTH_SESSION_COOKIE_NAME=__Host-sicwe_session
```

The engine never stores the raw session token in PostgreSQL.

### Password bounds

Local passwords must be at least 12 characters and at most 72 UTF-8 bytes.

The upper bound avoids relying on bcrypt truncation. Unknown accounts still
perform bcrypt work so the common login path does not expose an obvious
user-existence timing distinction.

### Browser headers and caching

The Next.js configuration emits a baseline CSP plus clickjacking, MIME sniffing,
referrer, browser-feature, opener/resource, and cross-domain-policy headers.

Production builds also emit HSTS.

Administrative pages are explicitly `private, no-store`. Authenticated REST
API responses are also non-cacheable.

The baseline CSP permits inline framework script/style execution for Next.js
compatibility. A deployment may impose a stricter nonce/hash CSP after testing
it against its exact frontend build.

### Webhook network boundary

Webhook destinations are validated at creation and again before delivery.

Private/non-public IPv4 and IPv6 targets, IPv4-mapped private IPv6 addresses,
6to4, Teredo, documentation, benchmarking, and similar special ranges are
rejected.

Application checks do not eliminate DNS-rebinding TOCTOU risk. Production
deployments should block internal/private/metadata networks at the egress
firewall as a second independent control.

### Dependency and container baseline

CI now rejects high/critical runtime dependency advisories:

```bash
npm audit --omit=dev --audit-level=high
```

The production Docker image runs as an unprivileged `nextjs` user and disables
framework telemetry.

See `SECURITY.md` and
`docs/architecture/0021-security-hardening-baseline.md` for the full trust
model and residual deployment responsibilities.


## Accessibility and public-sector usability

PR 19 establishes the shared accessibility/usability baseline inherited by thin
applications.

### Keyboard and screen-reader behavior

The root layout includes a keyboard-visible "Skip to main content" link and a
focusable content target.

Global focus styles use `:focus-visible` and must not be removed by downstream
themes without replacing them with an equally visible indicator.

Public intake fields use explicit labels and associate help/error text with
controls through `aria-describedby`. Server-side validation returns a
field-linked error summary and moves focus to that summary so a keyboard or
screen-reader user does not need to discover errors by scanning the entire
form.

Invalid controls use `aria-invalid`. Required fields are communicated in text
as well as visually.

### Public intake language

Generic public intake avoids internal implementation language in the primary
flow. Form-version metadata remains available under expandable "Form
information" details instead of appearing as a primary instruction.

When a thin app supplies separate branded home copy, the page retains one
primary `h1`; the form title is nested below it.

### Responsive presentation

The shared stylesheet provides:

- readable line lengths and spacing;
- controls sized for pointer/touch use;
- horizontal table scrolling on narrow screens;
- single-column definition lists on small screens;
- preserved keyboard focus visibility;
- reduced-motion behavior for users who request it.

Thin apps may customize appearance, but should preserve the semantic HTML and
interaction behavior.

### Print behavior

Case detail pages expose a "Print case summary" action. Print CSS removes
navigation/forms/actions and avoids splitting major sections where practical.

This is a convenience output, not a certified records-export format. Formal
records exports should continue using the engine's structured/export
capabilities.

### Automated accessibility regression gate

CI runs:

```bash
npm run test:a11y
```

The suite uses Axe against representative core surfaces and checks WCAG 2 A/AA
and WCAG 2.1 A/AA rules that can be evaluated reliably in the DOM test
environment.

Color-contrast automation is disabled in JSDOM because it has no layout/render
engine. Contrast must still be reviewed when changing the shared stylesheet or
thin-app branding.

Automated checks supplement rather than replace keyboard, screen-reader,
zoom/reflow, and human usability testing.


## Generic 1.0 release contract

PR 21 completes the upstream engine's release-candidate contract without
bundling any specific application.

The neutral fixture is:

```text
examples/application-manifest.example.json
```

It intentionally uses only generic identifiers such as:

```text
Example Application
example_form
example_workflow
state_a
example_queue
example_review
```

### Database-backed integration verification

CI starts PostgreSQL 16 and runs all migrations from an empty database:

```bash
npm run db:migrate
```

It then runs:

```bash
npm run test:integration
```

The integration contract proves:

- application-manifest reconciliation;
- identical-manifest idempotency;
- public intake;
- case creation;
- round-robin routing;
- workflow transitions;
- business-day deadline creation and completion;
- independent review;
- explicit review effect;
- final closure;
- form/workflow version increments after manifest changes;
- preservation of historical submission/form and case/workflow references;
- refusal to take ownership of unmanaged resource collisions.

The normal PR gate also verifies the release contract:

```bash
npm run verify:release-contract
```

### Distribution

The package version for this milestone is:

```text
1.0.0-rc.1
```

A Git tag whose version exactly matches `package.json` triggers the release
workflow. For example:

```text
v1.0.0-rc.1
```

The verified image is published as:

```text
ghcr.io/neophilism/secure-intake-case-workflow-engine:1.0.0-rc.1
```

Stable non-prerelease tags additionally receive `latest`.

Downstream applications should pin an explicit version or immutable digest and
keep their application manifest/configuration in their own repository.

See:

```text
docs/downstream-application-contract.md
docs/architecture/0023-generic-1.0-release-contract.md
```

### Release boundary

This repository owns reusable engine behavior and neutral contract fixtures
only.

Application-specific terminology, statutory policy, forms, workflows, routing,
deadlines, review policy, branding, and specialized code belong in downstream
repositories.

When downstream development exposes a reusable gap, implement the neutral
capability upstream, issue a new engine release, and update the downstream
repository to that release.
