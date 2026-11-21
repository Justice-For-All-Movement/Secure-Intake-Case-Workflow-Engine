import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  auditEvents,
  caseAssignmentHistory,
  caseQueues,
  caseRoutingRules,
  caseTeamMemberships,
  caseTeams,
  cases,
  caseTags,
  intakeSubmissions,
  offices,
  organizationMemberships,
  queueAssignmentCursors,
  users,
} from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import { auditEventValues } from "@/modules/audit/event";
import { createNotificationForMembershipInTransaction } from "@/modules/notifications/service";
import {
  parseRoutingRuleDefinition,
  type RoutingRuleDefinition,
} from "./definition";
import { routingRuleMatches } from "./evaluator";
import { assertRoutingAvoidsSealedFields } from "@/modules/sealed/policy";
import { roundRobinIndex } from "./round-robin";

export class RoutingTargetUnavailableError extends Error {
  constructor(message = "The routing target is unavailable.") {
    super(message);
    this.name = "RoutingTargetUnavailableError";
  }
}

export class CaseAssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseAssignmentError";
  }
}

export async function createTeam(
  db: Database,
  scope: TenantScope,
  input: {
    name: string;
    slug: string;
    officeId?: string | null;
    description?: string | null;
    actorUserId?: string | null;
  },
) {
  if (input.officeId) {
    const [office] = await db
      .select({ id: offices.id })
      .from(offices)
      .where(
        and(
          eq(offices.id, input.officeId),
          eq(offices.organizationId, scope.organizationId),
          eq(offices.status, "active"),
        ),
      )
      .limit(1);

    if (!office) {
      throw new RoutingTargetUnavailableError(
        "Team office was not found in the active organization.",
      );
    }
  }

  const [team] = await db
    .insert(caseTeams)
    .values({
      organizationId: scope.organizationId,
      name: input.name.trim(),
      slug: input.slug,
      officeId: input.officeId ?? null,
      description: input.description?.trim() || null,
      createdByUserId: input.actorUserId ?? null,
    })
    .returning();


  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: input.actorUserId ? "user" : "system",
      actorUserId: input.actorUserId ?? null,
      action: "routing.team_created",
      resourceType: "routing_team",
      resourceId: team.id,
      newState: {
        officeId: team.officeId,
        status: team.status,
      },
      metadata: { slug: team.slug },
    }),
  );

  return team;
}

export async function addTeamMember(
  db: Database,
  scope: TenantScope,
  input: {
    teamId: string;
    membershipId: string;
    actorUserId: string;
  },
) {
  const [[team], [membership]] = await Promise.all([
    db
      .select()
      .from(caseTeams)
      .where(
        and(
          eq(caseTeams.id, input.teamId),
          eq(caseTeams.organizationId, scope.organizationId),
          eq(caseTeams.status, "active"),
        ),
      )
      .limit(1),
    db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .innerJoin(
        users,
        and(
          eq(users.id, organizationMemberships.userId),
          eq(users.status, "active"),
        ),
      )
      .where(
        and(
          eq(organizationMemberships.id, input.membershipId),
          eq(
            organizationMemberships.organizationId,
            scope.organizationId,
          ),
          eq(organizationMemberships.status, "active"),
        ),
      )
      .limit(1),
  ]);

  if (!team || !membership) {
    throw new RoutingTargetUnavailableError(
      "Team and membership must both be active in the organization.",
    );
  }

  const [row] = await db
    .insert(caseTeamMemberships)
    .values({
      organizationId: scope.organizationId,
      teamId: team.id,
      organizationMembershipId: membership.id,
      isAvailable: true,
    })
    .onConflictDoUpdate({
      target: [
        caseTeamMemberships.teamId,
        caseTeamMemberships.organizationMembershipId,
      ],
      set: {
        isAvailable: true,
        updatedAt: new Date(),
      },
    })
    .returning();


  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: "user",
      actorUserId: input.actorUserId,
      action: "routing.team_member_added",
      resourceType: "routing_team_membership",
      resourceId: row.id,
      parentResourceType: "routing_team",
      parentResourceId: team.id,
      newState: {
        organizationMembershipId: membership.id,
        isAvailable: row.isAvailable,
      },
    }),
  );

  return row;
}

