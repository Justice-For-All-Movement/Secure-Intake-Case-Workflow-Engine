import { getRuntimeDatabase } from "@/db/runtime";
import {
  authorizePlatformRequest,
  ensureOrganization,
  platformJson,
} from "@/modules/integration/platform";

export async function POST(request: Request) {
  const auth = authorizePlatformRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const result = await ensureOrganization(getRuntimeDatabase(), {
      slug: String(body.slug ?? ""),
      name: String(body.name ?? ""),
    });
    return platformJson(
      {
        data: {
          id: result.organization.id,
          slug: result.organization.slug,
          name: result.organization.name,
          status: result.organization.status,
          created: result.created,
        },
      },
      result.created ? 201 : 200,
    );
  } catch (error) {
    return platformJson(
      {
        error: {
          code: "invalid_request",
          message:
            error instanceof Error && error.message.startsWith("slug")
              ? error.message
              : "Organization could not be provisioned.",
        },
      },
      400,
    );
  }
}
