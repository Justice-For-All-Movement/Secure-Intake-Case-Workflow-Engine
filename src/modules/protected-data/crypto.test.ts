import { describe, expect, it, vi } from "vitest";
import { createCipheriv } from "node:crypto";
import { encryptProtectedPayload, decryptProtectedPayload } from "./crypto";

vi.mock("@/lib/env", () => ({ env: { PROTECTED_DATA_ENCRYPTION_KEY: "ab".repeat(32) } }));
const context = { organizationId: "test-org", submissionId: "test-submission", compartmentKey: "identity" };
const secret = { name: "Synthetic Person", email: "synthetic@example.invalid" };

describe("protected payload envelope", () => {
  it("round trips existing v1 format and randomizes the IV", () => {
    const first = encryptProtectedPayload(secret, context), second = encryptProtectedPayload(secret, context);
    expect(first.split(".")).toHaveLength(4);
    expect(first).not.toBe(second);
    expect(decryptProtectedPayload(first, context)).toEqual(secret);
    expect(decryptProtectedPayload(second, context)).toEqual(secret);
  });

  it.each(["organizationId", "submissionId", "compartmentKey"] as const)("binds %s through authenticated context", field => {
    const value = encryptProtectedPayload(secret, context);
    expect(() => decryptProtectedPayload(value, { ...context, [field]: "different" })).toThrow();
  });

  it("rejects appended segments and ignored base64 characters", () => {
    const value = encryptProtectedPayload(secret, context);
    for (const modified of [value + ".ignored", value + "!", value + "=", value + "\n"]) {
      expect(() => decryptProtectedPayload(modified, context)).toThrow("Protected payload is invalid.");
    }
  });

  it.each([1, 2, 3])("rejects authentication tampering in segment %s", segment => {
    const parts = encryptProtectedPayload(secret, context).split(".");
    parts[segment] = (parts[segment][0] === "A" ? "B" : "A") + parts[segment].slice(1);
    expect(() => decryptProtectedPayload(parts.join("."), context)).toThrow("Protected payload is invalid.");
  });

  it("rejects invalid version, component lengths and empty components", () => {
    const parts = encryptProtectedPayload(secret, context).split(".");
    for (const [index, replacement] of [[0, "v2"], [1, "a"], [2, "a"], [3, ""]] as const) {
      const changed = [...parts]; changed[index] = replacement;
      expect(() => decryptProtectedPayload(changed.join("."), context)).toThrow("Protected payload is invalid.");
    }
  });

  it("rejects noncanonical trailing base64 bits even when decoded bytes are identical", () => {
    const parts = encryptProtectedPayload(secret, context).split(".");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const tag = parts[2];
    parts[2] = tag.slice(0, -1) + alphabet[alphabet.indexOf(tag.at(-1)!) + 1];
    expect(Buffer.from(parts[2], "base64url")).toEqual(Buffer.from(tag, "base64url"));
    expect(() => decryptProtectedPayload(parts.join("."), context)).toThrow("Protected payload is invalid.");
  });

  it("bounds both encryption and decoding to 256 KiB of plaintext", () => {
    const payload = { data: "x".repeat(256 * 1024 - 11) };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBe(256 * 1024);
    expect(decryptProtectedPayload(encryptProtectedPayload(payload, context), context)).toEqual(payload);
    expect(() => encryptProtectedPayload({ data: payload.data + "x" }, context)).toThrow(/256 KiB/);
    expect(() => decryptProtectedPayload("v1." + "x".repeat(400000), context)).toThrow("Protected payload is invalid.");
  });

  it("does not expose authenticated malformed plaintext in errors", () => {
    const marker = "synthetic-sensitive-plaintext";
    const iv = Buffer.alloc(12, 1);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from("ab".repeat(32), "hex"), iv);
    cipher.setAAD(Buffer.from(`protected-data:v1:${context.organizationId}:${context.submissionId}:${context.compartmentKey}`));
    const encrypted = Buffer.concat([cipher.update("{" + marker), cipher.final()]);
    const value = ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
    expect(() => decryptProtectedPayload(value, context)).toThrow("Protected payload is invalid.");
  });
});
