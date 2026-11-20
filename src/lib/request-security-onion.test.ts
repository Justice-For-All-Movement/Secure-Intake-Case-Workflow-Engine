import { afterEach, describe, expect, it, vi } from "vitest";

const ONION = "http://4otao7w7mfhq5fonenjeteqe3cinbkbmyognbtvd5nx7vk3lziuisdyd.onion";

describe("browser mutation origin checks with an onion service", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("trusts the configured onion origin as well as the web origin, and nothing else", async () => {
    vi.stubEnv("ONION_ORIGIN", ONION);
    vi.resetModules();
    const { isTrustedBrowserMutation } = await import("./request-security");
    const post = (origin: string) => new Request(`${ONION}/submit`, { method: "POST", headers: { Origin: origin } });
    expect(isTrustedBrowserMutation(post(ONION))).toBe(true);
    expect(isTrustedBrowserMutation(post("http://localhost:3000"))).toBe(true);
    expect(isTrustedBrowserMutation(post("http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion"))).toBe(false);
  });

  it("does not trust onion origins when none is configured", async () => {
    vi.resetModules();
    const { isTrustedBrowserMutation } = await import("./request-security");
    expect(isTrustedBrowserMutation(new Request("http://localhost:3000/x", { method: "POST", headers: { Origin: ONION } }))).toBe(false);
  });
});
