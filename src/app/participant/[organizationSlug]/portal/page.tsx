import { RotateSecretForm } from "@/components/participant/rotate-secret-form";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRuntimeDatabase } from "@/db/runtime";
import { findApplicationProfileByOrganizationSlug } from "@/modules/application/repository";
import {
  readExternalParticipantSessionToken,
} from "@/modules/participant-portal/server-session";
import {
  listExternalParticipantMessages,
  resolveExternalParticipantContext,
} from "@/modules/participant-portal/service";
import {
  externalParticipantLogoutAction,
  externalParticipantRotateSecretAction,
  externalParticipantMessageAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default async function ExternalParticipantPortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string }>;
  searchParams: Promise<{
    error?: string;
    sent?: string;
  }>;
}) {
  const { organizationSlug } = await params;
  const { error, sent } = await searchParams;
  const db = getRuntimeDatabase();
  const token = await readExternalParticipantSessionToken();

  if (!token) {
    redirect(
      `/participant/${encodeURIComponent(
        organizationSlug,
      )}?error=session_required`,
    );
  }

  const context = await resolveExternalParticipantContext(db, {
    organizationSlug,
    sessionToken: token,
  });
  if (!context) {
    redirect(
      `/participant/${encodeURIComponent(
        organizationSlug,
      )}?error=session_required`,
    );
  }

  const [application, messages] = await Promise.all([
    findApplicationProfileByOrganizationSlug(
      db,
      organizationSlug,
    ),
    listExternalParticipantMessages(db, context),
  ]);

  const name =
    application?.profile?.applicationName ??
    context.organization.name;
  const threads = new Map<string, string>();
  for (const message of messages) {
    threads.set(
      message.threadId,
      message.threadSubject ??
        message.subject ??
        "Portal conversation",
    );
  }

  return (
    <main>
      <header>
        <h1>{name} participant portal</h1>
        <form
          action={externalParticipantLogoutAction.bind(
            null,
            organizationSlug,
          )}
        >
          <button type="submit">Sign out</button>
        </form>
      </header>

      <section aria-labelledby="participant-status-heading">
        <h2 id="participant-status-heading">Status</h2>
        <dl>
          <dt>Tracking code</dt>
          <dd>
            <code>{context.submission.confirmationCode}</code>
          </dd>
          <dt>Submitted</dt>
          <dd>
            {context.submission.submittedAt?.toISOString() ??
              "Recorded"}
          </dd>
          {context.case ? (
            <>
              <dt>Case number</dt>
              <dd>{context.case.caseNumber}</dd>
              <dt>Current status</dt>
              <dd>{context.case.statusLabel}</dd>
              <dt>Status last updated</dt>
              <dd>{context.case.updatedAt.toISOString()}</dd>
            </>
          ) : (
            <>
              <dt>Current status</dt>
              <dd>Submission received</dd>
            </>
          )}
        </dl>
      </section>

      <section aria-labelledby="participant-messages-heading">
        <h2 id="participant-messages-heading">Secure messages</h2>
        {sent === "1" ? (
          <p role="status">Your message was recorded.</p>
        ) : null}
        {error === "message_failed" ? (
          <p role="alert">
            The message could not be recorded. Check the message and try
            again.
          </p>
        ) : null}

        {messages.length === 0 ? (
          <p>No portal messages are available.</p>
        ) : (
          <ol>
            {messages.map((message) => (
              <li key={message.id}>
                <article>
                  <h3>
                    {message.subject ??
                      message.threadSubject ??
                      "Portal message"}
                  </h3>
                  <p>
                    <strong>
                      {message.direction === "outbound"
                        ? name
                        : "You"}
                    </strong>
                    {" · "}
                    {(
                      message.sentAt ??
                      message.receivedAt ??
                      message.createdAt
                    ).toISOString()}
                  </p>
                  <p>{message.body}</p>
                </article>
              </li>
            ))}
          </ol>
        )}

        {context.allowMessaging && context.case ? (
          <details>
            <summary>Send a secure message</summary>
            <form
              action={externalParticipantMessageAction.bind(
                null,
                organizationSlug,
              )}
            >
              {threads.size > 0 ? (
                <label>
                  Reply to an existing conversation (optional)
                  <select name="threadId" defaultValue="">
                    <option value="">Start a new conversation</option>
                    {[...threads.entries()].map(
                      ([threadId, label]) => (
                        <option key={threadId} value={threadId}>
                          {label}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              ) : null}
              <label>
                Subject (optional)
                <input name="subject" maxLength={500} />
              </label>
              <label>
                Message
                <textarea
                  name="body"
                  required
                  minLength={1}
                  maxLength={20000}
                  rows={8}
                />
              </label>
              <p>
                File attachments are not enabled in the participant portal
                yet.
              </p>
              <button type="submit">Send secure message</button>
            </form>
          </details>
        ) : context.allowMessaging ? (
          <p>
            Secure messaging will become available after the submission
            has been opened as a case.
          </p>
        ) : (
          <p>Secure messaging is not enabled for this submission.</p>
        )}
      </section>

      <RotateSecretForm
        action={externalParticipantRotateSecretAction.bind(
          null,
          organizationSlug,
        )}
      />
    </main>
  );
}
