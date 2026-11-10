import { randomUUID } from "node:crypto";
import { and, eq, max } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditEvents,
  cases,
  documentAccessEvents,
  documentCaseLinks,
  documentCustodyEvents,
  documents,
  documentSubmissionLinks,
  documentTypes,
  documentVersions,
  intakeSubmissions,
} from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import { auditEventValues } from "@/modules/audit/event";
import { sha256Hex } from "./hash";
import {
  isDocumentVisibility,
  type DocumentVisibility,
  type MalwareScanStatus,
} from "./policy";
import {
  documentStorageKey,
  getDocumentStorageAdapter,
  type DocumentStorageAdapter,
} from "./storage";
import {
  enqueueDocumentScanInTransaction,
} from "./scan-queue";

const typeKeyPattern = /^[a-z][a-z0-9_-]*$/;

export class DocumentNotFoundError extends Error {
  constructor() {
    super("Document was not found in the active organization.");
    this.name = "DocumentNotFoundError";
  }
}

export class DocumentContentUnavailableError extends Error {
  constructor() {
    super("Document content is not available for download.");
    this.name = "DocumentContentUnavailableError";
  }
}

export function configuredDocumentMaxBytes(): number {
  const raw = Number(
    process.env.DOCUMENT_MAX_BYTES ?? String(25 * 1024 * 1024),
  );

  if (!Number.isSafeInteger(raw) || raw < 1) {
    throw new Error("DOCUMENT_MAX_BYTES must be a positive integer.");
  }

  return raw;
}

export async function createDocumentType(
  db: Database,
  scope: TenantScope,
  input: {
    key: string;
    name: string;
    description?: string | null;
    acceptedMimeTypes?: string[];
    maxBytes?: number | null;
    actorUserId?: string | null;
  },
) {
  const key = input.key.trim();
  if (!typeKeyPattern.test(key)) {
    throw new Error("Document type key is invalid.");
  }
  if (!input.name.trim()) {
    throw new Error("Document type name is required.");
  }
  if (
    input.maxBytes !== undefined &&
    input.maxBytes !== null &&
    (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)
  ) {
    throw new Error("Document type maxBytes must be a positive integer.");
  }

  const [row] = await db
    .insert(documentTypes)
    .values({
      organizationId: scope.organizationId,
      key,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      acceptedMimeTypes: [
        ...new Set(
          (input.acceptedMimeTypes ?? [])
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
        ),
      ],
      maxBytes:
        input.maxBytes !== undefined && input.maxBytes !== null
          ? input.maxBytes
          : null,
      createdByUserId: input.actorUserId ?? null,
    })
    .returning();


  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: input.actorUserId ? "user" : "system",
      actorUserId: input.actorUserId ?? null,
      action: "document.type_created",
      resourceType: "document_type",
      resourceId: row.id,
      newState: {
        key: row.key,
        status: row.status,
        maxBytes: row.maxBytes,
      },
      metadata: {
        acceptedMimeTypes: row.acceptedMimeTypes,
      },
    }),
  );

  return row;
}

