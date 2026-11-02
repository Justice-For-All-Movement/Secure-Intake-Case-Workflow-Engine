import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const MAX_LOCK_BYTES = 2 * 1024 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const invalid = () => { throw new Error("Unsupported or incomplete dependency lock metadata."); };

/** Deterministic metadata inventory. This is neither an SPDX SBOM nor legal approval. */
export function dependencyInventory(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_LOCK_BYTES) invalid();
  let lock;
  try { lock = JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object" ||
      Array.isArray(lock.packages) || !lock.packages[""] || typeof lock.name !== "string" ||
      typeof lock.version !== "string") invalid();
  const dependencies = [];
  for (const location of Object.keys(lock.packages).filter(key => key !== "").sort()) {
    const metadata = lock.packages[location];
    // Preserve distinct nested installations instead of collapsing by package name.
    if (!/^(?:node_modules\/(?:@[A-Za-z0-9_][A-Za-z0-9._-]*\/)?[A-Za-z0-9_][A-Za-z0-9._-]*\/)*node_modules\/(?:@[A-Za-z0-9_][A-Za-z0-9._-]*\/)?[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(location) ||
        !metadata || metadata.link || typeof metadata.version !== "string" || !metadata.version ||
        typeof metadata.resolved !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.integrity ?? "") ||
        !["dev", "optional", "devOptional"].every(key => metadata[key] === undefined || typeof metadata[key] === "boolean")) invalid();
    const integrity = Buffer.from(metadata.integrity.slice(7), "base64");
    if (integrity.length !== 64 || `sha512-${integrity.toString("base64")}` !== metadata.integrity) invalid();
    let source;
    try { source = new URL(metadata.resolved); } catch { invalid(); }
    if (source.protocol !== "https:" || source.hostname !== "registry.npmjs.org" || source.port ||
        source.username || source.password || source.search || source.hash || !source.pathname.endsWith(".tgz")) invalid();
    if (metadata.license !== undefined && (typeof metadata.license !== "string" || !metadata.license || metadata.license.length > 512 || /[\r\n\u0000]/.test(metadata.license))) invalid();
    const name = location.split("node_modules/").at(-1);
    dependencies.push({ location, name, version: metadata.version, resolved: metadata.resolved,
      integrity: metadata.integrity, declaredLicense: metadata.license ?? null,
      dev: metadata.dev ?? false, optional: metadata.optional ?? false, devOptional: metadata.devOptional ?? false });
  }
  if (!dependencies.length) invalid();
  return { schemaVersion: 1, source: { name: lock.name, version: lock.version, lockSha256: sha256(bytes) },
    limitations: ["Registry-declared license metadata is unverified; license text and obligations require review.",
      "Lock integrity is metadata; this inventory does not attest installed bytes, image contents or build provenance."],
    summary: { dependencies: dependencies.length, missingLicenseMetadata: dependencies.filter(d => d.declaredLicense === null).length },
    dependencies };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("Run without arguments after restoring the committed dependency lock.");
    const bytes = readFileSync(new URL("../package-lock.json", import.meta.url));
    process.stdout.write(JSON.stringify(dependencyInventory(bytes), null, 2) + "\n");
  } catch {
    process.stderr.write("Dependency inventory failed; restore and validate the committed lock metadata.\n");
    process.exitCode = 1;
  }
}
