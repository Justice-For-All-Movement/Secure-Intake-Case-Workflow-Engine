import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { organizations } from "../src/db/schema";
import { env } from "../src/lib/env";
import { createTrustedTenantScope } from "../src/lib/tenancy";
import { createApiClient, hashApiToken } from "../src/modules/api/auth";
import { integrationServiceScopes } from "../src/modules/integration/presets";

function valueAfter(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// Usage: npm run api:create-client -- --organization <slug> --name <name>
//          [--permissions a,b,c | --preset integration] [--with-protected]
//          [--expires-at <ISO time>] [--json]
async function main() {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const organizationSlug = valueAfter("--organization");
  const name = valueAfter("--name");
  if (!organizationSlug || !name) {
    throw new Error("--organization <slug> and --name <name> are required.");
  }
  const explicit = valueAfter("--permissions");
  const permissions: string[] = explicit
    ? explicit.split(",").map((value) => value.trim()).filter(Boolean)
    : [...integrationServiceScopes];
  if (process.argv.includes("--with-protected")) {
    permissions.push("submission:view_protected");
  }
  const expires = valueAfter("--expires-at");

  const { client, db } = createDatabase(env.DATABASE_URL);
  try {
    const [organization] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, organizationSlug))
      .limit(1);
    if (!organization) throw new Error("Organization was not found.");
    const created = await createApiClient(
      db,
      createTrustedTenantScope(organization.id),
      {
        name,
        permissions,
        expiresAt: expires ? new Date(expires) : null,
        actorUserId: null,
      },
    );
    const output = {
      clientId: created.client.id,
      organizationId: organization.id,
      permissions: created.client.permissions,
      // The token is printed once and never stored. `fingerprint` is its
      // SHA-256, the value a downstream identity service pins.
      token: created.token,
      fingerprint: hashApiToken(created.token),
    };
    process.stdout.write(
      process.argv.includes("--json")
        ? `${JSON.stringify(output)}\n`
        : `API client ${output.clientId}\nToken (shown once): ${output.token}\nSHA-256 fingerprint: ${output.fingerprint}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `API client creation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
