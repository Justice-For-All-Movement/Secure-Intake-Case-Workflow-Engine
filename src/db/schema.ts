import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("organizations_slug_idx").on(table.slug)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("users_email_idx").on(table.email)],
);

export const userCredentials = pgTable("user_credentials", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("auth_identities_user_idx").on(table.userId),
    uniqueIndex("auth_identities_provider_subject_idx").on(
      table.provider,
      table.subject,
    ),
  ],
);

export const offices = pgTable(
  "offices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    parentOfficeId: uuid("parent_office_id"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("offices_organization_idx").on(table.organizationId),
    uniqueIndex("offices_org_slug_idx").on(table.organizationId, table.slug),
    foreignKey({
      columns: [table.parentOfficeId],
      foreignColumns: [table.id],
      name: "offices_parent_office_fk",
    }).onDelete("set null"),
  ],
);

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("organization_memberships_organization_idx").on(table.organizationId),
    index("organization_memberships_user_idx").on(table.userId),
    uniqueIndex("organization_memberships_org_user_idx").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export const officeMemberships = pgTable(
  "office_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    organizationMembershipId: uuid("organization_membership_id")
      .notNull()
      .references(() => organizationMemberships.id, { onDelete: "cascade" }),
    officeId: uuid("office_id")
      .notNull()
      .references(() => offices.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("office_memberships_organization_idx").on(table.organizationId),
    uniqueIndex("office_memberships_membership_office_idx").on(
      table.organizationMembershipId,
      table.officeId,
    ),
  ],
);

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("organization_invitations_organization_idx").on(table.organizationId),
    uniqueIndex("organization_invitations_token_hash_idx").on(table.tokenHash),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("roles_organization_idx").on(table.organizationId),
    uniqueIndex("roles_org_key_idx").on(table.organizationId, table.key),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("role_permissions_organization_idx").on(table.organizationId),
    uniqueIndex("role_permissions_role_permission_idx").on(
      table.roleId,
      table.permission,
    ),
  ],
);

export const membershipRoles = pgTable(
  "membership_roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    organizationMembershipId: uuid("organization_membership_id")
      .notNull()
      .references(() => organizationMemberships.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("membership_roles_organization_idx").on(table.organizationId),
    uniqueIndex("membership_roles_membership_role_idx").on(
      table.organizationMembershipId,
      table.roleId,
    ),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    activeOrganizationId: uuid("active_organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("auth_sessions_user_idx").on(table.userId),
    uniqueIndex("auth_sessions_token_hash_idx").on(table.tokenHash),
  ],
);


export const authLoginThrottles = pgTable(
  "auth_login_throttles",
  {
    keyHash: text("key_hash").primaryKey(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true })
      .notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("auth_login_throttles_blocked_until_idx").on(
      table.blockedUntil,
    ),
    index("auth_login_throttles_updated_at_idx").on(
      table.updatedAt,
    ),
  ],
);


export const apiClients = pgTable(
  "api_clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    permissions: jsonb("permissions")
      .$type<string[]>()
      .notNull()
      .default([]),
    status: text("status").notNull().default("active"),
    rateLimitPerMinute: integer("rate_limit_per_minute")
      .notNull()
      .default(120),
    rateWindowStartedAt: timestamp("rate_window_started_at", {
      withTimezone: true,
    }),
    rateWindowCount: integer("rate_window_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    serviceUserId: uuid("service_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    acknowledgedEventCursor: text("acknowledged_event_cursor"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("api_clients_organization_idx").on(table.organizationId),
    uniqueIndex("api_clients_key_prefix_idx").on(table.keyPrefix),
    uniqueIndex("api_clients_key_hash_idx").on(table.keyHash),
  ],
);


export const applicationManifestRevisions = pgTable(
  "application_manifest_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    manifestKey: text("manifest_key").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    manifest: jsonb("manifest")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text("status").notNull().default("active"),
    appliedByUserId: uuid("applied_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("application_manifest_revisions_organization_idx").on(
      table.organizationId,
      table.appliedAt,
    ),
    index("application_manifest_revisions_org_hash_idx").on(
      table.organizationId,
      table.manifestHash,
    ),
    uniqueIndex("application_manifest_revisions_one_active_idx")
      .on(table.organizationId)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const applicationProfiles = pgTable(
  "application_profiles",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    manifestRevisionId: uuid("manifest_revision_id")
      .notNull()
      .references(() => applicationManifestRevisions.id, {
        onDelete: "restrict",
      }),
    applicationKey: text("application_key").notNull(),
    applicationName: text("application_name").notNull(),
    shortName: text("short_name"),
    description: text("description"),
    branding: jsonb("branding")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    terminology: jsonb("terminology")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    operationalViews: jsonb("operational_views")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    operationalMetrics: jsonb("operational_metrics")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("application_profiles_org_key_idx").on(
      table.organizationId,
      table.applicationKey,
    ),
  ],
);

export const applicationManagedResources = pgTable(
  "application_managed_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    manifestRevisionId: uuid("manifest_revision_id")
      .notNull()
      .references(() => applicationManifestRevisions.id, {
        onDelete: "cascade",
      }),
    resourceType: text("resource_type").notNull(),
    resourceKey: text("resource_key").notNull(),
    resourceId: text("resource_id").notNull(),
    checksum: text("checksum").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("application_managed_resources_key_idx").on(
      table.organizationId,
      table.resourceType,
      table.resourceKey,
    ),
    index("application_managed_resources_revision_idx").on(
      table.manifestRevisionId,
    ),
  ],
);


