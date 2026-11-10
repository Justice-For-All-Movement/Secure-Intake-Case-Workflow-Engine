import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  apiClients,
  auditEvents,
  organizations,
} from "@/db/schema";
import { env } from "@/lib/env";
import {
  createTrustedTenantScope,
  type TenantScope,
} from "@/lib/tenancy";
import { auditEventValues } from "@/modules/audit/event";
import {
  corePermissions,
  type Permission,
} from "@/modules/auth/permissions";

const tokenPattern = /^sicwe_([a-f0-9]{12})_([A-Za-z0-9_-]{40,})$/;
const forbiddenApiScopes = new Set(["api:manage", "webhook:manage"]);

export class ApiAuthenticationError extends Error {
  constructor(
    readonly code:
      | "invalid_token"
      | "expired_token"
      | "inactive_client"
      | "inactive_organization"
      | "rate_limited",
  ) {
    super(code);
    this.name = "ApiAuthenticationError";
  }
}

export interface ApiAuthorizationContext {
  clientId: string;
  clientName: string;
  organizationId: string;
  tenantScope: TenantScope;
  permissions: ReadonlySet<string>;
  rateLimit: number;
  rateRemaining: number;
  rateResetAt: Date;
}

export function hashApiToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function normalizeApiPermissions(
  permissions: readonly string[],
) {
  const allowed = new Set<string>(corePermissions);
  const requested = [
    ...new Set(
      permissions
        .map((permission) => permission.trim())
        .filter(Boolean),
    ),
  ];
  const invalid = requested.filter(
    (permission) =>
      !allowed.has(permission) ||
      forbiddenApiScopes.has(permission),
  );
  if (invalid.length) {
    throw new Error(
      `Invalid or non-delegable API permissions: ${invalid.join(", ")}`,
    );
  }
  return requested.sort();
}

export async function createApiClient(
  db: Database,
  scope: TenantScope,
  input: {
    name: string;
    permissions: readonly string[];
    rateLimitPerMinute?: number;
    expiresAt?: Date | null;
    actorUserId: string | null;
  },
) {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new Error("API client name is required.");

  const permissions = normalizeApiPermissions(input.permissions);
  if (permissions.length === 0) {
    throw new Error("At least one API permission is required.");
  }

  const rateLimit =
    input.rateLimitPerMinute ?? env.API_DEFAULT_RATE_LIMIT_PER_MINUTE;
  if (
    !Number.isInteger(rateLimit) ||
    rateLimit < 1 ||
    rateLimit > 10000
  ) {
    throw new Error("API rate limit is invalid.");
  }

  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const token = `sicwe_${prefix}_${secret}`;

  const [client] = await db
    .insert(apiClients)
    .values({
      organizationId: scope.organizationId,
      name,
      keyPrefix: prefix,
      keyHash: hashApiToken(token),
      permissions,
      rateLimitPerMinute: rateLimit,
      expiresAt: input.expiresAt ?? null,
      createdByUserId: input.actorUserId,
    })
    .returning();

  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: input.actorUserId ? "user" : "system",
      actorUserId: input.actorUserId,
      action: "api.client_created",
      resourceType: "api_client",
      resourceId: client.id,
      newState: {
        status: client.status,
        permissions,
        rateLimitPerMinute: client.rateLimitPerMinute,
        expiresAt: client.expiresAt?.toISOString() ?? null,
      },
      metadata: { keyPrefix: client.keyPrefix, name: client.name },
    }),
  );

  return { client, token };
}

export async function listApiClients(
  db: Database,
  scope: TenantScope,
) {
  return db
    .select({
      id: apiClients.id,
      name: apiClients.name,
      keyPrefix: apiClients.keyPrefix,
      permissions: apiClients.permissions,
      status: apiClients.status,
      rateLimitPerMinute: apiClients.rateLimitPerMinute,
      expiresAt: apiClients.expiresAt,
      lastUsedAt: apiClients.lastUsedAt,
      revokedAt: apiClients.revokedAt,
      createdAt: apiClients.createdAt,
    })
    .from(apiClients)
    .where(eq(apiClients.organizationId, scope.organizationId))
    .orderBy(apiClients.name);
}

