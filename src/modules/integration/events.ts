import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { apiClients } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { TenantScope } from "@/lib/tenancy";

export interface IntegrationEvent {
  id: string;
  cursor: string;
  sequence: number;
  type: string;
  action: string;
  occurredAt: string;
  resource: {
    type: string;
    id: string;
    parentType: string | null;
    parentId: string | null;
  };
  actor: { type: string };
  source: string;
  correlationId: string;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

export class InvalidEventCursorError extends Error {
  constructor() {
    super("Event cursor is invalid.");
    this.name = "InvalidEventCursorError";
  }
}

export function encodeEventCursor(txid: number, sequence: number) {
  return Buffer.from(`v1.${txid}.${sequence}`, "utf8").toString(
    "base64url",
  );
}

export function decodeEventCursor(cursor: string) {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^v1\.(\d{1,15})\.(\d{1,15})$/.exec(text);
  if (!match || cursor.length > 100) throw new InvalidEventCursorError();
  return { txid: Number(match[1]), sequence: Number(match[2]) };
}

export function integrationEventFromRow(row: {
  id: string;
  txid: number | string;
  sequence: number | string;
  eventType: string | null;
  action: string;
  occurredAt: Date | string;
  resourceType: string;
  resourceId: string;
  parentResourceType: string | null;
  parentResourceId: string | null;
  actorType: string;
  source: string;
  correlationId: string;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}): IntegrationEvent {
  const sequence = Number(row.sequence);
  return {
    id: row.id,
    cursor: encodeEventCursor(Number(row.txid), sequence),
    sequence,
    type: row.eventType ?? row.action,
    action: row.action,
    occurredAt: new Date(row.occurredAt).toISOString(),
    resource: {
      type: row.resourceType,
      id: row.resourceId,
      parentType: row.parentResourceType,
      parentId: row.parentResourceId,
    },
    actor: { type: row.actorType },
    source: row.source,
    correlationId: row.correlationId,
    previousState: row.previousState,
    newState: row.newState,
    metadata: row.metadata ?? {},
  };
}

/**
 * Ordered, gap-free feed. Rows are ordered by (transaction id, sequence) and a
 * row is only returned once every older transaction has finished, so a
 * consumer that resumes from the last returned cursor never skips an event
 * that commits late.
 */
export async function listIntegrationEvents(
  db: Database,
  scope: TenantScope,
  input: {
    after?: string | null;
    limit?: number;
    types?: readonly string[];
  },
) {
  const after = input.after
    ? decodeEventCursor(input.after)
    : { txid: 0, sequence: 0 };
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const types = (input.types ?? []).filter(Boolean).slice(0, 50);
  const typeFilter = types.length
    ? sql`and (event_type in (${sql.join(
        types.map((type) => sql`${type}`),
        sql`, `,
      )}) or action in (${sql.join(
        types.map((type) => sql`${type}`),
        sql`, `,
      )}))`
    : sql``;

  const rows = (await db.execute(sql`
    select
      id, txid, sequence, event_type as "eventType", action,
      occurred_at as "occurredAt", resource_type as "resourceType",
      resource_id as "resourceId",
      parent_resource_type as "parentResourceType",
      parent_resource_id as "parentResourceId",
      actor_type as "actorType", source,
      correlation_id as "correlationId",
      previous_state as "previousState", new_state as "newState", metadata
    from audit_events
    where organization_id = ${scope.organizationId}
      and txid < txid_snapshot_xmin(txid_current_snapshot())
      and (txid, sequence) > (${after.txid}, ${after.sequence})
      ${typeFilter}
    order by txid asc, sequence asc
    limit ${limit + 1}
  `)) as unknown as Parameters<typeof integrationEventFromRow>[0][];

  const page = rows.slice(0, limit).map(integrationEventFromRow);
  return {
    events: page,
    hasMore: rows.length > limit,
    nextCursor: page.length
      ? page[page.length - 1].cursor
      : (input.after ?? null),
  };
}

export async function acknowledgeEventCursor(
  db: Database,
  clientId: string,
  cursor: string,
) {
  decodeEventCursor(cursor);
  await db
    .update(apiClients)
    .set({ acknowledgedEventCursor: cursor })
    .where(eq(apiClients.id, clientId));
  return { acknowledgedCursor: cursor };
}

export async function readAcknowledgedEventCursor(
  db: Database,
  clientId: string,
) {
  const [row] = await db
    .select({ cursor: apiClients.acknowledgedEventCursor })
    .from(apiClients)
    .where(eq(apiClients.id, clientId))
    .limit(1);
  return row?.cursor ?? null;
}
