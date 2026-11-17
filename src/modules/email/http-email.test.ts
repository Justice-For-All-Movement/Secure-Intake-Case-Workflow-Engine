import { describe, expect, it } from "vitest";
import {
  createEmailCommunicationTransport,
  createEmailNotificationTransport,
  emailConfigFromEnvironment,
  HttpEmailSender,
  parseSenderAddress,
} from "./http-email";
import { createConfiguredBackgroundJobHandlers } from "@/modules/jobs/worker";

const base = {
  EMAIL_TRANSPORT_DRIVER: "http",
  EMAIL_HTTP_URL: "https://mail.example.org/emails",
  EMAIL_FROM: "Intake <noreply@example.org>",
  EMAIL_HTTP_TOKEN: "secret-token-value",
};

function recorder(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("email configuration", () => {
  it("is disabled unless the driver is http", () => {
    expect(emailConfigFromEnvironment({})).toBeNull();
    expect(emailConfigFromEnvironment({ EMAIL_TRANSPORT_DRIVER: "none" })).toBeNull();
    expect(() => emailConfigFromEnvironment({ EMAIL_TRANSPORT_DRIVER: "smtp" })).toThrow(
      /must be `http` or `none`/,
    );
  });

  it("accepts a complete HTTPS configuration", () => {
    const config = emailConfigFromEnvironment(base);
    expect(config?.endpoint.href).toBe("https://mail.example.org/emails");
    expect(config?.timeoutMs).toBe(30000);
    expect(config?.provider).toBe("http-email");
  });

  it("rejects unsafe endpoints without echoing values", () => {
    for (const url of [
      "http://mail.example.org/emails",
      "https://user:pw@mail.example.org/emails",
      "https://mail.example.org/emails?key=abc",
      "https://mail.example.org/emails#x",
      "not a url",
    ]) {
      let message = "";
      try {
        emailConfigFromEnvironment({ ...base, EMAIL_HTTP_URL: url });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/EMAIL_HTTP_URL/);
      expect(message).not.toContain("abc");
      expect(message).not.toContain("pw");
    }
    expect(
      emailConfigFromEnvironment({ ...base, EMAIL_HTTP_URL: "http://127.0.0.1:8025/emails" })
        ?.endpoint.port,
    ).toBe("8025");
  });

  it("validates sender, token, timeout and provider", () => {
    expect(() => emailConfigFromEnvironment({ ...base, EMAIL_FROM: "" })).toThrow(/EMAIL_FROM/);
    expect(() => emailConfigFromEnvironment({ ...base, EMAIL_FROM: "x\r\nBcc: a@b.c" })).toThrow(
      /EMAIL_FROM/,
    );
    expect(() => emailConfigFromEnvironment({ ...base, EMAIL_HTTP_TOKEN: "a b" })).toThrow(
      /EMAIL_HTTP_TOKEN/,
    );
    expect(() => emailConfigFromEnvironment({ ...base, EMAIL_HTTP_TIMEOUT_MS: "10" })).toThrow(
      /EMAIL_HTTP_TIMEOUT_MS/,
    );
    expect(() => emailConfigFromEnvironment({ ...base, EMAIL_PROVIDER: "bad provider!" })).toThrow(
      /EMAIL_PROVIDER/,
    );
    expect(parseSenderAddress("noreply@example.org")).toBe("noreply@example.org");
    expect(parseSenderAddress("Example Office <noreply@example.org>")).toBe(
      "Example Office <noreply@example.org>",
    );
  });
});

describe("HTTP email sender", () => {
  const config = emailConfigFromEnvironment(base)!;

  it("posts one JSON message with bearer token and idempotency key", async () => {
    const { calls, fetcher } = recorder(() => Response.json({ id: "provider-42" }));
    const sender = new HttpEmailSender(config, fetcher);
    const result = await sender.send({
      idempotencyKey: "notification-abc",
      to: ["Person@Example.org"],
      bcc: ["audit@example.org"],
      subject: "Line one\r\nInjected: header",
      text: "Body",
      replyTo: "office@example.org",
    });
    expect(result.externalMessageId).toBe("provider-42");
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-token-value");
    expect(headers["idempotency-key"]).toBe("notification-abc");
    expect(calls[0].init.redirect).toBe("manual");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      from: "Intake <noreply@example.org>",
      to: ["person@example.org"],
      bcc: ["audit@example.org"],
      subject: "Line one Injected: header",
      text: "Body",
      reply_to: "office@example.org",
    });
  });

  it("fails on non-2xx, redirects and transport errors without upstream text", async () => {
    for (const status of [302, 400, 401, 500]) {
      const { fetcher } = recorder(
        () => new Response("upstream secret detail", { status, headers: status === 302 ? { location: "https://elsewhere" } : {} }),
      );
      const sender = new HttpEmailSender(config, fetcher);
      await expect(
        sender.send({ idempotencyKey: "k1", to: ["a@example.org"], subject: "s", text: "t" }),
      ).rejects.toThrow(new RegExp(`^Email provider returned HTTP ${status}\\.$`));
    }
    const failing = new HttpEmailSender(config, (async () => {
      throw new Error("getaddrinfo ENOTFOUND internal-host secret");
    }) as typeof fetch);
    await expect(
      failing.send({ idempotencyKey: "k1", to: ["a@example.org"], subject: "s", text: "t" }),
    ).rejects.toThrow(/^Email provider could not be reached\.$/);
  });

  it("bounds the response and ignores malformed ids", async () => {
    const big = new HttpEmailSender(config, recorder(() => new Response("x".repeat(70 * 1024))).fetcher);
    await expect(
      big.send({ idempotencyKey: "k1", to: ["a@example.org"], subject: "s", text: "t" }),
    ).rejects.toThrow(/64 KiB/);
    const odd = new HttpEmailSender(config, recorder(() => Response.json({ id: "bad id\nx" })).fetcher);
    await expect(
      odd.send({ idempotencyKey: "k1", to: ["a@example.org"], subject: "s", text: "t" }),
    ).resolves.toEqual({ externalMessageId: null });
    const empty = new HttpEmailSender(config, recorder(() => new Response(null, { status: 202 })).fetcher);
    await expect(
      empty.send({ idempotencyKey: "k1", to: ["a@example.org"], subject: "s", text: "t" }),
    ).resolves.toEqual({ externalMessageId: null });
  });

  it("rejects messages without valid recipients, subject or key", async () => {
    const { calls, fetcher } = recorder(() => Response.json({}));
    const sender = new HttpEmailSender(config, fetcher);
    await expect(sender.send({ idempotencyKey: "k1", to: [], subject: "s", text: "t" })).rejects.toThrow(
      /no recipients/,
    );
    await expect(
      sender.send({ idempotencyKey: "k1", to: ["not-an-address"], subject: "s", text: "t" }),
    ).rejects.toThrow(/recipient is invalid/);
    await expect(
      sender.send({ idempotencyKey: "k1", to: ["a@example.org"], subject: " \n ", text: "t" }),
    ).rejects.toThrow(/subject is empty/);
    await expect(
      sender.send({ idempotencyKey: "bad key", to: ["a@example.org"], subject: "s", text: "t" }),
    ).rejects.toThrow(/idempotency key/);
    expect(calls).toHaveLength(0);
  });
});

