import { and, eq, max } from "drizzle-orm";
import type {
  Database,
  DatabaseTransaction,
} from "@/db/client";
import {
  applicationManagedResources,
  applicationManifestRevisions,
  applicationProfiles,
  auditEvents,
  caseQueues,
  caseReferralPolicies,
  caseRoutingRules,
  caseTeams,
  caseWorkflowVersions,
  caseWorkflows,
  communicationTemplates,
  deadlineCalendars,
  documentTypes,
  intakeForms,
  intakeFormVersions,
  intakeFormWorkflowBindings,
  reviewPolicies,
  reviewPolicyPrerequisites,
  rolePermissions,
  roles,
} from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import { auditEventValues } from "@/modules/audit/event";
import { validateCommunicationTemplate } from "@/modules/communications/template";
import { checksumJson } from "./canonical";
import {
  assertNoRoutingOnSealedFields,
  assertRoutingAvoidsSealedFields,
  assertSealingAvailableForDefinition,
} from "@/modules/sealed/policy";
import {
  parseApplicationManifest,
  type ApplicationManifest,
} from "./manifest";

type Counts = Record<string, number>;

export interface ApplyApplicationManifestResult {
  revisionId: string;
  manifestHash: string;
  noChange: boolean;
  counts: Counts;
}

export async function applyApplicationManifest(
  db: Database,
  scope: TenantScope,
  input: unknown,
  actorUserId: string,
): Promise<ApplyApplicationManifestResult> {
  const manifest = parseApplicationManifest(input);
  validateManifestTemplates(manifest);
  validateTimeZones(manifest);
  // A form with sealed fields is published only where sealing recipients exist.
  for (const form of manifest.forms) {
    assertSealingAvailableForDefinition(form.definition);
  }

  const manifestHash = checksumJson(manifest);

  const [current] = await db
    .select({
      profile: applicationProfiles,
      revision: applicationManifestRevisions,
    })
    .from(applicationProfiles)
    .innerJoin(
      applicationManifestRevisions,
      eq(
        applicationManifestRevisions.id,
        applicationProfiles.manifestRevisionId,
      ),
    )
    .where(
      eq(applicationProfiles.organizationId, scope.organizationId),
    )
    .limit(1);

  if (current?.revision.manifestHash === manifestHash) {
    return {
      revisionId: current.revision.id,
      manifestHash,
      noChange: true,
      counts: {},
    };
  }

  return db.transaction(async (tx) => {
    const now = new Date();

    await tx
      .update(applicationManifestRevisions)
      .set({ status: "superseded" })
      .where(
        and(
          eq(
            applicationManifestRevisions.organizationId,
            scope.organizationId,
          ),
          eq(applicationManifestRevisions.status, "active"),
        ),
      );

    const [revision] = await tx
      .insert(applicationManifestRevisions)
      .values({
        organizationId: scope.organizationId,
        manifestKey: manifest.application.key,
        manifestHash,
        manifest,
        status: "active",
        appliedByUserId: actorUserId,
        appliedAt: now,
      })
      .returning();

    await tx
      .insert(applicationProfiles)
      .values({
        organizationId: scope.organizationId,
        manifestRevisionId: revision.id,
        applicationKey: manifest.application.key,
        applicationName: manifest.application.name,
        shortName: manifest.application.shortName ?? null,
        description: manifest.application.description ?? null,
        branding: manifest.application.branding,
        terminology: manifest.application.terminology,
        operationalViews: manifest.operationalViews,
        operationalMetrics: manifest.operationalMetrics,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: applicationProfiles.organizationId,
        set: {
          manifestRevisionId: revision.id,
          applicationKey: manifest.application.key,
          applicationName: manifest.application.name,
          shortName: manifest.application.shortName ?? null,
          description: manifest.application.description ?? null,
          branding: manifest.application.branding,
          terminology: manifest.application.terminology,
          operationalViews: manifest.operationalViews,
          operationalMetrics: manifest.operationalMetrics,
          updatedAt: now,
        },
      });

    const counts: Counts = {};
    const managed = async (
      resourceType: string,
      resourceKey: string,
    ) => {
      const [row] = await tx
        .select()
        .from(applicationManagedResources)
        .where(
          and(
            eq(
              applicationManagedResources.organizationId,
              scope.organizationId,
            ),
            eq(
              applicationManagedResources.resourceType,
              resourceType,
            ),
            eq(
              applicationManagedResources.resourceKey,
              resourceKey,
            ),
          ),
        )
        .limit(1);
      return row ?? null;
    };

    const assertOwned = async (
      resourceType: string,
      resourceKey: string,
      existingId: string | null,
    ) => {
      if (!existingId) return;
      const row = await managed(resourceType, resourceKey);
      if (!row || row.resourceId !== existingId) {
        throw new Error(
          `Manifest cannot take ownership of existing ${resourceType} '${resourceKey}'.`,
        );
      }
    };

    const record = async (
      resourceType: string,
      resourceKey: string,
      resourceId: string,
      configuration: unknown,
    ) => {
      await tx
        .insert(applicationManagedResources)
        .values({
          organizationId: scope.organizationId,
          manifestRevisionId: revision.id,
          resourceType,
          resourceKey,
          resourceId,
          checksum: checksumJson(configuration),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            applicationManagedResources.organizationId,
            applicationManagedResources.resourceType,
            applicationManagedResources.resourceKey,
          ],
          set: {
            manifestRevisionId: revision.id,
            resourceId,
            checksum: checksumJson(configuration),
            updatedAt: now,
          },
        });
      counts[resourceType] = (counts[resourceType] ?? 0) + 1;
    };

    for (const configured of manifest.roles) {
      const [existing] = await tx
        .select()
        .from(roles)
        .where(
          and(
            eq(roles.organizationId, scope.organizationId),
            eq(roles.key, configured.key),
          ),
        )
        .limit(1);

      await assertOwned("role", configured.key, existing?.id ?? null);
      if (existing?.isSystem) {
        throw new Error(
          `Manifest cannot modify system role '${configured.key}'.`,
        );
      }

      const [role] = existing
        ? await tx
            .update(roles)
            .set({
              name: configured.name,
              description: configured.description ?? null,
              updatedAt: now,
            })
            .where(eq(roles.id, existing.id))
            .returning()
        : await tx
            .insert(roles)
            .values({
              organizationId: scope.organizationId,
              key: configured.key,
              name: configured.name,
              description: configured.description ?? null,
              isSystem: false,
            })
            .returning();

      await tx
        .delete(rolePermissions)
        .where(eq(rolePermissions.roleId, role.id));
      if (configured.permissions.length) {
        await tx.insert(rolePermissions).values(
          configured.permissions.map((permission) => ({
            organizationId: scope.organizationId,
            roleId: role.id,
            permission,
          })),
        );
      }
      await record("role", configured.key, role.id, configured);
    }

    for (const configured of manifest.documentTypes) {
      const [existing] = await tx
        .select()
        .from(documentTypes)
        .where(
          and(
            eq(documentTypes.organizationId, scope.organizationId),
            eq(documentTypes.key, configured.key),
          ),
        )
        .limit(1);

      await assertOwned(
        "document_type",
        configured.key,
        existing?.id ?? null,
      );

      const [resource] = existing
        ? await tx
            .update(documentTypes)
            .set({
              name: configured.name,
              description: configured.description ?? null,
              acceptedMimeTypes: configured.acceptedMimeTypes,
              maxBytes: configured.maxBytes ?? null,
              status: "active",
              updatedAt: now,
            })
            .where(eq(documentTypes.id, existing.id))
            .returning()
        : await tx
            .insert(documentTypes)
            .values({
              organizationId: scope.organizationId,
              key: configured.key,
              name: configured.name,
              description: configured.description ?? null,
              acceptedMimeTypes: configured.acceptedMimeTypes,
              maxBytes: configured.maxBytes ?? null,
              status: "active",
              createdByUserId: actorUserId,
            })
            .returning();

      await record(
        "document_type",
        configured.key,
        resource.id,
        configured,
      );
    }

    for (const configured of manifest.referralPolicies) {
      const [existing] = await tx
        .select()
        .from(caseReferralPolicies)
        .where(
          and(
            eq(
              caseReferralPolicies.organizationId,
              scope.organizationId,
            ),
            eq(caseReferralPolicies.key, configured.key),
          ),
        )
        .limit(1);

      await assertOwned(
        "referral_policy",
        configured.key,
        existing?.id ?? null,
      );

      const [resource] = existing
        ? await tx
            .update(caseReferralPolicies)
            .set({
              name: configured.name,
              description: configured.description ?? null,
              definition: configured.definition,
              status: "active",
              updatedAt: now,
            })
            .where(eq(caseReferralPolicies.id, existing.id))
            .returning()
        : await tx
            .insert(caseReferralPolicies)
            .values({
              organizationId: scope.organizationId,
              key: configured.key,
              name: configured.name,
              description: configured.description ?? null,
              definition: configured.definition,
              status: "active",
              createdByUserId: actorUserId,
            })
            .returning();

      await record(
        "referral_policy",
        configured.key,
        resource.id,
        configured,
      );
    }

    const calendarIds = new Map<string, string>();
    for (const configured of manifest.deadlineCalendars) {
      const [existing] = await tx
        .select()
        .from(deadlineCalendars)
        .where(
          and(
            eq(
              deadlineCalendars.organizationId,
              scope.organizationId,
            ),
            eq(deadlineCalendars.key, configured.key),
          ),
        )
        .limit(1);

      await assertOwned(
        "deadline_calendar",
        configured.key,
        existing?.id ?? null,
      );

      const [resource] = existing
        ? await tx
            .update(deadlineCalendars)
            .set({
              name: configured.name,
              timeZone: configured.timeZone,
              weekendDays: configured.weekendDays,
              status: "active",
              updatedAt: now,
            })
            .where(eq(deadlineCalendars.id, existing.id))
            .returning()
        : await tx
            .insert(deadlineCalendars)
            .values({
              organizationId: scope.organizationId,
              key: configured.key,
              name: configured.name,
              timeZone: configured.timeZone,
              weekendDays: configured.weekendDays,
              status: "active",
              createdByUserId: actorUserId,
            })
            .returning();

      calendarIds.set(configured.key, resource.id);
      await record(
        "deadline_calendar",
        configured.key,
        resource.id,
        configured,
      );
    }

    const teamIds = new Map<string, string>();
    for (const configured of manifest.teams) {
      const [existing] = await tx
        .select()
        .from(caseTeams)
        .where(
          and(
            eq(caseTeams.organizationId, scope.organizationId),
            eq(caseTeams.slug, configured.slug),
          ),
        )
        .limit(1);

      await assertOwned("routing_team", configured.slug, existing?.id ?? null);

      const [resource] = existing
        ? await tx
            .update(caseTeams)
            .set({
              name: configured.name,
              description: configured.description ?? null,
              status: "active",
              updatedAt: now,
            })
            .where(eq(caseTeams.id, existing.id))
            .returning()
        : await tx
            .insert(caseTeams)
            .values({
              organizationId: scope.organizationId,
              slug: configured.slug,
              name: configured.name,
              description: configured.description ?? null,
              status: "active",
              createdByUserId: actorUserId,
            })
            .returning();

      teamIds.set(configured.slug, resource.id);
      await record(
        "routing_team",
        configured.slug,
        resource.id,
        configured,
      );
    }

    const queueIds = new Map<string, string>();
    for (const configured of manifest.queues) {
      const teamId = configured.teamSlug
        ? teamIds.get(configured.teamSlug)
        : null;
      if (configured.teamSlug && !teamId) {
        throw new Error(
          `Queue team '${configured.teamSlug}' was not reconciled.`,
        );
      }

      const [existing] = await tx
        .select()
        .from(caseQueues)
        .where(
          and(
            eq(caseQueues.organizationId, scope.organizationId),
            eq(caseQueues.slug, configured.slug),
          ),
        )
        .limit(1);

      await assertOwned(
        "routing_queue",
        configured.slug,
        existing?.id ?? null,
      );

      const [resource] = existing
        ? await tx
            .update(caseQueues)
            .set({
              teamId,
              name: configured.name,
              description: configured.description ?? null,
              assignmentStrategy: configured.assignmentStrategy,
              status: "active",
              updatedAt: now,
            })
            .where(eq(caseQueues.id, existing.id))
            .returning()
        : await tx
            .insert(caseQueues)
            .values({
              organizationId: scope.organizationId,
              teamId,
              slug: configured.slug,
              name: configured.name,
              description: configured.description ?? null,
              assignmentStrategy: configured.assignmentStrategy,
              status: "active",
              createdByUserId: actorUserId,
            })
            .returning();

      queueIds.set(configured.slug, resource.id);
      await record(
        "routing_queue",
        configured.slug,
        resource.id,
        configured,
      );
    }

    for (const configured of manifest.communicationTemplates) {
      const [existing] = await tx
        .select()
        .from(communicationTemplates)
        .where(
          and(
            eq(
              communicationTemplates.organizationId,
              scope.organizationId,
            ),
            eq(communicationTemplates.key, configured.key),
          ),
        )
        .limit(1);

      await assertOwned(
        "communication_template",
        configured.key,
        existing?.id ?? null,
      );

      const [resource] = existing
        ? await tx
            .update(communicationTemplates)
            .set({
              name: configured.name,
              channel: configured.channel,
              subjectTemplate: configured.subjectTemplate ?? null,
              bodyTemplate: configured.bodyTemplate,
              defaultVisibility: configured.defaultVisibility,
              status: "active",
              updatedAt: now,
            })
            .where(eq(communicationTemplates.id, existing.id))
            .returning()
        : await tx
            .insert(communicationTemplates)
            .values({
              organizationId: scope.organizationId,
              key: configured.key,
              name: configured.name,
              channel: configured.channel,
              subjectTemplate: configured.subjectTemplate ?? null,
              bodyTemplate: configured.bodyTemplate,
              defaultVisibility: configured.defaultVisibility,
              status: "active",
              createdByUserId: actorUserId,
            })
            .returning();

      await record(
        "communication_template",
        configured.key,
        resource.id,
        configured,
      );
    }

    const workflowIds = new Map<string, string>();
    for (const configured of manifest.workflows) {
      const [existing] = await tx
        .select()
        .from(caseWorkflows)
        .where(
          and(
            eq(caseWorkflows.organizationId, scope.organizationId),
            eq(caseWorkflows.slug, configured.slug),
          ),
        )
        .limit(1);

      await assertOwned("workflow", configured.slug, existing?.id ?? null);

      const [workflow] = existing
        ? await tx
            .update(caseWorkflows)
            .set({
              name: configured.name,
              description: configured.description ?? null,
              status: "active",
              updatedAt: now,
            })
            .where(eq(caseWorkflows.id, existing.id))
            .returning()
        : await tx
            .insert(caseWorkflows)
            .values({
              organizationId: scope.organizationId,
              slug: configured.slug,
              name: configured.name,
              description: configured.description ?? null,
              status: "active",
              createdByUserId: actorUserId,
            })
            .returning();

      workflowIds.set(configured.slug, workflow.id);

      const [published] = await tx
        .select()
        .from(caseWorkflowVersions)
        .where(
          and(
            eq(
              caseWorkflowVersions.organizationId,
              scope.organizationId,
            ),
            eq(caseWorkflowVersions.workflowId, workflow.id),
            eq(caseWorkflowVersions.status, "published"),
          ),
        )
        .limit(1);

      if (
        !published ||
        checksumJson(published.definition) !==
          checksumJson(configured.definition)
      ) {
        const [current] = await tx
          .select({ value: max(caseWorkflowVersions.versionNumber) })
          .from(caseWorkflowVersions)
          .where(eq(caseWorkflowVersions.workflowId, workflow.id));
        await tx
          .update(caseWorkflowVersions)
          .set({ status: "superseded", updatedAt: now })
          .where(
            and(
              eq(caseWorkflowVersions.workflowId, workflow.id),
              eq(caseWorkflowVersions.status, "published"),
            ),
          );
        await tx.insert(caseWorkflowVersions).values({
          organizationId: scope.organizationId,
          workflowId: workflow.id,
          versionNumber: (current?.value ?? 0) + 1,
          definition: configured.definition,
          status: "published",
          createdByUserId: actorUserId,
          publishedAt: now,
        });
      }

      await record(
        "workflow",
        configured.slug,
        workflow.id,
        configured,
      );
    }

    const formIds = new Map<string, string>();
    for (const configured of manifest.forms) {
      const [existing] = await tx
        .select()
        .from(intakeForms)
        .where(
          and(
            eq(intakeForms.organizationId, scope.organizationId),
            eq(intakeForms.slug, configured.slug),
          ),
        )
        .limit(1);

      await assertOwned("form", configured.slug, existing?.id ?? null);

      const [form] = existing
        ? await tx
            .update(intakeForms)
            .set({
              name: configured.name,
              description: configured.description ?? null,
              accessMode: configured.accessMode,
              status: "active",
              updatedAt: now,
            })
            .where(eq(intakeForms.id, existing.id))
            .returning()
        : await tx
            .insert(intakeForms)
            .values({
              organizationId: scope.organizationId,
              slug: configured.slug,
              name: configured.name,
              description: configured.description ?? null,
              accessMode: configured.accessMode,
              status: "active",
              createdByUserId: actorUserId,
            })
            .returning();

      formIds.set(configured.slug, form.id);

      const [published] = await tx
        .select()
        .from(intakeFormVersions)
        .where(
          and(
            eq(
              intakeFormVersions.organizationId,
              scope.organizationId,
            ),
            eq(intakeFormVersions.formId, form.id),
            eq(intakeFormVersions.status, "published"),
          ),
        )
        .limit(1);

      if (
        !published ||
        checksumJson(published.definition) !==
          checksumJson(configured.definition)
      ) {
        const [current] = await tx
          .select({ value: max(intakeFormVersions.versionNumber) })
          .from(intakeFormVersions)
          .where(eq(intakeFormVersions.formId, form.id));
        await tx
          .update(intakeFormVersions)
          .set({ status: "superseded", updatedAt: now })
          .where(
            and(
              eq(intakeFormVersions.formId, form.id),
              eq(intakeFormVersions.status, "published"),
            ),
          );
        await tx.insert(intakeFormVersions).values({
          organizationId: scope.organizationId,
          formId: form.id,
          versionNumber: (current?.value ?? 0) + 1,
          definition: configured.definition,
          status: "published",
          createdByUserId: actorUserId,
          publishedAt: now,
        });
      }

      await record("form", configured.slug, form.id, configured);
    }

    for (const configured of manifest.forms) {
      if (!configured.workflowSlug) continue;
      const formId = formIds.get(configured.slug);
      const workflowId = workflowIds.get(configured.workflowSlug);
      if (!formId || !workflowId) {
        throw new Error("Form/workflow binding could not be resolved.");
      }
      await tx
        .insert(intakeFormWorkflowBindings)
        .values({
          organizationId: scope.organizationId,
          formId,
          workflowId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: intakeFormWorkflowBindings.formId,
          set: {
            organizationId: scope.organizationId,
            workflowId,
            updatedAt: now,
          },
        });
      await record(
        "form_workflow_binding",
        configured.slug,
        formId,
        {
          formSlug: configured.slug,
          workflowSlug: configured.workflowSlug,
        },
      );
    }

    for (const configured of manifest.routingRules) {
      await assertRoutingAvoidsSealedFields(tx, scope, configured.definition);
      const targetQueueId = queueIds.get(configured.targetQueueSlug);
      if (!targetQueueId) {
        throw new Error(
          `Routing target queue '${configured.targetQueueSlug}' was not reconciled.`,
        );
      }

      const ownership = await managed("routing_rule", configured.key);
      const [existing] = ownership
        ? await tx
            .select()
            .from(caseRoutingRules)
            .where(
              and(
                eq(caseRoutingRules.id, ownership.resourceId),
                eq(
                  caseRoutingRules.organizationId,
                  scope.organizationId,
                ),
              ),
            )
            .limit(1)
        : [];

      const [resource] = existing
        ? await tx
            .update(caseRoutingRules)
            .set({
              name: configured.name,
              priority: configured.priority,
              definition: configured.definition,
              targetQueueId,
              status: "active",
              updatedAt: now,
            })
            .where(eq(caseRoutingRules.id, existing.id))
            .returning()
        : await tx
            .insert(caseRoutingRules)
            .values({
              organizationId: scope.organizationId,
              name: configured.name,
              priority: configured.priority,
              definition: configured.definition,
              targetQueueId,
              status: "active",
              createdByUserId: actorUserId,
            })
            .returning();

      await record(
        "routing_rule",
        configured.key,
        resource.id,
        configured,
      );
    }

    for (const configured of manifest.forms) {
      await assertNoRoutingOnSealedFields(tx, scope, configured.definition);
    }

    const policyIds = new Map<string, string>();
    for (const configured of manifest.reviewPolicies) {
      const calendarId = configured.calendarKey
        ? calendarIds.get(configured.calendarKey)
        : null;
      if (configured.calendarKey && !calendarId) {
        throw new Error(
          `Review calendar '${configured.calendarKey}' was not reconciled.`,
        );
      }

      const [existing] = await tx
        .select()
        .from(reviewPolicies)
        .where(
          and(
            eq(reviewPolicies.organizationId, scope.organizationId),
            eq(reviewPolicies.key, configured.key),
          ),
        )
        .limit(1);

      await assertOwned(
        "review_policy",
        configured.key,
        existing?.id ?? null,
      );

      const values = {
        name: configured.name,
        description: configured.description ?? null,
        level: configured.level,
        eligibleCaseStatuses: configured.eligibleCaseStatuses,
        filingWindowValue: configured.filingWindow?.value ?? null,
        filingWindowUnit: configured.filingWindow?.unit ?? null,
        decisionDeadlineValue:
          configured.decisionDeadline?.value ?? null,
        decisionDeadlineUnit:
          configured.decisionDeadline?.unit ?? null,
        decisionWarningBeforeValue:
          configured.decisionWarningBefore?.value ?? null,
        decisionWarningBeforeUnit:
          configured.decisionWarningBefore?.unit ?? null,
        calendarId,
        allowedOutcomes: configured.allowedOutcomes,
        requireIndependentReviewer:
          configured.requireIndependentReviewer,
        status: "active",
        updatedAt: now,
      };

      const [resource] = existing
        ? await tx
            .update(reviewPolicies)
            .set(values)
            .where(eq(reviewPolicies.id, existing.id))
            .returning()
        : await tx
            .insert(reviewPolicies)
            .values({
              organizationId: scope.organizationId,
              key: configured.key,
              ...values,
              createdByUserId: actorUserId,
            })
            .returning();

      policyIds.set(configured.key, resource.id);
      await record(
        "review_policy",
        configured.key,
        resource.id,
        configured,
      );
    }

    for (const configured of manifest.reviewPolicies) {
      const policyId = policyIds.get(configured.key);
      if (!policyId) continue;
      await tx
        .delete(reviewPolicyPrerequisites)
        .where(eq(reviewPolicyPrerequisites.policyId, policyId));

      const prerequisites = configured.prerequisitePolicyKeys.map(
        (key) => {
          const prerequisitePolicyId = policyIds.get(key);
          if (!prerequisitePolicyId) {
            throw new Error(
              `Review prerequisite '${key}' was not reconciled.`,
            );
          }
          return {
            organizationId: scope.organizationId,
            policyId,
            prerequisitePolicyId,
          };
        },
      );

      if (prerequisites.length) {
        await tx
          .insert(reviewPolicyPrerequisites)
          .values(prerequisites);
      }
    }

    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: scope.organizationId,
        actorType: "user",
        actorUserId,
        action: "application.manifest_applied",
        resourceType: "application_manifest_revision",
        resourceId: revision.id,
        newState: {
          applicationKey: manifest.application.key,
          manifestHash,
        },
        metadata: {
          counts,
          schemaVersion: manifest.schemaVersion,
        },
      }),
    );

    return {
      revisionId: revision.id,
      manifestHash,
      noChange: false,
      counts,
    };
  });
}

function validateManifestTemplates(
  manifest: ApplicationManifest,
) {
  for (const template of manifest.communicationTemplates) {
    validateCommunicationTemplate(template.bodyTemplate);
    if (template.subjectTemplate) {
      validateCommunicationTemplate(template.subjectTemplate);
    }
  }
}

function validateTimeZones(manifest: ApplicationManifest) {
  for (const calendar of manifest.deadlineCalendars) {
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: calendar.timeZone,
      }).format(new Date());
    } catch {
      throw new Error(
        `Invalid deadline calendar time zone: ${calendar.timeZone}`,
      );
    }
  }
}