export const intakeForms = pgTable(
  "intake_forms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    accessMode: text("access_mode").notNull().default("public"),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("intake_forms_organization_idx").on(table.organizationId),
    uniqueIndex("intake_forms_org_slug_idx").on(
      table.organizationId,
      table.slug,
    ),
  ],
);

export const intakeFormVersions = pgTable(
  "intake_form_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    formId: uuid("form_id")
      .notNull()
      .references(() => intakeForms.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    definition: jsonb("definition")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text("status").notNull().default("draft"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("intake_form_versions_organization_idx").on(table.organizationId),
    index("intake_form_versions_form_idx").on(table.formId),
    uniqueIndex("intake_form_versions_form_number_idx").on(
      table.formId,
      table.versionNumber,
    ),
    uniqueIndex("intake_form_versions_one_published_idx")
      .on(table.formId)
      .where(sql`${table.status} = 'published'`),
  ],
);

export const intakeSubmissions = pgTable(
  "intake_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    formId: uuid("form_id")
      .notNull()
      .references(() => intakeForms.id, { onDelete: "restrict" }),
    formVersionId: uuid("form_version_id")
      .notNull()
      .references(() => intakeFormVersions.id, { onDelete: "restrict" }),
    submitterUserId: uuid("submitter_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("draft"),
    answers: jsonb("answers")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    draftTokenHash: text("draft_token_hash"),
    confirmationCode: text("confirmation_code"),
    locale: text("locale"),
    originalSha256: text("original_sha256"),
    channel: text("channel").notNull().default("public_form"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("intake_submissions_organization_idx").on(table.organizationId),
    index("intake_submissions_form_idx").on(table.formId),
    uniqueIndex("intake_submissions_draft_token_hash_idx").on(
      table.draftTokenHash,
    ),
    uniqueIndex("intake_submissions_confirmation_code_idx").on(
      table.confirmationCode,
    ),
  ],
);


export const externalParticipantCredentials = pgTable(
  "external_participant_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => intakeSubmissions.id, { onDelete: "cascade" }),
    secretHash: text("secret_hash").notNull(),
    status: text("status").notNull().default("active"),
    credentialVersion: integer("credential_version").notNull().default(1),
    lastAuthenticatedAt: timestamp("last_authenticated_at", {
      withTimezone: true,
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("external_participant_credentials_submission_idx").on(
      table.submissionId,
    ),
    uniqueIndex("external_participant_credentials_secret_hash_idx").on(
      table.secretHash,
    ),
    index("external_participant_credentials_org_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const externalParticipantSessions = pgTable(
  "external_participant_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => externalParticipantCredentials.id, {
        onDelete: "cascade",
      }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("external_participant_sessions_token_hash_idx").on(
      table.tokenHash,
    ),
    index("external_participant_sessions_credential_idx").on(
      table.credentialId,
      table.expiresAt,
    ),
    index("external_participant_sessions_org_idx").on(
      table.organizationId,
      table.expiresAt,
    ),
  ],
);



export const submissionProtectedCompartments = pgTable(
  "submission_protected_compartments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => intakeSubmissions.id, { onDelete: "cascade" }),
    compartmentKey: text("compartment_key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    fieldIds: jsonb("field_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("submission_protected_compartments_org_idx").on(
      table.organizationId,
    ),
    index("submission_protected_compartments_submission_idx").on(
      table.submissionId,
    ),
    uniqueIndex("submission_protected_compartments_unique_idx").on(
      table.submissionId,
      table.compartmentKey,
    ),
  ],
);

export const protectedRevealRequests = pgTable(
  "protected_reveal_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    compartmentId: uuid("compartment_id")
      .notNull()
      .references(() => submissionProtectedCompartments.id, {
        onDelete: "cascade",
      }),
    requestedByUserId: uuid("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    decisionReason: text("decision_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("protected_reveal_requests_org_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("protected_reveal_requests_compartment_idx").on(
      table.compartmentId,
      table.createdAt,
    ),
    uniqueIndex("protected_reveal_requests_active_idx")
      .on(table.compartmentId, table.requestedByUserId)
      .where(
        sql`${table.status} in ('pending','approved')`,
      ),
  ],
);




export const caseWorkflows = pgTable(
  "case_workflows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_workflows_organization_idx").on(table.organizationId),
    uniqueIndex("case_workflows_org_slug_idx").on(
      table.organizationId,
      table.slug,
    ),
  ],
);

export const caseWorkflowVersions = pgTable(
  "case_workflow_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => caseWorkflows.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    definition: jsonb("definition")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text("status").notNull().default("draft"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_workflow_versions_organization_idx").on(table.organizationId),
    index("case_workflow_versions_workflow_idx").on(table.workflowId),
    uniqueIndex("case_workflow_versions_workflow_number_idx").on(
      table.workflowId,
      table.versionNumber,
    ),
    uniqueIndex("case_workflow_versions_one_published_idx")
      .on(table.workflowId)
      .where(sql`${table.status} = 'published'`),
  ],
);

