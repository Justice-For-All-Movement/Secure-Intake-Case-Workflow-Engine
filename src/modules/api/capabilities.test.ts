import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { engineBuildInfo } from "@/lib/build-info";
import { createTrustedTenantScope } from "@/lib/tenancy";
import { corePermissions } from "@/modules/auth/permissions";
import { ApiAuthenticationError, authenticateApiToken, type ApiAuthorizationContext } from "./auth";
import { apiCapabilities, apiEndpoints } from "./capabilities";
import { GET } from "@/app/api/v1/capabilities/route";
import { paginated, parsePage } from "./http";

vi.mock("@/db/runtime", () => ({ getRuntimeDatabase: vi.fn(() => ({ testDatabase: true })) }));
vi.mock("./auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("./auth")>(),
  authenticateApiToken: vi.fn(),
}));

const organizationId = "11111111-1111-4111-8111-111111111111";
const token = `sicwe_012345abcdef_${"a".repeat(43)}`;
function context(permissions: readonly string[] = []): ApiAuthorizationContext {
  return {
    clientId: "private-client-id", clientName: "private-client-name", organizationId,
    tenantScope: createTrustedTenantScope(organizationId), permissions: new Set(permissions),
    rateLimit: 120, rateRemaining: 119, rateResetAt: new Date("2026-01-01T00:01:00Z"),
  };
}
function request() { return new Request("https://intake.example/api/v1/capabilities", { headers: { authorization: `Bearer ${token}` } }); }

describe("authenticated API capabilities", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(authenticateApiToken).mockResolvedValue(context()); });

  it("requires bearer authentication through the actual HTTP authorization module", async () => {
    const response = await GET(new Request("https://intake.example/api/v1/capabilities"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="sicwe-api"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(authenticateApiToken).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Bearer token required." } });
  });

  it.each(["invalid_token", "expired_token", "inactive_client", "inactive_organization", "rate_limited"] as const)("preserves %s rejection", async code => {
    vi.mocked(authenticateApiToken).mockRejectedValue(new ApiAuthenticationError(code));
    const response = await GET(request());
    expect(response.status).toBe(code === "rate_limited" ? 429 : 401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    if (code === "rate_limited") expect(response.headers.get("retry-after")).toBe("60");
    const body = await response.json();
    expect(body.error.code).toBe(code);
    expect(body.data).toBeUndefined();
  });

  it("fails closed without disclosing database errors", async () => {
    vi.mocked(authenticateApiToken).mockRejectedValue(new Error("private database connection"));
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("private database");
  });

  it("uses the real package version and rate headers; valid clients need no extra permission", async () => {
    const response = await GET(request()), body = await response.json();
    expect(response.status).toBe(200);
    expect(authenticateApiToken).toHaveBeenCalledWith(expect.anything(), token);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-ratelimit-limit")).toBe("120");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("119");
    expect(response.headers.get("x-ratelimit-reset")).toBe("1767225660");
    expect(body.data.engine).toEqual(engineBuildInfo);
    expect(body.data.endpoints.filter((endpoint: { available: boolean }) => endpoint.available).map((endpoint: { id: string }) => endpoint.id)).toEqual(["capabilities"]);
  });

  it("reports only granted delegable scopes and requires every scope for each route", () => {
    const value = apiCapabilities(context(["case:view", "document:view", "case:create", "api:manage", "webhook:manage", "untrusted:secret"]));
    expect(value.authentication.grantedScopes).toEqual(["case:create", "case:view", "document:view"]);
    expect(value.endpoints.find(endpoint => endpoint.id === "documents.list")?.available).toBe(true);
    expect(value.endpoints.find(endpoint => endpoint.id === "deadlines.list")?.available).toBe(false);
    expect(value.endpoints.find(endpoint => endpoint.id === "cases.open")?.available).toBe(false);
    expect(value.endpoints.find(endpoint => endpoint.id === "referrals.create")?.available).toBe(false);
  });

  it("does not serialize identity, token, tenant, deployment secrets, or data", async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue(context(corePermissions));
    const response = await GET(request()), text = await response.text();
    for (const secret of [token, organizationId, "private-client", "tenantScope", "keyHash", "DATABASE_URL", "storageKey", "answers", "clientId", "clientName", "organizationId"]) expect(text).not.toContain(secret);
    const data = JSON.parse(text).data;
    expect(data.endpoints.every((endpoint: { available: boolean }) => endpoint.available)).toBe(true);
    expect(data.limits.attachments).toMatchObject({ metadataOnly: false, binaryDownload: true, binaryUpload: false, protectedBinary: false });
    expect(data.limits.requestIdempotency).toBe(true);
    expect(text.length).toBeLessThan(60000); // downstream verifiers cap the capability document at 64 KiB
    expect(data.limits.requestIdHeader).toBe(false);
  });
});

describe("source-bound API capability inventory", () => {
  it("covers every authenticated v1 method with exactly the implemented scopes", () => {
    const root = path.resolve("src/app/api/v1");
    const actual: { path: string; method: string; scopes: string[] }[] = [];
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith("route.ts")) continue;
      const source = readFileSync(path.join(root, file), "utf8");
      if (!source.includes("authorizeApiRequest")) continue; // public index and OpenAPI
      const route = "/api/v1/" + file.replace(/\/route\.ts$/, "").replace(/\[([^\]]+)\]/g, "{$1}");
      for (const match of source.matchAll(/export async function (GET|POST)\([\s\S]*?(?=export async function|$)/g)) {
        const auth = match[0].match(/authorizeApiRequest\(request,\s*\[([\s\S]*?)\]\)/);
        expect(auth, `${route} ${match[1]}`).not.toBeNull();
        actual.push({ path: route, method: match[1], scopes: [...auth![1].matchAll(/"([a-z_:]+)"/g)].map(scope => scope[1]).sort() });
      }
    }
    const expected = apiEndpoints.map(endpoint => ({ path: endpoint.path, method: endpoint.method, scopes: [...endpoint.requiredScopes].sort() }));
    const sort = (items: typeof actual) => items.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
    expect(sort(actual)).toEqual(sort(expected));
  });

  it("reports pagination as implemented, including the boundary continuation trap", () => {
    const limits = apiCapabilities(context()).limits.pagination;
    expect(parsePage(new Request("https://intake.example?limit=1000&offset=20000"))).toEqual({ limit: limits.maxLimit, offset: limits.maxOffset });
    expect(parsePage(new Request("https://intake.example"))).toEqual({ limit: limits.defaultLimit, offset: 0 });
    expect(paginated(Array.from({ length: 100 }), 100, 10000).pagination.nextOffset).toBe(10100);
    expect(limits).toMatchObject({ cursor: false, stableSnapshot: false, nextOffsetMayExceedMax: true });
    for (const endpoint of apiEndpoints) {
      const source = readFileSync(path.resolve("src/app", endpoint.path.slice(1).replace(/\{([^}]+)\}/g, "[$1]"), "route.ts"), "utf8");
      // A route file may serve several methods; offset pagination is a property of the file's list method.
      expect(source.includes("paginated(")).toBe(apiEndpoints.some(other => other.path === endpoint.path && other.pagination === "offset"));
    }
  });
});
