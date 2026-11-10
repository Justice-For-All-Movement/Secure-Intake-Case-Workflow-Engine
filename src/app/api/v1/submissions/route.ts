import { runApi } from "@/modules/integration/api";
import { createSubmission } from "@/modules/integration/service";
import { getRuntimeDatabase } from "@/db/runtime";
import { listApiSubmissions } from "@/modules/api/repository";
import {
  apiJson,
  authorizeApiRequest,
  isUuid,
  paginated,
  parsePage,
} from "@/modules/api/http";

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, ["submission:view"]);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const { limit, offset } = parsePage(request);
  const formId = url.searchParams.get("formId");
  if (formId && !isUuid(formId)) {
    return apiJson(
      auth.context,
      { error: { code: "invalid_id", message: "formId must be a UUID." } },
      { status: 400 },
    );
  }
  const records = await listApiSubmissions(
    getRuntimeDatabase(),
    auth.context.tenantScope,
    {
      status: url.searchParams.get("status"),
      formId,
      limit,
      offset,
    },
  );

  return apiJson(
    auth.context,
    paginated(records, limit, offset),
  );
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, ["submission:create"]);
  if (!auth.ok) return auth.response;
  const context = auth.context;
  return runApi(context, request, async (body) => {
    const data = await createSubmission(getRuntimeDatabase(), context, body);
    return {
      status: 201,
      data,
      // The access secret is shown once and never persisted, so an
      // idempotent replay returns the same submission without it.
      replayData: {
        ...data,
        participantAccessSecret: null,
        participantAccessSecretWithheld: Boolean(data.participantAccessSecret),
      },
    };
  });
}
