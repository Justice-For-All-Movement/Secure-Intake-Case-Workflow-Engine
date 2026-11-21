import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as sealedCrypto from "./sealed-crypto";
import { sealingKeyId } from "./recipients";

// sealed-crypto.js is a byte-identical copy of the research application's
// web/js/sealed-crypto.js. Envelopes made here must open there, so any change
// must be made upstream first and copied verbatim; this test pins the copy.
const PINNED_SHA256 = "23d52014ca79d1ae8197698fe7a82a11cdf501cd7392f8db7c12f205562412a3";
const vendored = readFileSync(path.resolve("src/modules/sealed/sealed-crypto.js"));

const upstreamCandidates = [
  process.env.SEALED_CRYPTO_UPSTREAM,
  path.resolve("../public-accountability-machine/web/js/sealed-crypto.js"),
].filter((candidate): candidate is string => Boolean(candidate));
const upstream = upstreamCandidates.find((candidate) => existsSync(candidate));

describe("vendored sealing library", () => {
  it("is the pinned upstream file, unchanged", () => {
    expect(createHash("sha256").update(vendored).digest("hex")).toBe(PINNED_SHA256);
  });

  it.skipIf(!upstream)("is byte-identical to the upstream checkout", () => {
    expect(Buffer.compare(vendored, readFileSync(upstream!))).toBe(0);
  });

  it("computes key ids exactly as the server-side configuration check does", async () => {
    const pair = await sealedCrypto.generateKeyPair();
    expect(await sealedCrypto.keyId(pair.publicJwk)).toBe(sealingKeyId(pair.publicJwk));
    expect(pair.id).toBe(sealingKeyId(pair.publicJwk));
  });

  it("seals for several recipients; each opens it and the fingerprint verifies", async () => {
    const a = await sealedCrypto.generateKeyPair();
    const b = await sealedCrypto.generateKeyPair();
    const content = { text: "Something happened at the depot.", files: [{ name: "a.txt", type: "text/plain", base64: "aGk=" }] };
    const envelope = await sealedCrypto.seal(content, [
      { id: a.id, publicJwk: a.publicJwk },
      { id: b.id, publicJwk: b.publicJwk },
    ]);
    expect(JSON.stringify(envelope)).not.toContain("depot");
    for (const pair of [a, b]) {
      const opened = await sealedCrypto.open(envelope, pair.id, await sealedCrypto.importPrivate(pair.privateJwk));
      expect(opened.content).toEqual(content);
      expect(opened.commitmentVerified).toBe(true);
    }
  });
});
