import { and, eq, inArray, ne } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "@/db/client";
import { caseRoutingRules, intakeFormVersions } from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";
import {
  parseFormDefinition,
  sealedFieldsInDefinition,
  type FormDefinition,
} from "@/modules/forms/definition";
import type { RoutingRuleDefinition } from "@/modules/routing/definition";
import {
  requireSealingRecipients,
  sealingConfig,
  type SealingConfig,
} from "./recipients";

type DbExecutor = Database | DatabaseTransaction;

export class SealedRoutingError extends Error {
  constructor(fieldIds: readonly string[]) {
    super(
      `Routing cannot use sealed fields (${fieldIds.join(", ")}): the server cannot read them.`,
    );
    this.name = "SealedRoutingError";
  }
}

/** A form with sealed fields can be published only when sealing recipients are configured. */
export function assertSealingAvailableForDefinition(
  definition: FormDefinition,
  config: SealingConfig = sealingConfig(),
) {
  if (sealedFieldsInDefinition(definition).length === 0) return;
  requireSealingRecipients(config);
}

/** Submission field ids a routing rule reads. */
export function routingSubmissionFieldIds(definition: RoutingRuleDefinition) {
  return definition.conditions.flatMap((condition) =>
    condition.field === "submission" ? [condition.fieldId] : [],
  );
}

/** Ids of sealed fields in any non-superseded form version of the organization. */
export async function sealedFieldIdsInOrganization(
  db: DbExecutor,
  scope: TenantScope,
): Promise<Set<string>> {
  const rows = await db
    .select({ definition: intakeFormVersions.definition })
    .from(intakeFormVersions)
    .where(
      and(
        eq(intakeFormVersions.organizationId, scope.organizationId),
        ne(intakeFormVersions.status, "superseded"),
      ),
    );
  const ids = new Set<string>();
  for (const row of rows) {
    let definition: FormDefinition;
    try {
      definition = parseFormDefinition(row.definition);
    } catch {
      continue;
    }
    for (const field of sealedFieldsInDefinition(definition)) ids.add(field.id);
  }
  return ids;
}

/** Refuses a routing rule that reads a sealed field of any of the organization's forms. */
export async function assertRoutingAvoidsSealedFields(
  db: DbExecutor,
  scope: TenantScope,
  definition: RoutingRuleDefinition,
) {
  const used = routingSubmissionFieldIds(definition);
  if (used.length === 0) return;
  const sealed = await sealedFieldIdsInOrganization(db, scope);
  const conflicts = used.filter((id) => sealed.has(id));
  if (conflicts.length > 0) throw new SealedRoutingError(conflicts);
}

/** Refuses publishing a form whose sealed fields an active routing rule reads. */
export async function assertNoRoutingOnSealedFields(
  db: DbExecutor,
  scope: TenantScope,
  definition: FormDefinition,
) {
  const sealed = new Set(sealedFieldsInDefinition(definition).map((field) => field.id));
  if (sealed.size === 0) return;
  const rules = await db
    .select({ definition: caseRoutingRules.definition })
    .from(caseRoutingRules)
    .where(
      and(
        eq(caseRoutingRules.organizationId, scope.organizationId),
        inArray(caseRoutingRules.status, ["active"]),
      ),
    );
  const conflicts = new Set<string>();
  for (const rule of rules) {
    const conditions = (rule.definition as RoutingRuleDefinition | null)?.conditions ?? [];
    for (const condition of conditions) {
      if (condition.field === "submission" && sealed.has(condition.fieldId)) {
        conflicts.add(condition.fieldId);
      }
    }
  }
  if (conflicts.size > 0) throw new SealedRoutingError([...conflicts]);
}
