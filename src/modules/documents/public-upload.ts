import { randomUUID } from "node:crypto";
import type { Database, DatabaseTransaction } from "@/db/client";
import {
  auditEvents,
  documentAccessEvents,
  documentCustodyEvents,
  documents,
  documentSubmissionLinks,
  documentVersions,
} from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import { auditEventValues } from "@/modules/audit/event";
import {
  fieldsInDefinition,
  type FormDefinition,
} from "@/modules/forms/definition";
import { visibleFieldIdsForDefinition } from "@/modules/forms/visibility";
import { sha256Hex } from "./hash";
import { findActiveDocumentTypeByKey } from "./repository";
import { enqueueDocumentScanInTransaction } from "./scan-queue";
import {
  documentStorageKey,
  getDocumentStorageAdapter,
  type DocumentStorageAdapter,
} from "./storage";

export interface PublicUploadValidationErrorItem {
  fieldId: string;
  message: string;
}

export class PublicUploadValidationError extends Error {
  readonly errors: PublicUploadValidationErrorItem[];

  constructor(errors: PublicUploadValidationErrorItem[]) {
    super("Public upload validation failed.");
    this.name = "PublicUploadValidationError";
    this.errors = errors;
  }
}

export interface StagedPublicUpload {
  documentId: string;
  versionId: string;
  documentTypeId: string;
  formFieldId: string;
  visibility: "participant" | "internal" | "restricted";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageDriver: string;
  storageKey: string;
}

export interface StagedPublicUploadSet {
  uploads: StagedPublicUpload[];
  answerReferences: Record<string, string[]>;
  storage: DocumentStorageAdapter;
}

function browserFiles(formData: FormData, fieldId: string): File[] {
  return formData
    .getAll(fieldId)
    .filter(
      (value): value is File =>
        typeof value !== "string" &&
        typeof value.name === "string" &&
        value.size > 0,
    );
}

function normalizedMime(value: string) {
  return value.trim().toLowerCase() || "application/octet-stream";
}

