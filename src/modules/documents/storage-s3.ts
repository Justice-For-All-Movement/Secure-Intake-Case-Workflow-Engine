import {
  createHash,
  createHmac,
} from "node:crypto";
import type { DocumentStorageAdapter } from "./storage";

interface S3StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function sha256Hex(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(
  key: Uint8Array | string,
  value: string,
): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signingKey(
  secret: string,
  date: string,
  region: string,
) {
  const dateKey = hmac("AWS4" + secret, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function encodedPath(...parts: string[]) {
  return (
    "/" +
    parts
      .map((part) =>
        part
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/"),
      )
      .join("/")
  );
}

export class S3CompatibleStorageAdapter
  implements DocumentStorageAdapter
{
  readonly driver = "s3";

  private readonly endpoint: URL;

  constructor(private readonly config: S3StorageConfig) {
    this.endpoint = new URL(config.endpoint);
    if (
      this.endpoint.protocol !== "https:" ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    ) {
      throw new Error(
        "DOCUMENT_S3_ENDPOINT must be a bare HTTPS URL.",
      );
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.request("PUT", key, data);
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.request("GET", key);
    return new Uint8Array(await response.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    await this.request("DELETE", key);
  }

  private async request(
    method: "GET" | "PUT" | "DELETE",
    key: string,
    body?: Uint8Array,
  ): Promise<Response> {
    if (
      !/^[a-zA-Z0-9/_-]+$/.test(key) ||
      key.includes("..")
    ) {
      throw new Error("Invalid document storage key.");
    }

    const timeoutMs = Number(process.env.DOCUMENT_S3_TIMEOUT_MS ?? "120000");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
      throw new Error("DOCUMENT_S3_TIMEOUT_MS must be between 1000 and 300000.");
    }

    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payload = body ?? new Uint8Array();
    const payloadHash = sha256Hex(payload);

    const basePath = this.endpoint.pathname.replace(/\/+$/, "");
    const objectPath = encodedPath(
      this.config.bucket,
      key,
    );
    const canonicalUri =
      (basePath || "") + objectPath;
    const requestUrl = new URL(this.endpoint);
    requestUrl.pathname = canonicalUri;

    const canonicalHeaders = [
      `host:${requestUrl.host}`,
      ...(method === "PUT" ? ["if-none-match:*"] : []),
      `x-amz-content-sha256:${payloadHash}`,
      `x-amz-date:${amzDate}`,
      ...(this.config.sessionToken
        ? [
            `x-amz-security-token:${this.config.sessionToken}`,
          ]
        : []),
    ].join("\n") + "\n";

    const signedHeaders = [
      "host",
      ...(method === "PUT" ? ["if-none-match"] : []),
      "x-amz-content-sha256",
      "x-amz-date",
      ...(this.config.sessionToken
        ? ["x-amz-security-token"]
        : []),
    ].join(";");

    const canonicalRequest = [
      method,
      canonicalUri,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const scope = [
      dateStamp,
      this.config.region,
      "s3",
      "aws4_request",
    ].join("/");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = createHmac(
      "sha256",
      signingKey(
        this.config.secretAccessKey,
        dateStamp,
        this.config.region,
      ),
    )
      .update(stringToSign)
      .digest("hex");

    const headers: Record<string, string> = {
      // Preserve document-version bytes on retries and key collisions.
      // This condition is signed; a 409/412 must never trigger an unconditional retry.
      ...(method === "PUT" ? { "if-none-match": "*" } : {}),
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
    if (this.config.sessionToken) {
      headers["x-amz-security-token"] =
        this.config.sessionToken;
    }

    const response = await fetch(requestUrl, {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      ...(body ? { body: Buffer.from(body) } : {}),
    });

    if (!response.ok) {
      throw new Error(`S3 storage ${method} failed with ${response.status}.`);
    }

    return response;
  }
}
