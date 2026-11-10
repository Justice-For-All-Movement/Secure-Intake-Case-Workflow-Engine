import { getRuntimeDatabase } from "@/db/runtime";
import { authorizeApiRequest } from "@/modules/api/http";
import { runApi, requireUuid } from "@/modules/integration/api";
import * as service from "@/modules/integration/service";
import { binaryResponse } from "@/modules/integration/api";


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
    const { version, data } = await service.readDocumentContent(db, context, id);
    return binaryResponse(context, data, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(data.byteLength),
      "Content-Disposition": `attachment; filename="document-${version.id}"`,
      Digest: `sha-256=${Buffer.from(version.sha256, "hex").toString("base64")}`,
      "X-Content-SHA256": version.sha256,
      "X-Declared-Content-Type": encodeURIComponent(version.mimeType),
      "X-Original-Filename": encodeURIComponent(version.originalFilename),
    });
  });
}
