import { describe, expect, it, vi } from "vitest";
import { webhookSignature, encryptWebhookSecret, decryptWebhookSecret } from "./crypto";

vi.mock("@/lib/env", () => ({ env: { WEBHOOK_ENCRYPTION_KEY: "cd".repeat(32) } }));

describe("webhook signatures", () => {
  it.each(["x".repeat(32), "x".repeat(256), "界".repeat(256)])("preserves supported secret round trips", secret => {
    const value = encryptWebhookSecret(secret);
    expect(decryptWebhookSecret(value)).toBe(secret);
    expect(encryptWebhookSecret(secret)).not.toBe(value);
  });

  it("rejects alternate envelope encodings and extra segments", () => {
    const value = encryptWebhookSecret("x".repeat(32));
    for (const invalid of [value + ".ignored", value + "!", value + "=", value + "\n", "v1." + "x".repeat(2000)]) {
      expect(() => decryptWebhookSecret(invalid)).toThrow("Webhook signing secret is invalid.");
    }
    const parts = value.split("."), alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    parts[2] = parts[2].slice(0, -1) + alphabet[alphabet.indexOf(parts[2].at(-1)!) + 1];
    expect(() => decryptWebhookSecret(parts.join("."))).toThrow("Webhook signing secret is invalid.");
  });

  it.each([1, 2, 3])("rejects tampered secret segment %s with a categorical error", segment => {
    const parts = encryptWebhookSecret("x".repeat(32)).split(".");
    parts[segment] = (parts[segment][0] === "A" ? "B" : "A") + parts[segment].slice(1);
    expect(() => decryptWebhookSecret(parts.join("."))).toThrow("Webhook signing secret is invalid.");
  });
  it("signs timestamp and exact body deterministically", () => {
    const signature = webhookSignature(
      "01234567890123456789012345678901",
      "1730000000",
      '{"type":"case.created"}',
    );
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(
      webhookSignature(
        "01234567890123456789012345678901",
        "1730000000",
        '{"type":"case.created"}',
      ),
    ).toBe(signature);
    expect(
      webhookSignature(
        "01234567890123456789012345678901",
        "1730000001",
        '{"type":"case.created"}',
      ),
    ).not.toBe(signature);
  });
});
