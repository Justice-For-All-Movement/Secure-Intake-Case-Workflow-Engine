import { describe, expect, it, vi } from "vitest";
import type { createDatabase } from "@/db/client";
import { checkDatabaseReadiness } from "./readiness";

describe("database readiness", () => {
  it("bounds a stalled database query and closes its client", async () => {
    const end = vi.fn(async () => undefined);
    const open = (): ReturnType<typeof createDatabase> => ({
      client: { unsafe: () => new Promise<never>(() => undefined), end },
      db: null,
    }) as unknown as ReturnType<typeof createDatabase>;
    await expect(checkDatabaseReadiness("postgresql://user:secret@example.net/db", open, 10))
      .resolves.toEqual({ ready: false, status: "unavailable" });
    expect(end).toHaveBeenCalledOnce();
  });

  it("returns unavailable when the connection factory fails before opening a client", async () => {
    await expect(checkDatabaseReadiness("invalid-url", () => { throw new Error("invalid connection"); }))
      .resolves.toEqual({ ready: false, status: "unavailable" });
  });

  it("fails closed when DATABASE_URL is unavailable", async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      await expect(
        checkDatabaseReadiness(),
      ).resolves.toEqual({
        ready: false,
        status: "unconfigured",
      });
    } finally {
      if (original === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = original;
      }
    }
  });
});
