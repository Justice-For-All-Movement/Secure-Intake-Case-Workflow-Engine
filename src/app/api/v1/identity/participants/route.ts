import { getRuntimeDatabase } from "@/db/runtime";
import { authorizeApiRequest } from "@/modules/api/http";
import { runApi, requireUuid } from "@/modules/integration/api";
import * as service from "@/modules/integration/service";
import { invalid } from "@/modules/integration/api";


export async function GET(
  request: Request,
) {
  const auth = await authorizeApiRequest(request, ["identity:manage"]);
  if (!auth.ok) return auth.response;
  const context = auth.context;
  return runApi(context, request, async (body) => {
    const db = getRuntimeDatabase();
    void body;
    const url = new URL(request.url);
    const provider = url.searchParams.get("provider");
    const subject = url.searchParams.get("subject");
    if (!provider || !subject) throw invalid("provider and subject are required.");
    return { data: await service.listParticipantIdentityLinks(db, context, provider, subject) };
  });
}