describe("email transports", () => {
  const config = emailConfigFromEnvironment(base)!;

  it("delivers notifications with the link appended", async () => {
    const { calls, fetcher } = recorder(() => Response.json({ id: "n1" }));
    const transport = createEmailNotificationTransport(new HttpEmailSender(config, fetcher));
    expect(transport.channel).toBe("email");
    await transport.send({
      idempotencyKey: "delivery-1",
      channel: "email",
      destination: "member@example.org",
      eventType: "case.assigned",
      severity: "info",
      title: "Assigned",
      body: "A case was assigned.",
      link: "https://intake.example.org/admin/cases/1",
      resourceType: "case",
      resourceId: "1",
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.to).toEqual(["member@example.org"]);
    expect(body.text).toBe("A case was assigned.\n\nhttps://intake.example.org/admin/cases/1");
    expect((calls[0].init.headers as Record<string, string>)["idempotency-key"]).toBe(
      "notification-delivery-1",
    );
  });

  it("delivers email correspondence and refuses attachments rather than dropping them", async () => {
    const { calls, fetcher } = recorder(() => Response.json({ id: "c1" }));
    const transport = createEmailCommunicationTransport(new HttpEmailSender(config, fetcher));
    expect(transport.supportedChannels).toEqual(["email"]);
    const request = {
      idempotencyKey: "message-1",
      channel: "email" as const,
      senderAddress: "caseworker@example.org",
      recipients: [
        { type: "to" as const, address: "party@example.org" },
        { type: "cc" as const, address: "copy@example.org" },
      ],
      subject: "Your case",
      body: "Hello",
      attachments: [],
    };
    await expect(transport.send(request)).resolves.toEqual({ externalMessageId: "c1" });
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      to: ["party@example.org"],
      cc: ["copy@example.org"],
      reply_to: "caseworker@example.org",
    });
    await expect(
      transport.send({
        ...request,
        attachments: [{ documentVersionId: "d", filename: "f.pdf", mimeType: "application/pdf", sha256: "0".repeat(64) }],
      }),
    ).rejects.toThrow(/does not send attachments/);
    expect(calls).toHaveLength(1);
  });
});

describe("worker handler registration", () => {
  it("claims external delivery jobs only when a provider is configured", () => {
    const core = createConfiguredBackgroundJobHandlers({});
    expect([...core.keys()].sort()).toEqual([
      "deadline.sweep",
      "document.scan",
      "retention.sweep",
      "review.sweep",
      "webhook.deliver",
    ]);
    const withEmail = createConfiguredBackgroundJobHandlers(base);
    expect(withEmail.has("notification.deliver")).toBe(true);
    expect(withEmail.has("correspondence.deliver")).toBe(true);
    expect(() =>
      createConfiguredBackgroundJobHandlers({ ...base, EMAIL_HTTP_URL: "http://example.org" }),
    ).toThrow(/EMAIL_HTTP_URL/);
  });
});
