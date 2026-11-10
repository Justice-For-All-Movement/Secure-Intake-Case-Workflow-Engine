import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");
export const baseUrl = () => process.env.IT_BASE_URL as string;

export interface ApiResponse {
  status: number;
  headers: Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
}

export async function api(
  token: string | null,
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  const response = await fetch(`${baseUrl()}/api/v1${pathname}`, {
    method,
    redirect: "manual",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // binary or empty
  }
  return {
    status: response.status,
    headers: response.headers,
    body: parsed,
    text,
  };
}

/** Runs the real worker script until it has nothing left to claim. */
export async function runWorker(
  overrides: Record<string, string> = {},
  maxIterations = 12,
) {
  const serverEnv = JSON.parse(process.env.IT_SERVER_ENV as string);
  let total = { claimed: 0, succeeded: 0, failed: 0 };
  for (let index = 0; index < maxIterations; index += 1) {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        path.join(root, "node_modules/.bin/tsx"),
        ["scripts/run-worker.ts", "--once"],
        {
          cwd: root,
          env: { ...process.env, ...serverEnv, ...overrides },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve(stdout)
          : reject(new Error(`worker exited ${code}: ${stderr}`)),
      );
    });
    const match = /claimed=(\d+) succeeded=(\d+) failed=(\d+)/.exec(output);
    if (!match) throw new Error(`Unexpected worker output: ${output}`);
    total = {
      claimed: total.claimed + Number(match[1]),
      succeeded: total.succeeded + Number(match[2]),
      failed: total.failed + Number(match[3]),
    };
    if (Number(match[1]) === 0) break;
  }
  return total;
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(300);
  }
}

export interface FeedEvent {
  id: string;
  cursor: string;
  sequence: number;
  type: string;
  action: string;
  resource: {
    type: string;
    id: string;
    parentType: string | null;
    parentId: string | null;
  };
  newState: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

export async function allEvents(token: string): Promise<FeedEvent[]> {
  const events: FeedEvent[] = [];
  let after: string | null = null;
  for (;;) {
    const page: ApiResponse = await api(
      token,
      "GET",
      `/events?limit=500${after ? `&after=${after}` : ""}`,
    );
    if (page.status !== 200) throw new Error(`events: ${page.text}`);
    events.push(...page.body.data);
    if (!page.body.cursor.hasMore) return events;
    after = page.body.cursor.next;
  }
}

export async function waitForEvent(
  token: string,
  predicate: (event: FeedEvent) => boolean,
  what: string,
) {
  return until(
    async () => (await allEvents(token)).find(predicate),
    `event ${what}`,
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Playwright is provided by the environment, not by this package, so it is
 * loaded dynamically and typed loosely. Returns null when unavailable.
 */
export function loadPlaywright(): { chromium: { launch: () => Promise<any> } } | null {
  try {
    return createRequire(import.meta.url)("playwright");
  } catch {
    return null;
  }
}
