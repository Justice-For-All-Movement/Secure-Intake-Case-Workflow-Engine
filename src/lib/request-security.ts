import { env } from "@/lib/env";

export function trustedApplicationOrigin(): string {
  return new URL(env.APP_BASE_URL).origin;
}

/** The application's own origins: its web address and, when configured, its Tor onion address. */
export function trustedApplicationOrigins(): string[] {
  return [trustedApplicationOrigin(), ...(env.ONION_ORIGIN ? [env.ONION_ORIGIN] : [])];
}

export function isTrustedBrowserMutation(request: Request): boolean {
  const expected = trustedApplicationOrigins();
  const fetchSite = request.headers.get("sec-fetch-site");

  if (fetchSite === "cross-site") {
    return false;
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return expected.includes(new URL(origin).origin);
    } catch {
      return false;
    }
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return expected.includes(new URL(referer).origin);
    } catch {
      return false;
    }
  }

  return false;
}

export function rejectUntrustedBrowserMutation(
  request: Request,
): Response | null {
  if (isTrustedBrowserMutation(request)) return null;

  return Response.json(
    { error: "invalid_request_origin" },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
