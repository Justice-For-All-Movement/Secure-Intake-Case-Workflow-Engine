import { engineBuildInfo } from "@/lib/build-info";
import { corePermissions } from "@/modules/auth/permissions";
import type { ApiAuthorizationContext } from "./auth";

// Inventory of the bearer API only. A delegable permission is not evidence
// that an HTTP operation exists. Keep this inventory bound to the route tests.
export const apiEndpoints = [
  { id: "capabilities", method: "GET", path: "/api/v1/capabilities", requiredScopes: [], pagination: "none" },
  { id: "cases.list", method: "GET", path: "/api/v1/cases", requiredScopes: ["case:view"], pagination: "offset" },
  { id: "cases.get", method: "GET", path: "/api/v1/cases/{caseId}", requiredScopes: ["case:view"], pagination: "none" },
  { id: "deadlines.list", method: "GET", path: "/api/v1/cases/{caseId}/deadlines", requiredScopes: ["case:view", "deadline:view"], pagination: "none" },
  { id: "deadlines.extend", method: "POST", path: "/api/v1/cases/{caseId}/deadlines", requiredScopes: ["case:view", "deadline:operate"], pagination: "none" },
  { id: "referrals.list", method: "GET", path: "/api/v1/cases/{caseId}/referrals", requiredScopes: ["case:view", "referral:view"], pagination: "none" },
  { id: "referrals.create", method: "POST", path: "/api/v1/cases/{caseId}/referrals", requiredScopes: ["case:view", "referral:manage"], pagination: "none" },
  { id: "referrals.get", method: "GET", path: "/api/v1/cases/{caseId}/referrals/{referralId}", requiredScopes: ["case:view", "referral:view"], pagination: "none" },
  { id: "referrals.operate", method: "POST", path: "/api/v1/cases/{caseId}/referrals/{referralId}", requiredScopes: ["case:view", "referral:manage"], pagination: "none" },
  { id: "reviews.list", method: "GET", path: "/api/v1/cases/{caseId}/reviews", requiredScopes: ["case:view", "review:view"], pagination: "none" },
  { id: "documents.list", method: "GET", path: "/api/v1/cases/{caseId}/documents", requiredScopes: ["case:view", "document:view"], pagination: "none" },
  { id: "documents.get", method: "GET", path: "/api/v1/documents/{versionId}", requiredScopes: ["document:view"], pagination: "none" },
  { id: "forms.list", method: "GET", path: "/api/v1/forms", requiredScopes: ["form:view"], pagination: "none" },
  { id: "submissions.list", method: "GET", path: "/api/v1/submissions", requiredScopes: ["submission:view"], pagination: "offset" },
  { id: "audit.list", method: "GET", path: "/api/v1/audit-events", requiredScopes: ["audit:view"], pagination: "offset" },
  { id: "cases.open", method: "POST", path: "/api/v1/cases", requiredScopes: ["case:create", "submission:view"], pagination: "none" },
  { id: "cases.status", method: "GET", path: "/api/v1/cases/{caseId}/status", requiredScopes: ["case:view"], pagination: "none" },
  { id: "cases.transition", method: "POST", path: "/api/v1/cases/{caseId}/transitions", requiredScopes: ["case:view", "case:update"], pagination: "none" },
  { id: "cases.triage", method: "POST", path: "/api/v1/cases/{caseId}/triage", requiredScopes: ["case:view", "case:update"], pagination: "none" },
  { id: "cases.assign", method: "POST", path: "/api/v1/cases/{caseId}/assignment", requiredScopes: ["case:view", "case:assign"], pagination: "none" },
  { id: "participant_messages.list", method: "GET", path: "/api/v1/cases/{caseId}/participant-messages", requiredScopes: ["case:view", "correspondence:view"], pagination: "none" },
  { id: "participant_messages.post", method: "POST", path: "/api/v1/cases/{caseId}/participant-messages", requiredScopes: ["case:view", "correspondence:manage"], pagination: "none" },
  { id: "notes.list", method: "GET", path: "/api/v1/cases/{caseId}/notes", requiredScopes: ["case:view", "note:view"], pagination: "none" },
  { id: "notes.create", method: "POST", path: "/api/v1/cases/{caseId}/notes", requiredScopes: ["case:view", "note:create_internal"], pagination: "none" },
  { id: "submissions.create", method: "POST", path: "/api/v1/submissions", requiredScopes: ["submission:create"], pagination: "none" },
  { id: "submissions.get", method: "GET", path: "/api/v1/submissions/{submissionId}", requiredScopes: ["submission:view"], pagination: "none" },
  { id: "submissions.protected", method: "GET", path: "/api/v1/submissions/{submissionId}/protected", requiredScopes: ["submission:view", "submission:view_protected"], pagination: "none" },
  { id: "submissions.attachments", method: "GET", path: "/api/v1/submissions/{submissionId}/attachments", requiredScopes: ["submission:view", "document:view"], pagination: "none" },
  { id: "submissions.identity", method: "POST", path: "/api/v1/submissions/{submissionId}/identity", requiredScopes: ["identity:manage"], pagination: "none" },
  { id: "documents.content", method: "GET", path: "/api/v1/documents/{versionId}/content", requiredScopes: ["document:view"], pagination: "none" },
  { id: "documents.custody", method: "GET", path: "/api/v1/documents/{versionId}/custody", requiredScopes: ["document:view"], pagination: "none" },
  { id: "events.list", method: "GET", path: "/api/v1/events", requiredScopes: ["event:view"], pagination: "cursor" },
  { id: "events.ack", method: "POST", path: "/api/v1/events/ack", requiredScopes: ["event:view"], pagination: "none" },
  { id: "identity.staff.get", method: "GET", path: "/api/v1/identity/staff", requiredScopes: ["identity:manage"], pagination: "none" },
  { id: "identity.staff.upsert", method: "POST", path: "/api/v1/identity/staff", requiredScopes: ["identity:manage"], pagination: "none" },
  { id: "identity.participants", method: "GET", path: "/api/v1/identity/participants", requiredScopes: ["identity:manage"], pagination: "none" },
  { id: "manifest.get", method: "GET", path: "/api/v1/application/manifest", requiredScopes: ["application:view"], pagination: "none" },
  { id: "manifest.apply", method: "POST", path: "/api/v1/application/manifest", requiredScopes: ["application:manage"], pagination: "none" },
] as const;

