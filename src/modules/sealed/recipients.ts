import { createHash, createPublicKey } from "node:crypto";

/**
 * Sealing recipients: the public keys answers marked `sealed: true` are
 * encrypted to in the participant's browser. Configured as deployment data in
 * SEALING_RECIPIENTS, a JSON array of `{ keyId, label, publicJwk }` (the
 * research team's public sealing keys). Private keys never reach this
 * application, so it can store sealed answers but never read them.
 *
 * Absent → sealing is unavailable (the default): forms with sealed fields
 * cannot be published and their sealed fields are disabled.
 * Invalid → also unavailable, with the reason (never a partial key set).
 */
export interface SealingRecipient {
  keyId: string;
  label: string;
  publicJwk: { crv: "P-256"; kty: "EC"; x: string; y: string };
}

export type SealingConfig =
  | { status: "unconfigured" }
  | { status: "invalid"; error: string }
  | { status: "ready"; recipients: readonly SealingRecipient[] };

export class SealingUnavailableError extends Error {
  constructor(reason: string) {
    super(`Sealed answers are unavailable: ${reason}`);
    this.name = "SealingUnavailableError";
  }
}

export const MAX_SEALING_RECIPIENTS = 50;

/** Canonical JSON (sorted keys), identical to sealed-crypto.js `canonical`. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Key id: SHA-256 hex of the canonical {crv,kty,x,y}, as sealed-crypto.js `keyId`. */
export function sealingKeyId(jwk: { crv: string; kty: string; x: string; y: string }) {
  const { crv, kty, x, y } = jwk;
  return createHash("sha256")
    .update(canonicalJson({ crv, kty, x, y }))
    .digest("hex");
}

const coordinate = /^[A-Za-z0-9_-]{43}$/;

/** A P-256 public JWK (never a private key), reduced to {crv,kty,x,y}. */
export function parsePublicSealingJwk(
  value: unknown,
): SealingRecipient["publicJwk"] {
  const jwk = value as Record<string, unknown> | null;
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) {
    throw new Error("publicJwk must be an object");
  }
  if ("d" in jwk) {
    throw new Error("publicJwk contains a private key (d); only public keys belong here");
  }
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string" ||
    !coordinate.test(jwk.x) ||
    !coordinate.test(jwk.y)
  ) {
    throw new Error("publicJwk must be an EC P-256 public key");
  }
  const reduced = { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y } as const;
  try {
    // Rejects coordinates that are not a point on the curve.
    createPublicKey({ key: reduced, format: "jwk" });
  } catch {
    throw new Error("publicJwk is not a valid P-256 point");
  }
  return reduced;
}

export function parseSealingRecipients(raw: string | undefined | null): SealingConfig {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return { status: "unconfigured" };
  }
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("SEALING_RECIPIENTS is not valid JSON");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("SEALING_RECIPIENTS must be a non-empty JSON array");
    }
    if (parsed.length > MAX_SEALING_RECIPIENTS) {
      throw new Error(`SEALING_RECIPIENTS may list at most ${MAX_SEALING_RECIPIENTS} keys`);
    }
    const seen = new Set<string>();
    const recipients = parsed.map((entry, index): SealingRecipient => {
      const where = `SEALING_RECIPIENTS[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`${where} must be an object`);
      }
      const record = entry as Record<string, unknown>;
      const extra = Object.keys(record).filter(
        (key) => !["keyId", "label", "publicJwk"].includes(key),
      );
      if (extra.length > 0) {
        throw new Error(`${where} has unexpected fields: ${extra.join(", ")}`);
      }
      if (
        typeof record.label !== "string" ||
        record.label.trim() === "" ||
        record.label.length > 100
      ) {
        throw new Error(`${where}.label must be 1-100 characters`);
      }
      let publicJwk: SealingRecipient["publicJwk"];
      try {
        publicJwk = parsePublicSealingJwk(record.publicJwk);
      } catch (error) {
        throw new Error(`${where}: ${(error as Error).message}`);
      }
      const expected = sealingKeyId(publicJwk);
      if (typeof record.keyId !== "string" || record.keyId !== expected) {
        throw new Error(`${where}.keyId does not match the SHA-256 fingerprint of its public key`);
      }
      if (seen.has(expected)) throw new Error(`${where} repeats a key`);
      seen.add(expected);
      return { keyId: expected, label: record.label.trim(), publicJwk };
    });
    return { status: "ready", recipients };
  } catch (error) {
    return { status: "invalid", error: (error as Error).message };
  }
}

let cached: { raw: string | undefined; config: SealingConfig } | null = null;

/** The deployment's sealing configuration (SEALING_RECIPIENTS). */
export function sealingConfig(): SealingConfig {
  const raw = process.env.SEALING_RECIPIENTS;
  if (!cached || cached.raw !== raw) {
    cached = { raw, config: parseSealingRecipients(raw) };
  }
  return cached.config;
}

export function requireSealingRecipients(
  config: SealingConfig = sealingConfig(),
): readonly SealingRecipient[] {
  if (config.status === "ready") return config.recipients;
  throw new SealingUnavailableError(
    config.status === "unconfigured"
      ? "SEALING_RECIPIENTS is not configured in this deployment."
      : `SEALING_RECIPIENTS is invalid (${config.error}).`,
  );
}
