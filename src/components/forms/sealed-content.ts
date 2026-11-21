import type { FormField } from "@/modules/forms/definition";

/**
 * Builds the content sealed in the participant's browser: every visible
 * sealed answer and file of the form, together, in one record. `text` and
 * `files` follow the research application's sealed-record shape (its reader
 * shows `text` and offers `files` for saving); `answers` keeps the values by
 * field id for machine use.
 */
export interface SealedFileInput {
  fieldId: string;
  name: string;
  type: string;
  bytes: Uint8Array;
}

export interface SealedContent {
  schema: "intake-sealed-answers/v1";
  text: string;
  fields: Array<{ id: string; label: string; type: string }>;
  answers: Record<string, unknown>;
  files?: Array<{ fieldId: string; name: string; type: string; base64: string }>;
}

const ADDRESS_PARTS = ["line1", "line2", "city", "region", "postalCode", "country"] as const;

function isEmpty(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value as Record<string, unknown>).every((part) => !part))
  );
}

function optionLabel(field: FormField, value: string) {
  return field.options?.find((option) => option.value === value)?.label ?? value;
}

function displayValue(field: FormField, value: unknown): string {
  switch (field.type) {
    case "boolean":
    case "attestation":
      return value === true ? "Yes" : "No";
    case "select":
      return typeof value === "string" ? optionLabel(field, value) : String(value);
    case "multiselect":
      return Array.isArray(value)
        ? value.map((item) => optionLabel(field, String(item))).join(", ")
        : String(value);
    case "address": {
      const address = (value ?? {}) as Record<string, string>;
      return ADDRESS_PARTS.map((part) => address[part]).filter(Boolean).join("\n");
    }
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Returns null when no sealed field has an answer or file (nothing to seal). */
export function buildSealedContent(
  sealedFields: readonly FormField[],
  visibleFieldIds: ReadonlySet<string>,
  answers: Record<string, unknown>,
  files: readonly SealedFileInput[],
): SealedContent | null {
  const visible = sealedFields.filter((field) => visibleFieldIds.has(field.id));
  const visibleIds = new Set(visible.map((field) => field.id));
  const sealedAnswers: Record<string, unknown> = {};
  const blocks: string[] = [];
  const sealedFiles = files.filter((file) => visibleIds.has(file.fieldId));

  for (const field of visible) {
    if (field.type === "file") {
      const names = sealedFiles
        .filter((file) => file.fieldId === field.id)
        .map((file) => file.name);
      if (names.length > 0) {
        sealedAnswers[field.id] = names;
        blocks.push(`${field.label}\nAttached files: ${names.join(", ")}`);
      }
      continue;
    }
    const value = answers[field.id];
    if (isEmpty(value)) continue;
    sealedAnswers[field.id] = value;
    blocks.push(`${field.label}\n${displayValue(field, value)}`);
  }

  if (Object.keys(sealedAnswers).length === 0) return null;
  const content: SealedContent = {
    schema: "intake-sealed-answers/v1",
    text: blocks.join("\n\n"),
    fields: visible
      .filter((field) => Object.hasOwn(sealedAnswers, field.id))
      .map((field) => ({ id: field.id, label: field.label, type: field.type })),
    answers: sealedAnswers,
  };
  if (sealedFiles.length > 0) {
    content.files = sealedFiles.map((file) => ({
      fieldId: file.fieldId,
      name: file.name,
      type: file.type || "application/octet-stream",
      base64: base64FromBytes(file.bytes),
    }));
  }
  return content;
}
