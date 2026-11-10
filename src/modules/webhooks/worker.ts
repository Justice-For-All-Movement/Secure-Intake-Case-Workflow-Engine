import { and, eq, sql } from "drizzle-orm";
import type { BackgroundJobHandler } from "@/modules/jobs/worker";
import {
  auditEvents,
  webhookDeliveries,
  webhookSubscriptions,
} from "@/db/schema";
import {
  decryptWebhookSecret,
  webhookSignature,
} from "./crypto";
import { integrationEventFromRow } from "@/modules/integration/events";
import { assertWebhookDestinationPublic } from "./policy";

function deliveryIdFromPayload(payload: Record<string, unknown>) {
  const value = payload.deliveryId;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Webhook delivery job is missing deliveryId.");
  }
  return value;
}

export const deliverWebhookJob: BackgroundJobHandler = async ({
  db,
  scope,
  job,
  finalAttempt,
}) => {
  const deliveryId = deliveryIdFromPayload(job.payload);
  const [row] = await db
    .select({
      delivery: webhookDeliveries,
      subscription: webhookSubscriptions,
      event: auditEvents,
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
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(
          webhookDeliveries.organizationId,
          scope.organizationId,
        ),
      ),
    )
    .limit(1);

  if (!row) throw new Error("Webhook delivery was not found.");
  if (row.delivery.status === "delivered") return;

  if (row.subscription.status !== "active") {
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        lastError: "Webhook subscription is disabled.",
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, row.delivery.id));
    return;
  }

  const attemptStartedAt = new Date();
  await db
    .update(webhookDeliveries)
    .set({
      status: "delivering",
      attemptCount: sql`${webhookDeliveries.attemptCount} + 1`,
      lastError: null,
      updatedAt: attemptStartedAt,
    })
    .where(eq(webhookDeliveries.id, row.delivery.id));

  let responseStatus: number | null = null;

  try {
    await assertWebhookDestinationPublic(row.subscription.endpointUrl);
    const secret = decryptWebhookSecret(
      row.subscription.signingSecretCiphertext,
    );

    const event = integrationEventFromRow(row.event);
    const payload = {
      // `id` is the delivery id (unique per subscription + event); `eventId`
      // is stable across subscriptions and matches the event feed.
      id: row.delivery.id,
      eventId: event.id,
      type: event.type,
      action: event.action,
      cursor: event.cursor,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      organizationId: row.event.organizationId,
      resource: event.resource,
      actor: event.actor,
      correlationId: event.correlationId,
      source: event.source,
      previousState: event.previousState,
      newState: event.newState,
      metadata: event.metadata,
    };
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = webhookSignature(secret, timestamp, body);

    const response = await fetch(row.subscription.endpointUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "SICWE-Webhook/1.0",
        "X-SICWE-Delivery": row.delivery.id,
        "X-SICWE-Event": event.type,
        "X-SICWE-Event-Id": event.id,
        "X-SICWE-Timestamp": timestamp,
        "X-SICWE-Signature": `sha256=${signature}`,
      },
      body,
    });
    responseStatus = response.status;

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Webhook endpoint returned HTTP ${response.status}.`,
      );
    }

    await db
      .update(webhookDeliveries)
      .set({
        status: "delivered",
        responseStatus,
        deliveredAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, row.delivery.id));
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 2000)
        : "Unknown webhook delivery failure.";

    await db
      .update(webhookDeliveries)
      .set({
        status: finalAttempt ? "failed" : "pending",
        responseStatus,
        lastError: message,
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, row.delivery.id));

    throw error;
  }
};
