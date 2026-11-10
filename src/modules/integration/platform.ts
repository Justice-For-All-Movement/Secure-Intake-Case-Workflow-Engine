import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { Database } from "@/db/client";
import { auditEvents, organizations } from "@/db/schema";
import { createTrustedTenantScope } from "@/lib/tenancy";
import { createApiClient } from "@/modules/api/auth";
import { auditEventValues } from "@/modules/audit/event";
import { ensureDefaultRoles } from "@/modules/auth/default-roles";
import { createWebhookSubscription } from "@/modules/webhooks/service";

const headers = { "Cache-Control": "private, no-store", Pragma: "no-cache" };

export function platformJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers });
}

/**
 * Deployment-level provisioning credential. Only the SHA-256 of the token is
 * configured (PLATFORM_API_TOKEN_SHA256). When unset the platform API does
 * not exist (404), so a default deployment exposes no provisioning surface.
 */
export function authorizePlatformRequest(
  request: Request,
): { ok: true } | { ok: false; response: NextResponse } {
  const configured = process.env.PLATFORM_API_TOKEN_SHA256?.trim().toLowerCase();
  if (!configured || !/^[a-f0-9]{64}$/.test(configured)) {
    return {
      ok: false,
      response: platformJson(
        { error: { code: "not_found", message: "Not found." } },
        404,
      ),
    };
  }
  const match = /^Bearer\s+(.+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  const token = match?.[1]?.trim() ?? "";
  const presented = createHash("sha256").update(token, "utf8").digest();
  if (
    token.length < 32 ||
    !timingSafeEqual(presented, Buffer.from(configured, "hex"))
  ) {
    return {
      ok: false,
      response: platformJson(
        {
          error: {
            code: "unauthorized",
            message: "Platform credential is not valid.",
          },
        },
        401,
      ),
    };
  }
  return { ok: true };
}

export async function ensureOrganization(
  db: Database,
  input: { slug: string; name: string },
) {
  const slug = input.slug.trim();
  const name = input.name.trim().slice(0, 200);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug) || !name) {
    throw new Error("slug (lowercase letters, digits, hyphens) and name are required.");
  }
  const [created] = await db
    .insert(organizations)
    .values({ slug, name })
    .onConflictDoNothing()
    .returning();
  const [organization] = created
    ? [created]
    : await db
        .select()
        .from(organizations)
        .where(eq(organizations.slug, slug))
        .limit(1);
  await ensureDefaultRoles(db, createTrustedTenantScope(organization.id));
  if (created) {
    await db.insert(auditEvents).values(
      auditEventValues({
        organizationId: organization.id,
        actorType: "system",
        action: "organization.provisioned",
        resourceType: "organization",
        resourceId: organization.id,
        source: "platform_api",
      }),
    );
  }
  return { organization, created: Boolean(created) };
}

export async function findOrganizationBySlug(db: Database, slug: string) {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  return organization?.status === "active" ? organization : null;
}

export async function provisionApiClient(
  db: Database,
  organizationId: string,
  input: { name: string; permissions: readonly string[]; expiresAt?: Date | null },
) {
  return createApiClient(db, createTrustedTenantScope(organizationId), {
    name: input.name,
    permissions: input.permissions,
    expiresAt: input.expiresAt ?? null,
    actorUserId: null,
  });
}

export async function provisionWebhook(
  db: Database,
  organizationId: string,
  input: { name: string; endpointUrl: string; eventTypes: readonly string[] },
) {
  const signingSecret = randomBytes(32).toString("base64url");
  const subscription = await createWebhookSubscription(
    db,
    createTrustedTenantScope(organizationId),
    {
      name: input.name,
      endpointUrl: input.endpointUrl,
      eventTypes: input.eventTypes,
      signingSecret,
      actorUserId: null,
    },
  );
  return { subscription, signingSecret };
}
