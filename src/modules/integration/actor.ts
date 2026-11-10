import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  apiClients,
  organizationMemberships,
  users,
} from "@/db/schema";
import type { ApiAuthorizationContext } from "@/modules/api/auth";

/**
 * Service operations that require a user actor are attributed to a dedicated
 * password-less service user for the API client. It holds no roles and cannot
 * sign in; authority always comes from the API client's scopes.
 */
export async function ensureServiceActor(
  db: Database,
  context: ApiAuthorizationContext,
): Promise<string> {
  const [client] = await db
    .select({ serviceUserId: apiClients.serviceUserId })
    .from(apiClients)
    .where(eq(apiClients.id, context.clientId))
    .limit(1);
  if (client?.serviceUserId) return client.serviceUserId;

  return db.transaction(async (tx) => {
    const email = `api-client+${context.clientId}@service.invalid`;
    const [user] = await tx
      .insert(users)
      .values({
        email,
        displayName: `Service: ${context.clientName}`.slice(0, 200),
      })
      .onConflictDoUpdate({
        target: users.email,
        set: { updatedAt: new Date() },
      })
      .returning({ id: users.id });
    await tx
      .insert(organizationMemberships)
      .values({
        organizationId: context.organizationId,
        userId: user.id,
        title: "API service account",
      })
      .onConflictDoNothing();
    await tx
      .update(apiClients)
      .set({ serviceUserId: user.id })
      .where(
        and(
          eq(apiClients.id, context.clientId),
          eq(apiClients.organizationId, context.organizationId),
        ),
      );
    return user.id;
  });
}
