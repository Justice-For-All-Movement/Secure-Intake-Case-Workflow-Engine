import { describe, expect, it } from "vitest";
import {
  nextScheduleRunAt,
  retryDelaySeconds,
} from "./backoff";

describe("background job timing", () => {
  it("uses capped exponential retry backoff", () => {
    expect(retryDelaySeconds(1)).toBe(5);
    expect(retryDelaySeconds(2)).toBe(10);
    expect(retryDelaySeconds(3)).toBe(20);
    expect(retryDelaySeconds(20)).toBe(900);
  });

  it("advances recurring schedules past missed intervals without replay storms", () => {
    expect(
      nextScheduleRunAt(
        new Date("2026-10-05T12:00:00Z"),
        60,
        new Date("2026-10-05T12:05:30Z"),
      ).toISOString(),
    ).toBe("2026-10-05T12:06:00.000Z");
  });
});

describe("bounded retry parameters", () => {
  it("caps huge retries without producing infinity", () => {
    expect(retryDelaySeconds(Number.MAX_SAFE_INTEGER)).toBe(900);
    expect(retryDelaySeconds(54)).toBe(900);
  });
  it("rejects non-finite and unsafe configuration", () => {
    for (const bad of [Infinity, Number.MAX_SAFE_INTEGER + 1, 0, -1]) {
      expect(() => retryDelaySeconds(bad)).toThrow();
    }
    expect(() => retryDelaySeconds(2, {maxSeconds: Infinity})).toThrow();
    expect(() => retryDelaySeconds(2, {baseSeconds: 0})).toThrow();
    expect(() => nextScheduleRunAt(new Date(), Number.MAX_SAFE_INTEGER, new Date())).toThrow();
  });
});
