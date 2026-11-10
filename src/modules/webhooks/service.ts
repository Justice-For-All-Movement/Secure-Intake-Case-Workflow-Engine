import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditEvents,
  webhookDeliveries,
  webhookSubscriptions,
} from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import { auditEventValues } from "@/modules/audit/event";
import { encryptWebhookSecret } from "./crypto";
import {
  assertWebhookDestinationPublic,
  normalizeWebhookEventTypes,
  normalizeWebhookUrl,
} from "./policy";

export async function listWebhookSubscriptions(
  db: Database,
  scope: TenantScope,
) {
  return db
    .select({
      id: webhookSubscriptions.id,
      name: webhookSubscriptions.name,
      endpointUrl: webhookSubscriptions.endpointUrl,
      eventTypes: webhookSubscriptions.eventTypes,
      status: webhookSubscriptions.status,
      disabledAt: webhookSubscriptions.disabledAt,
      createdAt: webhookSubscriptions.createdAt,
      updatedAt: webhookSubscriptions.updatedAt,
    })
    .from(webhookSubscriptions)
    .where(
      eq(webhookSubscriptions.organizationId, scope.organizationId),
    )
    .orderBy(webhookSubscriptions.name);
}

export async function createWebhookSubscription(
  db: Database,
  scope: TenantScope,
  input: {
    name: string;
    endpointUrl: string;
    eventTypes: readonly string[];
    signingSecret: string;
    actorUserId: string | null;
  },
) {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new Error("Webhook name is required.");

  const endpointUrl = normalizeWebhookUrl(input.endpointUrl);
  await assertWebhookDestinationPublic(endpointUrl);
  const eventTypes = normalizeWebhookEventTypes(input.eventTypes);
  const signingSecretCiphertext = encryptWebhookSecret(
    input.signingSecret,
  );

  const [subscription] = await db
    .insert(webhookSubscriptions)
    .values({
      organizationId: scope.organizationId,
      name,
      endpointUrl,
      eventTypes,
      signingSecretCiphertext,
      createdByUserId: input.actorUserId,
    })
    .returning();

  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: input.actorUserId ? "user" : "system",
      actorUserId: input.actorUserId,
      action: "webhook.subscription_created",
      resourceType: "webhook_subscription",
      resourceId: subscription.id,
      newState: {
        status: subscription.status,
        eventTypes,
      },
      metadata: {
        name: subscription.name,
        endpointOrigin: new URL(endpointUrl).origin,
      },
    }),
  );

  return subscription;
}

export async function disableWebhookSubscription(
  db: Database,
  scope: TenantScope,
  input: { subscriptionId: string; actorUserId: string },
) {
  const now = new Date();
  const [subscription] = await db
    .update(webhookSubscriptions)
    .set({
      status: "disabled",
      disabledAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(webhookSubscriptions.id, input.subscriptionId),
        eq(
          webhookSubscriptions.organizationId,
          scope.organizationId,
        ),
        eq(webhookSubscriptions.status, "active"),
      ),
    )
    .returning();

  if (!subscription) return null;

  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: "user",
      actorUserId: input.actorUserId,
      action: "webhook.subscription_disabled",
      resourceType: "webhook_subscription",
      resourceId: subscription.id,
      previousState: { status: "active" },
      newState: { status: "disabled" },
      metadata: { name: subscription.name },
    }),
  );

  return subscription;
}

export async function listWebhookDeliveries(
  db: Database,
  scope: TenantScope,
  limit = 100,
) {
  return db
    .select({
      delivery: webhookDeliveries,
      subscriptionName: webhookSubscriptions.name,
      eventAction: auditEvents.action,
      eventOccurredAt: auditEvents.occurredAt,
    })
    .from(webhookDeliveries)
    .innerJoin(
      webhookSubscriptions,
      and(
        eq(
          webhookSubscriptions.id,
          webhookDeliveries.subscriptionId,
        ),
        eq(
          webhookSubscriptions.organizationId,
          webhookDeliveries.organizationId,
        ),
      ),
    )
    .innerJoin(
      auditEvents,
      and(
        eq(auditEvents.id, webhookDeliveries.auditEventId),
        eq(
          auditEvents.organizationId,
          webhookDeliveries.organizationId,
        ),
      ),
    )
    .where(eq(webhookDeliveries.organizationId, scope.organizationId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}
