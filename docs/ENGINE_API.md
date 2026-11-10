# Engine API

This engine is a Next.js + Drizzle + PostgreSQL application, not a
`createEngine` library; its public surface is HTTP.

- **Service API, event feed, webhooks, identity mapping, local start, env
  vars, limits and what is not implemented**: [PAM_INTEGRATION.md](PAM_INTEGRATION.md).
- Capability discovery: `GET /api/v1/capabilities` ([api-capabilities.md](api-capabilities.md)).
- Configuration contract (manifest): [downstream-application-contract.md](downstream-application-contract.md).
