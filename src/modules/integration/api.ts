import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getRuntimeDatabase } from "@/db/runtime";
import { apiIdempotencyKeys } from "@/db/schema";
import type { ApiAuthorizationContext } from "@/modules/api/auth";
import { apiJson } from "@/modules/api/http";
import {
  CaseConcurrencyError,
  CaseNotFoundError,
  SubmissionNotReviewableError,
  TransitionGuardError,
  WorkflowNotAvailableError,
  WorkflowTransitionNotAvailableError,
} from "@/modules/cases/service";
import {
  DocumentContentUnavailableError,
  DocumentNotFoundError,
} from "@/modules/documents/service";
import {
  FormNotAvailableError,
  SubmissionValidationError,
} from "@/modules/forms/service";
import { InvalidEventCursorError } from "./events";

export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiProblem";
  }
}

export function notFound(what: string) {
  return new ApiProblem(404, "not_found", `${what} not found.`);
}

export function invalid(message: string, details?: unknown) {
  return new ApiProblem(422, "invalid_request", message, details);
}

function problemFromError(error: unknown): ApiProblem {
  if (error instanceof ApiProblem) return error;
  if (error instanceof SubmissionValidationError) {
    return new ApiProblem(
      422,
      "validation_failed",
      "Submission validation failed.",
      error.errors,
    );
  }
  if (error instanceof ZodError) {
    return new ApiProblem(
      422,
      "validation_failed",
      "Request validation failed.",
      error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  if (error instanceof TransitionGuardError) {
    return new ApiProblem(
      422,
      "transition_guard_failed",
      error.message,
      error.failures,
    );
  }
  if (
    error instanceof CaseNotFoundError ||
    error instanceof DocumentNotFoundError ||
    error instanceof FormNotAvailableError
  ) {
    return new ApiProblem(404, "not_found", "Resource not found.");
  }
  if (error instanceof SubmissionNotReviewableError) {
    return new ApiProblem(
      409,
      "submission_not_submitted",
      "Only a submitted submission can open a case.",
    );
  }
  if (
    error instanceof CaseConcurrencyError ||
    error instanceof WorkflowTransitionNotAvailableError ||
    error instanceof WorkflowNotAvailableError
  ) {
    return new ApiProblem(409, "conflict", error.message);
  }
  if (error instanceof DocumentContentUnavailableError) {
    return new ApiProblem(
      409,
      "content_unavailable",
      "Document content is quarantined or blocked.",
    );
  }
  if (error instanceof InvalidEventCursorError) {
    return new ApiProblem(400, "invalid_cursor", error.message);
  }
  // Unknown failures never disclose internals.
  return new ApiProblem(
    400,
    "operation_failed",
    "The operation could not be completed.",
  );
}

export interface ApiResult {
  status?: number;
  data: unknown;
  extra?: Record<string, unknown>;
  /**
   * Stored for idempotent replays instead of `data` when the first response
   * carries a one-time secret that must never be persisted.
   */
  replayData?: unknown;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Runs one authenticated API operation: parses a JSON body for writes, maps
 * domain errors to stable problem codes, and honours `Idempotency-Key` on
 * writes (same key + same request replays the stored response; same key with
 * a different request is rejected).
 */
export async function runApi(
  context: ApiAuthorizationContext,
  request: Request,
  operation: (body: Record<string, unknown>) => Promise<ApiResult | Response>,
): Promise<Response> {
  const isWrite = request.method !== "GET";
  let raw = "";
  let body: Record<string, unknown> = {};
  if (isWrite) {
    try {
      raw = await request.text();
      if (raw.length > 2_000_000) {
        throw new ApiProblem(413, "too_large", "Request body is too large.");
      }
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      body = parsed as Record<string, unknown>;
    } catch (error) {
      const problem =
        error instanceof ApiProblem
          ? error
          : new ApiProblem(
              400,
              "invalid_json",
              "Request body must be a JSON object.",
            );
      return problemResponse(context, problem);
    }
  }

  const key = isWrite
    ? request.headers.get("idempotency-key")?.trim() || null
    : null;
  if (key && (key.length < 8 || key.length > 200)) {
    return problemResponse(
      context,
      new ApiProblem(
        400,
        "invalid_idempotency_key",
        "Idempotency-Key must be 8-200 characters.",
      ),
    );
  }

  const db = getRuntimeDatabase();
  const path = new URL(request.url).pathname;
  const requestSha256 = sha256(raw);
  let reservationId: string | null = null;

  if (key) {
    const [reserved] = await db
      .insert(apiIdempotencyKeys)
      .values({
        organizationId: context.organizationId,
        apiClientId: context.clientId,
        idempotencyKey: key,
        requestMethod: request.method,
        requestPath: path,
        requestSha256,
      })
      .onConflictDoNothing()
      .returning({ id: apiIdempotencyKeys.id });

    if (!reserved) {
      const [existing] = await db
        .select()
        .from(apiIdempotencyKeys)
        .where(
          and(
            eq(apiIdempotencyKeys.apiClientId, context.clientId),
            eq(apiIdempotencyKeys.idempotencyKey, key),
          ),
        )
        .limit(1);
      if (
        !existing ||
        existing.requestMethod !== request.method ||
        existing.requestPath !== path ||
        existing.requestSha256 !== requestSha256
      ) {
        return problemResponse(
          context,
          new ApiProblem(
            422,
            "idempotency_key_reused",
            "Idempotency-Key was already used for a different request.",
          ),
        );
      }
      if (existing.responseStatus === null) {
        return problemResponse(
          context,
          new ApiProblem(
            409,
            "idempotency_in_progress",
            "The original request is still in progress.",
          ),
        );
      }
      return apiJson(context, existing.responseBody, {
        status: existing.responseStatus,
        headers: { "Idempotent-Replay": "true" },
      });
    }
    reservationId = reserved.id;
  }

  try {
    const result = await operation(body);
    if (result instanceof Response) {
      if (reservationId) await releaseReservation(reservationId);
      return result;
    }
    const status = result.status ?? 200;
    const payload = { data: result.data, ...(result.extra ?? {}) };
    if (reservationId) {
      await db
        .update(apiIdempotencyKeys)
        .set({
          responseStatus: status,
          responseBody: JSON.parse(
            JSON.stringify(
              result.replayData === undefined
                ? payload
                : { data: result.replayData, ...(result.extra ?? {}) },
            ),
          ),
          completedAt: new Date(),
        })
        .where(eq(apiIdempotencyKeys.id, reservationId));
    }
    return apiJson(context, payload, { status });
  } catch (error) {
    if (reservationId) await releaseReservation(reservationId);
    return problemResponse(context, problemFromError(error));
  }
}

async function releaseReservation(id: string) {
  await getRuntimeDatabase()
    .delete(apiIdempotencyKeys)
    .where(eq(apiIdempotencyKeys.id, id));
}

function problemResponse(
  context: ApiAuthorizationContext,
  problem: ApiProblem,
) {
  return apiJson(
    context,
    {
      error: {
        code: problem.code,
        message: problem.message,
        ...(problem.details !== undefined
          ? { details: problem.details }
          : {}),
      },
    },
    { status: problem.status },
  );
}

export function binaryResponse(
  context: ApiAuthorizationContext,
  data: Uint8Array,
  headers: Record<string, string>,
) {
  return new NextResponse(Buffer.from(data), {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-RateLimit-Limit": String(context.rateLimit),
      "X-RateLimit-Remaining": String(context.rateRemaining),
      ...headers,
    },
  });
}

export function requireUuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new ApiProblem(400, "invalid_id", `${name} must be a UUID.`);
  }
  return value;
}

export function optionalString(
  value: unknown,
  name: string,
  max = 2000,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) {
    throw invalid(`${name} must be a string of at most ${max} characters.`);
  }
  return value;
}

export function requiredString(
  value: unknown,
  name: string,
  max = 2000,
): string {
  const result = optionalString(value, name, max)?.trim();
  if (!result) throw invalid(`${name} is required.`);
  return result;
}