export async function revokeApiClient(
  db: Database,
  scope: TenantScope,
  input: { clientId: string; actorUserId: string },
) {
  const now = new Date();
  const [client] = await db
    .update(apiClients)
    .set({
      status: "revoked",
      revokedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(apiClients.id, input.clientId),
        eq(apiClients.organizationId, scope.organizationId),
        eq(apiClients.status, "active"),
      ),
    )
    .returning();

  if (!client) return null;

  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: "user",
      actorUserId: input.actorUserId,
      action: "api.client_revoked",
      resourceType: "api_client",
      resourceId: client.id,
      previousState: { status: "active" },
      newState: { status: "revoked" },
      metadata: { keyPrefix: client.keyPrefix, name: client.name },
    }),
  );

  return client;
}

export async function authenticateApiToken(
  db: Database,
  token: string,
  now = new Date(),
): Promise<ApiAuthorizationContext> {
  if (!tokenPattern.test(token)) {
    throw new ApiAuthenticationError("invalid_token");
  }

  const [row] = await db
    .select({
      client: apiClients,
      organizationStatus: organizations.status,
    })
    .from(apiClients)
    .innerJoin(
      organizations,
      eq(organizations.id, apiClients.organizationId),
    )
    .where(eq(apiClients.keyHash, hashApiToken(token)))
    .limit(1);

  if (!row) throw new ApiAuthenticationError("invalid_token");
  if (row.client.status !== "active") {
    throw new ApiAuthenticationError("inactive_client");
  }
  if (row.organizationStatus !== "active") {
    throw new ApiAuthenticationError("inactive_organization");
  }
  if (row.client.expiresAt && row.client.expiresAt <= now) {
    throw new ApiAuthenticationError("expired_token");
  }

  const minuteStart = new Date(
    Math.floor(now.getTime() / 60_000) * 60_000,
  );
  // Raw SQL fragments do not get column-aware Date serialization.
  const minuteStartSql = sql`${minuteStart.toISOString()}::timestamptz`;

  const [rated] = await db
    .update(apiClients)
    .set({
      rateWindowStartedAt: sql`case
        when ${apiClients.rateWindowStartedAt} is null
          or ${apiClients.rateWindowStartedAt} < ${minuteStartSql}
        then ${minuteStartSql}
        else ${apiClients.rateWindowStartedAt}
      end`,
      rateWindowCount: sql`case
        when ${apiClients.rateWindowStartedAt} is null
          or ${apiClients.rateWindowStartedAt} < ${minuteStartSql}
        then 1
        else ${apiClients.rateWindowCount} + 1
      end`,
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(apiClients.id, row.client.id),
        eq(apiClients.status, "active"),
        or(
          isNull(apiClients.expiresAt),
          gt(apiClients.expiresAt, now),
        ),
      ),
    )
    .returning({
      count: apiClients.rateWindowCount,
      limit: apiClients.rateLimitPerMinute,
    });

  if (!rated) throw new ApiAuthenticationError("inactive_client");

  const resetAt = new Date(minuteStart.getTime() + 60_000);
  if (rated.count > rated.limit) {
    throw new ApiAuthenticationError("rate_limited");
  }

  return {
    clientId: row.client.id,
    clientName: row.client.name,
    organizationId: row.client.organizationId,
    tenantScope: createTrustedTenantScope(row.client.organizationId),
    permissions: new Set(row.client.permissions),
    rateLimit: rated.limit,
    rateRemaining: Math.max(0, rated.limit - rated.count),
    rateResetAt: resetAt,
  };
}

export function apiClientHasPermission(
  context: ApiAuthorizationContext,
  permission: Permission,
) {
  return context.permissions.has(permission);
}