export function apiCapabilities(context: ApiAuthorizationContext) {
  // Never serialize the authorization context: it contains identifiers and
  // names that are unnecessary for feature negotiation.
  const grantedScopes = corePermissions.filter(
    (scope) => scope !== "api:manage" && scope !== "webhook:manage" && context.permissions.has(scope),
  ).sort();
  return {
    schemaVersion: 1,
    apiVersion: "v1",
    integrationContract: "2026-11-pam",
    engine: engineBuildInfo,
    authentication: { scheme: "bearer", tenantSource: "api_client", grantedScopes },
    endpoints: apiEndpoints.map((endpoint) => ({
      ...endpoint,
      requiredScopes: [...endpoint.requiredScopes],
      available: endpoint.requiredScopes.every((scope) => grantedScopes.includes(scope)),
    })),
    limits: {
      pagination: { mode: "offset", defaultLimit: 50, maxLimit: 100, maxOffset: 10000, cursor: false, stableSnapshot: false, nextOffsetMayExceedMax: true },
      requestIdempotency: true,
      idempotencyHeader: "Idempotency-Key",
      events: { feed: "/api/v1/events", cursor: true, ordered: true, webhookSignature: "hmac-sha256", maxLimit: 500 },
      requestIdHeader: false,
      caseSearch: {
        query: ["q", "status", "priority", "queue", "assignee", "tag", "focus", "sort", "limit", "offset"],
        focuses: ["all", "open", "unassigned", "overdue", "escalated", "open_review", "recently_closed"],
        sorts: ["updated_desc", "created_desc", "priority_desc"],
      },
      submissionQuery: ["status", "formId", "limit", "offset"],
      auditQuery: ["action", "resourceType", "resourceId", "limit", "offset"],
      deadlineOperations: ["extend", "create"],
      referralOperations: ["send", "acknowledge", "response", "complete", "cancel"],
      referralResponseTypes: ["preliminary_response", "status_update", "final_response"],
      attachments: {
        metadataOnly: false,
        binaryDownload: true,
        binaryDownloadRequires: { contentStatus: "available", malwareScanStatus: "clean" },
        binaryUpload: false,
        protectedBinary: false,
        restrictedMetadataScope: "document:view_private",
        trustedContent: { contentStatus: "available", malwareScanStatus: "clean", digest: "sha256" },
      },
    },
  } as const;
}
