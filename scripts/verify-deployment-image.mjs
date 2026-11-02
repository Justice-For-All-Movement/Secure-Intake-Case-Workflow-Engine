import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedRepository = "ghcr.io/neophilism/secure-intake-case-workflow-engine";
const shaPattern = /^[a-f0-9]{40}$/i;
const digestPattern = /^sha256:[a-f0-9]{64}$/i;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value, keys) => object(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validSource = value => typeof value === "string" && value.length === 40 && shaPattern.test(value) && !/^0{40}$/.test(value);

export function verifyDeploymentImage(evidence, expectedSource, blueprintText) {
  const failed = [];
  const validEvidence = hasKeys(evidence, ["schemaVersion", "engine", "container"]) &&
    evidence.schemaVersion === 1 &&
    hasKeys(evidence.engine, ["version", "sourceCommit", "tag"]) &&
    hasKeys(evidence.container, ["repository", "digest", "immutableRef"]) &&
    typeof evidence.engine.version === "string" &&
    evidence.engine.version.length <= 128 && !/\s/.test(evidence.engine.version) &&
    /^1\.0\.0(?:-rc\.\d+)?$/.test(evidence.engine.version) &&
    validSource(evidence.engine.sourceCommit) &&
    evidence?.engine?.sourceCommit === expectedSource &&
    evidence?.engine?.tag === `v${evidence?.engine?.version}` &&
    evidence?.container?.repository === expectedRepository &&
    typeof evidence.container.digest === "string" && evidence.container.digest.length === 71 && digestPattern.test(evidence.container.digest) &&
    !/^sha256:0{64}$/i.test(evidence?.container?.digest ?? "") &&
    evidence?.container?.immutableRef ===
      `${expectedRepository}@${evidence?.container?.digest}`;
  if (!validSource(expectedSource) || evidence?.engine?.sourceCommit !== expectedSource) {
    failed.push("source_commit");
  }
  if (!validEvidence) failed.push("release_evidence");

  const imageLines = typeof blueprintText === "string" && Buffer.byteLength(blueprintText) <= 1024 * 1024
    ? [...blueprintText.matchAll(/^\s*image:\s*(\S+)\s*$/gm)] : [];
  if (imageLines.length !== 1 ||
      !validEvidence || imageLines[0][1] !== evidence.container.immutableRef) {
    failed.push("blueprint_image");
  }
  return { ok: failed.length === 0, failed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const options = new Map();
    const allowed = ["--evidence", "--source", "--blueprint"];
    if (args.length !== 6) throw new Error("Invalid arguments");
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index], value = args[index + 1];
      if (!allowed.includes(key) || options.has(key) || !value || value.startsWith("--")) throw new Error("Invalid arguments");
      options.set(key, value);
    }
    const readBounded = (path, limit) => {
      const info = statSync(path);
      if (!info.isFile() || info.size > limit) throw new Error("Invalid input");
      return readFileSync(path, "utf8");
    };
    const result = verifyDeploymentImage(
      JSON.parse(readBounded(options.get("--evidence"), 65536)),
      options.get("--source"),
      readBounded(options.get("--blueprint"), 1024 * 1024)
    );
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error("Deployment image preflight input invalid or unreadable; no deployment was performed.");
    process.exitCode = 2;
  }
}
