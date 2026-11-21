import { describe, expect, it } from "vitest";
import { generateKeyPair } from "./sealed-crypto";
import {
  parseSealingRecipients,
  requireSealingRecipients,
  SealingUnavailableError,
  sealingKeyId,
} from "./recipients";

async function entry() {
  const pair = await generateKeyPair();
  return { pair, value: { keyId: pair.id, label: "Laptop", publicJwk: pair.publicJwk } };
}

describe("SEALING_RECIPIENTS", () => {
  it("is unavailable when absent or empty", () => {
    expect(parseSealingRecipients(undefined)).toEqual({ status: "unconfigured" });
    expect(parseSealingRecipients("  ")).toEqual({ status: "unconfigured" });
    expect(() => requireSealingRecipients({ status: "unconfigured" })).toThrow(SealingUnavailableError);
  });

  it("accepts P-256 public keys whose keyId is the SHA-256 of the canonical JWK", async () => {
    const a = await entry();
    const b = await entry();
    const config = parseSealingRecipients(JSON.stringify([a.value, b.value]));
    expect(config.status).toBe("ready");
    if (config.status !== "ready") return;
    expect(config.recipients.map((r) => r.keyId)).toEqual([a.pair.id, b.pair.id]);
    expect(config.recipients[0].publicJwk).toEqual({ crv: "P-256", kty: "EC", x: a.pair.publicJwk.x, y: a.pair.publicJwk.y });
    expect(sealingKeyId(a.pair.publicJwk)).toBe(a.pair.id);
  });

  it.each([
    ["not JSON", () => "{nope"],
    ["an empty array", () => "[]"],
    ["an object instead of an array", () => "{}"],
  ])("rejects %s", (_name, make) => {
    expect(parseSealingRecipients(make()).status).toBe("invalid");
  });

  it("rejects a private key, a wrong fingerprint, another curve, an off-curve point, duplicates and extra fields", async () => {
    const a = await entry();
    const cases: unknown[] = [
      [{ ...a.value, publicJwk: { ...a.pair.privateJwk } }],
      [{ ...a.value, publicJwk: { ...a.pair.publicJwk, d: "x" } }],
      [{ ...a.value, keyId: "0".repeat(64) }],
      [{ ...a.value, keyId: undefined }],
      [{ ...a.value, publicJwk: { ...a.pair.publicJwk, crv: "P-384" } }],
      [{ ...a.value, publicJwk: { ...a.pair.publicJwk, kty: "OKP" } }],
      [{ ...a.value, publicJwk: { ...a.pair.publicJwk, y: a.pair.publicJwk.x } }],
      [a.value, a.value],
      [{ ...a.value, note: "plaintext" }],
      [{ ...a.value, label: "" }],
    ];
    for (const value of cases) {
      const parsed = parseSealingRecipients(JSON.stringify(value));
      expect(parsed.status, JSON.stringify(value).slice(0, 80)).toBe("invalid");
    }
    const withPrivate = parseSealingRecipients(JSON.stringify([{ ...a.value, publicJwk: a.pair.privateJwk }]));
    expect(withPrivate.status === "invalid" && withPrivate.error).toMatch(/private key/);
    // The error never echoes key material.
    expect(JSON.stringify(withPrivate)).not.toContain(String(a.pair.privateJwk.d));
  });
});