function positiveByteSetting(
  name: string,
  fallback: number,
): number {
  const raw = Number(process.env[name] ?? String(fallback));
  if (!Number.isSafeInteger(raw) || raw < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return raw;
}

function configuredPublicUploadMaxBytes(): number {
  return positiveByteSetting(
    "DOCUMENT_MAX_BYTES",
    25 * 1024 * 1024,
  );
}

function configuredPublicUploadTotalMaxBytes(): number {
  return positiveByteSetting(
    "PUBLIC_UPLOAD_TOTAL_MAX_BYTES",
    50 * 1024 * 1024,
  );
}

export async function stagePublicSubmissionUploads(
  db: Database,
  scope: TenantScope,
  definition: FormDefinition,
  ordinaryAnswers: Record<string, unknown>,
  formData: FormData,
  storage: DocumentStorageAdapter = getDocumentStorageAdapter(),
): Promise<StagedPublicUploadSet> {
  const uploads: StagedPublicUpload[] = [];
  const answerReferences: Record<string, string[]> = {};
  const errors: PublicUploadValidationErrorItem[] = [];
  const visible = visibleFieldIdsForDefinition(definition, ordinaryAnswers);
  const totalMaxBytes = configuredPublicUploadTotalMaxBytes();
  let acceptedBytes = 0;

  try {
    for (const field of fieldsInDefinition(definition)) {
      if (field.type !== "file" || !visible.has(field.id)) continue;
      // Sealed files are encrypted in the browser into the sealed envelope;
      // a file posted in clear under a sealed field is never stored.
      if (field.sealed) continue;

      const files = browserFiles(formData, field.id);
      if (!field.publicUpload) {
        if (files.length > 0 || field.required) {
          errors.push({
            fieldId: field.id,
            message: "Secure public upload is not enabled for this field.",
          });
        }
        continue;
      }

      if (field.required && files.length === 0) {
        errors.push({
          fieldId: field.id,
          message: "This field is required.",
        });
        continue;
      }

      const maxFiles = field.maxFiles ?? 1;
      if (files.length > maxFiles) {
        errors.push({
          fieldId: field.id,
          message: `Attach no more than ${maxFiles} files.`,
        });
        continue;
      }

      const documentType = await findActiveDocumentTypeByKey(
        db,
        scope,
        field.publicUpload.documentTypeKey,
      );
      if (!documentType) {
        throw new Error(
          `Configured public-upload document type '${field.publicUpload.documentTypeKey}' is unavailable.`,
        );
      }

      const refs: string[] = [];
      for (const file of files) {
        const mimeType = normalizedMime(file.type);
        const globalMax = configuredPublicUploadMaxBytes();

        if (file.size > globalMax) {
          errors.push({
            fieldId: field.id,
            message: "An attachment exceeds the deployment upload-size limit.",
          });
          continue;
        }
        if (acceptedBytes + file.size > totalMaxBytes) {
          errors.push({
            fieldId: field.id,
            message: "The combined attachment size exceeds the public-upload request limit.",
          });
          continue;
        }
        if (
          documentType.maxBytes !== null &&
          file.size > documentType.maxBytes
        ) {
          errors.push({
            fieldId: field.id,
            message: "An attachment exceeds the allowed size for this document type.",
          });
          continue;
        }
        if (
          field.acceptedMimeTypes?.length &&
          !field.acceptedMimeTypes
            .map((value) => value.trim().toLowerCase())
            .includes(mimeType)
        ) {
          errors.push({
            fieldId: field.id,
            message: `Attachment type ${mimeType} is not allowed for this field.`,
          });
          continue;
        }
        if (
          documentType.acceptedMimeTypes.length > 0 &&
          !documentType.acceptedMimeTypes.includes(mimeType)
        ) {
          errors.push({
            fieldId: field.id,
            message: `Attachment type ${mimeType} is not allowed for this document type.`,
          });
          continue;
        }

        const data = new Uint8Array(await file.arrayBuffer());
        if (data.byteLength !== file.size || data.byteLength < 1) {
          errors.push({
            fieldId: field.id,
            message: "An attachment could not be read safely.",
          });
          continue;
        }

        const documentId = randomUUID();
        const versionId = randomUUID();
        const storageKey = documentStorageKey({
          organizationId: scope.organizationId,
          documentId,
          versionId,
        });
        await storage.put(storageKey, data);

        const filename = file.name
          .trim()
          .replace(/[\\/\0]/g, "_")
          .slice(0, 240);
        if (!filename) {
          errors.push({
            fieldId: field.id,
            message: "An attachment filename is required.",
          });
          await storage.remove(storageKey).catch(() => undefined);
          continue;
        }

        acceptedBytes += data.byteLength;
        uploads.push({
          documentId,
          versionId,
          documentTypeId: documentType.id,
          formFieldId: field.id,
          visibility: field.publicUpload.visibility,
          filename,
          mimeType,
          sizeBytes: data.byteLength,
          sha256: sha256Hex(data),
          storageDriver: storage.driver,
          storageKey,
        });
        refs.push(versionId);
      }

      if (refs.length > 0) {
        answerReferences[field.id] = refs;
      }
    }

    if (errors.length > 0) {
      throw new PublicUploadValidationError(errors);
    }

    return { uploads, answerReferences, storage };
  } catch (error) {
    await cleanupStagedPublicUploads({ uploads, answerReferences, storage });
    throw error;
  }
}

export async function cleanupStagedPublicUploads(
  staged: StagedPublicUploadSet,
) {
  await Promise.all(
    staged.uploads.map((upload) =>
      staged.storage.remove(upload.storageKey).catch(() => undefined),
    ),
  );
}

export async function persistStagedPublicUploads(
  tx: DatabaseTransaction,
  scope: TenantScope,
  submissionId: string,
  uploads: readonly StagedPublicUpload[],
) {
  for (const upload of uploads) {
    const [document] = await tx
      .insert(documents)
      .values({
        id: upload.documentId,
        organizationId: scope.organizationId,
        documentTypeId: upload.documentTypeId,
        title: upload.filename || "Uploaded attachment",
        visibility: upload.visibility,
        createdByUserId: null,
      })
      .returning();

    const [version] = await tx
      .insert(documentVersions)
      .values({
        id: upload.versionId,
        organizationId: scope.organizationId,
        documentId: upload.documentId,
        versionNumber: 1,
        originalFilename: upload.filename || "attachment",
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        sha256: upload.sha256,
        storageDriver: upload.storageDriver,
        storageKey: upload.storageKey,
        contentStatus: "quarantined",
        malwareScanStatus: "pending",
        uploadedByUserId: null,
      })
      .returning();

    const [link] = await tx
      .insert(documentSubmissionLinks)
      .values({
        organizationId: scope.organizationId,
        submissionId,
        documentVersionId: upload.versionId,
        formFieldId: upload.formFieldId,
        attachedByUserId: null,
      })
      .returning();

    await tx.insert(documentCustodyEvents).values({
      organizationId: scope.organizationId,
      documentVersionId: upload.versionId,
      action: "public_upload_quarantined",
      toCustodian: "system",
      location: upload.storageDriver,
      actorUserId: null,
      note: `SHA-256 ${upload.sha256}`,
    });

    await tx.insert(documentAccessEvents).values({
      organizationId: scope.organizationId,
      documentVersionId: upload.versionId,
      action: "public_upload",
      actorUserId: null,
      metadata: {
        submissionId,
        formFieldId: upload.formFieldId,
        storageDriver: upload.storageDriver,
      },
    });

    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: scope.organizationId,
        actorType: "anonymous",
        action: "document.public_upload_quarantined",
        resourceType: "document_version",
        resourceId: version.id,
        parentResourceType: "submission",
        parentResourceId: submissionId,
        newState: {
          contentStatus: version.contentStatus,
          malwareScanStatus: version.malwareScanStatus,
        },
        metadata: {
          documentId: document.id,
          documentTypeId: document.documentTypeId,
          linkId: link.id,
          formFieldId: upload.formFieldId,
          sha256: version.sha256,
          mimeType: version.mimeType,
          sizeBytes: version.sizeBytes,
          visibility: document.visibility,
        },
      }),
    );

    await enqueueDocumentScanInTransaction(
      tx,
      scope,
      version.id,
    );
  }
}
