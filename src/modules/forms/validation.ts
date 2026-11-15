import { z } from "zod";
import type { FormDefinition, FormField } from "./definition";
import { fieldsInDefinition } from "./definition";
import {
  type AnswerMap,
  visibleFieldIdsForDefinition,
} from "./visibility";

export interface ValidationError {
  fieldId: string;
  message: string;
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

    const value = Object.prototype.hasOwnProperty.call(answers, field.id)
      ? answers[field.id]
      : undefined;
    const empty = isEmpty(value);

    if (!options.partial && field.required && empty) {
      errors.push({ fieldId: field.id, message: "This field is required." });
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
  const fields = fieldsInDefinition(definition);
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
  const fail = (message: string) =>
    errors.push({ fieldId: field.id, message });

  switch (field.type) {
    case "short_text":
    case "long_text":
    case "phone":
    case "date": {
      if (typeof value !== "string") {
        fail("Enter a text value.");
        return;
      }

      if (field.type === "date" && !isIsoDate(value)) {
        fail("Enter a valid date.");
        return;
      }

      validateStringRules(field, value, fail);
      return;
    }

    case "email": {
      if (typeof value !== "string" || !emailSchema.safeParse(value).success) {
        fail("Enter a valid email address.");
        return;
      }
      validateStringRules(field, value, fail);
      return;
    }

    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail("Enter a valid number.");
        return;
      }
      if (field.validation?.min !== undefined && value < field.validation.min) {
        fail(`Value must be at least ${field.validation.min}.`);
      }
      if (field.validation?.max !== undefined && value > field.validation.max) {
        fail(`Value must be no more than ${field.validation.max}.`);
      }
      return;
    }

    case "boolean":
    case "attestation": {
      if (typeof value !== "boolean") {
        fail("Choose yes or no.");
        return;
      }
      if (field.type === "attestation" && field.required && value !== true) {
        fail("You must affirm this statement to continue.");
      }
      return;
    }

    case "select": {
      if (typeof value !== "string") {
        fail("Choose a valid option.");
        return;
      }
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (!allowed.has(value)) fail("Choose a valid option.");
      return;
    }

    case "multiselect": {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        fail("Choose valid options.");
        return;
      }
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (value.some((item) => !allowed.has(item))) {
        fail("Choose valid options.");
      }
      return;
    }

    case "address": {
      if (!isAddress(value)) {
        fail("Enter a valid address.");
        return;
      }

      if (
        field.required &&
        ["line1", "city", "region", "postalCode", "country"].some(
          (part) => !value[part]?.trim(),
        )
      ) {
        fail("Complete all required address fields.");
      }
      return;
    }

    case "file": {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        fail("Attachment references are invalid.");
        return;
      }
      if (field.maxFiles !== undefined && value.length > field.maxFiles) {
        fail(`Attach no more than ${field.maxFiles} files.`);
      }
      return;
    }
  }
}

function validateStringRules(
  field: FormField,
  value: string,
  fail: (message: string) => void,
) {
  const rules = field.validation;
  if (!rules) return;

  if (rules.minLength !== undefined && value.length < rules.minLength) {
    fail(`Enter at least ${rules.minLength} characters.`);
  }
  if (rules.maxLength !== undefined && value.length > rules.maxLength) {
    fail(`Enter no more than ${rules.maxLength} characters.`);
  }
  if (rules.pattern && !new RegExp(rules.pattern).test(value)) {
    fail("The value does not match the required format.");
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
