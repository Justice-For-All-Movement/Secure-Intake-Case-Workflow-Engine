import { z } from "zod";
import {
  corePermissions,
  defaultRoleTemplates,
} from "@/modules/auth/permissions";
import { formDefinitionSchema } from "@/modules/forms/definition";
import { routingRuleDefinitionSchema } from "@/modules/routing/definition";
import { referralPolicyDefinitionSchema } from "@/modules/referrals/definition";
import {
  applicationOperationalViewSchema,
  operationalMetricDefinitionSchema,
} from "@/modules/operations/definition";
import { workflowDefinitionSchema } from "@/modules/workflows/definition";

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_-]*$/);

const labelPairSchema = z.object({
  singular: z.string().min(1).max(100),
  plural: z.string().min(1).max(100),
});

const brandingSchema = z.object({
  logoUrl: z
    .string()
    .max(2000)
    .refine(
      (value) =>
        value.startsWith("/") ||
        (() => {
          try {
            return new URL(value).protocol === "https:";
          } catch {
            return false;
          }
        })(),
      "logoUrl must be a root-relative path or HTTPS URL.",
    )
    .optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  homeTitle: z.string().min(1).max(300).optional(),
  homeDescription: z.string().max(2000).optional(),
});

const terminologySchema = z
  .object({
    case: labelPairSchema.default({
      singular: "Case",
      plural: "Cases",
    }),
    submission: labelPairSchema.default({
      singular: "Submission",
      plural: "Submissions",
    }),
    submitter: labelPairSchema.default({
      singular: "Submitter",
      plural: "Submitters",
    }),
    review: labelPairSchema.default({
      singular: "Review",
      plural: "Reviews",
    }),
    deadline: labelPairSchema.default({
      singular: "Deadline",
      plural: "Deadlines",
    }),
    document: labelPairSchema.default({
      singular: "Document",
      plural: "Documents",
    }),
    queue: labelPairSchema.default({
      singular: "Queue",
      plural: "Queues",
    }),
    referral: labelPairSchema.default({
      singular: "Referral",
      plural: "Referrals",
    }),
  })
  .default({
    case: { singular: "Case", plural: "Cases" },
    submission: { singular: "Submission", plural: "Submissions" },
    submitter: { singular: "Submitter", plural: "Submitters" },
    review: { singular: "Review", plural: "Reviews" },
    deadline: { singular: "Deadline", plural: "Deadlines" },
    document: { singular: "Document", plural: "Documents" },
    queue: { singular: "Queue", plural: "Queues" },
    referral: { singular: "Referral", plural: "Referrals" },
  });

const roleSchema = z.object({
  key: identifier,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  permissions: z.array(z.enum(corePermissions)).max(200),
});

const documentTypeSchema = z.object({
  key: identifier,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  acceptedMimeTypes: z.array(z.string().min(1).max(200)).max(100).default([]),
  maxBytes: z.number().int().positive().max(2_147_483_647).optional(),
});

const referralPolicySchema = z.object({
  key: identifier,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  definition: referralPolicyDefinitionSchema,
});

const deadlineCalendarSchema = z.object({
  key: identifier,
  name: z.string().min(1).max(200),
  timeZone: z.string().min(1).max(100).default("UTC"),
  weekendDays: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .default([0, 6]),
});

