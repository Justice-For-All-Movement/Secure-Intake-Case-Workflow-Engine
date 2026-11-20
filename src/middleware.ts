import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// When the application also runs as a Tor onion service (ONION_ORIGIN), every page served on the web address carries
// an Onion-Location header, so Tor Browser offers the onion address, which keeps a visit off the visitor's network.
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  const onion = process.env.ONION_ORIGIN;
  if (onion && /^http:\/\/[a-z2-7]{56}\.onion$/.test(onion) && !request.nextUrl.hostname.endsWith(".onion")) {
    response.headers.set("Onion-Location", `${onion}${request.nextUrl.pathname}${request.nextUrl.search}`);
  }
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
