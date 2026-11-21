import type { SealedEnvelopeSummary } from "@/modules/sealed/service";

/**
 * Sealed answers were encrypted in the participant's browser to the research
 * team's keys. This application cannot read them, so staff see only that
 * they exist and can download the encrypted file — never any plaintext.
 */
export function SealedAnswersPanel({
  submissionId,
  summary,
}: {
  submissionId: string;
  summary: SealedEnvelopeSummary;
}) {
  return (
    <section aria-labelledby="sealed-answers-heading" data-testid="sealed-answers">
      <h3 id="sealed-answers-heading">Sealed answers</h3>
      <p>
        Sealed answers — readable only in PAM (Sealed sources) or with the
        offline sealed reader. They were encrypted on the participant&apos;s
        device; this service holds only the encrypted file and cannot open it.
      </p>
      <dl>
        <dt>Received</dt>
        <dd>{summary.receivedAt.toISOString()}</dd>
        <dt>Fingerprint (commitment)</dt>
        <dd>
          <code>{summary.commitment}</code>
        </dd>
        <dt>Sealed for</dt>
        <dd>
          {summary.recipientKeyIds.length} key
          {summary.recipientKeyIds.length === 1 ? "" : "s"}
        </dd>
        <dt>Size</dt>
        <dd>{summary.sizeBytes} bytes</dd>
      </dl>
      <p>
        <a
          href={`/admin/sealed/${encodeURIComponent(submissionId)}`}
          download
        >
          Download sealed file
        </a>
      </p>
    </section>
  );
}
