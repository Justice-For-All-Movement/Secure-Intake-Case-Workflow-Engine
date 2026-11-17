import { isIP } from "node:net";
import { z } from "zod";
import type {
  CommunicationDeliveryRequest,
  CommunicationTransport,
} from "@/modules/communications/transport";
import type {
  NotificationDeliveryRequest,
  NotificationTransport,
} from "@/modules/notifications/transport";

/**
 * Provider-neutral outbound email over an HTTPS JSON API.
 *
 * Request (one per message):
 *   POST EMAIL_HTTP_URL
 *   Authorization: Bearer EMAIL_HTTP_TOKEN        (when set)
 *   Idempotency-Key: <stable delivery or message id>
 *   {"from": EMAIL_FROM, "to": [...], "cc"?: [...], "bcc"?: [...],
 *    "subject": "...", "text": "...", "reply_to"?: "..."}
 * Any 2xx answer is a successful hand-off; an `id` string in a JSON body is
 * stored as the provider message id. Any other answer, a redirect, a timeout
 * or an oversized body is a failure. Upstream bodies are never stored or
 * logged. This shape matches common transactional email APIs (for example
 * Resend's `POST /emails`), and a small relay can adapt any other provider.
 */

const emailAddress = z.string().trim().email().max(320);

export class EmailConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigurationError";
  }
}

export interface HttpEmailConfig {
  endpoint: URL;
  token: string | null;
  from: string;
  provider: string;
  timeoutMs: number;
}

export interface HttpEmailMessage {
  idempotencyKey: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  replyTo?: string | null;
}

type EnvironmentSource = Record<string, string | undefined>;

function isLoopbackHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."))
  );
}

/** Accepts `addr@example.org` or `Display Name <addr@example.org>`. */
export function parseSenderAddress(value: string): string {
  const trimmed = value.trim();
  const named = /^([^<>\r\n]{1,200})<([^<>\s]+)>$/.exec(trimmed);
  const address = named ? named[2] : trimmed;
  if (!emailAddress.safeParse(address).success || /[\r\n]/.test(trimmed)) {
    throw new EmailConfigurationError(
      "EMAIL_FROM must be an email address or `Name <address>`.",
    );
  }
  return trimmed;
}

/**
 * Reads the email configuration. Returns null when outbound email is not
 * enabled (`EMAIL_TRANSPORT_DRIVER` unset or `none`); throws a categorical
 * error (never echoing a value) when it is enabled but incomplete or unsafe.
 */
export function emailConfigFromEnvironment(
  source: EnvironmentSource = process.env,
): HttpEmailConfig | null {
  const driver = (source.EMAIL_TRANSPORT_DRIVER ?? "").trim().toLowerCase();
  if (!driver || driver === "none") return null;
  if (driver !== "http") {
    throw new EmailConfigurationError(
      "EMAIL_TRANSPORT_DRIVER must be `http` or `none`.",
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(source.EMAIL_HTTP_URL ?? "");
  } catch {
    throw new EmailConfigurationError("EMAIL_HTTP_URL must be an absolute URL.");
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !(
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" && isLoopbackHost(endpoint.hostname))
    )
  ) {
    throw new EmailConfigurationError(
      "EMAIL_HTTP_URL must be HTTPS (plain HTTP only on loopback) without credentials, query or fragment.",
    );
  }

  const from = parseSenderAddress(source.EMAIL_FROM ?? "");
  const token = source.EMAIL_HTTP_TOKEN?.trim() || null;
  if (token && (token.length > 4096 || /[\s]/.test(token))) {
    throw new EmailConfigurationError("EMAIL_HTTP_TOKEN is malformed.");
  }

  const timeoutMs = Number(source.EMAIL_HTTP_TIMEOUT_MS ?? "30000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    throw new EmailConfigurationError(
      "EMAIL_HTTP_TIMEOUT_MS must be between 1000 and 300000.",
    );
  }

  const provider = (source.EMAIL_PROVIDER ?? "http-email").trim();
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(provider)) {
    throw new EmailConfigurationError("EMAIL_PROVIDER must be a short identifier.");
  }

  return { endpoint, token, from, provider, timeoutMs };
}

