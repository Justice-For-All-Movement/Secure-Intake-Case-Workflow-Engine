import { getRuntimeDatabase } from "@/db/runtime";
import { authorizeApiRequest } from "@/modules/api/http";
import { requireUuid, runApi } from "@/modules/integration/api";
import * as events from "@/modules/integration/events";
import { requiredString } from "@/modules/integration/api";


export async function GET(
  request: Request,
) {
  const auth = await authorizeApiRequest(request, ["event:view"]);
  if (!auth.ok) return auth.response;
  const context = auth.context;
  return runApi(context, request, async (body) => {
    const db = getRuntimeDatabase();
    void body;
    const url = new URL(request.url);
    const after =
      url.searchParams.get("after") ??
      (await events.readAcknowledgedEventCursor(db, context.clientId));
    const page = await events.listIntegrationEvents(db, context.tenantScope, {
      after,
      limit: Number(url.searchParams.get("limit") ?? "100") || 100,
      types: (url.searchParams.get("types") ?? "").split(",").filter(Boolean),
    });
    void requiredString;
    return {
      data: page.events,
      extra: { cursor: { next: page.nextCursor, hasMore: page.hasMore } },
    };
  });
}
