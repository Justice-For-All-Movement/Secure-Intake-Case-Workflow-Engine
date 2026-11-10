import { and, desc, eq, ne } from "drizzle-orm";
import type { Database } from "@/db/client";
import {
  intakeForms,
  intakeSubmissions,
} from "@/db/schema";
import type { TenantScope } from "@/lib/tenancy";

export async function listApiSubmissions(
  db: Database,
  scope: TenantScope,
  input: {
    status?: string | null;
    formId?: string | null;
    limit: number;
    offset: number;
  },
) {
  const conditions = [
    eq(intakeSubmissions.organizationId, scope.organizationId),
    // An unsubmitted draft belongs to the participant alone.
    ne(intakeSubmissions.status, "draft"),
  ];
  if (input.status?.trim()) {
    conditions.push(eq(intakeSubmissions.status, input.status.trim()));
  }
  if (input.formId?.trim()) {
    conditions.push(eq(intakeSubmissions.formId, input.formId.trim()));
  }

  return db
    .select({
      id: intakeSubmissions.id,
      formId: intakeSubmissions.formId,
      formVersionId: intakeSubmissions.formVersionId,
      formName: intakeForms.name,
      status: intakeSubmissions.status,
      answers: intakeSubmissions.answers,
      confirmationCode: intakeSubmissions.confirmationCode,
      submittedAt: intakeSubmissions.submittedAt,
      createdAt: intakeSubmissions.createdAt,
      updatedAt: intakeSubmissions.updatedAt,
    })
    .from(intakeSubmissions)
    .innerJoin(
      intakeForms,
      and(
        eq(intakeForms.id, intakeSubmissions.formId),
        eq(
          intakeForms.organizationId,
          intakeSubmissions.organizationId,
        ),
      ),
    )
    .where(and(...conditions))
    .orderBy(
      desc(intakeSubmissions.submittedAt),
      desc(intakeSubmissions.createdAt),
    )
    .limit(input.limit)
    .offset(input.offset);
}
