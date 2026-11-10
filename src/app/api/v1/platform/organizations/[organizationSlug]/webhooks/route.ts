import { getRuntimeDatabase } from "@/db/runtime";
import {
  authorizePlatformRequest,
  findOrganizationBySlug,
  platformJson,
  provisionWebhook,
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
    const { subscription, signingSecret } = await provisionWebhook(
      db,
      organization.id,
      {
        name: String(body.name ?? ""),
        endpointUrl: String(body.endpointUrl ?? ""),
        eventTypes: Array.isArray(body.eventTypes)
          ? body.eventTypes.map(String)
          : [],
      },
    );
    return platformJson(
      {
        data: {
          id: subscription.id,
          name: subscription.name,
          endpointUrl: subscription.endpointUrl,
          eventTypes: subscription.eventTypes,
          status: subscription.status,
          // Shown exactly once; stored encrypted.
          signingSecret,
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
              : "Webhook could not be created.",
        },
      },
      400,
    );
  }
}
