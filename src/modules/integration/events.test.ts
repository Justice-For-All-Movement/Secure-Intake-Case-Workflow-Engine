import { afterEach, describe, expect, it } from "vitest";
import {
  decodeEventCursor,
  encodeEventCursor,
  integrationEventFromRow,
  InvalidEventCursorError,
} from "./events";
import {
  assertWebhookDestinationPublic,
  normalizeWebhookUrl,
} from "@/modules/webhooks/policy";

describe("event cursor", () => {
  it("round-trips and rejects anything else", () => {
    const cursor = encodeEventCursor(18737, 14);
    expect(decodeEventCursor(cursor)).toEqual({ txid: 18737, sequence: 14 });
    for (const bad of ["", "abc", Buffer.from("v2.1.1").toString("base64url"), Buffer.from("v1.1.1; drop").toString("base64url"), "x".repeat(200)]) {
      expect(() => decodeEventCursor(bad)).toThrow(InvalidEventCursorError);
    }
  });

  it("uses the public type and keeps the internal action", () => {
    const event = integrationEventFromRow({
      id: "e1", txid: "5", sequence: "9", eventType: "case.opened", action: "case.created",
      occurredAt: "2026-01-01T00:00:00Z", resourceType: "case", resourceId: "c1",
      parentResourceType: "submission", parentResourceId: "s1", actorType: "system",
      source: "api", correlationId: "k", previousState: null, newState: { status: "a" }, metadata: null,
    });
    expect(event).toMatchObject({ type: "case.opened", action: "case.created", sequence: 9, metadata: {} });
    expect(decodeEventCursor(event.cursor)).toEqual({ txid: 5, sequence: 9 });
  });
});

describe("private webhook origins need explicit operator approval", () => {
  const saved = process.env.WEBHOOK_ALLOWED_PRIVATE_ORIGINS;
  afterEach(() => {
    if (saved === undefined) delete process.env.WEBHOOK_ALLOWED_PRIVATE_ORIGINS;
    else process.env.WEBHOOK_ALLOWED_PRIVATE_ORIGINS = saved;
  });

  it("allows only the exact approved origin", async () => {
    delete process.env.WEBHOOK_ALLOWED_PRIVATE_ORIGINS;
    expect(() => normalizeWebhookUrl("http://127.0.0.1:8090/hook")).toThrow();
    process.env.WEBHOOK_ALLOWED_PRIVATE_ORIGINS = "http://127.0.0.1:8090, not a url";
    expect(normalizeWebhookUrl("http://127.0.0.1:8090/hook#x")).toBe("http://127.0.0.1:8090/hook");
    await expect(assertWebhookDestinationPublic("http://127.0.0.1:8090/hook")).resolves.toBeUndefined();
    expect(() => normalizeWebhookUrl("http://127.0.0.1:8091/hook")).toThrow();
    expect(() => normalizeWebhookUrl("http://user:pw@127.0.0.1:8090/hook")).toThrow();
    expect(() => normalizeWebhookUrl("https://127.0.0.1/hook")).toThrow();
  });
});
