import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_-]*$/, "Use lowercase identifiers with letters, numbers, underscores, or hyphens.");

export const fieldTypeSchema = z.enum([
  "short_text",
  "long_text",
  "email",
  "phone",
  "date",
  "number",
  "boolean",
  "select",
  "multiselect",
  "address",
  "attestation",
  "file",
]);

export type FieldType = z.infer<typeof fieldTypeSchema>;

export const optionSchema = z.object({
  value: z.string().min(1).max(200),
  label: z.string().min(1).max(300),
});

export const conditionSchema = z.object({
  fieldId: identifier,
  operator: z.enum(["equals", "not_equals", "includes", "exists"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export type FieldCondition = z.infer<typeof conditionSchema>;

export const fieldValidationSchema = z.object({
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().max(500).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const fieldProtectionSchema = z.object({
  compartment: identifier,
  revealPolicy: z.literal("dual_control").default("dual_control"),
});

const publicUploadSchema = z.object({
  documentTypeKey: identifier,
  visibility: z
    .enum(["participant", "internal", "restricted"])
    .default("internal"),
});

export const formFieldSchema = z
  .object({
    id: identifier,
    type: fieldTypeSchema,
    label: z.string().min(1).max(500),
    helpText: z.string().max(2000).optional(),
    placeholder: z.string().max(500).optional(),
    required: z.boolean().default(false),
    options: z.array(optionSchema).max(200).optional(),
    validation: fieldValidationSchema.optional(),
    condition: conditionSchema.optional(),
    attestationText: z.string().max(5000).optional(),
    acceptedMimeTypes: z.array(z.string().min(1).max(200)).max(100).optional(),
    maxFiles: z.number().int().positive().max(50).optional(),
    publicUpload: publicUploadSchema.optional(),
    protection: fieldProtectionSchema.optional(),
  })
  .superRefine((field, ctx) => {
    if (
      (field.type === "select" || field.type === "multiselect") &&
      (!field.options || field.options.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Select fields require at least one option.",
        path: ["options"],
      });
    }

    if (field.type === "attestation" && !field.attestationText) {
      ctx.addIssue({
        code: "custom",
        message: "Attestation fields require attestationText.",
        path: ["attestationText"],
      });
    }

    if (field.type === "file" && field.protection) {
      ctx.addIssue({
        code: "custom",
        message:
          "File fields cannot use protected compartments until protected document storage is configured.",
        path: ["protection"],
      });
    }

    if (field.publicUpload && field.type !== "file") {
      ctx.addIssue({
        code: "custom",
        message: "publicUpload may be configured only on file fields.",
        path: ["publicUpload"],
      });
    }

    if (
      field.validation?.minLength !== undefined &&
      field.validation?.maxLength !== undefined &&
      field.validation.minLength > field.validation.maxLength
    ) {
      ctx.addIssue({
        code: "custom",
        message: "minLength cannot exceed maxLength.",
        path: ["validation"],
      });
    }

    if (
      field.validation?.min !== undefined &&
      field.validation?.max !== undefined &&
      field.validation.min > field.validation.max
    ) {
      ctx.addIssue({
        code: "custom",
        message: "min cannot exceed max.",
        path: ["validation"],
      });
    }

    if (field.validation?.pattern) {
      try {
        new RegExp(field.validation.pattern);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Validation pattern must be a valid regular expression.",
          path: ["validation", "pattern"],
        });
      }
    }
  });

export type FormField = z.infer<typeof formFieldSchema>;

export const formSectionSchema = z.object({
  id: identifier,
  title: z.string().min(1).max(500),
  description: z.string().max(4000).optional(),
  fields: z.array(formFieldSchema).min(1).max(200),
});

export type FormSection = z.infer<typeof formSectionSchema>;

const participantPortalSchema = z.object({
  enabled: z.boolean().default(false),
  allowMessaging: z.boolean().default(true),
  messagingCondition: conditionSchema.optional(),
});

const localeTag = z
  .string()
  .min(2)
  .max(35)
  .regex(
    /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/,
    "Use a BCP 47 language tag such as en, es or uk.",
  );

const fieldTranslationSchema = z.object({
  label: z.string().min(1).max(500).optional(),
  helpText: z.string().max(2000).optional(),
  placeholder: z.string().max(500).optional(),
  attestationText: z.string().max(5000).optional(),
  options: z.record(z.string(), z.string().min(1).max(300)).optional(),
});

/**
 * Per-locale text for one form, supplied as data. Anything omitted falls back
 * to the default-locale text in the definition itself. `ui` overrides the
 * renderer's built-in interface strings (see form-ui-strings.ts for keys).
 */
export const formTranslationSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  description: z.string().max(4000).optional(),
  direction: z.enum(["ltr", "rtl"]).optional(),
  intro: z.string().max(10000).optional(),
  submitLabel: z.string().min(1).max(100).optional(),
  confirmationMessage: z.string().max(5000).optional(),
  sections: z
    .record(
      z.string(),
      z.object({
        title: z.string().min(1).max(500).optional(),
        description: z.string().max(4000).optional(),
      }),
    )
    .optional(),
  fields: z.record(z.string(), fieldTranslationSchema).optional(),
  ui: z.record(z.string(), z.string().max(1000)).optional(),
});

export type FormTranslation = z.infer<typeof formTranslationSchema>;

export const formDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultLocale: localeTag.optional(),
    translations: z.record(localeTag, formTranslationSchema).optional(),
    resumableDrafts: z.boolean().optional(),
    intro: z.string().max(10000).optional(),
    submitLabel: z.string().min(1).max(100).default("Submit"),
    confirmationMessage: z.string().max(5000).optional(),
    participantPortal: participantPortalSchema.optional(),
    sections: z.array(formSectionSchema).min(1).max(100),
  })
  .superRefine((definition, ctx) => {
    const sectionIds = new Set<string>();
    const fieldIds = new Set<string>();
    const fieldOrder = new Map<string, number>();
    let nextFieldIndex = 0;

    definition.sections.forEach((section, sectionIndex) => {
      if (sectionIds.has(section.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate section id: ${section.id}`,
          path: ["sections", sectionIndex, "id"],
        });
      }
      sectionIds.add(section.id);

      section.fields.forEach((field, fieldIndex) => {
        if (fieldIds.has(field.id)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate field id: ${field.id}`,
            path: ["sections", sectionIndex, "fields", fieldIndex, "id"],
          });
        }
        fieldIds.add(field.id);
        fieldOrder.set(field.id, nextFieldIndex++);
      });
    });

    for (const [locale, translation] of Object.entries(
      definition.translations ?? {},
    )) {
      for (const sectionId of Object.keys(translation.sections ?? {})) {
        if (!sectionIds.has(sectionId)) {
          ctx.addIssue({
            code: "custom",
            message: `Translation ${locale} references unknown section: ${sectionId}`,
            path: ["translations", locale, "sections", sectionId],
          });
        }
      }
      for (const fieldId of Object.keys(translation.fields ?? {})) {
        if (!fieldIds.has(fieldId)) {
          ctx.addIssue({
            code: "custom",
            message: `Translation ${locale} references unknown field: ${fieldId}`,
            path: ["translations", locale, "fields", fieldId],
          });
        }
      }
    }

    const protectionByField = new Map(
      fieldsInDefinition(definition).map((field) => [
        field.id,
        field.protection?.compartment ?? null,
      ] as const),
    );

    if (definition.participantPortal?.messagingCondition) {
      const condition = definition.participantPortal.messagingCondition;
      if (!fieldIds.has(condition.fieldId)) {
        ctx.addIssue({
          code: "custom",
          message:
            "Participant messaging condition references an unknown field.",
          path: ["participantPortal", "messagingCondition"],
        });
      } else if (protectionByField.get(condition.fieldId)) {
        ctx.addIssue({
          code: "custom",
          message:
            "Participant messaging condition must reference an ordinary, non-protected field.",
          path: ["participantPortal", "messagingCondition"],
        });
      }

      if (!definition.participantPortal.allowMessaging) {
        ctx.addIssue({
          code: "custom",
          message:
            "Participant messaging condition cannot be used when allowMessaging is false.",
          path: ["participantPortal", "messagingCondition"],
        });
      }
    }

    definition.sections.forEach((section, sectionIndex) => {
      section.fields.forEach((field, fieldIndex) => {
        if (!field.condition) return;

        if (!fieldIds.has(field.condition.fieldId)) {
          ctx.addIssue({
            code: "custom",
            message: `Condition references unknown field: ${field.condition.fieldId}`,
            path: ["sections", sectionIndex, "fields", fieldIndex, "condition"],
          });
        }

        const controllerIndex = fieldOrder.get(field.condition.fieldId);
        const dependentIndex = fieldOrder.get(field.id);
        const controllerCompartment = protectionByField.get(
          field.condition.fieldId,
        );
        const dependentCompartment = protectionByField.get(field.id);

        if (
          controllerCompartment &&
          controllerCompartment !== dependentCompartment
        ) {
          ctx.addIssue({
            code: "custom",
            message:
              "A protected field may control visibility only within the same protected compartment.",
            path: ["sections", sectionIndex, "fields", fieldIndex, "condition"],
          });
        }

        if (
          controllerIndex !== undefined &&
          dependentIndex !== undefined &&
          controllerIndex >= dependentIndex
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Conditions may reference only fields that appear earlier in the form.",
            path: ["sections", sectionIndex, "fields", fieldIndex, "condition"],
          });
        }
      });
    });
  });

export type FormDefinition = z.infer<typeof formDefinitionSchema>;

export function parseFormDefinition(input: unknown): FormDefinition {
  return formDefinitionSchema.parse(input);
}

export function fieldsInDefinition(
  definition: FormDefinition,
): FormField[] {
  return definition.sections.flatMap((section) => section.fields);
}