export const intakeFormWorkflowBindings = pgTable(
  "intake_form_workflow_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    formId: uuid("form_id")
      .notNull()
      .references(() => intakeForms.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => caseWorkflows.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("intake_form_workflow_bindings_organization_idx").on(table.organizationId),
    uniqueIndex("intake_form_workflow_bindings_form_idx").on(table.formId),
  ],
);


export const caseTeams = pgTable(
  "case_teams",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    officeId: uuid("office_id").references(() => offices.id, {
      onDelete: "set null",
    }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_teams_organization_idx").on(table.organizationId),
    uniqueIndex("case_teams_org_slug_idx").on(
      table.organizationId,
      table.slug,
    ),
  ],
);

export const caseTeamMemberships = pgTable(
  "case_team_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => caseTeams.id, { onDelete: "cascade" }),
    organizationMembershipId: uuid("organization_membership_id")
      .notNull()
      .references(() => organizationMemberships.id, {
        onDelete: "cascade",
      }),
    isAvailable: boolean("is_available").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_team_memberships_organization_idx").on(table.organizationId),
    index("case_team_memberships_team_idx").on(table.teamId),
    uniqueIndex("case_team_memberships_team_member_idx").on(
      table.teamId,
      table.organizationMembershipId,
    ),
  ],
);

export const caseQueues = pgTable(
  "case_queues",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => caseTeams.id, {
      onDelete: "set null",
    }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    assignmentStrategy: text("assignment_strategy")
      .notNull()
      .default("manual"),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_queues_organization_idx").on(table.organizationId),
    uniqueIndex("case_queues_org_slug_idx").on(
      table.organizationId,
      table.slug,
    ),
  ],
);

export const queueAssignmentCursors = pgTable(
  "queue_assignment_cursors",
  {
    queueId: uuid("queue_id")
      .primaryKey()
      .references(() => caseQueues.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cursorValue: integer("cursor_value").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("queue_assignment_cursors_organization_idx").on(
      table.organizationId,
    ),
  ],
);

export const caseRoutingRules = pgTable(
  "case_routing_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(100),
    status: text("status").notNull().default("active"),
    definition: jsonb("definition")
      .$type<Record<string, unknown>>()
      .notNull(),
    targetQueueId: uuid("target_queue_id")
      .notNull()
      .references(() => caseQueues.id, { onDelete: "restrict" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_routing_rules_organization_idx").on(table.organizationId),
    index("case_routing_rules_priority_idx").on(
      table.organizationId,
      table.priority,
    ),
  ],
);

export const caseNumberSequences = pgTable(
  "case_number_sequences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    calendarYear: integer("calendar_year").notNull(),
    lastValue: integer("last_value").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("case_number_sequences_org_year_idx").on(
      table.organizationId,
      table.calendarYear,
    ),
  ],
);

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseNumber: text("case_number").notNull(),
    sourceSubmissionId: uuid("source_submission_id").references(
      () => intakeSubmissions.id,
      { onDelete: "restrict" },
    ),
    caseType: text("case_type").notNull().default("general"),
    workflowVersionId: uuid("workflow_version_id").references(
      () => caseWorkflowVersions.id,
      { onDelete: "restrict" },
    ),
    workflowDefinition: jsonb("workflow_definition")
      .$type<Record<string, unknown>>()
      .notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    status: text("status").notNull().default("intake_review"),
    priority: text("priority").notNull().default("normal"),
    disposition: text("disposition"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    assignedQueueId: uuid("assigned_queue_id").references(
      () => caseQueues.id,
      { onDelete: "set null" },
    ),
    assignedMembershipId: uuid("assigned_membership_id").references(
      () => organizationMemberships.id,
      { onDelete: "set null" },
    ),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    escalationLevel: integer("escalation_level").notNull().default(0),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    escalationReason: text("escalation_reason"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("cases_organization_idx").on(table.organizationId),
    index("cases_status_idx").on(table.organizationId, table.status),
    index("cases_workflow_version_idx").on(table.workflowVersionId),
    index("cases_queue_idx").on(table.organizationId, table.assignedQueueId),
    index("cases_assignee_idx").on(
      table.organizationId,
      table.assignedMembershipId,
    ),
    uniqueIndex("cases_org_number_idx").on(
      table.organizationId,
      table.caseNumber,
    ),
    uniqueIndex("cases_source_submission_idx").on(table.sourceSubmissionId),
  ],
);

export const caseStatusHistory = pgTable(
  "case_status_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    workflowVersionId: uuid("workflow_version_id").references(
      () => caseWorkflowVersions.id,
      { onDelete: "restrict" },
    ),
    transitionKey: text("transition_key"),
    note: text("note"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_status_history_organization_idx").on(table.organizationId),
    index("case_status_history_case_idx").on(table.caseId, table.createdAt),
  ],
);

export const caseTags = pgTable(
  "case_tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_tags_organization_idx").on(table.organizationId),
    uniqueIndex("case_tags_case_tag_idx").on(table.caseId, table.tag),
  ],
);


