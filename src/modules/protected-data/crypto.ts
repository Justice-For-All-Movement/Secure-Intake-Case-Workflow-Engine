import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { env } from "@/lib/env";

export interface ProtectedPayloadContext {
  organizationId: string;
  submissionId: string;
  compartmentKey: string;
}

const maxPlaintextBytes = 256 * 1024;
const maxEnvelopeCharacters = 5 + 16 + 22 + Math.ceil(maxPlaintextBytes * 4 / 3);
const invalidPayload = () => new Error("Protected payload is invalid.");

function decodeCanonicalComponent(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidPayload();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw invalidPayload();
  return bytes;
}

function encryptionKey() {
  if (!env.PROTECTED_DATA_ENCRYPTION_KEY) {
    throw new Error(
      "PROTECTED_DATA_ENCRYPTION_KEY is required when protected form fields are used.",
    );
  }
  return Buffer.from(env.PROTECTED_DATA_ENCRYPTION_KEY, "hex");
}

function authenticatedContext(context: ProtectedPayloadContext) {
  return Buffer.from(
    `protected-data:v1:${context.organizationId}:${context.submissionId}:${context.compartmentKey}`,
    "utf8",
  );
}

export function encryptProtectedPayload(
  payload: Record<string, unknown>,
  context: ProtectedPayloadContext,
) {
  const plaintext = JSON.stringify(payload);
  if (Buffer.byteLength(plaintext, "utf8") > maxPlaintextBytes) {
    throw new Error("Protected payload exceeds the 256 KiB limit.");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(authenticatedContext(context));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptProtectedPayload(
  value: string,
  context: ProtectedPayloadContext,
): Record<string, unknown> {
  if (typeof value !== "string" || value.length > maxEnvelopeCharacters) throw invalidPayload();
  const components = value.split(".");
  const [version, ivValue, tagValue, ciphertextValue] = components;
  if (
    components.length !== 4 ||
    version !== "v1" ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue
  ) {
    throw invalidPayload();
  }

  const iv = decodeCanonicalComponent(ivValue);
  const tag = decodeCanonicalComponent(tagValue);
  const ciphertext = decodeCanonicalComponent(ciphertextValue);
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > maxPlaintextBytes) throw invalidPayload();
  const key = encryptionKey();

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      iv,
    );
    decipher.setAAD(authenticatedContext(context));
    decipher.setAuthTag(tag);

    const decoded = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    const payload: unknown = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw invalidPayload();
    }
    return payload as Record<string, unknown>;
  } catch {
    // Do not expose authenticated plaintext fragments or cryptographic diagnostics.
    throw invalidPayload();
  }
}
