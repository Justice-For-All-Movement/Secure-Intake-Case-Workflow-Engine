import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getMalwareScanner } from "./scanner";

const original = {
  url: process.env.MALWARE_SCANNER_URL,
  provider: process.env.MALWARE_SCANNER_PROVIDER,
  token: process.env.MALWARE_SCANNER_TOKEN,
  timeout: process.env.MALWARE_SCANNER_TIMEOUT_MS,
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries({
    MALWARE_SCANNER_URL: original.url,
    MALWARE_SCANNER_PROVIDER: original.provider,
    MALWARE_SCANNER_TOKEN: original.token,
    MALWARE_SCANNER_TIMEOUT_MS: original.timeout,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("HTTP malware scanner adapter", () => {
  it("rejects unbounded scanner timeout configuration", async () => {
    process.env.MALWARE_SCANNER_URL = "https://scanner.example.test/scan";
    process.env.MALWARE_SCANNER_TIMEOUT_MS = "300001";
    await expect(getMalwareScanner()?.scan({
      data: new Uint8Array([1]), filename: "file.bin",
      mimeType: "application/octet-stream", sha256: "a".repeat(64)
    })).rejects.toThrow(/MALWARE_SCANNER_TIMEOUT_MS/);
  });

  it("rejects oversized scanner metadata", async () => {
    process.env.MALWARE_SCANNER_URL = "https://scanner.example.test/scan";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "clean", details: { blob: "x".repeat(70 * 1024) }
    })));
    await expect(getMalwareScanner()?.scan({
      data: new Uint8Array([1]), filename: "file.bin",
      mimeType: "application/octet-stream", sha256: "a".repeat(64)
    })).rejects.toThrow(/exceeds 64 KiB/);
  });

  it("does not forward document bytes or tokens across redirects", async () => {
    process.env.MALWARE_SCANNER_URL = "https://scanner.example.test/scan";
    process.env.MALWARE_SCANNER_TOKEN = "scanner-token";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, {
      status: 307, headers: { location: "https://other.example.test/scan" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const scanner = getMalwareScanner();
    await expect(scanner?.scan({
      data: new Uint8Array([1]), filename: "file.bin",
      mimeType: "application/octet-stream", sha256: "a".repeat(64)
    })).rejects.toThrow("Malware scanner returned HTTP 307.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("returns null when scanning is not configured", () => {
    delete process.env.MALWARE_SCANNER_URL;
    expect(getMalwareScanner()).toBeNull();
  });

  it("posts bytes and accepts clean results", async () => {
    process.env.MALWARE_SCANNER_URL =
      "https://scanner.example.test/v1/scan";
    process.env.MALWARE_SCANNER_PROVIDER = "example-scanner";
    process.env.MALWARE_SCANNER_TOKEN = "scanner-token";

    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe(
        "https://scanner.example.test/v1/scan",
      );
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer scanner-token");
      expect(headers["x-content-sha256"]).toBe("a".repeat(64));
      return Response.json({
        status: "clean",
        details: { engine: "test" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const scanner = getMalwareScanner();
    expect(scanner?.provider).toBe("example-scanner");
    await expect(
      scanner?.scan({
        data: new TextEncoder().encode("file"),
        filename: "example.pdf",
        mimeType: "application/pdf",
        sha256: "a".repeat(64),
      }),
    ).resolves.toEqual({
      status: "clean",
      details: { engine: "test" },
    });
  });

  it("rejects insecure endpoints and invalid scanner statuses", async () => {
    process.env.MALWARE_SCANNER_URL =
      "http://scanner.example.test/scan";
    expect(() => getMalwareScanner()).toThrow(/HTTPS URL/);

    process.env.MALWARE_SCANNER_URL =
      "https://scanner.example.test/scan?token=secret";
    expect(() => getMalwareScanner()).toThrow(/HTTPS URL/);

    process.env.MALWARE_SCANNER_URL =
      "https://scanner.example.test/scan";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ status: "unknown" }),
      ),
    );

    const scanner = getMalwareScanner();
    await expect(
      scanner?.scan({
        data: new Uint8Array([1]),
        filename: "file.bin",
        mimeType: "application/octet-stream",
        sha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/invalid status/i);
  });
});
