import { runApi } from "@/modules/integration/api";
import { createManualDeadline } from "@/modules/integration/service";
import { getRuntimeDatabase } from "@/db/runtime";
import { findCaseById } from "@/modules/cases/repository";
import { listCaseDeadlines } from "@/modules/deadlines/repository";
import { extendDeadline } from "@/modules/deadlines/service";
import {
  apiJson,
  authorizeApiRequest,
  isUuid,
} from "@/modules/api/http";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const auth = await authorizeApiRequest(request, [
    "case:view",
    "deadline:view",
  ]);
  if (!auth.ok) return auth.response;

  const { caseId } = await params;
  if (!isUuid(caseId)) {
    return apiJson(
      auth.context,
      { error: { code: "invalid_id", message: "caseId must be a UUID." } },
      { status: 400 },
    );
  }
  const db = getRuntimeDatabase();
  const record = await findCaseById(
    db,
    auth.context.tenantScope,
    caseId,
  );
  if (!record) {
    return apiJson(
      auth.context,
      { error: { code: "not_found", message: "Case not found." } },
      { status: 404 },
    );
  }

  return apiJson(auth.context, {
    data: await listCaseDeadlines(
      db,
      auth.context.tenantScope,
      caseId,
    ),
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> },
) {
  const auth = await authorizeApiRequest(request, [
    "case:view",
    "deadline:operate",
  ]);
  if (!auth.ok) return auth.response;

  const { caseId } = await params;
  if (!isUuid(caseId)) {
    return apiJson(
      auth.context,
      { error: { code: "invalid_id", message: "caseId must be a UUID." } },
      { status: 400 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiJson(
      auth.context,
      { error: { code: "invalid_json", message: "Request body must be JSON." } },
      { status: 400 },
    );
  }

  const operation = String(body.operation ?? "");
  if (operation === "create") {
    const context = auth.context;
    return runApi(
      context,
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      }),
      async (parsed) => ({
        status: 201,
        data: await createManualDeadline(
          getRuntimeDatabase(),
          context,
          caseId,
          parsed,
        ),
      }),
    );
  }
  const deadlineId = String(body.deadlineId ?? "");
  const reason = String(body.reason ?? "").trim();
  const extensionValue = Number(body.extensionValue);
  const extensionUnit = String(body.extensionUnit ?? "");

  if (
    operation !== "extend" ||
    !isUuid(deadlineId) ||
    !reason ||
    !Number.isInteger(extensionValue) ||
    extensionValue < 1 ||
    !["hours", "calendar_days", "business_days"].includes(
      extensionUnit,
    )
  ) {
    return apiJson(
      auth.context,
      {
        error: {
          code: "invalid_extension",
          message: "A valid extend operation, deadlineId, reason, value, and unit are required.",
        },
      },
      { status: 400 },
    );
  }

  const db = getRuntimeDatabase();
  const record = await findCaseById(
    db,
    auth.context.tenantScope,
    caseId,
  );
  if (!record) {
    return apiJson(
      auth.context,
      { error: { code: "not_found", message: "Case not found." } },
      { status: 404 },
    );
  }

  const deadlines = await listCaseDeadlines(
    db,
    auth.context.tenantScope,
    caseId,
  );
  if (!deadlines.some((deadline) => deadline.id === deadlineId)) {
    return apiJson(
      auth.context,
      { error: { code: "not_found", message: "Deadline not found for this case." } },
      { status: 404 },
    );
  }

  try {
    const data = await extendDeadline(
      db,
      auth.context.tenantScope,
      {
        deadlineId,
        actorUserId: null,
        auditSource: "api",
        reason,
        extension: {
          value: extensionValue,
          unit: extensionUnit as
            | "hours"
            | "calendar_days"
            | "business_days",
        },
      },
    );
    return apiJson(auth.context, { data });
  } catch {
    return apiJson(
      auth.context,
      {
        error: {
          code: "deadline_extension_failed",
          message: "Deadline extension could not be recorded.",
        },
      },
      { status: 400 },
    );
  }
}