const MAX_RESPONSE_BYTES = 64 * 1024;

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Email provider response exceeds 64 KiB.");
    }
    chunks.push(Buffer.from(value));
  }
  if (length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export class HttpEmailSender {
  constructor(
    readonly config: HttpEmailConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  get provider() {
    return this.config.provider;
  }

  async send(message: HttpEmailMessage): Promise<{ externalMessageId: string | null }> {
    const clean = (list: string[] | undefined) =>
      (list ?? []).map((address) => {
        const parsed = emailAddress.safeParse(address);
        if (!parsed.success) throw new Error("Email recipient is invalid.");
        return parsed.data.toLowerCase();
      });
    const to = clean(message.to);
    const cc = clean(message.cc);
    const bcc = clean(message.bcc);
    if (to.length + cc.length + bcc.length === 0) {
      throw new Error("Email has no recipients.");
    }
    if (to.length + cc.length + bcc.length > 50) {
      throw new Error("Email has too many recipients.");
    }
    const subject = message.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 998);
    if (!subject) throw new Error("Email subject is empty.");
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(message.idempotencyKey)) {
      throw new Error("Email idempotency key is invalid.");
    }
    const replyTo = message.replyTo
      ? emailAddress.safeParse(message.replyTo).data ?? null
      : null;

    const body: Record<string, unknown> = {
      from: this.config.from,
      to: to.length ? to : undefined,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject,
      text: message.text,
      reply_to: replyTo ?? undefined,
    };

    let response: Response;
    try {
      response = await this.fetcher(this.config.endpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "idempotency-key": message.idempotencyKey,
          ...(this.config.token
            ? { authorization: `Bearer ${this.config.token}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        error instanceof Error && error.name === "TimeoutError"
          ? "Email provider request timed out."
          : "Email provider could not be reached.",
      );
    }

    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Email provider returned HTTP ${response.status}.`);
    }

    const parsed = (await readBoundedJson(response)) as { id?: unknown } | null;
    const id =
      parsed && typeof parsed.id === "string" && /^[\x21-\x7e]{1,200}$/.test(parsed.id)
        ? parsed.id
        : null;
    return { externalMessageId: id };
  }
}

/** `notification.deliver` email channel. */
export function createEmailNotificationTransport(
  sender: HttpEmailSender,
): NotificationTransport {
  return {
    provider: sender.provider,
    channel: "email",
    async send(request: NotificationDeliveryRequest) {
      const lines = [request.body];
      if (request.link) {
        lines.push("", request.link);
      }
      return sender.send({
        idempotencyKey: `notification-${request.idempotencyKey}`,
        to: [request.destination],
        subject: request.title,
        text: lines.join("\n"),
      });
    },
  };
}

/** `correspondence.deliver` for the email channel. */
export function createEmailCommunicationTransport(
  sender: HttpEmailSender,
): CommunicationTransport {
  return {
    provider: sender.provider,
    supportedChannels: ["email"],
    async send(request: CommunicationDeliveryRequest) {
      if (request.attachments.length > 0) {
        // Never send an incomplete message silently: staff deliver
        // correspondence with attachments through another channel.
        throw new Error("The email transport does not send attachments.");
      }
      const of = (type: "to" | "cc" | "bcc") =>
        request.recipients
          .filter((recipient) => recipient.type === type)
          .map((recipient) => recipient.address);
      const result = await sender.send({
        idempotencyKey: `correspondence-${request.idempotencyKey}`,
        to: of("to"),
        cc: of("cc"),
        bcc: of("bcc"),
        subject: request.subject ?? "(no subject)",
        text: request.body,
        replyTo: request.senderAddress,
      });
      return { externalMessageId: result.externalMessageId };
    },
  };
}
