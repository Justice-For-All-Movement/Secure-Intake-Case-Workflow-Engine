import { NextResponse } from "next/server";
import { runApi } from "@/modules/integration/api";
import { openCase } from "@/modules/integration/service";
import { getRuntimeDatabase } from "@/db/runtime";
import {
  caseSearchDefinitionFromSearchParams,
} from "@/modules/operations/definition";
import { searchCases } from "@/modules/operations/repository";
import {
  apiJson,
  authorizeApiRequest,
  paginated,
  parsePage,
} from "@/modules/api/http";

export async function GET(request: Request) {
  const auth = await authorizeApiRequest(request, ["case:view"]);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  let definition;
  try {
    definition = caseSearchDefinitionFromSearchParams(
      Object.fromEntries(url.searchParams),
    );
  } catch {
    return apiJson(
      auth.context,
      {
        error: {
          code: "invalid_query",
          message: "Case search parameters are invalid.",
        },
      },
      { status: 400 },
    );
  }

  if (definition.focus === "mine") {
    return apiJson(
      auth.context,
      {
        error: {
          code: "unsupported_focus",
          message: "The 'mine' focus is not available to service credentials.",
        },
      },
      { status: 400 },
    );
  }

  const { limit, offset } = parsePage(request);
  definition = { ...definition, limit };
  const records = await searchCases(
    getRuntimeDatabase(),
    auth.context.tenantScope,
    definition,
    auth.context.clientId,
    { offset },
  );

  return apiJson(
    auth.context,
    paginated(records, limit, offset),
  );
}

export async function POST(request: Request) {
  const auth = await authorizeApiRequest(request, ["case:create", "submission:view"]);
  if (!auth.ok) return auth.response;
  const context = auth.context;
  return runApi(context, request, async (body) => {
    const result = await openCase(getRuntimeDatabase(), context, body);
    return { status: result.created ? 201 : 200, data: result };
  });
}