export async function uploadDocumentToCase(
  db: Database,
  scope: TenantScope,
  input: {
    caseId: string;
    documentTypeId: string;
    title: string;
    description?: string | null;
    visibility: DocumentVisibility;
    filename: string;
    mimeType: string;
    data: Uint8Array;
    actorUserId: string;
    evidenceDescription?: string | null;
    sourceDescription?: string | null;
    exhibitLabel?: string | null;
  },
  storage: DocumentStorageAdapter = getDocumentStorageAdapter(),
) {
  const target = await validateUploadTarget(
    db,
    scope,
    input.caseId,
    input.documentTypeId,
  );
  validateTypeRestrictions(target, input.mimeType, input.data.byteLength);
  const prepared = prepareContent(input.data, input.filename);
  const documentId = randomUUID();
  const versionId = randomUUID();
  const key = documentStorageKey({
    organizationId: scope.organizationId,
    documentId,
    versionId,
  });

  await storage.put(key, input.data);

  try {
    return await db.transaction(async (tx) => {
      const [document] = await tx
        .insert(documents)
        .values({
          id: documentId,
          organizationId: scope.organizationId,
          documentTypeId: target.documentTypeId,
          title: input.title.trim() || prepared.filename,
          description: input.description?.trim() || null,
          visibility: input.visibility,
          createdByUserId: input.actorUserId,
        })
        .returning();

      const [version] = await tx
        .insert(documentVersions)
        .values({
          id: versionId,
          organizationId: scope.organizationId,
          documentId,
          versionNumber: 1,
          originalFilename: prepared.filename,
          mimeType: input.mimeType.trim() || "application/octet-stream",
          sizeBytes: input.data.byteLength,
          sha256: prepared.sha256,
          storageDriver: storage.driver,
          storageKey: key,
          contentStatus: "quarantined",
          malwareScanStatus: "pending",
          uploadedByUserId: input.actorUserId,
        })
        .returning();

      const [link] = await tx
        .insert(documentCaseLinks)
        .values({
          organizationId: scope.organizationId,
          caseId: input.caseId,
          documentVersionId: versionId,
          relationship: "evidence",
          evidenceDescription:
            input.evidenceDescription?.trim() || null,
          sourceDescription:
            input.sourceDescription?.trim() || null,
          exhibitLabel: input.exhibitLabel?.trim() || null,
          attachedByUserId: input.actorUserId ?? null,
        })
        .returning();

      await tx.insert(documentCustodyEvents).values({
        organizationId: scope.organizationId,
        documentVersionId: versionId,
        action: "uploaded",
        toCustodian: "system",
        location: storage.driver,
        actorUserId: input.actorUserId ?? null,
        note: `SHA-256 ${prepared.sha256}`,
      });

      await tx.insert(documentAccessEvents).values({
        organizationId: scope.organizationId,
        documentVersionId: versionId,
        action: "upload",
        actorUserId: input.actorUserId ?? null,
        metadata: {
          caseId: input.caseId,
          storageDriver: storage.driver,
        },
      });

      await tx.insert(auditEvents).values(
        auditEventValues({
          organizationId: scope.organizationId,
          actorType: "user",
          actorUserId: input.actorUserId ?? null,
          action: "document.uploaded",
          resourceType: "document_version",
          resourceId: version.id,
          parentResourceType: "case",
          parentResourceId: input.caseId,
          newState: {
            contentStatus: version.contentStatus,
            malwareScanStatus: version.malwareScanStatus,
          },
          metadata: {
            documentId: document.id,
            documentTypeId: document.documentTypeId,
            versionNumber: version.versionNumber,
            sha256: version.sha256,
            mimeType: version.mimeType,
            sizeBytes: version.sizeBytes,
            visibility: document.visibility,
            relationship: link.relationship,
          },
        }),
      );

      await enqueueDocumentScanInTransaction(
        tx,
        scope,
        version.id,
      );

      return { document, version, link };
    });
  } catch (error) {
    await storage.remove(key).catch(() => undefined);
    throw error;
  }
}

