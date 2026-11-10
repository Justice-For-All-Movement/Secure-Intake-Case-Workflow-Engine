import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getMalwareScanner } from "./scanner";

function clamscanAvailable() {
  try {
    execFileSync("clamscan", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const work = mkdtempSync(path.join(tmpdir(), "sicwe-clam-test-"));
const database = path.join(work, "db");
const empty = path.join(work, "empty");
mkdirSync(database);
mkdirSync(empty);
writeFileSync(
  path.join(database, "local.ndb"),
  `Local.Test.Marker:0:*:${Buffer.from("LOCAL-TEST-MARKER-51d2").toString("hex")}\n`,
);
const saved = { ...process.env };
const input = (text: string) => ({
  data: Buffer.from(text),
  filename: "upload.txt",
  mimeType: "text/plain",
  sha256: "0".repeat(64),
});

afterEach(() => {
  process.env = { ...saved };
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("scanner selection never assumes clean", () => {
  it("has no scanner unless one is configured, and rejects unknown drivers", () => {
    delete process.env.MALWARE_SCANNER_DRIVER;
    delete process.env.MALWARE_SCANNER_URL;
    expect(getMalwareScanner()).toBeNull();
    process.env.MALWARE_SCANNER_DRIVER = "none";
    process.env.MALWARE_SCANNER_URL = "https://scanner.example.org/scan";
    expect(getMalwareScanner()).toBeNull();
    process.env.MALWARE_SCANNER_DRIVER = "trust-everything";
    expect(() => getMalwareScanner()).toThrow();
  });
});

describe.skipIf(!clamscanAvailable())("clamscan adapter (real binary)", () => {
  it("reports clean and infected using a configured signature directory", async () => {
    process.env.MALWARE_SCANNER_DRIVER = "clamscan";
    process.env.CLAMSCAN_DATABASE_DIR = database;
    const scanner = getMalwareScanner()!;
    expect(scanner.provider).toBe("clamscan");
    expect((await scanner.scan(input("ordinary text"))).status).toBe("clean");
    const infected = await scanner.scan(input("xx LOCAL-TEST-MARKER-51d2 xx"));
    expect(infected.status).toBe("infected");
    expect(String(infected.details?.signature)).toContain("Local.Test.Marker");
    // The temporary copy is removed.
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("sicwe-scan-"))).toEqual([]);
  });

  it("fails (stays quarantined) without signatures or without the binary", async () => {
    process.env.MALWARE_SCANNER_DRIVER = "clamscan";
    process.env.CLAMSCAN_DATABASE_DIR = empty;
    expect((await getMalwareScanner()!.scan(input("ordinary text"))).status).toBe("failed");
    process.env.CLAMSCAN_DATABASE_DIR = database;
    process.env.CLAMSCAN_PATH = path.join(work, "missing-binary");
    const result = await getMalwareScanner()!.scan(input("ordinary text"));
    expect(result).toMatchObject({ status: "failed", details: { reason: "scanner_unavailable" } });
  });
});