export async function createQueue(
  db: Database,
  scope: TenantScope,
  input: {
    name: string;
    slug: string;
    teamId?: string | null;
    description?: string | null;
    assignmentStrategy: "manual" | "round_robin";
    actorUserId?: string | null;
  },
) {
  if (input.assignmentStrategy === "round_robin" && !input.teamId) {
    throw new CaseAssignmentError(
      "Round-robin queues require a team.",
    );
  }

  if (input.teamId) {
    const [team] = await db
      .select()
      .from(caseTeams)
      .where(
        and(
          eq(caseTeams.id, input.teamId),
          eq(caseTeams.organizationId, scope.organizationId),
          eq(caseTeams.status, "active"),
        ),
      )
      .limit(1);

    if (!team) {
      throw new RoutingTargetUnavailableError(
        "Queue team was not found in the active organization.",
      );
    }
  }

  const [queue] = await db
    .insert(caseQueues)
    .values({
      organizationId: scope.organizationId,
      name: input.name.trim(),
      slug: input.slug,
      teamId: input.teamId ?? null,
      description: input.description?.trim() || null,
      assignmentStrategy: input.assignmentStrategy,
      createdByUserId: input.actorUserId ?? null,
    })
    .returning();


  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: input.actorUserId ? "user" : "system",
      actorUserId: input.actorUserId ?? null,
      action: "routing.queue_created",
      resourceType: "routing_queue",
      resourceId: queue.id,
      newState: {
        teamId: queue.teamId,
        assignmentStrategy: queue.assignmentStrategy,
        status: queue.status,
      },
      metadata: { slug: queue.slug },
    }),
  );

  return queue;
}

export async function createRoutingRule(
  db: Database,
  scope: TenantScope,
  input: {
    name: string;
    priority: number;
    definition: RoutingRuleDefinition;
    targetQueueId: string;
    actorUserId?: string | null;
  },
) {
  const definition = parseRoutingRuleDefinition(input.definition);
  await assertRoutingAvoidsSealedFields(db, scope, definition);
  const [queue] = await db
    .select()
    .from(caseQueues)
    .where(
      and(
        eq(caseQueues.id, input.targetQueueId),
        eq(caseQueues.organizationId, scope.organizationId),
        eq(caseQueues.status, "active"),
      ),
    )
    .limit(1);

  if (!queue) {
    throw new RoutingTargetUnavailableError();
  }

  const [rule] = await db
    .insert(caseRoutingRules)
    .values({
      organizationId: scope.organizationId,
      name: input.name.trim(),
      priority: input.priority,
      definition,
      targetQueueId: queue.id,
      createdByUserId: input.actorUserId ?? null,
    })
    .returning();


  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: input.actorUserId ? "user" : "system",
      actorUserId: input.actorUserId ?? null,
      action: "routing.rule_created",
      resourceType: "routing_rule",
      resourceId: rule.id,
      parentResourceType: "routing_queue",
      parentResourceId: rule.targetQueueId,
      newState: {
        priority: rule.priority,
        status: rule.status,
      },
      metadata: { name: rule.name },
    }),
  );

  return rule;
}

export async function setTeamMemberAvailability(
  db: Database,
  scope: TenantScope,
  input: {
    teamMembershipId: string;
    isAvailable: boolean;
    actorUserId: string;
  },
) {
  const [updated] = await db
    .update(caseTeamMemberships)
    .set({
      isAvailable: input.isAvailable,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(caseTeamMemberships.id, input.teamMembershipId),
        eq(
          caseTeamMemberships.organizationId,
          scope.organizationId,
        ),
      ),
    )
    .returning();


  if (!updated) {
    throw new RoutingTargetUnavailableError();
  }

  await db.insert(auditEvents).values(
    auditEventValues({
      organizationId: scope.organizationId,
      actorType: "user",
      actorUserId: input.actorUserId,
      action: "routing.team_member_availability_changed",
      resourceType: "routing_team_membership",
      resourceId: updated.id,
      newState: { isAvailable: updated.isAvailable },
      metadata: {
        teamId: updated.teamId,
        organizationMembershipId:
          updated.organizationMembershipId,
      },
    }),
  );

  return updated;
}

