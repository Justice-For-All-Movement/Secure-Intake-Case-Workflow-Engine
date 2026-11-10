import { getRuntimeDatabase } from "@/db/runtime";
import {
  authorizePlatformRequest,
  findOrganizationBySlug,
  platformJson,
  provisionApiClient,
} from "@/modules/integration/platform";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ organizationSlug: string }> },
) {
  const auth = authorizePlatformRequest(request);
  if (!auth.ok) return auth.response;
  const db = getRuntimeDatabase();
  const organization = await findOrganizationBySlug(
    db,
    (await params).organizationSlug,
  );
  if (!organization) {
    return platformJson(
      { error: { code: "not_found", message: "Organization not found." } },
      404,
    );
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const expiresAt = body.expiresAt ? new Date(String(body.expiresAt)) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new Error("expiresAt is invalid.");
    }
    const { client, token } = await provisionApiClient(db, organization.id, {
      name: String(body.name ?? ""),
      permissions: Array.isArray(body.permissions)
        ? body.permissions.map(String)
        : [],
      expiresAt,
    });
    return platformJson(
      {
        data: {
          id: client.id,
          name: client.name,
          keyPrefix: client.keyPrefix,
          permissions: client.permissions,
          expiresAt: client.expiresAt,
          // Shown exactly once; only its SHA-256 is stored.
          token,
        },
      },
      201,
    );
  } catch (error) {
    return platformJson(
      {
        error: {
          code: "invalid_request",
          message:
            error instanceof Error && !/query|relation|constraint/i.test(error.message)
              ? error.message.slice(0, 300)
              : "API client could not be created.",
        },
      },
      400,
    );
  }
}