export const caseSavedViews = pgTable(
  "case_saved_views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerMembershipId: uuid("owner_membership_id")
      .notNull()
      .references(() => organizationMemberships.id, {
        onDelete: "cascade",
      }),
    name: text("name").notNull(),
    definition: jsonb("definition")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("case_saved_views_owner_idx").on(
      table.organizationId,
      table.ownerMembershipId,
      table.name,
    ),
    uniqueIndex("case_saved_views_owner_name_idx").on(
      table.organizationId,
      table.ownerMembershipId,
      table.name,
    ),
    uniqueIndex("case_saved_views_one_default_idx")
      .on(table.organizationId, table.ownerMembershipId)
      .where(sql`${table.isDefault} = true`),
  ],
);


export const caseAssignmentHistory = pgTable(
  "case_assignment_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    fromQueueId: uuid("from_queue_id").references(() => caseQueues.id, {
      onDelete: "set null",
    }),
    toQueueId: uuid("to_queue_id").references(() => caseQueues.id, {
      onDelete: "set null",
    }),
    fromMembershipId: uuid("from_membership_id").references(
      () => organizationMemberships.id,
      { onDelete: "set null" },
    ),
    toMembershipId: uuid("to_membership_id").references(
      () => organizationMemberships.id,
      { onDelete: "set null" },
    ),
    source: text("source").notNull(),
    routingRuleId: uuid("routing_rule_id").references(
      () => caseRoutingRules.id,
      { onDelete: "set null" },
    ),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_assignment_history_organization_idx").on(
      table.organizationId,
    ),
    index("case_assignment_history_case_idx").on(
      table.caseId,
      table.createdAt,
    ),
  ],
);


export const documentTypes = pgTable(
  "document_types",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    acceptedMimeTypes: jsonb("accepted_mime_types")
      .$type<string[]>()
      .notNull()
      .default([]),
    maxBytes: integer("max_bytes"),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("document_types_organization_idx").on(table.organizationId),
    uniqueIndex("document_types_org_key_idx").on(
      table.organizationId,
      table.key,
    ),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentTypeId: uuid("document_type_id")
      .notNull()
      .references(() => documentTypes.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description"),
    visibility: text("visibility").notNull().default("internal"),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("documents_organization_idx").on(table.organizationId),
    index("documents_type_idx").on(table.organizationId, table.documentTypeId),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storageDriver: text("storage_driver").notNull(),
    storageKey: text("storage_key").notNull(),
    contentStatus: text("content_status").notNull().default("quarantined"),
    malwareScanStatus: text("malware_scan_status").notNull().default("pending"),
    malwareScanProvider: text("malware_scan_provider"),
    malwareScanDetails: jsonb("malware_scan_details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    malwareScannedAt: timestamp("malware_scanned_at", { withTimezone: true }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("document_versions_organization_idx").on(table.organizationId),
    index("document_versions_document_idx").on(table.documentId),
    uniqueIndex("document_versions_document_number_idx").on(
      table.documentId,
      table.versionNumber,
    ),
    uniqueIndex("document_versions_storage_idx").on(
      table.storageDriver,
      table.storageKey,
    ),
  ],
);

export const documentCaseLinks = pgTable(
  "document_case_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    relationship: text("relationship").notNull().default("evidence"),
    evidenceDescription: text("evidence_description"),
    sourceDescription: text("source_description"),
    exhibitLabel: text("exhibit_label"),
    attachedByUserId: uuid("attached_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    attachedAt: timestamp("attached_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("document_case_links_organization_idx").on(table.organizationId),
    index("document_case_links_case_idx").on(table.caseId),
    uniqueIndex("document_case_links_case_version_idx").on(
      table.caseId,
      table.documentVersionId,
    ),
  ],
);

export const documentSubmissionLinks = pgTable(
  "document_submission_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => intakeSubmissions.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    formFieldId: text("form_field_id"),
    attachedByUserId: uuid("attached_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    attachedAt: timestamp("attached_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("document_submission_links_organization_idx").on(table.organizationId),
    index("document_submission_links_submission_idx").on(table.submissionId),
    uniqueIndex("document_submission_links_submission_version_idx").on(
      table.submissionId,
      table.documentVersionId,
    ),
  ],
);

export const documentCustodyEvents = pgTable(
  "document_custody_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    fromCustodian: text("from_custodian"),
    toCustodian: text("to_custodian"),
    location: text("location"),
    note: text("note"),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("document_custody_events_organization_idx").on(table.organizationId),
    index("document_custody_events_version_idx").on(
      table.documentVersionId,
      table.occurredAt,
    ),
  ],
);

export const documentAccessEvents = pgTable(
  "document_access_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("document_access_events_organization_idx").on(table.organizationId),
    index("document_access_events_version_idx").on(
      table.documentVersionId,
      table.createdAt,
    ),
  ],
);



export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    eventTypes: jsonb("event_types")
      .$type<string[]>()
      .notNull()
      .default([]),
    signingSecretCiphertext: text("signing_secret_ciphertext").notNull(),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("webhook_subscriptions_organization_idx").on(table.organizationId),
    uniqueIndex("webhook_subscriptions_org_name_idx").on(
      table.organizationId,
      table.name,
    ),
  ],
);


