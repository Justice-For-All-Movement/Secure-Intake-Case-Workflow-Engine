import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const archivePath = new URL("../package-lock.json.gz.b64", import.meta.url);
const outputPath = new URL("../package-lock.json", import.meta.url);
const archiveSha256 = "39c4a491b2ac42ef79e05b18db4cf894e6af1c9d87356e6559d0d76f7e9b6300";
const lockSha256 = "5d7f30fabb0692441aa5d982a98bf2fd42ac3074e30c30dc19475906e89fb907";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const encoded = readFileSync(archivePath, "utf8").trim();
if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
  throw new Error("Dependency lock archive encoding is invalid.");
}
const archive = Buffer.from(encoded, "base64");
if (sha256(archive) !== archiveSha256) {
  throw new Error("Dependency lock archive checksum mismatch.");
}
const lock = gunzipSync(archive);
if (sha256(lock) !== lockSha256) {
  throw new Error("Dependency lock checksum mismatch.");
}
const parsed = JSON.parse(lock.toString("utf8"));
if (parsed.lockfileVersion !== 3 || !parsed.packages?.[""]) {
  throw new Error("Dependency lock format is invalid.");
}
writeFileSync(outputPath, lock, { flag: "w" });
process.stdout.write("Verified package-lock.json restored.\n");