export async function manualAssignCase(
  db: Database,
  scope: TenantScope,
  input: {
    caseId: string;
    queueId?: string | null;
    membershipId?: string | null;
    actorUserId: string;
    reason?: string | null;
  },
) {
  return db.transaction(async (tx) => {
    const [record] = await tx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.id, input.caseId),
          eq(cases.organizationId, scope.organizationId),
        ),
      )
      .limit(1);

    if (!record) {
      throw new CaseAssignmentError(
        "Case was not found in the active organization.",
      );
    }

    let queue: typeof caseQueues.$inferSelect | null = null;
    if (input.queueId) {
      [queue] = await tx
        .select()
        .from(caseQueues)
        .where(
          and(
            eq(caseQueues.id, input.queueId),
            eq(caseQueues.organizationId, scope.organizationId),
            eq(caseQueues.status, "active"),
          ),
        )
        .limit(1);

      if (!queue) throw new RoutingTargetUnavailableError();
    }

    if (input.membershipId) {
      const [membership] = await tx
        .select({ id: organizationMemberships.id })
        .from(organizationMemberships)
        .innerJoin(
          users,
          and(
            eq(users.id, organizationMemberships.userId),
            eq(users.status, "active"),
          ),
        )
        .where(
          and(
            eq(organizationMemberships.id, input.membershipId),
            eq(
              organizationMemberships.organizationId,
              scope.organizationId,
            ),
            eq(organizationMemberships.status, "active"),
          ),
        )
        .limit(1);

      if (!membership) {
        throw new RoutingTargetUnavailableError(
          "Assignee is not an active organization member.",
        );
      }

      if (queue?.teamId) {
        const [teamMember] = await tx
          .select()
          .from(caseTeamMemberships)
          .where(
            and(
              eq(caseTeamMemberships.teamId, queue.teamId),
              eq(
                caseTeamMemberships.organizationMembershipId,
                membership.id,
              ),
              eq(
                caseTeamMemberships.organizationId,
                scope.organizationId,
              ),
              eq(caseTeamMemberships.isAvailable, true),
            ),
          )
          .limit(1);

        if (!teamMember) {
          throw new RoutingTargetUnavailableError(
            "Assignee is not an available member of the queue team.",
          );
        }
      }
    }

    const now = new Date();
    const [updated] = await tx
      .update(cases)
      .set({
        assignedQueueId: queue?.id ?? null,
        assignedMembershipId: input.membershipId ?? null,
        assignedAt:
          queue || input.membershipId ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(cases.id, record.id),
          eq(cases.organizationId, scope.organizationId),
        ),
      )
      .returning();

    await tx.insert(caseAssignmentHistory).values({
      organizationId: scope.organizationId,
      caseId: record.id,
      fromQueueId: record.assignedQueueId,
      toQueueId: queue?.id ?? null,
      fromMembershipId: record.assignedMembershipId,
      toMembershipId: input.membershipId ?? null,
      source: "manual",
      actorUserId: input.actorUserId,
      reason: input.reason?.trim() || null,
      metadata: {},
    });

    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: scope.organizationId,
        actorType: "user",
        actorUserId: input.actorUserId,
        action: "case.assigned",
        resourceType: "case",
        resourceId: record.id,
        previousState: {
          assignedQueueId: record.assignedQueueId,
          assignedMembershipId: record.assignedMembershipId,
        },
        newState: {
          assignedQueueId: updated.assignedQueueId,
          assignedMembershipId: updated.assignedMembershipId,
        },
        metadata: {
          source: "manual",
          reasonProvided: Boolean(input.reason?.trim()),
        },
      }),
    );

    if (
      updated.assignedMembershipId &&
      updated.assignedMembershipId !== record.assignedMembershipId
    ) {
      await createNotificationForMembershipInTransaction(
        tx,
        scope,
        updated.assignedMembershipId,
        {
          eventType: "case.assigned",
          severity: "info",
          title: "Case assigned",
          body: `Case ${updated.caseNumber} has been assigned to you.`,
          link: `/admin/cases/${updated.id}`,
          resourceType: "case",
          resourceId: updated.id,
        },
      );
    }

    return updated;
  });
}

