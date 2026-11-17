import { describe, expect, it } from "vitest";
import { parseFormDefinition } from "./definition";
import {
  defaultFormUiStrings,
  resolveFormUiStrings,
  validationMessageKeys,
} from "./form-ui-strings";
import { validateSubmissionAnswers, validationMessage } from "./validation";

const definition = parseFormDefinition({
  schemaVersion: 1,
  sections: [
    {
      id: "s",
      title: "S",
      fields: [
        { id: "name", type: "short_text", label: "Name", required: true, validation: { minLength: 3 } },
        { id: "age", type: "number", label: "Age", validation: { min: 18, max: 120 } },
        { id: "contact", type: "email", label: "Email" },
      ],
    },
  ],
});

describe("validation messages", () => {
  it("returns language-neutral codes with English messages for API consumers", () => {
    const result = validateSubmissionAnswers(definition, {
      name: "Al",
      age: 7,
      contact: "nope",
    });
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      { fieldId: "name", code: "min_length", params: { minLength: 3 }, message: "Enter at least 3 characters." },
      { fieldId: "age", code: "min", params: { min: 18 }, message: "Value must be at least 18." },
      { fieldId: "contact", code: "email", message: "Enter a valid email address." },
    ]);
    const missing = validateSubmissionAnswers(definition, {});
    expect(missing.errors[0]).toEqual({
      fieldId: "name",
      code: "required",
      message: defaultFormUiStrings.validationRequired,
    });
  });

  it("renders every code from per-locale UI strings with parameters", () => {
    const spanish = resolveFormUiStrings({
      validationMinLength: "Escriba al menos {minLength} caracteres.",
      validationRequired: "Este campo es obligatorio.",
    });
    expect(
      validationMessage({ code: "min_length", params: { minLength: 3 }, message: "x" }, spanish),
    ).toBe("Escriba al menos 3 caracteres.");
    expect(validationMessage({ code: "required", message: "x" }, spanish)).toBe(
      "Este campo es obligatorio.",
    );
    // Untranslated codes fall back to English; unknown codes keep the message.
    expect(validationMessage({ code: "email", message: "x" }, spanish)).toBe(
      "Enter a valid email address.",
    );
    expect(validationMessage({ code: "constructor", message: "kept" }, spanish)).toBe("kept");
    expect(validationMessage({ message: "plain" })).toBe("plain");
    // A missing parameter leaves the placeholder rather than inventing a value.
    expect(validationMessage({ code: "max", message: "x" })).toBe("Value must be no more than {max}.");
  });

  it("maps every code to an existing UI string key", () => {
    for (const key of Object.values(validationMessageKeys)) {
      expect(defaultFormUiStrings[key]).toBeTruthy();
    }
  });
});
