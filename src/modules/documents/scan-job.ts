import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { documentVersions } from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import type { ClaimedJob } from "@/modules/jobs/service";
import { sha256Hex } from "./hash";
import { getMalwareScanner } from "./scanner";
import {
  recordMalwareScanResult,
} from "./service";
import {
  getDocumentStorageAdapter,
} from "./storage";

export async function scanDocumentVersionJob(input: {
  db: Database;
  scope: TenantScope;
  job: ClaimedJob;
  finalAttempt: boolean;
}) {
  const versionId = input.job.payload.versionId;
  if (typeof versionId !== "string" || !versionId) {
    throw new Error("document.scan job is missing versionId.");
  }

  const [version] = await input.db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.id, versionId),
        eq(
          documentVersions.organizationId,
          input.scope.organizationId,
        ),
      ),
    )
    .limit(1);

  if (!version) {
    throw new Error("Document version for scan job was not found.");
  }

  if (
    version.malwareScanStatus === "clean" ||
    version.malwareScanStatus === "infected"
  ) {
    return;
  }

  const scanner = getMalwareScanner();
  if (!scanner) {
    throw new Error(
      "No malware scanner is configured; document remains quarantined.",
    );
  }

  const storage = getDocumentStorageAdapter();
  if (version.storageDriver !== storage.driver) {
    throw new Error(
      `Document storage driver ${version.storageDriver} does not match configured driver ${storage.driver}.`,
    );
  }

  let data: Uint8Array;
  try {
    data = await storage.get(version.storageKey);
  } catch (error) {
    if (!input.finalAttempt) throw error;
    await recordMalwareScanResult(
      input.db,
      input.scope,
      {
        versionId: version.id,
        status: "failed",
        provider: scanner.provider,
        details: {
          reason: "storage_read_failed",
        },
        actorUserId: null,
      },
    );
    return;
  }

  if (sha256Hex(data) !== version.sha256) {
    await recordMalwareScanResult(
      input.db,
      input.scope,
      {
        versionId: version.id,
        status: "failed",
        provider: scanner.provider,
        details: {
          reason: "sha256_mismatch",
        },
        actorUserId: null,
      },
    );
    return;
  }

  try {
    const result = await scanner.scan({
      data,
      filename: version.originalFilename,
      mimeType: version.mimeType,
      sha256: version.sha256,
    });

    if (
      result.status === "failed" &&
      !input.finalAttempt
    ) {
      throw new Error(
        "Malware scanner returned failed; retrying job.",
      );
    }

    await recordMalwareScanResult(
      input.db,
      input.scope,
      {
        versionId: version.id,
        status: result.status,
        provider: scanner.provider,
        details: result.details,
        actorUserId: null,
      },
    );
  } catch (error) {
    if (!input.finalAttempt) throw error;
    await recordMalwareScanResult(
      input.db,
      input.scope,
      {
        versionId: version.id,
        status: "failed",
        provider: scanner.provider,
        details: {
          reason: "scanner_error",
        },
        actorUserId: null,
      },
    );
  }
}
