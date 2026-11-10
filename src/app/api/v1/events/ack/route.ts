import { getRuntimeDatabase } from "@/db/runtime";
import { authorizeApiRequest } from "@/modules/api/http";
import { runApi, requireUuid } from "@/modules/integration/api";
import * as events from "@/modules/integration/events";
import { requiredString } from "@/modules/integration/api";


export async function POST(
  request: Request,
) {
  const auth = await authorizeApiRequest(request, ["event:view"]);
  if (!auth.ok) return auth.response;
  const context = auth.context;
  return runApi(context, request, async (body) => {
    const db = getRuntimeDatabase();
    void body;
    return { data: await events.acknowledgeEventCursor(db, context.clientId, requiredString(body.cursor, "cursor", 100)) };
  });
}