export async function applyRoutingRules(
  db: Database,
  scope: TenantScope,
  input: {
    caseId: string;
    actorUserId: string;
  },
) {
  return db.transaction(async (tx) => {
    const [record] = await tx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.id, input.caseId),
          eq(cases.organizationId, scope.organizationId),
        ),
      )
      .limit(1);

    if (!record) {
      throw new CaseAssignmentError(
        "Case was not found in the active organization.",
      );
    }

    const [tagRows, ruleRows, source] = await Promise.all([
      tx
        .select({ tag: caseTags.tag })
        .from(caseTags)
        .where(
          and(
            eq(caseTags.caseId, record.id),
            eq(caseTags.organizationId, scope.organizationId),
          ),
        ),
      tx
        .select()
        .from(caseRoutingRules)
        .where(
          and(
            eq(
              caseRoutingRules.organizationId,
              scope.organizationId,
            ),
            eq(caseRoutingRules.status, "active"),
          ),
        )
        .orderBy(
          asc(caseRoutingRules.priority),
          asc(caseRoutingRules.createdAt),
        ),
      record.sourceSubmissionId
        ? tx
            .select({ answers: intakeSubmissions.answers })
            .from(intakeSubmissions)
            .where(
              and(
                eq(
                  intakeSubmissions.id,
                  record.sourceSubmissionId,
                ),
                eq(
                  intakeSubmissions.organizationId,
                  scope.organizationId,
                ),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
    ]);

    const context = {
      caseType: record.caseType,
      priority: record.priority,
      status: record.status,
      tags: tagRows.map((row) => row.tag),
      submissionAnswers: source[0]?.answers ?? null,
    };

    const match = ruleRows.find((rule) =>
      routingRuleMatches(
        parseRoutingRuleDefinition(rule.definition),
        context,
      ),
    );

    if (!match) {
      return {
        matched: false as const,
        case: record,
        rule: null,
      };
    }

    const [queue] = await tx
      .select()
      .from(caseQueues)
      .where(
        and(
          eq(caseQueues.id, match.targetQueueId),
          eq(caseQueues.organizationId, scope.organizationId),
          eq(caseQueues.status, "active"),
        ),
      )
      .limit(1);

    if (!queue) {
      throw new RoutingTargetUnavailableError();
    }

    let membershipId: string | null = null;

    if (queue.assignmentStrategy === "round_robin") {
      if (!queue.teamId) {
        throw new RoutingTargetUnavailableError(
          "Round-robin queue has no team.",
        );
      }

      const candidates = await tx
        .select({
          membershipId:
            caseTeamMemberships.organizationMembershipId,
        })
        .from(caseTeamMemberships)
        .innerJoin(
          organizationMemberships,
          and(
            eq(
              organizationMemberships.id,
              caseTeamMemberships.organizationMembershipId,
            ),
            eq(
              organizationMemberships.organizationId,
              scope.organizationId,
            ),
            eq(organizationMemberships.status, "active"),
          ),
        )
        .innerJoin(
          users,
          and(
            eq(users.id, organizationMemberships.userId),
            eq(users.status, "active"),
          ),
        )
        .where(
          and(
            eq(caseTeamMemberships.teamId, queue.teamId),
            eq(
              caseTeamMemberships.organizationId,
              scope.organizationId,
            ),
            eq(caseTeamMemberships.isAvailable, true),
          ),
        )
        .orderBy(
          asc(caseTeamMemberships.organizationMembershipId),
        );

      if (candidates.length === 0) {
        throw new RoutingTargetUnavailableError(
          "Round-robin queue has no available team members.",
        );
      }

      const [cursor] = await tx
        .insert(queueAssignmentCursors)
        .values({
          queueId: queue.id,
          organizationId: scope.organizationId,
          cursorValue: 1,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: queueAssignmentCursors.queueId,
          set: {
            cursorValue: sql`${queueAssignmentCursors.cursorValue} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning({
          value: queueAssignmentCursors.cursorValue,
        });

      if (!cursor) {
        throw new CaseAssignmentError(
          "Unable to allocate round-robin assignment.",
        );
      }

      membershipId =
        candidates[
          roundRobinIndex(cursor.value, candidates.length)
        ].membershipId;
    } else if (queue.assignmentStrategy !== "manual") {
      throw new RoutingTargetUnavailableError(
        `Unsupported queue assignment strategy: ${queue.assignmentStrategy}`,
      );
    }

    const now = new Date();
    const [updated] = await tx
      .update(cases)
      .set({
        assignedQueueId: queue.id,
        assignedMembershipId: membershipId,
        assignedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(cases.id, record.id),
          eq(cases.organizationId, scope.organizationId),
        ),
      )
      .returning();

    await tx.insert(caseAssignmentHistory).values({
      organizationId: scope.organizationId,
      caseId: record.id,
      fromQueueId: record.assignedQueueId,
      toQueueId: queue.id,
      fromMembershipId: record.assignedMembershipId,
      toMembershipId: membershipId,
      source: "routing",
      routingRuleId: match.id,
      actorUserId: input.actorUserId,
      reason: `Matched routing rule: ${match.name}`,
      metadata: {
        assignmentStrategy: queue.assignmentStrategy,
      },
    });

    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: scope.organizationId,
        actorType: "user",
        actorUserId: input.actorUserId,
        action: "case.routed",
        resourceType: "case",
        resourceId: record.id,
        previousState: {
          assignedQueueId: record.assignedQueueId,
          assignedMembershipId: record.assignedMembershipId,
        },
        newState: {
          assignedQueueId: updated.assignedQueueId,
          assignedMembershipId: updated.assignedMembershipId,
        },
        metadata: {
          routingRuleId: match.id,
          assignmentStrategy: queue.assignmentStrategy,
        },
      }),
    );

    if (
      updated.assignedMembershipId &&
      updated.assignedMembershipId !== record.assignedMembershipId
    ) {
      await createNotificationForMembershipInTransaction(
        tx,
        scope,
        updated.assignedMembershipId,
        {
          eventType: "case.assigned",
          severity: "info",
          title: "Case assigned by routing",
          body: `Case ${updated.caseNumber} has been routed to you.`,
          link: `/admin/cases/${updated.id}`,
          resourceType: "case",
          resourceId: updated.id,
        },
      );
    }

    return {
      matched: true as const,
      case: updated,
      rule: match,
    };
  });
}

export async function escalateCase(
  db: Database,
  scope: TenantScope,
  input: {
    caseId: string;
    actorUserId?: string | null;
    reason: string;
    targetQueueId?: string | null;
    priority?: "low" | "normal" | "high" | "critical";
  },
) {
  if (!input.reason.trim()) {
    throw new CaseAssignmentError("Escalation reason is required.");
  }

  return db.transaction(async (tx) => {
    const [record] = await tx
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.id, input.caseId),
          eq(cases.organizationId, scope.organizationId),
        ),
      )
      .limit(1);

    if (!record) {
      throw new CaseAssignmentError(
        "Case was not found in the active organization.",
      );
    }

    let targetQueueId = record.assignedQueueId;
    let targetMembershipId = record.assignedMembershipId;

    if (input.targetQueueId) {
      const [queue] = await tx
        .select()
        .from(caseQueues)
        .where(
          and(
            eq(caseQueues.id, input.targetQueueId),
            eq(caseQueues.organizationId, scope.organizationId),
            eq(caseQueues.status, "active"),
          ),
        )
        .limit(1);

      if (!queue) throw new RoutingTargetUnavailableError();

      targetQueueId = queue.id;
      targetMembershipId = null;

      if (queue.assignmentStrategy === "round_robin") {
        if (!queue.teamId) {
          throw new RoutingTargetUnavailableError(
            "Round-robin queue has no team.",
          );
        }

        const candidates = await tx
          .select({
            membershipId:
              caseTeamMemberships.organizationMembershipId,
          })
          .from(caseTeamMemberships)
          .innerJoin(
            organizationMemberships,
            and(
              eq(
                organizationMemberships.id,
                caseTeamMemberships.organizationMembershipId,
              ),
              eq(
                organizationMemberships.organizationId,
                scope.organizationId,
              ),
              eq(organizationMemberships.status, "active"),
            ),
          )
          .innerJoin(
            users,
            and(
              eq(users.id, organizationMemberships.userId),
              eq(users.status, "active"),
            ),
          )
          .where(
            and(
              eq(caseTeamMemberships.teamId, queue.teamId),
              eq(
                caseTeamMemberships.organizationId,
                scope.organizationId,
              ),
              eq(caseTeamMemberships.isAvailable, true),
            ),
          )
          .orderBy(
            asc(caseTeamMemberships.organizationMembershipId),
          );

        if (candidates.length === 0) {
          throw new RoutingTargetUnavailableError(
            "Escalation queue has no available members.",
          );
        }

        const [cursor] = await tx
          .insert(queueAssignmentCursors)
          .values({
            queueId: queue.id,
            organizationId: scope.organizationId,
            cursorValue: 1,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: queueAssignmentCursors.queueId,
            set: {
              cursorValue: sql`${queueAssignmentCursors.cursorValue} + 1`,
              updatedAt: new Date(),
            },
          })
          .returning({
            value: queueAssignmentCursors.cursorValue,
          });

        if (!cursor) {
          throw new CaseAssignmentError(
            "Unable to allocate escalation assignment.",
          );
        }

        targetMembershipId =
          candidates[
            roundRobinIndex(cursor.value, candidates.length)
          ].membershipId;
      }
    }

    const now = new Date();
    const nextLevel = record.escalationLevel + 1;
    const [updated] = await tx
      .update(cases)
      .set({
        assignedQueueId: targetQueueId,
        assignedMembershipId: targetMembershipId,
        assignedAt:
          targetQueueId !== record.assignedQueueId ||
          targetMembershipId !== record.assignedMembershipId
            ? now
            : record.assignedAt,
        priority: input.priority ?? record.priority,
        escalationLevel: nextLevel,
        escalatedAt: now,
        escalationReason: input.reason.trim(),
        updatedAt: now,
      })
      .where(
        and(
          eq(cases.id, record.id),
          eq(cases.organizationId, scope.organizationId),
        ),
      )
      .returning();

    await tx.insert(caseAssignmentHistory).values({
      organizationId: scope.organizationId,
      caseId: record.id,
      fromQueueId: record.assignedQueueId,
      toQueueId: targetQueueId,
      fromMembershipId: record.assignedMembershipId,
      toMembershipId: targetMembershipId,
      source: "escalation",
      actorUserId: input.actorUserId,
      reason: input.reason.trim(),
      metadata: {
        escalationLevel: nextLevel,
        priority: input.priority ?? record.priority,
      },
    });

    await tx.insert(auditEvents).values(
      auditEventValues({
        organizationId: scope.organizationId,
        actorType: input.actorUserId ? "user" : "system",
        actorUserId: input.actorUserId ?? null,
        action: "case.escalated",
        resourceType: "case",
        resourceId: record.id,
        previousState: {
          assignedQueueId: record.assignedQueueId,
          assignedMembershipId: record.assignedMembershipId,
          priority: record.priority,
          escalationLevel: record.escalationLevel,
        },
        newState: {
          assignedQueueId: updated.assignedQueueId,
          assignedMembershipId: updated.assignedMembershipId,
          priority: updated.priority,
          escalationLevel: updated.escalationLevel,
        },
        metadata: { reasonProvided: true },
      }),
    );

    if (updated.assignedMembershipId) {
      await createNotificationForMembershipInTransaction(
        tx,
        scope,
        updated.assignedMembershipId,
        {
          eventType: "case.escalated",
          severity:
            updated.priority === "critical" ? "critical" : "warning",
          title: "Case escalated",
          body: `Case ${updated.caseNumber} has been escalated to level ${updated.escalationLevel}.`,
          link: `/admin/cases/${updated.id}`,
          resourceType: "case",
          resourceId: updated.id,
        },
      );
    }

    return updated;
  });
}
