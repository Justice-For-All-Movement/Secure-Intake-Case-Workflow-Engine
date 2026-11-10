import { getRuntimeDatabase } from "@/db/runtime";
import { authorizeApiRequest } from "@/modules/api/http";
import { runApi, requireUuid } from "@/modules/integration/api";
import * as service from "@/modules/integration/service";


export async function GET(
  request: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  const auth = await authorizeApiRequest(request, ["document:view"]);
  if (!auth.ok) return auth.response;
  const context = auth.context;
  return runApi(context, request, async (body) => {
    const db = getRuntimeDatabase();
    const id = requireUuid((await params).versionId, "versionId");
    void body;
    return { data: await service.readDocumentCustody(db, context, id) };
  });
}