export async function uploadDocumentToSubmission(
  db: Database,
  scope: TenantScope,
  input: {
    submissionId: string;
    documentTypeId: string;
    formFieldId?: string | null;
    title: string;
    description?: string | null;
    visibility: DocumentVisibility;
    filename: string;
    mimeType: string;
    data: Uint8Array;
    actorUserId?: string | null;
  },
  storage: DocumentStorageAdapter = getDocumentStorageAdapter(),
) {
  const [[submission], [type]] = await Promise.all([
    db
      .select({ id: intakeSubmissions.id })
      .from(intakeSubmissions)
      .where(
        and(
          eq(intakeSubmissions.id, input.submissionId),
          eq(intakeSubmissions.organizationId, scope.organizationId),
        ),
      )
      .limit(1),
    db
      .select({
        id: documentTypes.id,
        acceptedMimeTypes: documentTypes.acceptedMimeTypes,
        maxBytes: documentTypes.maxBytes,
      })
      .from(documentTypes)
      .where(
        and(
          eq(documentTypes.id, input.documentTypeId),
          eq(documentTypes.organizationId, scope.organizationId),
          eq(documentTypes.status, "active"),
        ),
      )
      .limit(1),
  ]);

  if (!submission || !type) throw new DocumentNotFoundError();

  validateTypeRestrictions(type, input.mimeType, input.data.byteLength);
  const prepared = prepareContent(input.data, input.filename);
  const documentId = randomUUID();
  const versionId = randomUUID();
  const key = documentStorageKey({
    organizationId: scope.organizationId,
    documentId,
    versionId,
  });

  await storage.put(key, input.data);

  try {
    return await db.transaction(async (tx) => {
      const [document] = await tx
        .insert(documents)
        .values({
          id: documentId,
          organizationId: scope.organizationId,
          documentTypeId: type.id,
          title: input.title.trim() || prepared.filename,
          description: input.description?.trim() || null,
          visibility: input.visibility,
          createdByUserId: input.actorUserId ?? null,
        })
        .returning();

      const [version] = await tx
        .insert(documentVersions)
        .values({
          id: versionId,
          organizationId: scope.organizationId,
          documentId,
          versionNumber: 1,
          originalFilename: prepared.filename,
          mimeType: input.mimeType.trim() || "application/octet-stream",
          sizeBytes: input.data.byteLength,
          sha256: prepared.sha256,
          storageDriver: storage.driver,
          storageKey: key,
          contentStatus: "quarantined",
          malwareScanStatus: "pending",
          uploadedByUserId: input.actorUserId ?? null,
        })
        .returning();

      const [link] = await tx
        .insert(documentSubmissionLinks)
        .values({
          organizationId: scope.organizationId,
          submissionId: input.submissionId,
          documentVersionId: versionId,
          formFieldId: input.formFieldId?.trim() || null,
          attachedByUserId: input.actorUserId ?? null,
        })
        .returning();

      await tx.insert(documentCustodyEvents).values({
        organizationId: scope.organizationId,
        documentVersionId: versionId,
        action: "uploaded",
        toCustodian: "system",
        location: storage.driver,
        actorUserId: input.actorUserId ?? null,
        note: `SHA-256 ${prepared.sha256}`,
      });

      await tx.insert(documentAccessEvents).values({
        organizationId: scope.organizationId,
        documentVersionId: versionId,
        action: "upload",
        actorUserId: input.actorUserId ?? null,
        metadata: {
          submissionId: input.submissionId,
          storageDriver: storage.driver,
        },
      });


      await tx.insert(auditEvents).values(
        auditEventValues({
          organizationId: scope.organizationId,
          actorType: input.actorUserId ? "user" : "anonymous",
          actorUserId: input.actorUserId ?? null,
          action: "document.uploaded",
          resourceType: "document_version",
          resourceId: version.id,
          parentResourceType: "submission",
          parentResourceId: input.submissionId,
          newState: {
            contentStatus: version.contentStatus,
            malwareScanStatus: version.malwareScanStatus,
          },
          metadata: {
            documentId: document.id,
            documentTypeId: document.documentTypeId,
            versionNumber: version.versionNumber,
            sha256: version.sha256,
            mimeType: version.mimeType,
            sizeBytes: version.sizeBytes,
            visibility: document.visibility,
            formFieldId: link.formFieldId,
          },
        }),
      );

      await enqueueDocumentScanInTransaction(
        tx,
        scope,
        version.id,
      );

      return { document, version, link };
    });
  } catch (error) {
    await storage.remove(key).catch(() => undefined);
    throw error;
  }
}

