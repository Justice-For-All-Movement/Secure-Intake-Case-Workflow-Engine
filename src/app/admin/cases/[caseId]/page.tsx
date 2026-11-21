import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getRuntimeDatabase } from "@/db/runtime";
import {
  hasPermission,
  requireTenantScope,
} from "@/modules/auth/authorization";
import { getCurrentAuthorizationContext } from "@/modules/auth/server-session";
import {
  findCaseById,
  findCaseSourceSubmission,
  listCaseStatusHistory,
  listCaseTags,
} from "@/modules/cases/repository";
import { casePriorities } from "@/modules/cases/lifecycle";
import {
  canViewDocumentVisibility,
} from "@/modules/documents/policy";
import {
  listCaseDocuments,
  listDocumentAccessEvents,
  listDocumentCustodyEvents,
  listDocumentTypes,
} from "@/modules/documents/repository";
import {
  listCaseAssignmentHistory,
  listOrganizationMembers,
  listQueues,
} from "@/modules/routing/repository";
import {
  listCaseDeadlines,
  listDeadlineHistory,
} from "@/modules/deadlines/repository";
import {
  listCaseCorrespondence,
  listCaseCorrespondenceAttachments,
  listCaseNoteAttachments,
  listCaseNotes,
  listCommunicationTemplates,
} from "@/modules/communications/repository";
import { listCaseTimeline } from "@/modules/timeline/repository";
import {
  listCaseReviewHistory,
  listCaseReviews,
  listEligibleReviewers,
  listReviewPolicies,
} from "@/modules/reviews/repository";
import { CaseCommunicationsPanel } from "./communications-panel";
import { CaseReviewsPanel } from "./reviews-panel";
import { CaseTimelinePanel } from "./timeline-panel";
import { CaseProtectedDataPanel } from "./protected-data-panel";
import { SealedAnswersPanel } from "./sealed-answers-panel";
import { findSealedEnvelopeSummary } from "@/modules/sealed/service";
import { CaseReferralsPanel } from "./referrals-panel";
import {
  listProtectedCompartmentsForSubmission,
  listRevealRequestsForCompartments,
} from "@/modules/protected-data/repository";
import {
  findWorkflowState,
  parseWorkflowDefinition,
  transitionsFromState,
} from "@/modules/workflows/definition";
import { PrintPageButton } from "@/components/print-page-button";
import { getCaseParticipantMessagingCapability } from "@/modules/participant-portal/service";
import {
  listCaseReferrals,
  listReferralEvents,
  listReferralPolicies,
} from "@/modules/referrals/repository";
import {
  applyRoutingRulesAction,
  cancelDeadlineAction,
  completeDeadlineAction,
  escalateCaseAction,
  manualAssignCaseAction,
  pauseDeadlineAction,
  resumeDeadlineAction,
  recordDocumentCustodyAction,
  recordDocumentScanAction,
  transitionCaseAction,
  updateCaseMetadataAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<{ error?: string; document?: string }>;
}) {
  const context = await getCurrentAuthorizationContext();
  if (!context) redirect("/login");
  if (!context.tenantScope) redirect("/select-organization");
  if (!hasPermission(context, "case:view")) redirect("/forbidden");

  const { caseId } = await params;
  const { error, document: documentResult } = await searchParams;
  const scope = requireTenantScope(context);
  const db = getRuntimeDatabase();

  const record = await findCaseById(db, scope, caseId);
  if (!record) notFound();

  const [
    history,
    tags,
    source,
    queues,
    members,
    assignmentHistory,
    caseDocuments,
    documentTypes,
    deadlines,
    referrals,
    referralPolicies,
    notes,
    noteAttachments,
    correspondence,
    correspondenceAttachments,
    communicationTemplates,
    participantMessagingCapability,
    reviews,
    reviewPolicies,
    eligibleReviewers,
    timeline,
  ] = await Promise.all([
    listCaseStatusHistory(db, scope, record.id),
    listCaseTags(db, scope, record.id),
    hasPermission(context, "submission:view")
      ? findCaseSourceSubmission(db, scope, record.id)
      : Promise.resolve(null),
    listQueues(db, scope),
    listOrganizationMembers(db, scope),
    listCaseAssignmentHistory(db, scope, record.id),
    hasPermission(context, "document:view") ||
    hasPermission(context, "document:view_private")
      ? listCaseDocuments(db, scope, record.id)
      : Promise.resolve([]),
    hasPermission(context, "document:upload")
      ? listDocumentTypes(db, scope)
      : Promise.resolve([]),
    hasPermission(context, "deadline:view")
      ? listCaseDeadlines(db, scope, record.id)
      : Promise.resolve([]),
    hasPermission(context, "referral:view")
      ? listCaseReferrals(db, scope, record.id)
      : Promise.resolve([]),
    hasPermission(context, "referral:manage")
      ? listReferralPolicies(db, scope)
      : Promise.resolve([]),
    hasPermission(context, "note:view")
      ? listCaseNotes(db, scope, record.id)
      : Promise.resolve([]),
    hasPermission(context, "note:view")
      ? listCaseNoteAttachments(db, scope, record.id)
      : Promise.resolve([]),
    hasPermission(context, "correspondence:view")
      ? listCaseCorrespondence(db, scope, record.id)
      : Promise.resolve([]),
    hasPermission(context, "correspondence:view")
      ? listCaseCorrespondenceAttachments(db, scope, record.id)
      : Promise.resolve([]),
    hasPermission(context, "correspondence:view")
      ? listCommunicationTemplates(db, scope)
      : Promise.resolve([]),
    hasPermission(context, "correspondence:view")
      ? getCaseParticipantMessagingCapability(db, scope, record.id)
      : Promise.resolve({
          portalEnabled: false,
          allowMessaging: false,
          reason: "unavailable",
        }),
    hasPermission(context, "review:view")
      ? listCaseReviews(db, scope, record.id)
      : Promise.resolve([]),
    hasPermission(context, "review:view") ||
    hasPermission(context, "review:file") ||
    hasPermission(context, "case:appeal")
      ? listReviewPolicies(db, scope)
      : Promise.resolve([]),
    hasPermission(context, "review:assign")
      ? listEligibleReviewers(db, scope)
      : Promise.resolve([]),
    listCaseTimeline(db, scope, record.id, {
      includeNotes: hasPermission(context, "note:view"),
      includeCorrespondence: hasPermission(
        context,
        "correspondence:view",
      ),
      includeReviews: hasPermission(context, "review:view"),
      canViewDocuments: hasPermission(context, "document:view"),
      canViewPrivateDocuments: hasPermission(
        context,
        "document:view_private",
      ),
    }),
  ]);

  const workflow = parseWorkflowDefinition(record.workflowDefinition);
  const state = findWorkflowState(workflow, record.status);
  const canUpdate = hasPermission(context, "case:update");
  const canAssign = hasPermission(context, "case:assign");
  const canUploadDocuments = hasPermission(context, "document:upload");
  const canManageScan = hasPermission(context, "document:scan_manage");
  const canManageCustody = hasPermission(context, "document:manage");
  const canViewAccessHistory =
    hasPermission(context, "audit:view") ||
    hasPermission(context, "document:manage");
  const canApplyRouting =
    canAssign && hasPermission(context, "routing:view");
  const canViewDeadlines = hasPermission(context, "deadline:view");
  const canViewReferrals = hasPermission(context, "referral:view");
  const canManageReferrals = hasPermission(context, "referral:manage");
  const canOperateDeadlines = hasPermission(
    context,
    "deadline:operate",
  );
  const canViewNotes = hasPermission(context, "note:view");
  const canViewCorrespondence = hasPermission(
    context,
    "correspondence:view",
  );
  const canCreateInternalNote = hasPermission(
    context,
    "note:create_internal",
  );
  const canCreateParticipantNote = hasPermission(
    context,
    "note:create_participant",
  );
  const canManageCorrespondence = hasPermission(
    context,
    "correspondence:manage",
  );
  const canViewReviews = hasPermission(context, "review:view");
  const canFileReviews =
    hasPermission(context, "review:file") ||
    hasPermission(context, "case:appeal");
  const canAssignReviews = hasPermission(
    context,
    "review:assign",
  );
  const canDecideReviews = hasPermission(
    context,
    "review:decide",
  );
  const canManageReviews = hasPermission(
    context,
    "review:manage",
  );
  const canViewProtectedMetadata = hasPermission(
    context,
    "protected_data:view_metadata",
  );
  const canRequestProtectedReveal = hasPermission(
    context,
    "protected_data:request_reveal",
  );
  const canApproveProtectedReveal = hasPermission(
    context,
    "protected_data:approve_reveal",
  );
  const canApplyReviewEffect =
    canDecideReviews && canUpdate;
  const visibleDocuments = caseDocuments.filter(({ document }) =>
    canViewDocumentVisibility(
      document.visibility,
      context.permissions,
    ),
  );
  const visibleNoteAttachments = noteAttachments.filter(
    ({ document }) =>
      canViewDocumentVisibility(
        document.visibility,
        context.permissions,
      ),
  );
  const visibleCorrespondenceAttachments =
    correspondenceAttachments.filter(({ document }) =>
      canViewDocumentVisibility(
        document.visibility,
        context.permissions,
      ),
    );

  const sealedSummary = source
    ? await findSealedEnvelopeSummary(db, scope, source.submissionId)
    : null;

  const protectedCompartments =
    record.sourceSubmissionId && canViewProtectedMetadata
      ? await listProtectedCompartmentsForSubmission(
          db,
          scope,
          record.sourceSubmissionId,
        )
      : [];
  const protectedRevealRequests =
    protectedCompartments.length > 0
      ? await listRevealRequestsForCompartments(
          db,
          scope,
          protectedCompartments.map((entry) => entry.id),
        )
      : [];

  const documentHistory = new Map(
    await Promise.all(
      visibleDocuments.map(async ({ version }) => [
        version.id,
        {
          custody: await listDocumentCustodyEvents(
            db,
            scope,
            version.id,
          ),
          access: canViewAccessHistory
            ? await listDocumentAccessEvents(
                db,
                scope,
                version.id,
              )
            : [],
        },
      ] as const),
    ),
  );

  const reviewHistory = canViewReviews
    ? await listCaseReviewHistory(
        db,
        scope,
        reviews.map((review) => review.id),
      )
    : [];

  const referralEventsByReferral = new Map(
    await Promise.all(
      referrals.map(async ({ referral }) => [
        referral.id,
        await listReferralEvents(db, scope, referral.id),
      ] as const),
    ),
  );
  const referralDeadlinesByReferral = new Map(
    referrals.map(({ referral }) => [
      referral.id,
      deadlines.filter(
        (deadline) => deadline.referralId === referral.id,
      ),
    ] as const),
  );
  const caseLevelDeadlines = deadlines.filter(
    (deadline) => !deadline.referralId,
  );

  const deadlineHistory = new Map(
    await Promise.all(
      deadlines.map(async (deadline) => [
        deadline.id,
        await listDeadlineHistory(db, scope, deadline.id),
      ] as const),
    ),
  );

  const transitions = transitionsFromState(
    workflow,
    record.status,
  ).filter((transition) =>
    transition.requiredPermissions.every((permission) =>
      context.permissions.has(permission),
    ),
  );

  const queueById = new Map(
    queues.map((queue) => [queue.id, queue]),
  );
  const memberById = new Map(
    members.map((member) => [member.membershipId, member]),
  );
  const currentQueue = record.assignedQueueId
    ? queueById.get(record.assignedQueueId)
    : null;
  const currentAssignee = record.assignedMembershipId
    ? memberById.get(record.assignedMembershipId)
    : null;

  const memberLabel = (membershipId: string | null) => {
    if (!membershipId) return "unassigned";
    const member = memberById.get(membershipId);
    return member
      ? member.displayName ?? member.email
      : membershipId;
  };

  const queueLabel = (queueId: string | null) => {
    if (!queueId) return "no queue";
    return queueById.get(queueId)?.name ?? queueId;
  };

  return (
    <main>
      <nav>
        <Link href="/admin/cases">← Cases</Link>
        {" · "}
        <Link href="/admin/workflows">Workflows</Link>
        {" · "}
        <Link href="/admin/routing">Routing</Link>
        {" · "}
        <Link href="/admin/documents">Documents</Link>
        {" · "}
        <Link href="/admin/deadlines">Deadlines</Link>
        {" · "}
        <Link href="/admin/referrals">Referrals</Link>
        {" · "}
        <Link href="/admin/reviews">Reviews</Link>
        {" · "}
        <Link href="/admin/disclosures">Disclosures</Link>
        {" · "}
        <Link href="/admin/communications">Communications</Link>
        {" · "}
        <Link href="/notifications">Notifications</Link>
        {" · "}
        <Link href="/admin/jobs">Jobs</Link>
        {" · "}
        <Link href="/admin/audit">Audit</Link>
      </nav>

      <h1>
        {record.caseNumber}: {record.title}
      </h1>
      <div className="no-print">
        <PrintPageButton label="Print case summary" />
      </div>
      <p className="print-only">
        Printed case summary — {record.caseNumber}
      </p>

      {documentResult === "uploaded" ? (
        <p role="status">
          Document uploaded and quarantined pending malware-scan clearance.
        </p>
      ) : null}

      {error ? (
        <p role="alert">
          {error === "transition_requirements"
            ? "The workflow requirements for that transition were not satisfied."
            : error === "no_routing_match"
              ? "No active routing rule matched this case."
              : `The requested case operation could not be completed (${error}).`}
        </p>
      ) : null}

      <dl>
        <dt>Status</dt>
        <dd>{state?.label ?? record.status}</dd>
        <dt>Workflow</dt>
        <dd>
          {record.workflowVersionId
            ? "Pinned published workflow version"
            : "Built-in default workflow snapshot"}
        </dd>
        <dt>Type</dt>
        <dd>{record.caseType}</dd>
        <dt>Priority</dt>
        <dd>{record.priority}</dd>
        <dt>Queue</dt>
        <dd>{currentQueue?.name ?? "Unassigned"}</dd>
        <dt>Assignee</dt>
        <dd>
          {currentAssignee
            ? currentAssignee.displayName ?? currentAssignee.email
            : "Unassigned"}
        </dd>
        <dt>Assigned</dt>
        <dd>{record.assignedAt?.toISOString() ?? "—"}</dd>
        <dt>Escalation level</dt>
        <dd>{record.escalationLevel}</dd>
        <dt>Last escalated</dt>
        <dd>{record.escalatedAt?.toISOString() ?? "—"}</dd>
        <dt>Escalation reason</dt>
        <dd>{record.escalationReason ?? "—"}</dd>
        <dt>Created</dt>
        <dd>{record.createdAt.toISOString()}</dd>
        <dt>Opened</dt>
        <dd>{record.openedAt?.toISOString() ?? "—"}</dd>
        <dt>Resolved</dt>
        <dd>{record.resolvedAt?.toISOString() ?? "—"}</dd>
        <dt>Closed</dt>
        <dd>{record.closedAt?.toISOString() ?? "—"}</dd>
        <dt>Disposition</dt>
        <dd>{record.disposition ?? "—"}</dd>
        <dt>Tags</dt>
        <dd>{tags.map((tag) => tag.tag).join(", ") || "—"}</dd>
      </dl>

      {record.summary ? (
        <section>
          <h2>Summary</h2>
          <p>{record.summary}</p>
        </section>
      ) : null}

      {canViewNotes || canViewCorrespondence ? (
        <CaseCommunicationsPanel
          caseId={record.id}
          notes={notes}
          noteAttachments={visibleNoteAttachments}
          correspondence={correspondence}
          correspondenceAttachments={
            visibleCorrespondenceAttachments
          }
          templates={communicationTemplates}
          caseDocuments={visibleDocuments}
          canViewNotes={canViewNotes}
          canViewCorrespondence={canViewCorrespondence}
          canCreateInternalNote={canCreateInternalNote}
          canCreateParticipantNote={canCreateParticipantNote}
          canManageCorrespondence={canManageCorrespondence}
          participantMessagingCapability={
            participantMessagingCapability
          }
        />
      ) : null}

      {canViewReferrals ? (
        <CaseReferralsPanel
          caseId={record.id}
          referrals={referrals}
          policies={referralPolicies}
          eventsByReferral={referralEventsByReferral}
          deadlinesByReferral={referralDeadlinesByReferral}
          canManage={canManageReferrals}
          canOperateDeadlines={canOperateDeadlines}
        />
      ) : null}

      {canViewDeadlines ? (
        <section>
          <h2>Deadlines & statutory clocks</h2>
          {caseLevelDeadlines.length === 0 ? (
            <p>No case-level deadlines are attached to this case.</p>
          ) : (
            caseLevelDeadlines.map((deadline) => {
              const clockHistory =
                deadlineHistory.get(deadline.id) ?? [];
              const final =
                deadline.status === "completed" ||
                deadline.status === "cancelled";

              return (
                <article key={deadline.id}>
                  <h3>
                    {deadline.label} — {deadline.status}
                  </h3>
                  <dl>
                    <dt>Policy</dt>
                    <dd>
                      <code>{deadline.policyKey}</code> occurrence{" "}
                      {deadline.occurrence}
                    </dd>
                    <dt>Started</dt>
                    <dd>{deadline.startedAt.toISOString()}</dd>
                    <dt>Due</dt>
                    <dd>{deadline.dueAt.toISOString()}</dd>
                    <dt>Warning</dt>
                    <dd>
                      {deadline.warningAt?.toISOString() ?? "—"}
                      {deadline.warningIssuedAt
                        ? ` — issued ${deadline.warningIssuedAt.toISOString()}`
                        : ""}
                    </dd>
                    <dt>Clock</dt>
                    <dd>
                      {deadline.durationValue} {deadline.durationUnit}
                    </dd>
                    <dt>Pausable</dt>
                    <dd>{deadline.pausable ? "yes" : "no"}</dd>
                    <dt>Paused</dt>
                    <dd>{deadline.pausedAt?.toISOString() ?? "—"}</dd>
                    <dt>Accumulated pause</dt>
                    <dd>
                      {deadline.accumulatedPauseSeconds} seconds
                    </dd>
                    <dt>Overdue</dt>
                    <dd>{deadline.overdueAt?.toISOString() ?? "—"}</dd>
                    <dt>Escalated</dt>
                    <dd>{deadline.escalatedAt?.toISOString() ?? "—"}</dd>
                    <dt>Escalation policy</dt>
                    <dd>
                      {deadline.escalationPriority
                        ? `priority=${deadline.escalationPriority}`
                        : ""}
                      {deadline.escalationPriority &&
                      deadline.escalationQueueSlug
                        ? ", "
                        : ""}
                      {deadline.escalationQueueSlug
                        ? `queue=${deadline.escalationQueueSlug}`
                        : ""}
                      {!deadline.escalationPriority &&
                      !deadline.escalationQueueSlug
                        ? "—"
                        : ""}
                    </dd>
                  </dl>

                  {deadline.description ? (
                    <p>{deadline.description}</p>
                  ) : null}

                  <details>
                    <summary>Policy snapshot</summary>
                    <pre>
                      {JSON.stringify(
                        deadline.policySnapshot,
                        null,
                        2,
                      )}
                    </pre>
                  </details>

                  <details>
                    <summary>Clock history</summary>
                    {clockHistory.length === 0 ? (
                      <p>No clock history.</p>
                    ) : (
                      <ol>
                        {clockHistory.map((event) => (
                          <li key={event.id}>
                            {event.occurredAt.toISOString()}:{" "}
                            {event.eventType}
                            {event.reason
                              ? ` — ${event.reason}`
                              : ""}
                          </li>
                        ))}
                      </ol>
                    )}
                  </details>

                  {canOperateDeadlines && !final ? (
                    <div>
                      {deadline.status === "active" &&
                      deadline.pausable ? (
                        <form
                          action={pauseDeadlineAction.bind(
                            null,
                            record.id,
                            deadline.id,
                          )}
                        >
                          <label>
                            Pause reason
                            <input name="reason" required />
                          </label>
                          <button type="submit">Pause clock</button>
                        </form>
                      ) : null}

                      {deadline.status === "paused" ? (
                        <form
                          action={resumeDeadlineAction.bind(
                            null,
                            record.id,
                            deadline.id,
                          )}
                        >
                          <label>
                            Resume reason
                            <input name="reason" required />
                          </label>
                          <button type="submit">Resume clock</button>
                        </form>
                      ) : null}

                      <form
                        action={completeDeadlineAction.bind(
                          null,
                          record.id,
                          deadline.id,
                        )}
                      >
                        <label>
                          Completion reason
                          <input name="reason" required />
                        </label>
                        <button type="submit">Complete deadline</button>
                      </form>

                      <form
                        action={cancelDeadlineAction.bind(
                          null,
                          record.id,
                          deadline.id,
                        )}
                      >
                        <label>
                          Cancellation reason
                          <input name="reason" required />
                        </label>
                        <button type="submit">Cancel deadline</button>
                      </form>
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </section>
      ) : null}

      {canAssign ? (
        <section>
          <h2>Assignment</h2>

          <form action={manualAssignCaseAction.bind(null, record.id)}>
            <label>
              Queue
              <select
                name="queueId"
                defaultValue={record.assignedQueueId ?? ""}
              >
                <option value="">No queue</option>
                {queues
                  .filter((queue) => queue.status === "active")
                  .map((queue) => (
                    <option key={queue.id} value={queue.id}>
                      {queue.name} ({queue.assignmentStrategy})
                    </option>
                  ))}
              </select>
            </label>

            <label>
              Assignee
              <select
                name="membershipId"
                defaultValue={record.assignedMembershipId ?? ""}
              >
                <option value="">Unassigned</option>
                {members.map((member) => (
                  <option
                    key={member.membershipId}
                    value={member.membershipId}
                  >
                    {member.displayName ?? member.email}
                    {member.title ? ` — ${member.title}` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Reason
              <input name="reason" />
            </label>

            <button type="submit">Save assignment</button>
          </form>

          {canApplyRouting ? (
            <form action={applyRoutingRulesAction.bind(null, record.id)}>
              <button type="submit">
                Apply routing rules now
              </button>
            </form>
          ) : null}

          <details>
            <summary>Escalate case</summary>
            <form action={escalateCaseAction.bind(null, record.id)}>
              <label>
                Escalation reason
                <textarea name="reason" rows={3} required />
              </label>

              <label>
                Escalation queue (optional)
                <select name="targetQueueId" defaultValue="">
                  <option value="">Keep current queue</option>
                  {queues
                    .filter((queue) => queue.status === "active")
                    .map((queue) => (
                      <option key={queue.id} value={queue.id}>
                        {queue.name}
                      </option>
                    ))}
                </select>
              </label>

              <label>
                Priority (optional)
                <select name="priority" defaultValue="">
                  <option value="">Keep current priority</option>
                  {casePriorities.map((priority) => (
                    <option key={priority} value={priority}>
                      {priority}
                    </option>
                  ))}
                </select>
              </label>

              <button type="submit">Escalate</button>
            </form>
          </details>
        </section>
      ) : null}

      <section>
        <h2>Assignment history</h2>
        {assignmentHistory.length === 0 ? (
          <p>No assignment changes have been recorded.</p>
        ) : (
          <ol>
            {assignmentHistory.map((entry) => (
              <li key={entry.id}>
                {entry.createdAt.toISOString()}:{" "}
                {queueLabel(entry.fromQueueId)} /{" "}
                {memberLabel(entry.fromMembershipId)}
                {" → "}
                {queueLabel(entry.toQueueId)} /{" "}
                {memberLabel(entry.toMembershipId)}
                {" — "}
                {entry.source}
                {entry.reason ? ` — ${entry.reason}` : ""}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2>Documents & evidence</h2>
        {visibleDocuments.length === 0 ? (
          <p>No visible documents are attached to this case.</p>
        ) : (
          visibleDocuments.map(({ link, document, version, type }) => {
            const historyForVersion =
              documentHistory.get(version.id);
            const downloadable =
              version.contentStatus === "available" &&
              version.malwareScanStatus === "clean";

            return (
              <article key={link.id}>
                <h3>
                  {document.title} — version {version.versionNumber}
                </h3>
                <dl>
                  <dt>Type</dt>
                  <dd>
                    {type.name} (<code>{type.key}</code>)
                  </dd>
                  <dt>Filename</dt>
                  <dd>{version.originalFilename}</dd>
                  <dt>MIME type</dt>
                  <dd>{version.mimeType}</dd>
                  <dt>Size</dt>
                  <dd>{version.sizeBytes} bytes</dd>
                  <dt>SHA-256</dt>
                  <dd><code>{version.sha256}</code></dd>
                  <dt>Visibility</dt>
                  <dd>{document.visibility}</dd>
                  <dt>Content status</dt>
                  <dd>{version.contentStatus}</dd>
                  <dt>Malware scan</dt>
                  <dd>
                    {version.malwareScanStatus}
                    {version.malwareScanProvider
                      ? ` — ${version.malwareScanProvider}`
                      : ""}
                  </dd>
                  <dt>Evidence description</dt>
                  <dd>{link.evidenceDescription ?? "—"}</dd>
                  <dt>Source</dt>
                  <dd>{link.sourceDescription ?? "—"}</dd>
                  <dt>Exhibit</dt>
                  <dd>{link.exhibitLabel ?? "—"}</dd>
                </dl>

                {downloadable ? (
                  <p>
                    <a
                      href={`/api/documents/${version.id}/download`}
                    >
                      Download verified content
                    </a>
                  </p>
                ) : (
                  <p>
                    Content is not downloadable until the exact version is
                    malware-scan clean and available.
                  </p>
                )}

                {canManageScan ? (
                  <details>
                    <summary>Record malware-scan result</summary>
                    <form
                      action={recordDocumentScanAction.bind(
                        null,
                        record.id,
                        version.id,
                      )}
                    >
                      <label>
                        Status
                        <select
                          name="status"
                          defaultValue={version.malwareScanStatus}
                        >
                          <option value="pending">pending</option>
                          <option value="clean">clean</option>
                          <option value="infected">infected</option>
                          <option value="failed">failed</option>
                        </select>
                      </label>
                      <label>
                        Scanner/provider
                        <input
                          name="provider"
                          defaultValue={
                            version.malwareScanProvider ??
                            "manual-record"
                          }
                          required
                        />
                      </label>
                      <button type="submit">Record scan result</button>
                    </form>
                  </details>
                ) : null}

                {canManageCustody ? (
                  <details>
                    <summary>Record custody event</summary>
                    <form
                      action={recordDocumentCustodyAction.bind(
                        null,
                        record.id,
                        version.id,
                      )}
                    >
                      <label>
                        Action
                        <input name="action" required />
                      </label>
                      <label>
                        From custodian
                        <input name="fromCustodian" />
                      </label>
                      <label>
                        To custodian
                        <input name="toCustodian" />
                      </label>
                      <label>
                        Location
                        <input name="location" />
                      </label>
                      <label>
                        Note
                        <textarea name="note" rows={2} />
                      </label>
                      <button type="submit">Record custody event</button>
                    </form>
                  </details>
                ) : null}

                <details>
                  <summary>Custody history</summary>
                  {historyForVersion?.custody.length ? (
                    <ol>
                      {historyForVersion.custody.map((event) => (
                        <li key={event.id}>
                          {event.occurredAt.toISOString()}:{" "}
                          {event.action}
                          {event.fromCustodian
                            ? ` from ${event.fromCustodian}`
                            : ""}
                          {event.toCustodian
                            ? ` to ${event.toCustodian}`
                            : ""}
                          {event.location
                            ? ` at ${event.location}`
                            : ""}
                          {event.note ? ` — ${event.note}` : ""}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p>No custody events recorded.</p>
                  )}
                </details>

                {canViewAccessHistory ? (
                  <details>
                    <summary>Access history</summary>
                    {historyForVersion?.access.length ? (
                      <ol>
                        {historyForVersion.access.map((event) => (
                          <li key={event.id}>
                            {event.createdAt.toISOString()}:{" "}
                            {event.action}
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p>No access events recorded.</p>
                    )}
                  </details>
                ) : null}
              </article>
            );
          })
        )}

        {canUploadDocuments ? (
          documentTypes.filter((type) => type.status === "active").length >
          0 ? (
            <details>
              <summary>Upload case document</summary>
              <form
                action={`/api/cases/${record.id}/documents`}
                method="post"
                encType="multipart/form-data"
              >
                <label>
                  Document type
                  <select
                    name="documentTypeId"
                    defaultValue=""
                    required
                  >
                    <option value="" disabled>
                      Select type
                    </option>
                    {documentTypes
                      .filter((type) => type.status === "active")
                      .map((type) => (
                        <option key={type.id} value={type.id}>
                          {type.name} ({type.key})
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  File
                  <input name="file" type="file" required />
                </label>
                <label>
                  Title
                  <input name="title" />
                </label>
                <label>
                  Description
                  <textarea name="description" rows={2} />
                </label>
                <label>
                  Visibility
                  <select name="visibility" defaultValue="internal">
                    <option value="participant">participant</option>
                    <option value="internal">internal</option>
                    <option value="restricted">restricted</option>
                  </select>
                </label>
                <label>
                  Evidence description
                  <textarea name="evidenceDescription" rows={2} />
                </label>
                <label>
                  Source description
                  <textarea name="sourceDescription" rows={2} />
                </label>
                <label>
                  Exhibit label
                  <input name="exhibitLabel" />
                </label>
                <button type="submit">Upload and quarantine</button>
              </form>
            </details>
          ) : (
            <p>
              Create an active document type before uploading evidence.
            </p>
          )
        ) : null}
      </section>

      {canUpdate ? (
        <section>
          <h2>Case metadata</h2>
          <form action={updateCaseMetadataAction.bind(null, record.id)}>
            <label>
              Title
              <input name="title" required defaultValue={record.title} />
            </label>

            <label>
              Summary
              <textarea
                name="summary"
                rows={5}
                defaultValue={record.summary ?? ""}
              />
            </label>

            <label>
              Priority
              <select name="priority" defaultValue={record.priority}>
                {casePriorities.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Disposition
              <input
                name="disposition"
                defaultValue={record.disposition ?? ""}
              />
            </label>

            <label>
              Tags (comma-separated)
              <input
                name="tags"
                defaultValue={tags.map((tag) => tag.tag).join(", ")}
              />
            </label>

            <button type="submit">Save case metadata</button>
          </form>
        </section>
      ) : null}

      {transitions.length > 0 ? (
        <section>
          <h2>Workflow transition</h2>
          <form action={transitionCaseAction.bind(null, record.id)}>
            <label>
              Transition
              <select name="transitionKey" required defaultValue="">
                <option value="" disabled>
                  Select transition
                </option>
                {transitions.map((transition) => {
                  const target = findWorkflowState(
                    workflow,
                    transition.to,
                  );
                  return (
                    <option
                      key={transition.key}
                      value={transition.key}
                    >
                      {transition.label} →{" "}
                      {target?.label ?? transition.to}
                    </option>
                  );
                })}
              </select>
            </label>

            <label>
              Transition comment
              <textarea name="comment" rows={3} />
            </label>

            <label>
              Proposed disposition (optional)
              <input
                name="disposition"
                defaultValue={record.disposition ?? ""}
              />
            </label>

            <button type="submit">Apply transition</button>
          </form>

          <details>
            <summary>Transition requirements</summary>
            {transitions.map((transition) => (
              <article key={transition.key}>
                <h3>{transition.label}</h3>
                <p>
                  Comment: {transition.comment}. Required permissions:{" "}
                  {transition.requiredPermissions.join(", ")}.
                </p>
                {transition.guards.requiredCaseFields.length > 0 ? (
                  <p>
                    Required case fields:{" "}
                    {transition.guards.requiredCaseFields.join(", ")}.
                  </p>
                ) : null}
                {transition.guards.requiredSubmissionFields.length > 0 ? (
                  <p>
                    Required submission fields:{" "}
                    {transition.guards.requiredSubmissionFields.join(", ")}.
                  </p>
                ) : null}
                {transition.guards.requiredDocuments.length > 0 ? (
                  <p>
                    Required documents:{" "}
                    {transition.guards.requiredDocuments
                      .map(
                        (document) =>
                          `${document.type} × ${document.minCount}`,
                      )
                      .join(", ")}.
                  </p>
                ) : null}
              </article>
            ))}
          </details>
        </section>
      ) : null}

      {canViewReviews || canFileReviews ? (
        <CaseReviewsPanel
          caseId={record.id}
          currentCaseStatus={record.status}
          reviews={reviews}
          history={reviewHistory}
          policies={reviewPolicies}
          members={members}
          eligibleReviewers={eligibleReviewers}
          workflowStates={workflow.states}
          currentMembershipId={context.membership?.id ?? null}
          currentUserId={context.user.id}
          canFile={canFileReviews}
          canAssign={canAssignReviews}
          canDecide={canDecideReviews}
          canManage={canManageReviews}
          canApplyCaseEffect={canApplyReviewEffect}
        />
      ) : null}

      <CaseTimelinePanel items={timeline} />

      <section>
        <h2>Status history</h2>
        <ol>
          {history.map((entry) => (
            <li key={entry.id}>
              {entry.createdAt.toISOString()}:{" "}
              {entry.fromStatus ?? "created"} → {entry.toStatus}
              {entry.transitionKey
                ? ` [${entry.transitionKey}]`
                : ""}
              {entry.note ? ` — ${entry.note}` : ""}
            </li>
          ))}
        </ol>
      </section>

      {canViewProtectedMetadata && record.sourceSubmissionId ? (
        <CaseProtectedDataPanel
          caseId={record.id}
          compartments={protectedCompartments}
          requests={protectedRevealRequests}
          currentUserId={context.user.id}
          canRequest={canRequestProtectedReveal}
          canApprove={canApproveProtectedReveal}
        />
      ) : null}

      {source ? (
        <section>
          <h2>Source intake</h2>
          <p>
            {source.formName} · version {source.formVersion} · submitted{" "}
            {source.submittedAt?.toISOString() ?? "unknown"}
          </p>
          <p>Confirmation: {source.confirmationCode ?? "—"}</p>
          <pre>{JSON.stringify(source.answers, null, 2)}</pre>
          {sealedSummary ? (
            <SealedAnswersPanel
              submissionId={source.submissionId}
              summary={sealedSummary}
            />
          ) : null}
        </section>
      ) : record.sourceSubmissionId ? (
        <section>
          <h2>Source intake</h2>
          <p>
            Source submission details require the submission:view
            permission.
          </p>
        </section>
      ) : null}
    </main>
  );
}
