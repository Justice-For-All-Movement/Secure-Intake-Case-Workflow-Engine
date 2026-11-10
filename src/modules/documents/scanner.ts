import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) {
      throw new Error(
        "MALWARE_SCANNER_TIMEOUT_MS must be an integer >= 1000.",
      );
    }

    const response = await fetch(this.endpoint, {
      method: "POST",
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

    const body = (await response.json()) as {
      status?: unknown;
      details?: unknown;
    };
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

/**
 * Local ClamAV command-line adapter. The file is written to a private
 * temporary directory, scanned with `clamscan`, and removed. Exit code 0 is
 * clean, 1 is infected, anything else (including a missing or empty signature
 * database) is `failed`, which leaves the upload quarantined.
 */
class ClamscanMalwareScanner implements MalwareScanner {
  readonly provider = "clamscan";

  constructor(
    private readonly binary: string,
    private readonly databaseDirectory: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  async scan(input: {
    data: Uint8Array;
    filename: string;
    mimeType: string;
    sha256: string;
  }): Promise<MalwareScanResult> {
    const directory = await mkdtemp(path.join(tmpdir(), "sicwe-scan-"));
    const file = path.join(directory, "upload.bin");
    try {
      await writeFile(file, input.data, { mode: 0o600 });
      const args = ["--no-summary", "--stdout"];
      if (this.databaseDirectory) {
        args.push(`--database=${this.databaseDirectory}`);
      }
      args.push(file);

      const result = await new Promise<{
        code: number | null;
        stdout: string;
        error?: string;
      }>((resolve) => {
        execFile(
          this.binary,
          args,
          { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            const code =
              error && typeof (error as { code?: unknown }).code === "number"
                ? ((error as { code: number }).code)
                : error
                  ? null
                  : 0;
            resolve({
              code,
              stdout: String(stdout ?? ""),
              error: error && code === null ? error.message : undefined,
            });
          },
        );
      });

      if (result.code === 0) {
        return { status: "clean", details: { engine: "clamscan" } };
      }
      if (result.code === 1) {
        const signature =
          /:\s*(.+?)\s+FOUND\s*$/m.exec(result.stdout)?.[1] ?? "unknown";
        return {
          status: "infected",
          details: { engine: "clamscan", signature: signature.slice(0, 200) },
        };
      }
      return {
        status: "failed",
        details: {
          engine: "clamscan",
          reason:
            result.code === null ? "scanner_unavailable" : "scanner_error",
          exitCode: result.code,
        },
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function scannerTimeoutMs() {
  const timeoutMs = Number(
    process.env.MALWARE_SCANNER_TIMEOUT_MS ?? "120000",
  );
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) {
    throw new Error(
      "MALWARE_SCANNER_TIMEOUT_MS must be an integer >= 1000.",
    );
  }
  return timeoutMs;
}

/**
 * Scanner selection:
 * - MALWARE_SCANNER_DRIVER=clamscan  local `clamscan` (CLAMSCAN_PATH,
 *   CLAMSCAN_DATABASE_DIR)
 * - MALWARE_SCANNER_DRIVER=http or MALWARE_SCANNER_URL set  HTTPS scanner
 * - otherwise null: nothing is ever marked clean; uploads stay quarantined.
 */
export function getMalwareScanner(): MalwareScanner | null {
  const driver = process.env.MALWARE_SCANNER_DRIVER?.trim().toLowerCase();
  if (driver && !["clamscan", "http", "none"].includes(driver)) {
    throw new Error(
      "MALWARE_SCANNER_DRIVER must be clamscan, http or none.",
    );
  }
  if (driver === "none") return null;
  if (driver === "clamscan") {
    return new ClamscanMalwareScanner(
      process.env.CLAMSCAN_PATH?.trim() || "clamscan",
      process.env.CLAMSCAN_DATABASE_DIR?.trim() || undefined,
      scannerTimeoutMs(),
    );
  }

  const rawUrl = process.env.MALWARE_SCANNER_URL?.trim();
  if (!rawUrl) return null;

  const endpoint = new URL(rawUrl);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password
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
