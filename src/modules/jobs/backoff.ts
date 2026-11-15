export function retryDelaySeconds(
  attemptNumber: number,
  options: { baseSeconds?: number; maxSeconds?: number } = {},
): number {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("Attempt number must be a positive integer.");
  }

  const base = options.baseSeconds ?? 5;
  const max = options.maxSeconds ?? 900;
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(max) || base < 1 || max < base) {
    throw new Error("Retry backoff configuration is invalid.");
  }

  return attemptNumber > 53 ? max : Math.min(max, base * 2 ** (attemptNumber - 1));
}

export function nextScheduleRunAt(
  scheduledAt: Date,
  intervalSeconds: number,
  now: Date,
): Date {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 86400 * 365) {
    throw new Error("Schedule interval must be positive.");
  }

  const intervalMs = intervalSeconds * 1000;
  let next = scheduledAt.getTime() + intervalMs;

  if (next <= now.getTime()) {
    const missed =
      Math.floor((now.getTime() - next) / intervalMs) + 1;
    next += missed * intervalMs;
  }

  return new Date(next);
}