export async function addDocumentVersion(
  db: Database,
  scope: TenantScope,
  input: {
    documentId: string;
    filename: string;
    mimeType: string;
    data: Uint8Array;
    actorUserId: string;
  },
  storage: DocumentStorageAdapter = getDocumentStorageAdapter(),
) {
  const [document] = await db
    .select({
      id: documents.id,
      acceptedMimeTypes: documentTypes.acceptedMimeTypes,
      maxBytes: documentTypes.maxBytes,
    })
    .from(documents)
    .innerJoin(
      documentTypes,
      and(
        eq(documentTypes.id, documents.documentTypeId),
        eq(documentTypes.organizationId, scope.organizationId),
        eq(documentTypes.status, "active"),
      ),
    )
    .where(
      and(
        eq(documents.id, input.documentId),
        eq(documents.organizationId, scope.organizationId),
        eq(documents.status, "active"),
      ),
    )
    .limit(1);

  if (!document) throw new DocumentNotFoundError();
  validateTypeRestrictions(
    document,
    input.mimeType,
    input.data.byteLength,
  );

  const [current] = await db
    .select({ value: max(documentVersions.versionNumber) })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.organizationId, scope.organizationId),
        eq(documentVersions.documentId, document.id),
      ),
    );

  const prepared = prepareContent(input.data, input.filename);
  const versionNumber = (current?.value ?? 0) + 1;
  const versionId = randomUUID();
  const key = documentStorageKey({
    organizationId: scope.organizationId,
    documentId: document.id,
    versionId,
  });

  await storage.put(key, input.data);

  try {
    return await db.transaction(async (tx) => {
      const [version] = await tx
        .insert(documentVersions)
        .values({
          id: versionId,
          organizationId: scope.organizationId,
          documentId: document.id,
          versionNumber,
          originalFilename: prepared.filename,
          mimeType: input.mimeType.trim() || "application/octet-stream",
          sizeBytes: input.data.byteLength,
          sha256: prepared.sha256,
          storageDriver: storage.driver,
          storageKey: key,
          contentStatus: "quarantined",
          malwareScanStatus: "pending",
          uploadedByUserId: input.actorUserId,
        })
        .returning();

      await tx.insert(documentCustodyEvents).values({
        organizationId: scope.organizationId,
        documentVersionId: version.id,
        action: "version_uploaded",
        toCustodian: "system",
        location: storage.driver,
        actorUserId: input.actorUserId,
        note: `SHA-256 ${prepared.sha256}`,
      });

      await tx.insert(auditEvents).values(
        auditEventValues({
          organizationId: scope.organizationId,
          actorType: "user",
          actorUserId: input.actorUserId,
          action: "document.version_created",
          resourceType: "document_version",
          resourceId: version.id,
          parentResourceType: "document",
          parentResourceId: document.id,
          newState: {
            versionNumber: version.versionNumber,
            contentStatus: version.contentStatus,
            malwareScanStatus: version.malwareScanStatus,
          },
          metadata: {
            sha256: version.sha256,
            mimeType: version.mimeType,
            sizeBytes: version.sizeBytes,
          },
        }),
      );

      await enqueueDocumentScanInTransaction(
        tx,
        scope,
        version.id,
      );
      return version;
    });
  } catch (error) {
    await storage.remove(key).catch(() => undefined);
    throw error;
  }
}

export async function attachDocumentVersionToCase(
  db: Database,
  scope: TenantScope,
  input: {
    caseId: string;
    documentVersionId: string;
    actorUserId: string;
    evidenceDescription?: string | null;
    sourceDescription?: string | null;
    exhibitLabel?: string | null;
  },
) {
  const [[caseRecord], [version]] = await Promise.all([
    db
      .select({ id: cases.id })
      .from(cases)
      .where(
        and(
          eq(cases.id, input.caseId),
          eq(cases.organizationId, scope.organizationId),
        ),
      )
      .limit(1),
    db
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.id, input.documentVersionId),
          eq(documentVersions.organizationId, scope.organizationId),
        ),
      )
      .limit(1),
  ]);

  if (!caseRecord || !version) throw new DocumentNotFoundError();

  const [link] = await db
    .insert(documentCaseLinks)
    .values({
      organizationId: scope.organizationId,
      caseId: caseRecord.id,
      documentVersionId: version.id,
      evidenceDescription:
        input.evidenceDescription?.trim() || null,
      sourceDescription:
        input.sourceDescription?.trim() || null,
      exhibitLabel: input.exhibitLabel?.trim() || null,
      attachedByUserId: input.actorUserId ?? null,
    })
    .onConflictDoNothing()
    .returning();


  if (link) {
    await db.insert(auditEvents).values(
      auditEventValues({
        organizationId: scope.organizationId,
        actorType: "user",
        actorUserId: input.actorUserId ?? null,
        action: "document.attached_to_case",
        resourceType: "document_version",
        resourceId: version.id,
        parentResourceType: "case",
        parentResourceId: caseRecord.id,
        metadata: {
          linkId: link.id,
          relationship: link.relationship,
          exhibitLabelPresent: Boolean(link.exhibitLabel),
        },
      }),
    );
  }

  return link ?? null;
}

