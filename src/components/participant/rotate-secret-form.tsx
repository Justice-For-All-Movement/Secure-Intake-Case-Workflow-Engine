"use client";

import { useActionState } from "react";
import type { RotateSecretState } from "@/app/participant/[organizationSlug]/actions";

export function RotateSecretForm({
  action,
}: {
  action: (
    previous: RotateSecretState,
    formData: FormData,
  ) => Promise<RotateSecretState>;
}) {
  const [state, formAction, pending] = useActionState(action, {
    status: "idle",
  } as RotateSecretState);

  return (
    <section aria-labelledby="participant-secret-heading">
      <h2 id="participant-secret-heading">Access secret</h2>
      <p>
        If someone else may have seen your access secret, replace it. The old
        secret stops working immediately and other signed-in sessions are
        closed. A lost secret cannot be recovered by anyone, including staff.
      </p>
      <form action={formAction}>
        <button type="submit" disabled={pending} aria-disabled={pending}>
          Replace my access secret
        </button>
      </form>
      <div role="status" aria-live="polite">
        {state.status === "rotated" ? (
          <p>
            New access secret (shown only now):{" "}
            <code data-testid="rotated-secret">{state.accessSecret}</code>
          </p>
        ) : null}
        {state.status === "failed" ? (
          <p>The access secret could not be replaced. Sign in again.</p>
        ) : null}
      </div>
    </section>
  );
}
