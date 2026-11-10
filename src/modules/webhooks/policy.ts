import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const eventTypePattern = /^[a-z0-9_.:-]+$/i;

function normalizedHostname(value: string) {
  return value
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

export function normalizeWebhookEventTypes(
  values: readonly string[],
) {
  const types = [
    ...new Set(
      values.map((value) => value.trim()).filter(Boolean),
    ),
  ];

  if (types.length < 1 || types.length > 50) {
    throw new Error("Webhook requires 1-50 event types.");
  }
  for (const type of types) {
    if (
      type !== "*" &&
      (type.length > 200 || !eventTypePattern.test(type))
    ) {
      throw new Error("Webhook event type is invalid.");
    }
  }
  return types.sort();
}

/**
 * Exact origins (comma separated, e.g. `http://127.0.0.1:8090`) that an
 * operator has explicitly approved as webhook destinations even though they
 * are private or plain HTTP: a co-located downstream application. Everything
 * else must be public HTTPS.
 */
export function allowedPrivateWebhookOrigins(): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const raw of (process.env.WEBHOOK_ALLOWED_PRIVATE_ORIGINS ?? "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password
      ) {
        origins.add(url.origin);
      }
    } catch {
      // Ignore malformed entries: they approve nothing.
    }
  }
  return origins;
}

export function normalizeWebhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Webhook URL is invalid.");
  }

  if (
    !url.username &&
    !url.password &&
    allowedPrivateWebhookOrigins().has(url.origin)
  ) {
    url.hash = "";
    return url.toString();
  }

  if (url.protocol !== "https:") {
    throw new Error("Webhook URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Webhook URL cannot contain credentials.");
  }
  if (url.port && url.port !== "443") {
    throw new Error("Webhook URL must use the standard HTTPS port.");
  }

  const hostname = normalizedHostname(url.hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Webhook URL cannot target a local hostname.");
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error("Webhook URL cannot target a private address.");
  }

  url.hash = "";
  return url.toString();
}

export async function assertWebhookDestinationPublic(
  endpointUrl: string,
) {
  const url = new URL(normalizeWebhookUrl(endpointUrl));
  if (allowedPrivateWebhookOrigins().has(url.origin)) return;
  const hostname = normalizedHostname(url.hostname);
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("Webhook destination is private.");
    }
    return;
  }

  const resolved = await lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0) {
    throw new Error("Webhook destination did not resolve.");
  }
  if (resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error(
      "Webhook destination resolved to a private or local address.",
    );
  }
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/%.*$/, "");

  if (normalized.includes(":")) {
    const words = parseIpv6Words(normalized);
    if (!words) return true;

    const isUnspecified = words.every((word) => word === 0);
    const isLoopback =
      words.slice(0, 7).every((word) => word === 0) &&
      words[7] === 1;
    if (isUnspecified || isLoopback) return true;

    const isIpv4Mapped =
      words.slice(0, 5).every((word) => word === 0) &&
      words[5] === 0xffff;
    if (isIpv4Mapped) {
      return isPrivateAddress(
        [
          words[6] >> 8,
          words[6] & 0xff,
          words[7] >> 8,
          words[7] & 0xff,
        ].join("."),
      );
    }

    const first = words[0];
    const second = words[1];

    // Only ordinary global-unicast IPv6 is eligible for webhook egress.
    // This excludes ULA/link-local/multicast/NAT64/IPv4-compatible and
    // other special-purpose ranges outside 2000::/3.
    if ((first & 0xe000) !== 0x2000) return true;

    // Documentation, tunneling/transition, benchmarking, and ORCHID
    // ranges are not eligible webhook destinations.
    if (
      (first === 0x2001 && second === 0x0db8) ||
      (first === 0x2001 && second === 0x0000) ||
      (first === 0x2001 && second === 0x0002) ||
      (first === 0x2001 &&
        ((second & 0xfff0) === 0x0010 ||
          (second & 0xfff0) === 0x0020)) ||
      first === 0x2002
    ) {
      return true;
    }

    return false;
  }

  const parts = normalized.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6Words(address: string): number[] | null {
  let normalized = address;

  const embeddedIpv4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(
    normalized,
  );
  if (embeddedIpv4) {
    const octets = embeddedIpv4[2].split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some(
        (octet) =>
          !Number.isInteger(octet) || octet < 0 || octet > 255,
      )
    ) {
      return null;
    }
    normalized =
      embeddedIpv4[1] +
      ((octets[0] << 8) | octets[1]).toString(16) +
      ":" +
      ((octets[2] << 8) | octets[3]).toString(16);
  }

  if ((normalized.match(/::/g) ?? []).length > 1) return null;

  const hasCompression = normalized.includes("::");
  const [headRaw, tailRaw = ""] = normalized.split("::");
  const head = headRaw ? headRaw.split(":") : [];
  const tail = tailRaw ? tailRaw.split(":") : [];

  if (
    [...head, ...tail].some(
      (part) =>
        !/^[0-9a-f]{1,4}$/i.test(part) ||
        Number.parseInt(part, 16) > 0xffff,
    )
  ) {
    return null;
  }

  if (!hasCompression && head.length !== 8) return null;

  const missing = 8 - head.length - tail.length;
  if (hasCompression && missing < 1) return null;

  const words = [
    ...head.map((part) => Number.parseInt(part, 16)),
    ...Array(hasCompression ? missing : 0).fill(0),
    ...tail.map((part) => Number.parseInt(part, 16)),
  ];

  return words.length === 8 ? words : null;
}
