# SI-38 scoped security review

This is a source review of form-answer handling and selected protected-data boundaries. It is not a full E2EESA inventory, independent review, provider test or conformance claim. The canonical status in `security/e2eesa-status.json` remains authoritative.

## Reviewed paths and trust boundaries

| Flow | Source checked | Boundary |
| --- | --- | --- |
| Browser form values into answer maps | `src/modules/forms/form-data.ts`, `visibility.ts`, `validation.ts` | Untrusted client values become validated submission data. |
| Form definitions and conditional fields | `src/modules/forms/definition.ts` | Authorized definitions choose field IDs and visibility conditions. |
| Protected field segregation | `src/modules/protected-data/answers.ts`, `crypto.ts` | Server separates selected answers and encrypts them with a server-held key. |
| One-time protected reveal | `src/modules/protected-data/service.ts`, `src/app/admin/protected/reveal/[requestId]/route.ts` | Authenticated, tenant-scoped, dual-control request reveals plaintext to an authorized operator. |

## Finding SI38-01: inherited answer keys

The identifier grammar permits `constructor` as a field ID. An empty ordinary JavaScript object inherits `constructor` from `Object.prototype`. Conditional visibility and field validation previously read `answers[field.id]` without checking ownership, so an omitted `constructor` answer could appear present and produce a spurious required-field or type error.

The fix checks `Object.prototype.hasOwnProperty.call` before these reads. The regression exercises browser `FormData` parsing through validation with an absent `constructor` field, then confirms that an explicitly submitted value still activates its condition. This preserves existing valid field IDs without changing stored definitions.

## Remaining E2EESA work

- Complete the application component and data-flow inventory, including authentication, public disclosure, S3 storage, scanner plaintext transfer, notifications, webhooks, keys, build artifacts and provider operations.
- Test tenant and role boundaries, key custody and rotation, backup restoration, endpoint egress controls, and real provider behavior against exact source and deployment identities.
- Keep implementation, automated testing and independent review statuses separate. Server-held AES-GCM and TLS do not establish end-to-end encryption of content from the submitter to recipients.
- Leave conformance and certification claims pending until the applicable standard's evidence and review requirements are met.

## Finding SI38-02: protected-payload envelope ambiguity

The v1 decoder previously destructured the first four dot-separated segments and used Node's permissive Base64 decoder. A valid ciphertext plus an extra segment or noncanonical/ignored Base64 characters could still decrypt. This does not establish an AES-GCM break, but permits multiple text representations of the same authenticated ciphertext and bypasses strict envelope validation. Oversized decoder input was also unbounded.

The decoder now accepts exactly four components, the existing v1 version, canonical unpadded Base64url, a 12-byte IV, a 16-byte tag, and at most 256 KiB ciphertext/plaintext. Length is checked before decoding allocation. Existing canonical ciphertext format and AAD context bytes remain unchanged. Decryption/authentication/UTF-8/JSON errors are categorical and never include decoded plaintext or provider diagnostics. This adds no key rotation, reveal permission, new encryption profile or E2EE claim.

Twelve focused cryptographic-envelope regressions cover randomized-IV round trip, organization/submission/compartment context substitution, appended segments, noncanonical trailing bits, IV/tag/ciphertext tampering, malformed components, exact size boundaries and sanitized malformed-plaintext errors. Seven cases failed against the prior implementation; all twelve pass after correction. The combined form/answer/envelope suite passes 37 tests under Node 22 and Vitest 3.2.7. This is scoped automated testing, not all six E2EESA gates, an independent review, deployed-provider evidence or certification. Full inventory and assessment remain pending.

## Finding SI38-03: webhook secret envelope parsing

The webhook secret decoder had the same permissive segment/Base64 behavior. It now requires four canonical v1 components with exact IV/tag lengths and bounds ciphertext before allocation. Authenticated plaintext must remain within the existing 32–256 character secret contract; the conservative 1024-byte decode bound preserves UTF-8 secrets. Errors are categorical. Separate webhook and protected-payload keys, existing ciphertext format, signature construction and authorization remain unchanged.

The combined source suite now passes 45 tests across six files, including eight webhook crypto tests covering existing HMAC behavior, randomized-IV round trips (ASCII and Unicode), alternate encodings, extra segments and tampering. Local TypeScript checking passes. Full CI, upstream scoped assessment, deployment and all six required security gates still require exact-source verification.

## Finding SI38-04: webhook failure diagnostic propagation

The webhook worker persisted arbitrary exception messages to its delivery record and rethrew them to the generic job ledger. It now records and throws only a categorical failure, optionally including the numeric HTTP status. Four isolated worker scenarios exercise pending/final attempts with both thrown transport errors and HTTP 503; private fixture diagnostics never reach persisted state or the propagated error. Retry/final status and authorization checks are preserved. The 45 form/answer/crypto cases plus these four worker cases pass locally; full current-head CI remains separate.

[Source-bound flow discovery](SI-38_COMPONENT_FLOW_DISCOVERY.md) remains partial. In particular, DNS address binding and remaining provider/platform integration are unfinished engineering work; no production egress guarantee or E2EESA completion is asserted.
