import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { authLoginThrottles } from "@/db/schema";
import { env } from "@/lib/env";

export class LoginRateLimitError extends Error {
  constructor() {
    super("Too many failed sign-in attempts. Try again later.");
    this.name = "LoginRateLimitError";
  }
}

export function normalizeLoginIdentifier(value: string) {
  return value.trim().toLowerCase();
}

export function loginBucketHash(
  kind: "account" | "source" | "participant" | "draft",
  value: string,
) {
  return createHash("sha256")
    .update(kind + ":" + value, "utf8")
    .digest("hex");
}

export function loginThrottleKeys(
  email: string,
  source?: string | null,
) {
  const account = loginBucketHash(
    "account",
    normalizeLoginIdentifier(email),
  );
  const sourceKey = source?.trim()
    ? loginBucketHash("source", source.trim())
    : null;

  return {
    account,
    all: sourceKey ? [account, sourceKey] : [account],
  };
}

export function trustedLoginSource(
  headers: Headers,
): string | null {
  if (!env.AUTH_TRUST_PROXY_HEADERS) return null;

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp && isIP(realIp)) return realIp;

  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return null;

  const candidate = forwarded.split(",")[0]?.trim() ?? "";
  return isIP(candidate) ? candidate : null;
}

export async function assertLoginAllowed(
  db: Database,
  keys: readonly string[],
  now = new Date(),
) {
  if (keys.length === 0) return;

  const blocked = await db
    .select({ keyHash: authLoginThrottles.keyHash })
    .from(authLoginThrottles)
    .where(
      and(
        inArray(authLoginThrottles.keyHash, [...keys]),
        gt(authLoginThrottles.blockedUntil, now),
      ),
    )
    .limit(1);

  if (blocked.length) {
    throw new LoginRateLimitError();
  }
}

export interface ThrottleLimits {
  limit: number;
  windowMinutes: number;
  blockMinutes: number;
}

export async function recordLoginFailure(
  db: Database,
  keys: readonly string[],
  now = new Date(),
  limits: ThrottleLimits = {
    limit: env.AUTH_LOGIN_FAILURE_LIMIT,
    windowMinutes: env.AUTH_LOGIN_WINDOW_MINUTES,
    blockMinutes: env.AUTH_LOGIN_BLOCK_MINUTES,
  },
) {
  const cutoff = new Date(
    now.getTime() - limits.windowMinutes * 60_000,
  );
  const blockedUntil = new Date(
    now.getTime() + limits.blockMinutes * 60_000,
  );

  const staleBefore = new Date(
    now.getTime() -
      (Math.max(env.AUTH_LOGIN_WINDOW_MINUTES, limits.windowMinutes) +
        Math.max(env.AUTH_LOGIN_BLOCK_MINUTES, limits.blockMinutes)) *
        60_000 *
        2,
  );

  await db
    .delete(authLoginThrottles)
    .where(lt(authLoginThrottles.updatedAt, staleBefore));

  await db.transaction(async (tx) => {
    for (const keyHash of keys) {
      // Serialize updates for this opaque throttle bucket without exposing
      // the underlying account/source identifier. The lock is scoped to
      // this transaction and automatically released on commit/rollback.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${keyHash}, 0))`,
      );

      const [current] = await tx
        .select()
        .from(authLoginThrottles)
        .where(eq(authLoginThrottles.keyHash, keyHash))
        .limit(1);

      if (!current) {
        await tx.insert(authLoginThrottles).values({
          keyHash,
          windowStartedAt: now,
          failureCount: 1,
          blockedUntil:
            limits.limit <= 1
              ? blockedUntil
              : null,
          updatedAt: now,
        });
        continue;
      }

      const windowExpired = current.windowStartedAt < cutoff;
      const failureCount = windowExpired
        ? 1
        : current.failureCount + 1;
      const existingBlockStillActive =
        current.blockedUntil !== null &&
        current.blockedUntil > now;

      await tx
        .update(authLoginThrottles)
        .set({
          windowStartedAt: windowExpired
            ? now
            : current.windowStartedAt,
          failureCount,
          blockedUntil: existingBlockStillActive
            ? current.blockedUntil
            : failureCount >= limits.limit
              ? blockedUntil
              : null,
          updatedAt: now,
        })
        .where(eq(authLoginThrottles.keyHash, keyHash));
    }
  });
}

export async function clearLoginFailuresForKey(
  db: Database,
  keyHash: string,
) {
  await db
    .delete(authLoginThrottles)
    .where(eq(authLoginThrottles.keyHash, keyHash));
}

export async function clearAccountLoginFailures(
  db: Database,
  accountKey: string,
) {
  return clearLoginFailuresForKey(db, accountKey);
}
