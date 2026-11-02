import type { MalwareScanStatus } from "./policy";

export interface MalwareScanResult {
  status: Exclude<MalwareScanStatus, "pending">;
  details?: Record<string, unknown>;
}

export interface MalwareScanner {
  readonly provider: string;
  scan(input: {
    data: Uint8Array;
    filename: string;
    mimeType: string;
    sha256: string;
  }): Promise<MalwareScanResult>;
}

class HttpMalwareScanner implements MalwareScanner {
  readonly provider: string;

  constructor(
    private readonly endpoint: URL,
    provider: string,
    private readonly token?: string,
  ) {
    this.provider = provider;
  }

  async scan(input: {
    data: Uint8Array;
    filename: string;
    mimeType: string;
    sha256: string;
  }): Promise<MalwareScanResult> {
    const timeoutMs = Number(
      process.env.MALWARE_SCANNER_TIMEOUT_MS ?? "120000",
    );
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
      throw new Error(
        "MALWARE_SCANNER_TIMEOUT_MS must be between 1000 and 300000.",
      );
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type":
          input.mimeType || "application/octet-stream",
        "x-filename": encodeURIComponent(input.filename),
        "x-content-sha256": input.sha256,
        ...(this.token
          ? { authorization: `Bearer ${this.token}` }
          : {}),
      },
      body: Buffer.from(input.data),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Malware scanner returned HTTP ${response.status}.`,
      );
    }

    if (!response.body) throw new Error("Malware scanner returned an empty body.");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) {
        await reader.cancel();
        throw new Error("Malware scanner response exceeds 64 KiB.");
      }
      chunks.push(Buffer.from(value));
    }
    let body: { status?: unknown; details?: unknown };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
    } catch {
      throw new Error("Malware scanner returned invalid JSON.");
    }
    if (
      body.status !== "clean" &&
      body.status !== "infected" &&
      body.status !== "failed"
    ) {
      throw new Error(
        "Malware scanner returned an invalid status.",
      );
    }

    return {
      status: body.status,
      details:
        body.details &&
        typeof body.details === "object" &&
        !Array.isArray(body.details)
          ? (body.details as Record<string, unknown>)
          : {},
    };
  }
}

export function getMalwareScanner(): MalwareScanner | null {
  const rawUrl = process.env.MALWARE_SCANNER_URL?.trim();
  if (!rawUrl) return null;

  const endpoint = new URL(rawUrl);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "MALWARE_SCANNER_URL must be an HTTPS URL without embedded credentials.",
    );
  }

  return new HttpMalwareScanner(
    endpoint,
    process.env.MALWARE_SCANNER_PROVIDER?.trim() ||
      endpoint.hostname,
    process.env.MALWARE_SCANNER_TOKEN?.trim() || undefined,
  );
}
