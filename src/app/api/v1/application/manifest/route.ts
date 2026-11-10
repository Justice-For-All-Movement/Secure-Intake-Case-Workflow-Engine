import { getRuntimeDatabase } from "@/db/runtime";
import { authorizeApiRequest } from "@/modules/api/http";
import { runApi, requireUuid } from "@/modules/integration/api";
import { applyApplicationManifest } from "@/modules/application/service";
import { findActiveApplicationManifestRevision } from "@/modules/application/repository";
import { ensureServiceActor } from "@/modules/integration/actor";


export async function GET(
  request: Request,
) {
  const auth = await authorizeApiRequest(request, ["application:view"]);
  if (!auth.ok) return auth.response;
  const context = auth.context;
  return runApi(context, request, async (body) => {
    const db = getRuntimeDatabase();
    void body;
    const revision = await findActiveApplicationManifestRevision(db, context.tenantScope);
    return { data: revision ?? null };
  });
}

export async function POST(
  request: Request,
) {
  const auth = await authorizeApiRequest(request, ["application:manage"]);
  if (!auth.ok) return auth.response;
  const context = auth.context;
  return runApi(context, request, async (body) => {
    const db = getRuntimeDatabase();
    void body;
    return {
      data: await applyApplicationManifest(
        db,
        context.tenantScope,
        body.manifest ?? body,
        await ensureServiceActor(db, context),
      ),
    };
  });
}
