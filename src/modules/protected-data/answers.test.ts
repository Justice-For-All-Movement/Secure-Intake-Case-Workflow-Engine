import { describe, expect, it } from "vitest";
import type { FormDefinition } from "@/modules/forms/definition";
import { splitProtectedAnswers } from "./answers";

const definition: FormDefinition = {
  schemaVersion: 1,
  submitLabel: "Submit",
  sections: [
    {
      id: "section",
      title: "Section",
      fields: [
        {
          id: "ordinary",
          type: "short_text",
          label: "Ordinary",
          required: true,
        },
        {
          id: "protected_name",
          type: "short_text",
          label: "Protected",
          required: true,
          protection: {
            compartment: "identity",
            revealPolicy: "dual_control",
          },
        },
        {
          id: "protected_email",
          type: "email",
          label: "Protected email",
          required: false,
          protection: {
            compartment: "identity",
            revealPolicy: "dual_control",
          },
        },
      ],
    },
  ],
};

describe("splitProtectedAnswers", () => {
  it("removes protected values from the ordinary answer map", () => {
    const result = splitProtectedAnswers(definition, {
      ordinary: "visible",
      protected_name: "Secret Person",
      protected_email: "secret@example.invalid",
      unexpected_private_value: "must not leak",
    });

    expect(result.ordinaryAnswers).toEqual({ ordinary: "visible" });
    expect(result.compartments.get("identity")).toEqual({
      protected_name: "Secret Person",
      protected_email: "secret@example.invalid",
    });
  });
});
