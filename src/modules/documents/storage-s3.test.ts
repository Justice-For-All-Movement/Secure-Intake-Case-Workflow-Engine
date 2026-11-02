import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { S3CompatibleStorageAdapter } from "./storage-s3";

afterEach(() => {
  vi.unstubAllGlobals();
});

function adapter() {
  return new S3CompatibleStorageAdapter({
    endpoint: "https://objects.example.test",
    region: "us-east-1",
    bucket: "case-files",
    accessKeyId: "AKIATEST",
    secretAccessKey: "test-secret",
  });
}

describe("S3-compatible document storage", () => {
  it("cannot overwrite existing evidence and signs the create-only condition", async () => {
    let stored = "original";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (headers["if-none-match"] === "*") return new Response(null, { status: 412 });
      stored = Buffer.from(init?.body as Buffer).toString("utf8");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(adapter().put("org/doc/version", new TextEncoder().encode("replacement")))
      .rejects.toThrow("S3 storage PUT failed with 412.");
    expect(stored).toBe("original");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["if-none-match"]).toBe("*");
    expect(headers.authorization).toContain("SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date");
  });

  it("does not retry a conflicting create as an unconditional overwrite", async () => {
    const fetchMock = vi.fn(async () => new Response("private conflict detail", { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(adapter().put("org/doc/version", new Uint8Array([1])))
      .rejects.toThrow("S3 storage PUT failed with 409.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 403, 501])("fails closed when a provider rejects conditional writes (%s)", async status => {
    const fetchMock = vi.fn(async () => new Response("sensitive provider response", { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(adapter().put("org/doc/version", new Uint8Array([1])))
      .rejects.toThrow(`S3 storage PUT failed with ${status}.`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the first object under competing writes", async () => {
    let stored: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (stored !== undefined && headers["if-none-match"] === "*") return new Response(null, { status: 412 });
      stored = Buffer.from(init?.body as Buffer).toString("utf8");
      return new Response(null, { status: 200 });
    }));
    const outcomes = await Promise.allSettled(["first", "second"].map(text =>
      adapter().put("org/doc/version", new TextEncoder().encode(text))));
    expect(outcomes.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(stored).toBe("first");
  });

  it("rejects unbounded request timeout configuration", async () => {
    const previous = process.env.DOCUMENT_S3_TIMEOUT_MS;
    process.env.DOCUMENT_S3_TIMEOUT_MS = "0";
    try {
      await expect(adapter().get("org/doc/version")).rejects.toThrow(/DOCUMENT_S3_TIMEOUT_MS/);
    } finally {
      if (previous === undefined) delete process.env.DOCUMENT_S3_TIMEOUT_MS;
      else process.env.DOCUMENT_S3_TIMEOUT_MS = previous;
    }
  });

  it("rejects redirects without forwarding signed headers and omits provider diagnostics", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response("secret upstream diagnostic", {
      status: 307, headers: { location: "https://other.example.test/object" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(adapter().get("org/doc/version")).rejects.toThrow("S3 storage GET failed with 307.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("signs and writes immutable object bytes", async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe(
        "https://objects.example.test/case-files/org/doc/version",
      );
      expect(init?.method).toBe("PUT");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIATEST\//,
      );
      expect(headers["x-amz-content-sha256"]).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
      expect(Buffer.from(init?.body as Buffer).toString("utf8")).toBe(
        "evidence",
      );
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await adapter().put(
      "org/doc/version",
      new TextEncoder().encode("evidence"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retrieves and deletes objects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new TextEncoder().encode("evidence"), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const storage = adapter();
    expect(
      new TextDecoder().decode(
        await storage.get("org/doc/version"),
      ),
    ).toBe("evidence");
    await storage.remove("org/doc/version");

    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["if-none-match"]).toBeUndefined();
      expect(headers.authorization).not.toContain("if-none-match");
    }
  });

  it("rejects traversal keys and non-HTTPS endpoints", async () => {
    await expect(
      adapter().put(
        "../escape",
        new Uint8Array([1]),
      ),
    ).rejects.toThrow(/Invalid document storage key/);

    expect(
      () =>
        new S3CompatibleStorageAdapter({
          endpoint: "http://objects.example.test",
          region: "us-east-1",
          bucket: "case-files",
          accessKeyId: "AKIATEST",
          secretAccessKey: "test-secret",
        }),
    ).toThrow(/bare HTTPS URL/);
  });
});
