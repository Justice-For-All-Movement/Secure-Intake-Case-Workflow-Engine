import { z } from "zod";
import type { FormDefinition, FormField } from "./definition";
import { fieldsInDefinition } from "./definition";
import {
  type ValidationCode,
  validationMessage,
} from "./form-ui-strings";

export {
  type ValidationCode,
  validationMessage,
  validationMessageKeys,
} from "./form-ui-strings";
import {
  type AnswerMap,
  visibleFieldIdsForDefinition,
} from "./visibility";

export interface ValidationError {
  fieldId: string;
  /** English text (built-in strings); kept for existing API consumers. */
  message: string;
  /** Language-neutral code; render it with `validationMessage`. */
  code?: ValidationCode;
  params?: Record<string, number>;
}

function validationError(
  fieldId: string,
  code: ValidationCode,
  params?: Record<string, number>,
): ValidationError {
  const base = { code, ...(params ? { params } : {}) };
  return { fieldId, message: validationMessage({ ...base, message: "" }), ...base };
}

export type SubmissionValidationResult =
  | { success: true; answers: AnswerMap; errors: [] }
  | { success: false; answers: AnswerMap; errors: ValidationError[] };

const emailSchema = z.string().email();

export function validateSubmissionAnswers(
  definition: FormDefinition,
  rawAnswers: AnswerMap,
  options: { partial?: boolean } = {},
): SubmissionValidationResult {
  const answers = filterKnownAnswers(definition, rawAnswers);
  const errors: ValidationError[] = [];

  const visibleFieldIds = visibleFieldIdsForDefinition(definition, answers);

  for (const field of fieldsInDefinition(definition)) {
    if (!visibleFieldIds.has(field.id)) continue;
    // Checked in the browser; the server only checks the envelope exists.
    if (field.sealed) continue;

    const value = Object.prototype.hasOwnProperty.call(answers, field.id)
      ? answers[field.id]
      : undefined;
    const empty = isEmpty(value);

    if (!options.partial && field.required && empty) {
      errors.push(validationError(field.id, "required"));
      continue;
    }

    if (empty) continue;

    validateField(field, value, errors);
  }

  return errors.length === 0
    ? { success: true, answers, errors: [] }
    : { success: false, answers, errors };
}

export function filterKnownAnswers(
  definition: FormDefinition,
  rawAnswers: AnswerMap,
): AnswerMap {
  // Sealed answers are never accepted in clear: they arrive only inside the
  // sealed envelope, so a plaintext value for a sealed field is dropped here.
  const fields = fieldsInDefinition(definition).filter((field) => !field.sealed);
  const known = new Set(fields.map((field) => field.id));
  const declaredAnswers = Object.fromEntries(
    Object.entries(rawAnswers).filter(([fieldId]) => known.has(fieldId)),
  );
  const visible = visibleFieldIdsForDefinition(
    definition,
    declaredAnswers,
  );

  return Object.fromEntries(
    Object.entries(declaredAnswers).filter(([fieldId]) =>
      visible.has(fieldId),
    ),
  );
}

function validateField(
  field: FormField,
  value: unknown,
  errors: ValidationError[],
) {
  const fail = (code: ValidationCode, params?: Record<string, number>) =>
    errors.push(validationError(field.id, code, params));

  switch (field.type) {
    case "short_text":
    case "long_text":
    case "phone":
    case "date": {
      if (typeof value !== "string") {
        fail("text");
        return;
      }

      if (field.type === "date" && !isIsoDate(value)) {
        fail("date");
        return;
      }

      validateStringRules(field, value, fail);
      return;
    }

    case "email": {
      if (typeof value !== "string" || !emailSchema.safeParse(value).success) {
        fail("email");
        return;
      }
      validateStringRules(field, value, fail);
      return;
    }

    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail("number");
        return;
      }
      if (field.validation?.min !== undefined && value < field.validation.min) {
        fail("min", { min: field.validation.min });
      }
      if (field.validation?.max !== undefined && value > field.validation.max) {
        fail("max", { max: field.validation.max });
      }
      return;
    }

    case "boolean":
    case "attestation": {
      if (typeof value !== "boolean") {
        fail("boolean");
        return;
      }
      if (field.type === "attestation" && field.required && value !== true) {
        fail("attestation");
      }
      return;
    }

    case "select": {
      if (typeof value !== "string") {
        fail("option");
        return;
      }
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (!allowed.has(value)) fail("option");
      return;
    }

    case "multiselect": {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        fail("options");
        return;
      }
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (value.some((item) => !allowed.has(item))) {
        fail("options");
      }
      return;
    }

    case "address": {
      if (!isAddress(value)) {
        fail("address");
        return;
      }

      if (
        field.required &&
        ["line1", "city", "region", "postalCode", "country"].some(
          (part) => !value[part]?.trim(),
        )
      ) {
        fail("address_incomplete");
      }
      return;
    }

    case "file": {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        fail("attachments");
        return;
      }
      if (field.maxFiles !== undefined && value.length > field.maxFiles) {
        fail("max_files", { maxFiles: field.maxFiles });
      }
      return;
    }
  }
}

function validateStringRules(
  field: FormField,
  value: string,
  fail: (code: ValidationCode, params?: Record<string, number>) => void,
) {
  const rules = field.validation;
  if (!rules) return;

  if (rules.minLength !== undefined && value.length < rules.minLength) {
    fail("min_length", { minLength: rules.minLength });
  }
  if (rules.maxLength !== undefined && value.length > rules.maxLength) {
    fail("max_length", { maxLength: rules.maxLength });
  }
  if (rules.pattern && !new RegExp(rules.pattern).test(value)) {
    fail("pattern");
  }
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isAddress(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(["line1", "line2", "city", "region", "postalCode", "country"]);
  return Object.entries(value).every(([part, content]) =>
    allowed.has(part) && typeof content === "string",
  );
}
