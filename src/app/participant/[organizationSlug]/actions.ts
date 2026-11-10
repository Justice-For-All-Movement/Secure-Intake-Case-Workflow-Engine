"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getRuntimeDatabase } from "@/db/runtime";
import {
  LoginRateLimitError,
  trustedLoginSource,
} from "@/modules/auth/throttle";
import {
  authenticateExternalParticipant,
  ExternalParticipantAuthenticationError,
  logoutExternalParticipant,
  rotateExternalParticipantSecret,
  resolveExternalParticipantContext,
  sendExternalParticipantMessage,
} from "@/modules/participant-portal/service";
import {
  clearExternalParticipantSessionCookie,
  readExternalParticipantSessionToken,
  writeExternalParticipantSessionCookie,
} from "@/modules/participant-portal/server-session";

export async function externalParticipantLoginAction(
  organizationSlug: string,
  formData: FormData,
) {
  const trackingCode = String(
    formData.get("trackingCode") ?? "",
  ).trim();
  const accessSecret = String(
    formData.get("accessSecret") ?? "",
  ).trim();
  const requestHeaders = await headers();
  const source = trustedLoginSource(requestHeaders);

  try {
    const session = await authenticateExternalParticipant(
      getRuntimeDatabase(),
      {
        organizationSlug,
        confirmationCode: trackingCode,
        secret: accessSecret,
        source,
      },
    );
    await writeExternalParticipantSessionCookie(
      session.token,
      session.expiresAt,
    );
  } catch (error) {
    if (error instanceof LoginRateLimitError) {
      redirect(
        `/participant/${encodeURIComponent(
          organizationSlug,
        )}?error=rate_limited`,
      );
    }
    if (error instanceof ExternalParticipantAuthenticationError) {
      redirect(
        `/participant/${encodeURIComponent(
          organizationSlug,
        )}?error=invalid_credentials`,
      );
    }
    throw error;
  }

  redirect(
    `/participant/${encodeURIComponent(
      organizationSlug,
    )}/portal`,
  );
}

export async function externalParticipantLogoutAction(
  organizationSlug: string,
) {
  const token = await readExternalParticipantSessionToken();
  if (token) {
    await logoutExternalParticipant(getRuntimeDatabase(), {
      sessionToken: token,
    });
  }
  await clearExternalParticipantSessionCookie();
  redirect(
    `/participant/${encodeURIComponent(organizationSlug)}`,
  );
}

export async function externalParticipantMessageAction(
  organizationSlug: string,
  formData: FormData,
) {
  const token = await readExternalParticipantSessionToken();
  if (!token) {
    redirect(
      `/participant/${encodeURIComponent(
        organizationSlug,
      )}?error=session_required`,
    );
  }

  const context = await resolveExternalParticipantContext(
    getRuntimeDatabase(),
    {
      organizationSlug,
      sessionToken: token,
    },
  );
  if (!context) {
    await clearExternalParticipantSessionCookie();
    redirect(
      `/participant/${encodeURIComponent(
        organizationSlug,
      )}?error=session_required`,
    );
  }

  try {
    await sendExternalParticipantMessage(
      getRuntimeDatabase(),
      context,
      {
        threadId:
          String(formData.get("threadId") ?? "").trim() || null,
        subject:
          String(formData.get("subject") ?? "").trim() || null,
        body: String(formData.get("body") ?? ""),
      },
    );
  } catch {
    redirect(
      `/participant/${encodeURIComponent(
        organizationSlug,
      )}/portal?error=message_failed`,
    );
  }

  redirect(
    `/participant/${encodeURIComponent(
      organizationSlug,
    )}/portal?sent=1`,
  );
}

export interface RotateSecretState {
  status: "idle" | "rotated" | "failed";
  accessSecret?: string;
}

export async function externalParticipantRotateSecretAction(
  organizationSlug: string,
  _previous: RotateSecretState,
  _formData: FormData,
): Promise<RotateSecretState> {
  const token = await readExternalParticipantSessionToken();
  const context = token
    ? await resolveExternalParticipantContext(getRuntimeDatabase(), {
        organizationSlug,
        sessionToken: token,
      })
    : null;
  if (!context) return { status: "failed" };
  try {
    const rotated = await rotateExternalParticipantSecret(
      getRuntimeDatabase(),
      context,
    );
    return { status: "rotated", accessSecret: rotated.secret };
  } catch {
    return { status: "failed" };
  }
}