export async function recordMalwareScanResult(
  db: Database,
  scope: TenantScope,
  input: {
    versionId: string;
    status: MalwareScanStatus;
    provider: string;
    details?: Record<string, unknown>;
    actorUserId?: string | null;
  },
) {
  if (!input.provider.trim()) {
    throw new Error("Malware scan provider is required.");
  }

  const contentStatus =
    input.status === "clean"
      ? "available"
      : input.status === "infected"
        ? "blocked"
        : "quarantined";

  return db.transaction(async (tx) => {
    const [version] = await tx
      .update(documentVersions)
      .set({
        malwareScanStatus: input.status,
        malwareScanProvider: input.provider.trim(),
        malwareScanDetails: input.details ?? {},
        malwareScannedAt: new Date(),
        contentStatus,
      })
      .where(
        and(
          eq(documentVersions.id, input.versionId),
          eq(documentVersions.organizationId, scope.organizationId),
        ),
      )
      .returning();

    if (!version) throw new DocumentNotFoundError();

    const submissionLinks = await tx
      .select({
        submissionId: documentSubmissionLinks.submissionId,
      })
      .from(documentSubmissionLinks)
      .where(
        and(
          eq(
            documentSubmissionLinks.organizationId,
            scope.organizationId,
          ),
          eq(
            documentSubmissionLinks.documentVersionId,
            version.id,
          ),
        ),
      );
    const promotedCaseIds: string[] = [];

    if (input.status === "clean") {

      for (const submissionLink of submissionLinks) {
        const [caseRecord] = await tx
          .select({ id: cases.id })
          .from(cases)
          .where(
            and(
              eq(cases.organizationId, scope.organizationId),
              eq(
                cases.sourceSubmissionId,
                submissionLink.submissionId,
              ),
            ),
          )
          .limit(1);

        if (caseRecord) {
          await tx
            .insert(documentCaseLinks)
            .values({
              organizationId: scope.organizationId,
              caseId: caseRecord.id,
              documentVersionId: version.id,
              relationship: "evidence",
              sourceDescription:
                "Promoted from clean intake attachment.",
              attachedByUserId: input.actorUserId ?? null,
            })
            .onConflictDoNothing();
          promotedCaseIds.push(caseRecord.id);
        }
      }
    }

    await tx.insert(documentAccessEvents).values({
      organizationId: scope.organizationId,
      documentVersionId: version.id,
      action: "scan_result",
      actorUserId: input.actorUserId ?? null,
      metadata: {
        status: input.status,
        provider: input.provider,
      },
    });

    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: scope.organizationId,
        actorType: input.actorUserId ? "user" : "system",
        actorUserId: input.actorUserId ?? null,
        action: "document.scan_recorded",
        resourceType: "document_version",
        resourceId: version.id,
        parentResourceType: submissionLinks[0] ? "submission" : null,
        parentResourceId: submissionLinks[0]?.submissionId ?? null,
        newState: {
          malwareScanStatus: version.malwareScanStatus,
          contentStatus: version.contentStatus,
        },
        metadata: {
          provider: version.malwareScanProvider,
          documentId: version.documentId,
          sha256: version.sha256,
          sizeBytes: version.sizeBytes,
          mimeType: version.mimeType,
          submissionIds: submissionLinks.map(
            (link) => link.submissionId,
          ),
          caseIds: promotedCaseIds,
        },
      }),
    );

    return version;
  });
}

export async function recordCustodyEvent(
  db: Database,
  scope: TenantScope,
  input: {
    versionId: string;
    action: string;
    fromCustodian?: string | null;
    toCustodian?: string | null;
    location?: string | null;
    note?: string | null;
    actorUserId: string;
    occurredAt?: Date;
  },
) {
  if (!input.action.trim()) {
    throw new Error("Custody action is required.");
  }

  const [version] = await db
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.id, input.versionId),
        eq(documentVersions.organizationId, scope.organizationId),
      ),
    )
    .limit(1);

  if (!version) throw new DocumentNotFoundError();

  const [event] = await db
    .insert(documentCustodyEvents)
    .values({
      organizationId: scope.organizationId,
      documentVersionId: version.id,
      action: input.action.trim(),
      fromCustodian: input.fromCustodian?.trim() || null,
      toCustodian: input.toCustodian?.trim() || null,
      location: input.location?.trim() || null,
      note: input.note?.trim() || null,
      actorUserId: input.actorUserId ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();


  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: "user",
      actorUserId: input.actorUserId ?? null,
      action: "document.custody_recorded",
      resourceType: "document_version",
      resourceId: version.id,
      metadata: {
        custodyEventId: event.id,
        action: event.action,
        fromCustodian: event.fromCustodian,
        toCustodian: event.toCustodian,
        location: event.location,
      },
    }),
  );

  return event;
}

