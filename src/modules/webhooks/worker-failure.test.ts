import { describe, expect, it, vi, afterEach } from "vitest";
import { deliverWebhookJob } from "./worker";

vi.mock("@/db/schema", () => ({
  auditEvents: { id: "id", organizationId: "organizationId" },
  webhookDeliveries: { id: "id", organizationId: "organizationId", subscriptionId: "subscriptionId", auditEventId: "auditEventId", attemptCount: "attemptCount" },
  webhookSubscriptions: { id: "id", organizationId: "organizationId" },
}));
vi.mock("./crypto", () => ({ decryptWebhookSecret: () => "synthetic-test-secret", webhookSignature: () => "synthetic-signature" }));
vi.mock("./policy", () => ({ assertWebhookDestinationPublic: async () => undefined }));
afterEach(() => vi.unstubAllGlobals());

describe("webhook failure diagnostics", () => {
  it.each([
    { finalAttempt: false, httpStatus: null }, { finalAttempt: true, httpStatus: null },
    { finalAttempt: false, httpStatus: 503 }, { finalAttempt: true, httpStatus: 503 },
  ])("never persists or rethrows private diagnostics ($finalAttempt/$httpStatus)", async ({ finalAttempt, httpStatus }) => {
    const marker = "synthetic-sensitive-provider-detail";
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (httpStatus !== null) return new Response(marker, { status: httpStatus });
      throw new Error(marker);
    }));
    const updates: Record<string, unknown>[] = [];
    const row = {
      delivery: { id: "delivery", status: "pending" },
      subscription: { status: "active", endpointUrl: "https://receiver.example.invalid/hook", signingSecretCiphertext: "synthetic" },
      event: { action: "case.created", occurredAt: new Date(0), organizationId: "org", resourceType: "case", resourceId: "case-id", metadata: {} },
    };
    const query = { from: vi.fn(), innerJoin: vi.fn(), where: vi.fn(), limit: vi.fn(async () => [row]) };
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const db = {
      select: () => query,
      update: () => ({ set: (value: Record<string, unknown>) => {
        updates.push(value); return { where: async () => undefined };
      } }),
    };
    const expected = httpStatus === null ? "Webhook delivery failed." : `Webhook delivery failed with HTTP ${httpStatus}.`;
    await expect(deliverWebhookJob({ db, scope: { organizationId: "org" }, job: { payload: { deliveryId: "delivery" } }, finalAttempt } as unknown as Parameters<typeof deliverWebhookJob>[0]))
      .rejects.toThrow(expected);
    expect(updates.at(-1)?.status).toBe(finalAttempt ? "failed" : "pending");
    expect(updates.at(-1)?.lastError).toBe(expected);
    expect(JSON.stringify(updates)).not.toContain(marker);
  });
});
