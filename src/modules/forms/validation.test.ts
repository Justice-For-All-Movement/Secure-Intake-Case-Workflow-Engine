import { describe, expect, it } from "vitest";
import { parseFormDefinition } from "./definition";
import { validateSubmissionAnswers } from "./validation";
import { answersFromFormData } from "./form-data";

const definition = parseFormDefinition({
  schemaVersion: 1,
  sections: [
    {
      id: "request",
      title: "Request",
      fields: [
        {
          id: "email",
          type: "email",
          label: "Email",
          required: true,
        },
        {
          id: "urgent",
          type: "boolean",
          label: "Urgent",
        },
        {
          id: "urgent_reason",
          type: "long_text",
          label: "Urgent reason",
          required: true,
          condition: {
            fieldId: "urgent",
            operator: "equals",
            value: true,
          },
        },
        {
          id: "topics",
          type: "multiselect",
          label: "Topics",
          options: [
            { value: "privacy", label: "Privacy" },
            { value: "records", label: "Records" },
          ],
        },
      ],
    },
  ],
});

describe("submission validation", () => {
  it("rejects undeclared nested address data", () => {
    const addressDefinition = parseFormDefinition({
      schemaVersion: 1,
      sections: [{ id: "main", title: "Main", fields: [
        { id: "address", type: "address", label: "Address" },
      ] }],
    });
    const nested = validateSubmissionAnswers(addressDefinition, {
      address: { line1: "1 Main St", hidden_note: "unapproved nested data" },
    });
    expect(nested.success).toBe(false);
    expect(validateSubmissionAnswers(addressDefinition, { address: { line1: "1 Main St" } }).success).toBe(true);
  });

  it("does not read inherited constructor as a submitted answer", () => {
    const special = parseFormDefinition({
      schemaVersion: 1,
      sections: [{ id: "main", title: "Main", fields: [
        { id: "constructor", type: "short_text", label: "Constructor" },
        { id: "detail", type: "short_text", label: "Detail", required: true,
          condition: { fieldId: "constructor", operator: "exists" } },
      ] }],
    });
    const parsed = answersFromFormData(special, new FormData());
    expect(Object.prototype.hasOwnProperty.call(parsed, "constructor")).toBe(false);
    expect(validateSubmissionAnswers(special, parsed).success).toBe(true);
    expect(validateSubmissionAnswers(special, { constructor: "present" }).success).toBe(false);
  });

  it("does not require a hidden conditional field", () => {
    const result = validateSubmissionAnswers(definition, {
      email: "person@example.test",
      urgent: false,
    });

    expect(result.success).toBe(true);
  });

  it("requires a conditional field when its condition is met", () => {
    const result = validateSubmissionAnswers(definition, {
      email: "person@example.test",
      urgent: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContainEqual({
        fieldId: "urgent_reason",
        message: "This field is required.",
      });
    }
  });

  it("rejects invalid option values", () => {
    const result = validateSubmissionAnswers(definition, {
      email: "person@example.test",
      topics: ["not-a-real-option"],
    });

    expect(result.success).toBe(false);
  });

  it("strips unknown and conditionally hidden answers before persistence", () => {
    const result = validateSubmissionAnswers(definition, {
      email: "person@example.test",
      urgent: false,
      urgent_reason: "A malicious client tried to force hidden data.",
      unexpected_admin_flag: true,
    });

    expect(result.answers).toEqual({
      email: "person@example.test",
      urgent: false,
    });
  });

  it("drops stale values through a hidden conditional chain", () => {
    const chained = parseFormDefinition({
      schemaVersion: 1,
      sections: [
        {
          id: "chain",
          title: "Chain",
          fields: [
            { id: "a", type: "boolean", label: "A" },
            {
              id: "b",
              type: "boolean",
              label: "B",
              condition: { fieldId: "a", operator: "equals", value: true },
            },
            {
              id: "c",
              type: "short_text",
              label: "C",
              condition: { fieldId: "b", operator: "equals", value: true },
            },
          ],
        },
      ],
    });

    const result = validateSubmissionAnswers(chained, {
      a: false,
      b: true,
      c: "stale hidden value",
    });

    expect(result.answers).toEqual({ a: false });
  });

  it("allows incomplete drafts while still validating supplied values", () => {
    const result = validateSubmissionAnswers(
      definition,
      { urgent: false },
      { partial: true },
    );

    expect(result.success).toBe(true);

    const invalidEmail = validateSubmissionAnswers(
      definition,
      { email: "not-an-email" },
      { partial: true },
    );
    expect(invalidEmail.success).toBe(false);
  });
});
