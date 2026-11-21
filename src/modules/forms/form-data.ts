import type { FormDefinition, FormField } from "./definition";
import { fieldsInDefinition } from "./definition";

export function answersFromFormData(
  definition: FormDefinition,
  formData: FormData,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};

  for (const field of fieldsInDefinition(definition)) {
    // Sealed answers are never read from a form post: the browser sends them
    // only inside the sealed envelope (`__sealed`).
    if (field.sealed) continue;
    const parsed = parseFieldFromFormData(field, formData);
    if (parsed !== undefined) {
      answers[field.id] = parsed;
    }
  }

  return answers;
}

function parseFieldFromFormData(
  field: FormField,
  formData: FormData,
): unknown {
  switch (field.type) {
    case "boolean":
    case "attestation":
      return formData.get(field.id) === "true";
    case "number": {
      const raw = stringValue(formData.get(field.id));
      if (raw === "") return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : raw;
    }
    case "multiselect":
      return formData.getAll(field.id).map(stringValue).filter(Boolean);
    case "address": {
      const address = {
        line1: stringValue(formData.get(`${field.id}.line1`)),
        line2: stringValue(formData.get(`${field.id}.line2`)),
        city: stringValue(formData.get(`${field.id}.city`)),
        region: stringValue(formData.get(`${field.id}.region`)),
        postalCode: stringValue(formData.get(`${field.id}.postalCode`)),
        country: stringValue(formData.get(`${field.id}.country`)),
      };

      return Object.values(address).some(Boolean) ? address : undefined;
    }
    case "file": {
      // Browser File objects are staged by the public-upload subsystem. String
      // values remain supported for trusted/headless callers that already hold
      // stored document-version references.
      const references = formData
        .getAll(field.id)
        .filter((value): value is string => typeof value === "string")
        .filter(Boolean);
      return references.length > 0 ? references : undefined;
    }
    default: {
      const value = stringValue(formData.get(field.id));
      return value === "" ? undefined : value;
    }
  }
}

function stringValue(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}
