# Authenticated capability discovery

`GET /api/v1/capabilities` accepts the same bearer credential as the resource API and runs the existing authentication, organization, rate-limit and no-store response controls. It requires no additional scope so a valid client can discover its own supported operations.

The result contains engine build information, only the client's granted delegable scopes, and the implemented v1 method/path/permission inventory. An operation is marked available only when every required scope is present. No client names, client/organization identifiers, token, storage credentials, answers or record content are exposed.

Capability limits are explicit: offset pagination on list endpoints is not a stable snapshot (the event feed is cursor based and ordered); JSON `POST` operations honour `Idempotency-Key`; released (clean) document versions can be downloaded with their digest, quarantined or blocked ones cannot; there is no binary upload through the API. Protected structured intake fields do not establish protected binary storage. Consumers must not infer missing write, participant, attachment or protected-data APIs from permission names.

The source-bound test inventories authenticated route methods and scopes and checks the pagination boundary. The capability response describes source behavior; it is not evidence that a deployed instance is ready, scanned, independently audited or certified.
