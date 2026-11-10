import { getRuntimeDatabase } from "@/db/runtime";
import { authorizeApiRequest } from "@/modules/api/http";
import { runApi, requireUuid } from "@/modules/integration/api";
import * as service from "@/modules/integration/service";


export async function GET(
  request: Request,
  { params }: { params: Promise<{ submissionId: string }> },
) {
  const auth = await authorizeApiRequest(request, ["submission:view", "submission:view_protected"]);
  if (!auth.ok) return auth.response;
  const context = auth.context;
  return runApi(context, request, async (body) => {
    const db = getRuntimeDatabase();
    const id = requireUuid((await params).submissionId, "submissionId");
    void body;
    return { data: await service.getSubmissionProtected(db, context, id) };
  });
}
