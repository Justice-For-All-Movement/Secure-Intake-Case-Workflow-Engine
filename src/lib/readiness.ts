import { createDatabase } from "@/db/client";

export type DatabaseReadiness =
  | { ready: true; status: "ok" }
  | {
      ready: false;
      status: "unconfigured" | "unavailable";
    };

export async function checkDatabaseReadiness(
  databaseUrl = process.env.DATABASE_URL,
  openDatabase = createDatabase,
  timeoutMs = 5000,
): Promise<DatabaseReadiness> {
  if (!databaseUrl) {
    return {
      ready: false,
      status: "unconfigured",
    };
  }

  let client: ReturnType<typeof createDatabase>["client"] | undefined;
  try {
    client = openDatabase(databaseUrl).client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.unsafe("select 1"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Database readiness timed out.")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return {
      ready: true,
      status: "ok",
    };
  } catch {
    return {
      ready: false,
      status: "unavailable",
    };
  } finally {
    if (client) await client.end({ timeout: 1 }).catch(() => undefined);
  }
}