export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    actorType: text("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    parentResourceType: text("parent_resource_type"),
    parentResourceId: text("parent_resource_id"),
    correlationId: uuid("correlation_id").notNull(),
    source: text("source").notNull().default("application"),
    previousState: jsonb("previous_state")
      .$type<Record<string, unknown> | null>()
      .default(null),
    newState: jsonb("new_state")
      .$type<Record<string, unknown> | null>()
      .default(null),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // Assigned by the database (migration 0021); never supplied by callers.
    sequence: bigint("sequence", { mode: "number" })
      .notNull()
      .default(sql`nextval('audit_events_sequence_seq')`),
    txid: bigint("txid", { mode: "number" })
      .notNull()
      .default(sql`txid_current()`),
    eventType: text("event_type"),
  },
  (table) => [
    index("audit_events_organization_time_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
    index("audit_events_resource_idx").on(
      table.organizationId,
      table.resourceType,
      table.resourceId,
    ),
    index("audit_events_actor_idx").on(
      table.organizationId,
      table.actorUserId,
      table.occurredAt,
    ),
    index("audit_events_correlation_idx").on(
      table.organizationId,
      table.correlationId,
    ),
    index("audit_events_action_idx").on(
      table.organizationId,
      table.action,
      table.occurredAt,
    ),
  ],
);


export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id, {
        onDelete: "cascade",
      }),
    auditEventId: uuid("audit_event_id")
      .notNull()
      .references(() => auditEvents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    responseStatus: integer("response_status"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("webhook_deliveries_status_idx").on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index("webhook_deliveries_subscription_idx").on(
      table.subscriptionId,
      table.createdAt,
    ),
    uniqueIndex("webhook_deliveries_event_subscription_idx").on(
      table.subscriptionId,
      table.auditEventId,
    ),
  ],
);


export const deadlineCalendars = pgTable(
  "deadline_calendars",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    timeZone: text("time_zone").notNull().default("UTC"),
    weekendDays: jsonb("weekend_days")
      .$type<number[]>()
      .notNull()
      .default([0, 6]),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("deadline_calendars_organization_idx").on(table.organizationId),
    uniqueIndex("deadline_calendars_org_key_idx").on(
      table.organizationId,
      table.key,
    ),
  ],
);

export const deadlineCalendarExclusions = pgTable(
  "deadline_calendar_exclusions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => deadlineCalendars.id, { onDelete: "cascade" }),
    localDate: text("local_date").notNull(),
    label: text("label"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("deadline_calendar_exclusions_calendar_idx").on(
      table.calendarId,
      table.localDate,
    ),
    uniqueIndex("deadline_calendar_exclusions_unique_idx").on(
      table.calendarId,
      table.localDate,
    ),
  ],
);

export const caseReferralPolicies = pgTable(
  "case_referral_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    definition: jsonb("definition")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_referral_policies_organization_idx").on(table.organizationId),
    uniqueIndex("case_referral_policies_org_key_idx").on(
      table.organizationId,
      table.key,
    ),
  ],
);

export const caseReferrals = pgTable(
  "case_referrals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => caseReferralPolicies.id, { onDelete: "restrict" }),
    policyKey: text("policy_key").notNull(),
    policySnapshot: jsonb("policy_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    recipientKey: text("recipient_key"),
    recipientName: text("recipient_name").notNull(),
    externalReference: text("external_reference"),
    subject: text("subject"),
    summary: text("summary"),
    status: text("status").notNull().default("draft"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_referrals_organization_idx").on(table.organizationId),
    index("case_referrals_case_idx").on(table.caseId, table.createdAt),
    index("case_referrals_status_idx").on(
      table.organizationId,
      table.status,
      table.updatedAt,
    ),
    index("case_referrals_recipient_idx").on(
      table.organizationId,
      table.recipientKey,
    ),
  ],
);

export const caseReferralEvents = pgTable(
  "case_referral_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    referralId: uuid("referral_id")
      .notNull()
      .references(() => caseReferrals.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    summary: text("summary"),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_referral_events_organization_idx").on(table.organizationId),
    index("case_referral_events_referral_idx").on(
      table.referralId,
      table.occurredAt,
    ),
  ],
);

export const caseDeadlines = pgTable(
  "case_deadlines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    referralId: uuid("referral_id").references(() => caseReferrals.id, {
      onDelete: "cascade",
    }),
    policyKey: text("policy_key").notNull(),
    occurrence: integer("occurrence").notNull().default(1),
    label: text("label").notNull(),
    description: text("description"),
    triggerType: text("trigger_type").notNull(),
    triggerKey: text("trigger_key"),
    durationValue: integer("duration_value").notNull(),
    durationUnit: text("duration_unit").notNull(),
    calendarId: uuid("calendar_id").references(() => deadlineCalendars.id, {
      onDelete: "restrict",
    }),
    warningBeforeValue: integer("warning_before_value"),
    warningBeforeUnit: text("warning_before_unit"),
    pausable: boolean("pausable").notNull().default(false),
    escalationPriority: text("escalation_priority"),
    escalationQueueSlug: text("escalation_queue_slug"),
    policySnapshot: jsonb("policy_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text("status").notNull().default("active"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    warningAt: timestamp("warning_at", { withTimezone: true }),
    warningIssuedAt: timestamp("warning_issued_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    accumulatedPauseSeconds: integer("accumulated_pause_seconds")
      .notNull()
      .default(0),
    overdueAt: timestamp("overdue_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    escalationAttempts: integer("escalation_attempts").notNull().default(0),
    lastEscalationError: text("last_escalation_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_deadlines_organization_idx").on(table.organizationId),
    index("case_deadlines_case_idx").on(table.caseId),
    index("case_deadlines_referral_idx").on(table.referralId),
    index("case_deadlines_due_idx").on(
      table.organizationId,
      table.status,
      table.dueAt,
    ),
    uniqueIndex("case_deadlines_case_occurrence_idx")
      .on(table.caseId, table.policyKey, table.occurrence)
      .where(sql`${table.referralId} is null`),
    uniqueIndex("case_deadlines_referral_occurrence_idx")
      .on(table.referralId, table.policyKey, table.occurrence)
      .where(sql`${table.referralId} is not null`),
  ],
);

export const caseDeadlineHistory = pgTable(
  "case_deadline_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deadlineId: uuid("deadline_id")
      .notNull()
      .references(() => caseDeadlines.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("case_deadline_history_deadline_idx").on(
      table.deadlineId,
      table.occurredAt,
    ),
    index("case_deadline_history_organization_idx").on(table.organizationId),
  ],
);


export const caseNotes = pgTable(
  "case_notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    visibility: text("visibility").notNull().default("internal"),
    body: text("body").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_notes_organization_idx").on(table.organizationId),
    index("case_notes_case_idx").on(table.caseId, table.createdAt),
  ],
);