export async function downloadDocumentVersion(
  db: Database,
  scope: TenantScope,
  input: {
    versionId: string;
    actorUserId: string;
  },
  storage: DocumentStorageAdapter = getDocumentStorageAdapter(),
) {
  const [version] = await db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.id, input.versionId),
        eq(documentVersions.organizationId, scope.organizationId),
      ),
    )
    .limit(1);

  if (!version) throw new DocumentNotFoundError();
  if (
    version.contentStatus !== "available" ||
    version.malwareScanStatus !== "clean"
  ) {
    throw new DocumentContentUnavailableError();
  }
  if (version.storageDriver !== storage.driver) {
    throw new Error(
      `Document uses storage driver ${version.storageDriver}; current adapter is ${storage.driver}.`,
    );
  }

  const data = await storage.get(version.storageKey);
  if (sha256Hex(data) !== version.sha256) {
    throw new Error("Stored document content hash mismatch.");
  }

  await db.insert(documentAccessEvents).values({
    organizationId: scope.organizationId,
    documentVersionId: version.id,
    action: "download",
    actorUserId: input.actorUserId ?? null,
    metadata: {},
  });

  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: "user",
      actorUserId: input.actorUserId ?? null,
      action: "document.downloaded",
      resourceType: "document_version",
      resourceId: version.id,
      metadata: {
        documentId: version.documentId,
        versionNumber: version.versionNumber,
        sha256: version.sha256,
        sizeBytes: version.sizeBytes,
      },
    }),
  );

  return { version, data };
}

function prepareContent(data: Uint8Array, filename: string) {
  if (data.byteLength < 1) {
    throw new Error("Document content is empty.");
  }
  if (data.byteLength > configuredDocumentMaxBytes()) {
    throw new Error("Document exceeds configured maximum size.");
  }

  const sanitized = filename
    .trim()
    .replace(/[\\/\0]/g, "_")
    .slice(0, 240);

  if (!sanitized) {
    throw new Error("Document filename is required.");
  }

  return {
    filename: sanitized,
    sha256: sha256Hex(data),
  };
}

async function validateUploadTarget(
  db: Database,
  scope: TenantScope,
  caseId: string,
  documentTypeId: string,
) {
  const [[caseRecord], [type]] = await Promise.all([
    db
      .select({ id: cases.id })
      .from(cases)
      .where(
        and(
          eq(cases.id, caseId),
          eq(cases.organizationId, scope.organizationId),
        ),
      )
      .limit(1),
    db
      .select({
        id: documentTypes.id,
        acceptedMimeTypes: documentTypes.acceptedMimeTypes,
        maxBytes: documentTypes.maxBytes,
      })
      .from(documentTypes)
      .where(
        and(
          eq(documentTypes.id, documentTypeId),
          eq(documentTypes.organizationId, scope.organizationId),
          eq(documentTypes.status, "active"),
        ),
      )
      .limit(1),
  ]);

  if (!caseRecord || !type) throw new DocumentNotFoundError();

  return {
    caseId: caseRecord.id,
    documentTypeId: type.id,
    acceptedMimeTypes: type.acceptedMimeTypes,
    maxBytes: type.maxBytes,
  };
}

function validateTypeRestrictions(
  type: {
    acceptedMimeTypes: string[];
    maxBytes: number | null;
  },
  mimeType: string,
  sizeBytes: number,
) {
  const normalizedMime =
    mimeType.trim().toLowerCase() || "application/octet-stream";

  if (
    type.acceptedMimeTypes.length > 0 &&
    !type.acceptedMimeTypes.includes(normalizedMime)
  ) {
    throw new Error(
      `Document MIME type ${normalizedMime} is not allowed for this document type.`,
    );
  }

  if (type.maxBytes !== null && sizeBytes > type.maxBytes) {
    throw new Error("Document exceeds the document-type size limit.");
  }
}

export function parseDocumentVisibility(
  value: string,
): DocumentVisibility {
  if (!isDocumentVisibility(value)) {
    throw new Error("Document visibility is invalid.");
  }
  return value;
}
