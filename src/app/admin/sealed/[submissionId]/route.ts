import { getRuntimeDatabase } from "@/db/runtime";
import { auditEvents } from "@/db/schema";
import { auditEventValues } from "@/modules/audit/event";
import {
  hasPermission,
  requireTenantScope,
} from "@/modules/auth/authorization";
import { getCurrentAuthorizationContext } from "@/modules/auth/server-session";
import { findSealedEnvelope } from "@/modules/sealed/service";

const securityHeaders = {
  "Cache-Control": "no-store, private, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

function problem(code: string, status: number) {
  return new Response(JSON.stringify({ error: { code } }) + "\n", {
    status,
    headers: { ...securityHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Downloads a submission's sealed envelope: ciphertext only, to be opened in
 * PAM (Sealed sources) or with the offline sealed reader by a key holder.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ submissionId: string }> },
) {
  const context = await getCurrentAuthorizationContext();
  if (!context || !context.tenantScope) return problem("authentication_required", 401);
  if (!hasPermission(context, "submission:view")) return problem("permission_denied", 403);

  const { submissionId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)
  ) {
    return problem("invalid_submission_id", 400);
  }

  const db = getRuntimeDatabase();
  const scope = requireTenantScope(context);
  const sealed = await findSealedEnvelope(db, scope, submissionId);
  if (!sealed) return problem("not_found", 404);

  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: "user",
      actorUserId: context.user.id,
      action: "sealed_envelope.downloaded",
      resourceType: "submission",
      resourceId: submissionId,
      metadata: { commitment: sealed.commitment },
    }),
  );

  return new Response(sealed.envelopeJson, {
    status: 200,
    headers: {
      ...securityHeaders,
      "Content-Type": "application/vnd.pam.sealed+json",
      "Content-Disposition": `attachment; filename="sealed-${submissionId}.sealed.json"`,
    },
  });
}