const teamSchema = z.object({
  slug: identifier,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const queueSchema = z.object({
  slug: identifier,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  teamSlug: identifier.optional(),
  assignmentStrategy: z.enum(["manual", "round_robin"]).default("manual"),
});

const communicationTemplateSchema = z.object({
  key: identifier,
  name: z.string().min(1).max(200),
  channel: z.enum(["email", "letter", "portal", "manual"]).default("email"),
  subjectTemplate: z.string().max(5000).optional(),
  bodyTemplate: z.string().min(1).max(100_000),
  defaultVisibility: z
    .enum(["public", "participant", "internal", "restricted"])
    .default("participant"),
});

const workflowSchema = z.object({
  slug: identifier,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  definition: workflowDefinitionSchema,
});

const formSchema = z.object({
  slug: identifier,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  accessMode: z.enum(["public", "authenticated"]).default("public"),
  definition: formDefinitionSchema,
  workflowSlug: identifier.optional(),
});

const routingRuleSchema = z.object({
  key: identifier,
  name: z.string().min(1).max(200),
  priority: z.number().int().min(0).max(10000).default(100),
  definition: routingRuleDefinitionSchema,
  targetQueueSlug: identifier,
});

const reviewPolicySchema = z.object({
  key: identifier,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  level: z.number().int().min(1).max(100).default(1),
  eligibleCaseStatuses: z.array(identifier).max(200).default([]),
  filingWindow: z
    .object({
      value: z.number().int().positive().max(36500),
      unit: z.enum(["hours", "calendar_days", "business_days"]),
    })
    .optional(),
  decisionDeadline: z
    .object({
      value: z.number().int().positive().max(36500),
      unit: z.enum(["hours", "calendar_days", "business_days"]),
    })
    .optional(),
  decisionWarningBefore: z
    .object({
      value: z.number().int().positive().max(36500),
      unit: z.enum(["hours", "calendar_days", "business_days"]),
    })
    .optional(),
  calendarKey: identifier.optional(),
  allowedOutcomes: z.array(identifier).min(1).max(50).default([
    "affirmed",
    "modified",
    "reversed",
    "remanded",
    "dismissed",
  ]),
  requireIndependentReviewer: z.boolean().default(true),
  prerequisitePolicyKeys: z.array(identifier).max(50).default([]),
});

export const applicationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    application: z.object({
      key: identifier,
      name: z.string().min(1).max(200),
      shortName: z.string().min(1).max(100).optional(),
      description: z.string().max(4000).optional(),
      branding: brandingSchema.default({}),
      terminology: terminologySchema,
    }),
    roles: z.array(roleSchema).max(100).default([]),
    documentTypes: z.array(documentTypeSchema).max(200).default([]),
    referralPolicies: z.array(referralPolicySchema).max(100).default([]),
    deadlineCalendars: z.array(deadlineCalendarSchema).max(50).default([]),
    teams: z.array(teamSchema).max(100).default([]),
    queues: z.array(queueSchema).max(100).default([]),
    communicationTemplates: z
      .array(communicationTemplateSchema)
      .max(200)
      .default([]),
    workflows: z.array(workflowSchema).max(100).default([]),
    forms: z.array(formSchema).max(100).default([]),
    routingRules: z.array(routingRuleSchema).max(500).default([]),
    reviewPolicies: z.array(reviewPolicySchema).max(100).default([]),
    operationalViews: z
      .array(applicationOperationalViewSchema)
      .max(100)
      .default([]),
    operationalMetrics: z
      .array(operationalMetricDefinitionSchema)
      .max(100)
      .default([]),
  })
  .superRefine((manifest, ctx) => {
    const systemRoleKeys = new Set(
      defaultRoleTemplates.map((role) => role.key),
    );

    function unique(
      values: readonly string[],
      path: string,
    ) {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate ${path} key: ${value}`,
            path: [path, index],
          });
        }
        seen.add(value);
      });
      return seen;
    }

    const roleKeys = unique(
      manifest.roles.map((role) => role.key),
      "roles",
    );
    for (const key of roleKeys) {
      if (systemRoleKeys.has(key)) {
        ctx.addIssue({
          code: "custom",
          message:
            `Manifest role '${key}' collides with a core system role.`,
          path: ["roles"],
        });
      }
    }

    const documentTypeKeys = unique(
      manifest.documentTypes.map((item) => item.key),
      "documentTypes",
    );
    const documentTypeByKey = new Map(
      manifest.documentTypes.map((item) => [item.key, item] as const),
    );
    const referralPolicyKeys = unique(
      manifest.referralPolicies.map((item) => item.key),
      "referralPolicies",
    );
    void referralPolicyKeys;
    const calendarKeys = unique(
      manifest.deadlineCalendars.map((item) => item.key),
      "deadlineCalendars",
    );
    const teamKeys = unique(
      manifest.teams.map((item) => item.slug),
      "teams",
    );
    const queueKeys = unique(
      manifest.queues.map((item) => item.slug),
      "queues",
    );
    manifest.queues.forEach((queue, index) => {
      if (queue.teamSlug && !teamKeys.has(queue.teamSlug)) {
        ctx.addIssue({
          code: "custom",
          message:
            `Queue references undeclared team: ${queue.teamSlug}`,
          path: ["queues", index, "teamSlug"],
        });
      }
      if (
        queue.assignmentStrategy === "round_robin" &&
        !queue.teamSlug
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Round-robin queues require teamSlug.",
          path: ["queues", index, "teamSlug"],
        });
      }
    });
    unique(
      manifest.communicationTemplates.map((item) => item.key),
      "communicationTemplates",
    );
    const workflowKeys = unique(
      manifest.workflows.map((item) => item.slug),
      "workflows",
    );
    unique(
      manifest.forms.map((item) => item.slug),
      "forms",
    );
    unique(
      manifest.routingRules.map((item) => item.key),
      "routingRules",
    );
    const reviewKeys = unique(
      manifest.reviewPolicies.map((item) => item.key),
      "reviewPolicies",
    );
    const operationalViewKeys = unique(
      manifest.operationalViews.map((item) => item.key),
      "operationalViews",
    );
    unique(
      manifest.operationalMetrics.map((item) => item.key),
      "operationalMetrics",
    );

    const deadlinePolicyKeys = new Set<string>();
    for (const workflow of manifest.workflows) {
      for (const policy of workflow.definition.deadlinePolicies) {
        deadlinePolicyKeys.add(policy.key);
      }
    }
    for (const referralPolicy of manifest.referralPolicies) {
      for (const policy of referralPolicy.definition.deadlinePolicies) {
        deadlinePolicyKeys.add(policy.key);
      }
    }

    manifest.operationalViews.forEach((view, viewIndex) => {
      view.definition.queueSlugs.forEach((queueSlug, queueIndex) => {
        if (!queueKeys.has(queueSlug)) {
          ctx.addIssue({
            code: "custom",
            message:
              `Operational view references undeclared queue: ${queueSlug}`,
            path: [
              "operationalViews",
              viewIndex,
              "definition",
              "queueSlugs",
              queueIndex,
            ],
          });
        }
      });
    });

    manifest.operationalMetrics.forEach((metric, metricIndex) => {
      if (
        metric.type === "case_count" &&
        !operationalViewKeys.has(metric.viewKey)
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            `Case-count metric references undeclared operational view: ${metric.viewKey}`,
          path: [
            "operationalMetrics",
            metricIndex,
            "viewKey",
          ],
        });
      }

      if (metric.type === "deadline_compliance") {
        metric.policyKeys.forEach((policyKey, policyIndex) => {
          if (!deadlinePolicyKeys.has(policyKey)) {
            ctx.addIssue({
              code: "custom",
              message:
                `Deadline-compliance metric references undeclared deadline policy: ${policyKey}`,
              path: [
                "operationalMetrics",
                metricIndex,
                "policyKeys",
                policyIndex,
              ],
            });
          }
        });
      }
    });

    manifest.workflows.forEach((workflow, workflowIndex) => {
      workflow.definition.deadlinePolicies.forEach(
        (policy, policyIndex) => {
          if (
            policy.calendarKey &&
            !calendarKeys.has(policy.calendarKey)
          ) {
            ctx.addIssue({
              code: "custom",
              message:
                `Workflow deadline references undeclared calendar: ${policy.calendarKey}`,
              path: [
                "workflows",
                workflowIndex,
                "definition",
                "deadlinePolicies",
                policyIndex,
                "calendarKey",
              ],
            });
          }
          if (
            policy.escalation?.queueSlug &&
            !queueKeys.has(policy.escalation.queueSlug)
          ) {
            ctx.addIssue({
              code: "custom",
              message:
                `Workflow deadline references undeclared queue: ${policy.escalation.queueSlug}`,
              path: [
                "workflows",
                workflowIndex,
                "definition",
                "deadlinePolicies",
                policyIndex,
                "escalation",
                "queueSlug",
              ],
            });
          }
        },
      );

      workflow.definition.transitions.forEach(
        (transition, transitionIndex) => {
          transition.guards.requiredDocuments.forEach(
            (requirement, requirementIndex) => {
              if (!documentTypeKeys.has(requirement.type)) {
                ctx.addIssue({
                  code: "custom",
                  message:
                    `Workflow guard references undeclared document type: ${requirement.type}`,
                  path: [
                    "workflows",
                    workflowIndex,
                    "definition",
                    "transitions",
                    transitionIndex,
                    "guards",
                    "requiredDocuments",
                    requirementIndex,
                    "type",
                  ],
                });
              }
            },
          );
        },
      );
    });

    manifest.referralPolicies.forEach((policy, policyIndex) => {
      policy.definition.deadlinePolicies.forEach(
        (deadline, deadlineIndex) => {
          if (
            deadline.calendarKey &&
            !calendarKeys.has(deadline.calendarKey)
          ) {
            ctx.addIssue({
              code: "custom",
              message:
                `Referral deadline references undeclared calendar: ${deadline.calendarKey}`,
              path: [
                "referralPolicies",
                policyIndex,
                "definition",
                "deadlinePolicies",
                deadlineIndex,
                "calendarKey",
              ],
            });
          }
          if (
            deadline.escalation?.queueSlug &&
            !queueKeys.has(deadline.escalation.queueSlug)
          ) {
            ctx.addIssue({
              code: "custom",
              message:
                `Referral deadline references undeclared queue: ${deadline.escalation.queueSlug}`,
              path: [
                "referralPolicies",
                policyIndex,
                "definition",
                "deadlinePolicies",
                deadlineIndex,
                "escalation",
                "queueSlug",
              ],
            });
          }
        },
      );
    });

    manifest.forms.forEach((form, index) => {
      form.definition.sections.forEach((section, sectionIndex) => {
        section.fields.forEach((field, fieldIndex) => {
          if (field.type !== "file" || !field.publicUpload) return;

          const documentType = documentTypeByKey.get(
            field.publicUpload.documentTypeKey,
          );
          if (!documentType) {
            ctx.addIssue({
              code: "custom",
              message:
                `Public upload references undeclared document type: ${field.publicUpload.documentTypeKey}`,
              path: [
                "forms",
                index,
                "definition",
                "sections",
                sectionIndex,
                "fields",
                fieldIndex,
                "publicUpload",
                "documentTypeKey",
              ],
            });
            return;
          }

          if (
            field.acceptedMimeTypes &&
            documentType.acceptedMimeTypes.length > 0 &&
            field.acceptedMimeTypes.some(
              (mime) =>
                !documentType.acceptedMimeTypes.includes(
                  mime.trim().toLowerCase(),
                ),
            )
          ) {
            ctx.addIssue({
              code: "custom",
              message:
                "File-field MIME policy must be a subset of its document type policy.",
              path: [
                "forms",
                index,
                "definition",
                "sections",
                sectionIndex,
                "fields",
                fieldIndex,
                "acceptedMimeTypes",
              ],
            });
          }
        });
      });

      if (form.workflowSlug && !workflowKeys.has(form.workflowSlug)) {
        ctx.addIssue({
          code: "custom",
          message:
            `Form references undeclared workflow: ${form.workflowSlug}`,
          path: ["forms", index, "workflowSlug"],
        });
      }
    });

    const sealedFieldIds = new Set(
      manifest.forms.flatMap((form) =>
        form.definition.sections.flatMap((section) =>
          section.fields.filter((field) => field.sealed).map((field) => field.id),
        ),
      ),
    );

    manifest.routingRules.forEach((rule, index) => {
      rule.definition.conditions.forEach((condition, conditionIndex) => {
        if (condition.field === "submission" && sealedFieldIds.has(condition.fieldId)) {
          ctx.addIssue({
            code: "custom",
            message: `Routing rule cannot use sealed field ${condition.fieldId}: the server cannot read it.`,
            path: ["routingRules", index, "definition", "conditions", conditionIndex],
          });
        }
      });
      if (!queueKeys.has(rule.targetQueueSlug)) {
        ctx.addIssue({
          code: "custom",
          message:
            `Routing rule references undeclared queue: ${rule.targetQueueSlug}`,
          path: ["routingRules", index, "targetQueueSlug"],
        });
      }
    });

    manifest.reviewPolicies.forEach((policy, index) => {
      const usesBusinessDays =
        policy.filingWindow?.unit === "business_days" ||
        policy.decisionDeadline?.unit === "business_days" ||
        policy.decisionWarningBefore?.unit === "business_days";
      if (usesBusinessDays && !policy.calendarKey) {
        ctx.addIssue({
          code: "custom",
          message:
            "Business-day review timing requires calendarKey.",
          path: ["reviewPolicies", index, "calendarKey"],
        });
      }
      if (
        policy.calendarKey &&
        !calendarKeys.has(policy.calendarKey)
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            `Review policy references undeclared calendar: ${policy.calendarKey}`,
          path: ["reviewPolicies", index, "calendarKey"],
        });
      }
      const policyLevels = new Map(
        manifest.reviewPolicies.map((item) => [item.key, item.level]),
      );
      for (const prerequisite of policy.prerequisitePolicyKeys) {
        if (!reviewKeys.has(prerequisite)) {
          ctx.addIssue({
            code: "custom",
            message:
              `Review policy references undeclared prerequisite: ${prerequisite}`,
            path: [
              "reviewPolicies",
              index,
              "prerequisitePolicyKeys",
            ],
          });
        } else if (
          (policyLevels.get(prerequisite) ?? policy.level) >=
          policy.level
        ) {
          ctx.addIssue({
            code: "custom",
            message:
              "Review prerequisites must have a lower hierarchy level.",
            path: [
              "reviewPolicies",
              index,
              "prerequisitePolicyKeys",
            ],
          });
        }
      }
    });
  });

export type ApplicationManifest = z.infer<
  typeof applicationManifestSchema
>;

export type ApplicationTerminology =
  ApplicationManifest["application"]["terminology"];

export function parseApplicationManifest(
  value: unknown,
): ApplicationManifest {
  return applicationManifestSchema.parse(value);
}
