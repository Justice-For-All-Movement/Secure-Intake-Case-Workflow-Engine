/** Read-only, fail-closed release and database readiness smoke check. Node >=22. */
export function canonicalBaseUrl(input) {
  const u = new URL(input);
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.pathname !== "/" || u.search || u.hash || !u.hostname || u.hostname === "localhost") {
    throw new Error("Smoke-check base URL must be a canonical HTTPS origin without credentials, port or path.");
  }
  return u.origin;
}
export async function probePublicService(baseUrl, fetcher = fetch, expectedVersion, timeoutMs = 45000) {
  const origin = canonicalBaseUrl(baseUrl);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error("Smoke-check timeout must be between 1000 and 60000 milliseconds.");
  }
  if (expectedVersion !== undefined && (typeof expectedVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$/.test(expectedVersion))) {
    throw new Error("Expected engine version must be a valid package version.");
  }
  const results = [];
  for (const [path, expectedCheck, expectedStatus] of [
    ["/api/health", "liveness", "ok"],
    ["/api/ready", "readiness", "ready"]
  ]) {
    const response = await fetcher(origin + path, {
      method: "GET", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs)
    });
    // /api/ready returns a deliberately coarse public database status even on HTTP 503.
    // Read only a bounded known enum; never echo arbitrary response text or hidden database errors.
    const value = await response.json().catch(() => null);
    const databaseHint = path === "/api/ready" &&
      ["unconfigured", "unavailable"].includes(value?.checks?.database)
        ? " database=" + value.checks.database
        : "";
    if (!response.ok || !value || value.status !== expectedStatus || value.check !== expectedCheck ||
        typeof value.version !== "string" || !value.version) {
      throw new Error(path + " did not satisfy the " + expectedCheck + " contract (HTTP " + response.status + databaseHint + ").");
    }
    if (path === "/api/ready" && value.checks?.database !== "ok") {
      throw new Error("Database readiness probe did not return ok.");
    }
    if (expectedVersion && value.version !== expectedVersion) {
      throw new Error(path + " reports version " + value.version + "; expected deployed version " + expectedVersion + ".");
    }
    results.push({ path, httpStatus: response.status, check: expectedCheck, version: value.version });
  }
  if (results[0].version !== results[1].version) throw new Error("Version mismatch between health and readiness.");
  return { origin, checks: results, status: "smoke_verified", checkedAt: new Date().toISOString() };
}
/**
 * A free hosting tier may stop an idle service; the first request then waits
 * for a cold start that can exceed one request timeout. Wake the service with
 * bounded liveness requests before the strict probe. Only transport failures
 * (timeouts, resets) and gateway statuses 502/503/504 are retried; any other
 * answer ends the wake phase and the strict probe judges it. A service that is
 * still not answering after every attempt is reported as unreachable.
 */
export async function wakePublicService(baseUrl, fetcher = fetch, options = {}) {
  const origin = canonicalBaseUrl(baseUrl);
  const attempts = options.attempts ?? 4;
  const timeoutMs = options.timeoutMs ?? 45000;
  const delayMs = options.delayMs ?? 15000;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("Wake attempts must be between 1 and 10.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error("Smoke-check timeout must be between 1000 and 60000 milliseconds.");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60000) {
    throw new Error("Wake delay must be between 0 and 60000 milliseconds.");
  }
  let last = "no response";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(origin + "/api/health", {
        method: "GET", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs)
      });
      await response.body?.cancel().catch(() => {});
      if (![502, 503, 504].includes(response.status)) return { origin, attempts: attempt };
      last = "HTTP " + response.status;
    } catch (error) {
      // Report only the category: never echo upstream bodies or local details.
      last = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "transport error";
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error("Service did not answer after " + attempts + " wake attempts (" + last + ").");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error("Usage: node scripts/probe-public.mjs https://YOUR-AUTHORIZED-SERVICE");
    process.exitCode = 2;
  } else {
    const wakeAttempts = Number(process.env.PROBE_WAKE_ATTEMPTS || "1");
    wakePublicService(baseUrl, fetch, { attempts: wakeAttempts })
      .then(() => probePublicService(baseUrl, fetch, process.env.EXPECTED_ENGINE_VERSION || undefined)).then(result => console.log(JSON.stringify(result))).catch(error => {
      console.error("Smoke check failed: " + (error instanceof Error ? error.message : "unknown error"));
      process.exitCode = 1;
    });
  }
}
