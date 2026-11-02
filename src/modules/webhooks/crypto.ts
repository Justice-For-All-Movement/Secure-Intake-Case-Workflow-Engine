import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { env } from "@/lib/env";

function encryptionKey() {
  if (!env.WEBHOOK_ENCRYPTION_KEY) {
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY is required for webhook subscriptions.",
    );
  }
  return Buffer.from(env.WEBHOOK_ENCRYPTION_KEY, "hex");
}

export function encryptWebhookSecret(secret: string) {
  if (secret.length < 32 || secret.length > 256) {
    throw new Error("Webhook signing secret must be 32-256 characters.");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
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

export function decryptWebhookSecret(value: string) {
  const invalid = () => new Error("Webhook signing secret is invalid.");
  // Existing accepted secrets are at most 256 UTF-16 characters; 1024 bytes
  // conservatively covers their UTF-8 representation without unbounded decoding.
  if (typeof value !== "string" || value.length > 5 + 16 + 22 + Math.ceil(1024 * 4 / 3)) throw invalid();
  const components = value.split(".");
  const [version, ivValue, tagValue, ciphertextValue] = components;
  if (
    components.length !== 4 ||
    version !== "v1" ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue
  ) {
    throw invalid();
  }

  const decode = (component: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(component)) throw invalid();
    const bytes = Buffer.from(component, "base64url");
    if (bytes.toString("base64url") !== component) throw invalid();
    return bytes;
  };
  const iv = decode(ivValue), tag = decode(tagValue), ciphertext = decode(ciphertextValue);
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 1024) throw invalid();
  const key = encryptionKey();

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const secret = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (secret.length < 32 || secret.length > 256) throw invalid();
    return secret;
  } catch { throw invalid(); }
}

export function webhookSignature(
  secret: string,
  timestamp: string,
  body: string,
) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
}
