import { beforeAll, describe, expect, it } from "vitest";
import { seal } from "./sealed-crypto";
import { parseSealingRecipients, type SealingRecipient } from "./recipients";
import {
  checkSealedEnvelope,
  parseSealedEnvelopeText,
  SealedEnvelopeError,
  SEALED_ENVELOPE_MAX_CHARS,
} from "./envelope";
import { testSealingKeys } from "./test-keys";

let recipients: readonly SealingRecipient[];
let other: readonly SealingRecipient[];
let envelope: Record<string, unknown>;

beforeAll(async () => {
  const keys = await testSealingKeys(2);
  const config = parseSealingRecipients(keys.config);
  if (config.status !== "ready") throw new Error("test keys rejected");
  recipients = config.recipients;
  const otherKeys = await testSealingKeys(1);
  const otherConfig = parseSealingRecipients(otherKeys.config);
  if (otherConfig.status !== "ready") throw new Error("test keys rejected");
  other = otherConfig.recipients;
  envelope = (await seal({ text: "secret words" }, keys.recipients)) as unknown as Record<string, unknown>;
});

const mutate = (change: (e: Record<string, any>) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const copy = structuredClone(envelope) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  change(copy);
  return copy;
};

describe("sealed envelope validation", () => {
  it("accepts an envelope from seal() for the configured keys and keeps only envelope fields", () => {
    const checked = checkSealedEnvelope(envelope, recipients);
    expect(checked.commitment).toBe(envelope.commitment);
    expect(checked.recipientKeyIds).toEqual(recipients.map((r) => r.keyId));
    expect(JSON.parse(checked.serialized)).toEqual(envelope);
    expect(checked.serialized.startsWith('{"format":"pam-sealed"')).toBe(true);
    expect(checked.serialized).not.toContain("secret words");
    expect(parseSealedEnvelopeText(JSON.stringify(envelope), recipients).commitment).toBe(envelope.commitment);
  });

  it("refuses anything next to the ciphertext (plaintext cannot slip in)", () => {
    expect(() => checkSealedEnvelope(mutate((e) => { e.text = "secret words"; }), recipients)).toThrow(/not part of a sealed envelope/);
    expect(() => checkSealedEnvelope(mutate((e) => { e.recipients[0].note = "x"; }), recipients)).toThrow(SealedEnvelopeError);
  });

  it("refuses keys that are not configured recipients, and repeated recipients", () => {
    expect(() => checkSealedEnvelope(envelope, other)).toThrow(/not a configured sealing recipient/);
    expect(() => checkSealedEnvelope(mutate((e) => { e.recipients.push(e.recipients[0]); }), recipients)).toThrow(/twice/);
  });

  it.each([
    ["unknown format", (e: Record<string, any>) => { e.format = "other"; }], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["unknown version", (e: Record<string, any>) => { e.v = 2; }], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["non-base64 ciphertext", (e: Record<string, any>) => { e.ciphertext = "not base64!"; }], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["plain text as ciphertext", (e: Record<string, any>) => { e.ciphertext = "secret words"; }], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["short iv", (e: Record<string, any>) => { e.iv = "AAAA"; }], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["bad commitment", (e: Record<string, any>) => { e.commitment = "abc"; }], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["no recipients", (e: Record<string, any>) => { e.recipients = []; }], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["private ephemeral key", (e: Record<string, any>) => { e.recipients[0].epk.d = "AAAA"; }], // eslint-disable-line @typescript-eslint/no-explicit-any
    ["bad wrapped key", (e: Record<string, any>) => { e.recipients[0].wrappedKey = "AAAA"; }], // eslint-disable-line @typescript-eslint/no-explicit-any
  ])("refuses %s", (_name, change) => {
    expect(() => checkSealedEnvelope(mutate(change), recipients)).toThrow(SealedEnvelopeError);
  });

  it("refuses non-objects, invalid JSON and oversized input without parsing it", () => {
    for (const value of [null, "x", [], 1]) expect(() => checkSealedEnvelope(value, recipients)).toThrow(SealedEnvelopeError);
    expect(() => parseSealedEnvelopeText("{", recipients)).toThrow(/not valid JSON/);
    expect(() => parseSealedEnvelopeText("x".repeat(SEALED_ENVELOPE_MAX_CHARS + 1), recipients)).toThrow(/too large/);
  });
});
