import { getRuntimeDatabase } from "@/db/runtime";
import { authorizeApiRequest } from "@/modules/api/http";
import { runApi, requireUuid } from "@/modules/integration/api";
import * as service from "@/modules/integration/service";


export async function POST(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const auth = await authorizeApiRequest(request, ["case:view", "case:update"]);
  if (!auth.ok) return auth.response;
  const context = auth.context;
  return runApi(context, request, async (body) => {
    const db = getRuntimeDatabase();
    const id = requireUuid((await params).caseId, "caseId");
    void body;
    return { data: await service.transitionCaseByKey(db, context, id, body) };
  });
}
