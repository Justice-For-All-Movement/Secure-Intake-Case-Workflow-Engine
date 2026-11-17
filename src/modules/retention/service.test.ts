import { describe, expect, it } from "vitest";
import {
  retentionCutoffs,
  retentionPolicyFromEnvironment,
} from "./service";

describe("retention policy", () => {
  it("defaults to 30-day drafts and 7-day idempotency keys", () => {
    expect(retentionPolicyFromEnvironment({})).toEqual({
      draftRetentionDays: 30,
      idempotencyRetentionHours: 168,
    });
  });

  it("accepts bounded overrides and rejects anything else", () => {
    expect(
      retentionPolicyFromEnvironment({
        DRAFT_RETENTION_DAYS: "7",
        API_IDEMPOTENCY_RETENTION_HOURS: "24",
      }),
    ).toEqual({ draftRetentionDays: 7, idempotencyRetentionHours: 24 });
    for (const [name, value] of [
      ["DRAFT_RETENTION_DAYS", "0"],
      ["DRAFT_RETENTION_DAYS", "3651"],
      ["DRAFT_RETENTION_DAYS", "1.5"],
      ["DRAFT_RETENTION_DAYS", "ten"],
      ["API_IDEMPOTENCY_RETENTION_HOURS", "23"],
      ["API_IDEMPOTENCY_RETENTION_HOURS", "8761"],
    ]) {
      expect(() => retentionPolicyFromEnvironment({ [name]: value })).toThrow(name);
    }
  });

  it("computes cutoffs from the policy", () => {
    const now = new Date("2026-11-17T00:00:00Z");
    const cutoffs = retentionCutoffs(
      { draftRetentionDays: 30, idempotencyRetentionHours: 168 },
      now,
    );
    expect(cutoffs.draftsBefore.toISOString()).toBe("2026-10-18T00:00:00.000Z");
    expect(cutoffs.idempotencyBefore.toISOString()).toBe("2026-11-10T00:00:00.000Z");
  });
});