export const caseNoteDocumentLinks = pgTable(
  "case_note_document_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    noteId: uuid("note_id")
      .notNull()
      .references(() => caseNotes.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    attachedByUserId: uuid("attached_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    attachedAt: timestamp("attached_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_note_document_links_organization_idx").on(table.organizationId),
    index("case_note_document_links_note_idx").on(table.noteId),
    uniqueIndex("case_note_document_links_unique_idx").on(
      table.noteId,
      table.documentVersionId,
    ),
  ],
);

export const communicationTemplates = pgTable(
  "communication_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    channel: text("channel").notNull().default("email"),
    subjectTemplate: text("subject_template"),
    bodyTemplate: text("body_template").notNull(),
    defaultVisibility: text("default_visibility")
      .notNull()
      .default("participant"),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("communication_templates_organization_idx").on(table.organizationId),
    uniqueIndex("communication_templates_org_key_idx").on(
      table.organizationId,
      table.key,
    ),
  ],
);

export const caseCommunicationThreads = pgTable(
  "case_communication_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    subject: text("subject"),
    status: text("status").notNull().default("open"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_communication_threads_organization_idx").on(table.organizationId),
    index("case_communication_threads_case_idx").on(table.caseId, table.updatedAt),
  ],
);

export const caseCorrespondenceMessages = pgTable(
  "case_correspondence_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => caseCommunicationThreads.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    channel: text("channel").notNull().default("email"),
    visibility: text("visibility").notNull().default("participant"),
    status: text("status").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    senderAddress: text("sender_address"),
    recipients: jsonb("recipients")
      .$type<Array<{ type: "to" | "cc" | "bcc"; address: string; name?: string }>>()
      .notNull()
      .default([]),
    externalMessageId: text("external_message_id"),
    inReplyToMessageId: uuid("in_reply_to_message_id"),
    templateId: uuid("template_id").references(() => communicationTemplates.id, {
      onDelete: "set null",
    }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    deliveryProvider: text("delivery_provider"),
    deliveryMetadata: jsonb("delivery_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("case_correspondence_messages_organization_idx").on(table.organizationId),
    index("case_correspondence_messages_case_idx").on(table.caseId, table.createdAt),
    index("case_correspondence_messages_thread_idx").on(table.threadId, table.createdAt),
    uniqueIndex("case_correspondence_messages_external_idx")
      .on(
        table.organizationId,
        table.deliveryProvider,
        table.externalMessageId,
      )
      .where(sql`${table.externalMessageId} is not null`),
  ],
);

export const correspondenceMessageDocumentLinks = pgTable(
  "correspondence_message_document_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => caseCorrespondenceMessages.id, { onDelete: "cascade" }),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "restrict" }),
    attachedByUserId: uuid("attached_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    attachedAt: timestamp("attached_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("correspondence_message_document_links_organization_idx").on(
      table.organizationId,
    ),
    index("correspondence_message_document_links_message_idx").on(table.messageId),
    uniqueIndex("correspondence_message_document_links_unique_idx").on(
      table.messageId,
      table.documentVersionId,
    ),
  ],
);


export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    organizationMembershipId: uuid("organization_membership_id")
      .notNull()
      .references(() => organizationMemberships.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    severity: text("severity").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: text("link"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    inAppVisible: boolean("in_app_visible").notNull().default(true),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("notifications_membership_time_idx").on(
      table.organizationMembershipId,
      table.createdAt,
    ),
    index("notifications_organization_event_idx").on(
      table.organizationId,
      table.eventType,
      table.createdAt,
    ),
  ],
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    organizationMembershipId: uuid("organization_membership_id")
      .notNull()
      .references(() => organizationMemberships.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull().default("*"),
    channel: text("channel").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    destination: text("destination"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("notification_preferences_organization_idx").on(table.organizationId),
    uniqueIndex("notification_preferences_membership_event_channel_idx").on(
      table.organizationMembershipId,
      table.eventType,
      table.channel,
    ),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    destination: text("destination").notNull(),
    status: text("status").notNull().default("pending"),
    provider: text("provider"),
    externalMessageId: text("external_message_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("notification_deliveries_notification_idx").on(table.notificationId),
    index("notification_deliveries_status_idx").on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    uniqueIndex("notification_deliveries_notification_channel_idx").on(
      table.notificationId,
      table.channel,
    ),
  ],
);

export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(100),
    dedupeKey: text("dedupe_key"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("background_jobs_ready_idx").on(
      table.status,
      table.availableAt,
      table.priority,
      table.createdAt,
    ),
    index("background_jobs_lease_idx").on(table.status, table.leaseUntil),
    index("background_jobs_organization_idx").on(table.organizationId),
    uniqueIndex("background_jobs_dedupe_idx")
      .on(table.organizationId, table.jobType, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
  ],
);

export const backgroundJobAttempts = pgTable(
  "background_job_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => backgroundJobs.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id").notNull(),
    outcome: text("outcome"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("background_job_attempts_job_idx").on(table.jobId, table.attemptNumber),
    uniqueIndex("background_job_attempts_number_idx").on(
      table.jobId,
      table.attemptNumber,
    ),
  ],
);

export const backgroundSchedules = pgTable(
  "background_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    intervalSeconds: integer("interval_seconds").notNull(),
    priority: integer("priority").notNull().default(100),
    maxAttempts: integer("max_attempts").notNull().default(5),
    status: text("status").notNull().default("active"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("background_schedules_due_idx").on(table.status, table.nextRunAt),
    uniqueIndex("background_schedules_org_key_idx").on(
      table.organizationId,
      table.key,
    ),
  ],
);


export const reviewPolicies = pgTable(
  "review_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    level: integer("level").notNull().default(1),
    eligibleCaseStatuses: jsonb("eligible_case_statuses")
      .$type<string[]>()
      .notNull()
      .default([]),
    filingWindowValue: integer("filing_window_value"),
    filingWindowUnit: text("filing_window_unit"),
    decisionDeadlineValue: integer("decision_deadline_value"),
    decisionDeadlineUnit: text("decision_deadline_unit"),
    decisionWarningBeforeValue: integer("decision_warning_before_value"),
    decisionWarningBeforeUnit: text("decision_warning_before_unit"),
    calendarId: uuid("calendar_id").references(() => deadlineCalendars.id, {
      onDelete: "restrict",
    }),
    allowedOutcomes: jsonb("allowed_outcomes")
      .$type<string[]>()
      .notNull()
      .default([
        "affirmed",
        "modified",
        "reversed",
        "remanded",
        "dismissed",
      ]),
    requireIndependentReviewer: boolean("require_independent_reviewer")
      .notNull()
      .default(true),
    status: text("status").notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("review_policies_organization_idx").on(table.organizationId),
    uniqueIndex("review_policies_org_key_idx").on(
      table.organizationId,
      table.key,
    ),
  ],
);

export const reviewPolicyPrerequisites = pgTable(
  "review_policy_prerequisites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => reviewPolicies.id, { onDelete: "cascade" }),
    prerequisitePolicyId: uuid("prerequisite_policy_id")
      .notNull()
      .references(() => reviewPolicies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("review_policy_prerequisites_organization_idx").on(
      table.organizationId,
    ),
    uniqueIndex("review_policy_prerequisites_unique_idx").on(
      table.policyId,
      table.prerequisitePolicyId,
    ),
  ],
);

export const caseReviews = pgTable(
  "case_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => reviewPolicies.id, { onDelete: "restrict" }),
    parentReviewId: uuid("parent_review_id"),
    policyKeySnapshot: text("policy_key_snapshot").notNull(),
    policyNameSnapshot: text("policy_name_snapshot").notNull(),
    levelSnapshot: integer("level_snapshot").notNull(),
    policySnapshot: jsonb("policy_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    challengedSnapshot: jsonb("challenged_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text("status").notNull().default("filed"),
    grounds: text("grounds").notNull(),
    requestedRelief: text("requested_relief"),
    filedByUserId: uuid("filed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    filedAt: timestamp("filed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    filingDeadlineAt: timestamp("filing_deadline_at", {
      withTimezone: true,
    }),
    reviewerMembershipId: uuid("reviewer_membership_id").references(
      () => organizationMemberships.id,
      { onDelete: "set null" },
    ),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    decisionDueAt: timestamp("decision_due_at", { withTimezone: true }),
    decisionWarningAt: timestamp("decision_warning_at", { withTimezone: true }),
    decisionWarningIssuedAt: timestamp("decision_warning_issued_at", {
      withTimezone: true,
    }),
    decisionOverdueAt: timestamp("decision_overdue_at", {
      withTimezone: true,
    }),
    outcome: text("outcome"),
    writtenDecision: text("written_decision"),
    remandInstructions: text("remand_instructions"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    caseEffectAppliedAt: timestamp("case_effect_applied_at", {
      withTimezone: true,
    }),
    caseEffectTargetStatus: text("case_effect_target_status"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("case_reviews_organization_idx").on(table.organizationId),
    index("case_reviews_case_idx").on(table.caseId, table.createdAt),
    index("case_reviews_status_idx").on(
      table.organizationId,
      table.status,
      table.decisionDueAt,
    ),
    index("case_reviews_reviewer_idx").on(
      table.organizationId,
      table.reviewerMembershipId,
      table.status,
    ),
    uniqueIndex("case_reviews_open_root_unique_idx")
      .on(
        table.organizationId,
        table.caseId,
        table.policyId,
      )
      .where(
        sql`${table.parentReviewId} is null and ${table.status} in ('filed','assigned','under_review')`,
      ),
    uniqueIndex("case_reviews_open_parent_unique_idx")
      .on(
        table.organizationId,
        table.caseId,
        table.policyId,
        table.parentReviewId,
      )
      .where(
        sql`${table.parentReviewId} is not null and ${table.status} in ('filed','assigned','under_review')`,
      ),
    foreignKey({
      columns: [table.parentReviewId],
      foreignColumns: [table.id],
      name: "case_reviews_parent_review_fk",
    }).onDelete("restrict"),
  ],
);

export const caseReviewHistory = pgTable(
  "case_review_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => caseReviews.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("case_review_history_organization_idx").on(table.organizationId),
    index("case_review_history_review_idx").on(
      table.reviewId,
      table.occurredAt,
    ),
  ],
);


export const disclosurePublications = pgTable(
  "disclosure_publications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    slug: text("slug").notNull(),
    status: text("status").notNull().default("draft"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnByUserId: uuid("withdrawn_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    withdrawalReason: text("withdrawal_reason"),
    createdByUserId: uuid("created_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("disclosure_publications_organization_idx").on(
      table.organizationId,
    ),
    uniqueIndex("disclosure_publications_org_slug_idx").on(
      table.organizationId,
      table.slug,
    ),
    uniqueIndex("disclosure_publications_source_idx").on(
      table.organizationId,
      table.sourceType,
      table.sourceId,
    ),
  ],
);

export const disclosurePublicationVersions = pgTable(
  "disclosure_publication_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    publicationId: uuid("publication_id")
      .notNull()
      .references(() => disclosurePublications.id, {
        onDelete: "cascade",
      }),
    versionNumber: integer("version_number").notNull(),
    publicTitle: text("public_title").notNull(),
    publicSummary: text("public_summary"),
    publicData: jsonb("public_data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    redactionSummary: text("redaction_summary"),
    status: text("status").notNull().default("draft"),
    preparedByUserId: uuid("prepared_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    reviewNote: text("review_note"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("disclosure_publication_versions_org_idx").on(
      table.organizationId,
    ),
    index("disclosure_publication_versions_status_idx").on(
      table.organizationId,
      table.status,
    ),
    uniqueIndex("disclosure_publication_versions_number_idx").on(
      table.publicationId,
      table.versionNumber,
    ),
    uniqueIndex("disclosure_publication_versions_published_idx")
      .on(table.publicationId)
      .where(sql`${table.status} = 'published'`),
  ],
);

export const documentDerivatives = pgTable(
  "document_derivatives",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sourceDocumentVersionId: uuid("source_document_version_id")
      .notNull()
      .references(() => documentVersions.id, {
        onDelete: "restrict",
      }),
    derivativeDocumentVersionId: uuid("derivative_document_version_id")
      .notNull()
      .references(() => documentVersions.id, {
        onDelete: "restrict",
      }),
    audience: text("audience").notNull(),
    redactionSummary: text("redaction_summary"),
    createdByUserId: uuid("created_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("document_derivatives_source_idx").on(
      table.organizationId,
      table.sourceDocumentVersionId,
    ),
    uniqueIndex("document_derivatives_derived_idx").on(
      table.derivativeDocumentVersionId,
    ),
  ],
);

export const disclosurePublicationDocuments = pgTable(
  "disclosure_publication_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    publicationVersionId: uuid("publication_version_id")
      .notNull()
      .references(() => disclosurePublicationVersions.id, {
        onDelete: "cascade",
      }),
    documentDerivativeId: uuid("document_derivative_id")
      .notNull()
      .references(() => documentDerivatives.id, {
        onDelete: "restrict",
      }),
    label: text("label"),
    sortOrder: integer("sort_order").notNull().default(0),
    attachedByUserId: uuid("attached_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    attachedAt: timestamp("attached_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("disclosure_publication_documents_org_idx").on(
      table.organizationId,
    ),
    index("disclosure_publication_documents_version_idx").on(
      table.publicationVersionId,
      table.sortOrder,
    ),
    uniqueIndex("disclosure_publication_documents_unique_idx").on(
      table.publicationVersionId,
      table.documentDerivativeId,
    ),
  ],
);


export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    apiClientId: uuid("api_client_id")
      .notNull()
      .references(() => apiClients.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestMethod: text("request_method").notNull(),
    requestPath: text("request_path").notNull(),
    requestSha256: text("request_sha256").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("api_idempotency_keys_client_key_idx").on(
      table.apiClientId,
      table.idempotencyKey,
    ),
  ],
);

export const participantIdentityLinks = pgTable(
  "participant_identity_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => intakeSubmissions.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    createdByApiClientId: uuid("created_by_api_client_id").references(
      () => apiClients.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("participant_identity_links_submission_provider_idx").on(
      table.submissionId,
      table.provider,
    ),
    index("participant_identity_links_subject_idx").on(
      table.organizationId,
      table.provider,
      table.subject,
    ),
  ],
);
