import type { SealedEnvelope } from "./sealed-crypto";
import { parsePublicSealingJwk, type SealingRecipient } from "./recipients";

/**
 * Strict validation of a sealed envelope (format "pam-sealed", version 1)
 * produced by sealed-crypto.js `seal()` in the participant's browser. Only the
 * exact envelope shape is accepted — no other fields — so plaintext cannot
 * slip in next to the ciphertext by mistake. The server cannot check what is
 * inside; it checks the shape, the sizes and that every recipient is one of
 * the configured sealing keys.
 */
export class SealedEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedEnvelopeError";
  }
}

/** Largest ciphertext (base64 characters) accepted; matches the research application's limit. */
export const SEALED_CIPHERTEXT_MAX_CHARS = 40_000_000;
/** Largest serialized envelope accepted from a form or API request. */
export const SEALED_ENVELOPE_MAX_CHARS = 41_000_000;
/** Largest total size of files a participant may seal (raw bytes), enforced in the browser. */
export const SEALED_FILES_MAX_BYTES = 20_000_000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function fail(message: string): never {
  throw new SealedEnvelopeError(message);
}

function base64(value: unknown, what: string, decodedBytes?: number, maxChars = 128): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    value.length % 4 !== 0 ||
    !BASE64.test(value)
  ) {
    fail(`${what} must be base64`);
  }
  if (decodedBytes !== undefined && Buffer.from(value, "base64").length !== decodedBytes) {
    fail(`${what} has the wrong length`);
  }
  return value;
}

export interface CheckedSealedEnvelope {
  envelope: SealedEnvelope;
  commitment: string;
  recipientKeyIds: string[];
  serialized: string;
  sizeBytes: number;
}

export function checkSealedEnvelope(
  value: unknown,
  recipients: readonly SealingRecipient[],
): CheckedSealedEnvelope {
  const e = value as Record<string, unknown> | null;
  if (!e || typeof e !== "object" || Array.isArray(e)) fail("envelope must be an object");
  const allowed = ["format", "v", "alg", "iv", "ciphertext", "recipients", "commitment"];
  const extra = Object.keys(e).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    fail(`envelope has fields that are not part of a sealed envelope: ${extra.slice(0, 5).join(", ")}`);
  }
  if (e.format !== "pam-sealed" || e.v !== 1 || e.alg !== "ECDH-P256+HKDF-SHA256+A256GCM") {
    fail("unknown envelope format");
  }
  const iv = base64(e.iv, "iv", 12);
  // AES-GCM output is at least the 16-byte tag.
  const ciphertext = base64(e.ciphertext, "ciphertext", undefined, SEALED_CIPHERTEXT_MAX_CHARS);
  if (ciphertext.length < 24) fail("ciphertext is too short");
  if (typeof e.commitment !== "string" || !/^[0-9a-f]{64}$/.test(e.commitment)) {
    fail("commitment must be a SHA-256 hex digest");
  }
  if (!Array.isArray(e.recipients) || e.recipients.length < 1 || e.recipients.length > 50) {
    fail("recipients must list 1-50 wrapped keys");
  }
  const configured = new Set(recipients.map((recipient) => recipient.keyId));
  const seen = new Set<string>();
  const wrapped = (e.recipients as unknown[]).map((entry) => {
    const r = entry as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || Array.isArray(r)) fail("recipient entries must be objects");
    const extraR = Object.keys(r).filter(
      (key) => !["keyId", "epk", "salt", "iv", "wrappedKey"].includes(key),
    );
    if (extraR.length > 0) fail("recipient entries have unexpected fields");
    if (typeof r.keyId !== "string" || !/^[0-9a-f]{64}$/.test(r.keyId)) {
      fail("recipient keyId must be a key fingerprint");
    }
    if (!configured.has(r.keyId)) fail("envelope is sealed for a key that is not a configured sealing recipient");
    if (seen.has(r.keyId)) fail("envelope lists a recipient twice");
    seen.add(r.keyId);
    let epk;
    try {
      epk = parsePublicSealingJwk(r.epk);
    } catch {
      fail("recipient epk must be a P-256 public key");
    }
    return {
      keyId: r.keyId,
      epk,
      salt: base64(r.salt, "recipient salt", 16),
      iv: base64(r.iv, "recipient iv", 12),
      wrappedKey: base64(r.wrappedKey, "recipient wrappedKey", 48),
    };
  });

  // Rebuilt from validated parts only, with a fixed key order.
  const envelope: SealedEnvelope = {
    format: "pam-sealed",
    v: 1,
    alg: "ECDH-P256+HKDF-SHA256+A256GCM",
    iv,
    ciphertext,
    recipients: wrapped,
    commitment: e.commitment,
  };
  const serialized = JSON.stringify(envelope);
  return {
    envelope,
    commitment: envelope.commitment,
    recipientKeyIds: wrapped.map((r) => r.keyId),
    serialized,
    sizeBytes: Buffer.byteLength(serialized, "utf8"),
  };
}

/** Parses the serialized envelope a form posts (field `__sealed`). */
export function parseSealedEnvelopeText(
  raw: string,
  recipients: readonly SealingRecipient[],
): CheckedSealedEnvelope {
  if (raw.length > SEALED_ENVELOPE_MAX_CHARS) fail("envelope is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("envelope is not valid JSON");
  }
  return checkSealedEnvelope(parsed, recipients);
}
