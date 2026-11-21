import { describe, expect, it } from "vitest";
import { parseFormDefinition, sealedFieldsInDefinition } from "@/modules/forms/definition";
import { parseApplicationManifest } from "@/modules/application/manifest";
import { assertSealingAvailableForDefinition, routingSubmissionFieldIds } from "./policy";
import { parseSealingRecipients, SealingUnavailableError } from "./recipients";
import { testSealingKeys } from "./test-keys";

const base = (fields: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  sections: [{ id: "s", title: "S", fields }],
  ...extra,
});
const parse = (value: unknown) => () => parseFormDefinition(value);

describe("sealed field definition rules", () => {
  it("allows sealed text, select and file fields", () => {
    const definition = parseFormDefinition(base([
      { id: "kind", type: "select", label: "Kind", options: [{ value: "a", label: "A" }] },
      { id: "story", type: "long_text", label: "What happened", sealed: true, required: true },
      { id: "who", type: "select", label: "Who", sealed: true, options: [{ value: "x", label: "X" }], condition: { fieldId: "kind", operator: "equals", value: "a" } },
      { id: "proof", type: "file", label: "Files", sealed: true, maxFiles: 3 },
    ], { sealing: { sourceRiskLevel: "severe" } }));
    expect(sealedFieldsInDefinition(definition).map((f) => f.id)).toEqual(["story", "who", "proof"]);
    expect(definition.sealing?.sourceRiskLevel).toBe("severe");
  });

  it("refuses a sealed field that also uses a protected compartment", () => {
    expect(parse(base([{ id: "name", type: "short_text", label: "Name", sealed: true, protection: { compartment: "identity" } }]))).toThrow(/cannot also use a protected compartment/);
  });

  it("refuses a sealed file field bound to public (cleartext) upload", () => {
    expect(parse(base([{ id: "f", type: "file", label: "F", sealed: true, publicUpload: { documentTypeKey: "evidence" } }]))).toThrow(/never uploaded in clear/);
  });

  it("refuses visibility conditions that read a sealed field", () => {
    expect(parse(base([
      { id: "secret", type: "select", label: "S", sealed: true, options: [{ value: "y", label: "Y" }] },
      { id: "later", type: "short_text", label: "L", condition: { fieldId: "secret", operator: "equals", value: "y" } },
    ]))).toThrow(/sealed field cannot control visibility/);
  });

  it("refuses a participant-messaging condition on a sealed field", () => {
    expect(parse(base(
      [{ id: "secret", type: "boolean", label: "S", sealed: true }],
      { participantPortal: { enabled: true, allowMessaging: true, messagingCondition: { fieldId: "secret", operator: "equals", value: true } } },
    ))).toThrow(/messaging condition cannot reference a sealed field/);
  });

  it("refuses manifest routing rules on sealed fields", () => {
    const manifest = {
      schemaVersion: 1,
      application: { key: "app", name: "App", terminology: {} },
      queues: [{ slug: "q", name: "Q" }],
      forms: [{ slug: "report", name: "Report", definition: base([{ id: "secret", type: "short_text", label: "S", sealed: true }]) }],
      routingRules: [{ key: "r", name: "R", targetQueueSlug: "q", definition: { schemaVersion: 1, conditions: [{ field: "submission", fieldId: "secret", operator: "exists" }] } }],
    };
    expect(() => parseApplicationManifest(manifest)).toThrow(/cannot use sealed field secret/);
    expect(routingSubmissionFieldIds(manifest.routingRules[0].definition as never)).toEqual(["secret"]);
  });

  it("publishes a form with sealed fields only when sealing recipients are configured", async () => {
    const sealedForm = parseFormDefinition(base([{ id: "secret", type: "short_text", label: "S", sealed: true }]));
    const plainForm = parseFormDefinition(base([{ id: "plain", type: "short_text", label: "P" }]));
    expect(() => assertSealingAvailableForDefinition(sealedForm, { status: "unconfigured" })).toThrow(SealingUnavailableError);
    expect(() => assertSealingAvailableForDefinition(sealedForm, { status: "invalid", error: "x" })).toThrow(SealingUnavailableError);
    expect(() => assertSealingAvailableForDefinition(plainForm, { status: "unconfigured" })).not.toThrow();
    const ready = parseSealingRecipients((await testSealingKeys()).config);
    expect(() => assertSealingAvailableForDefinition(sealedForm, ready)).not.toThrow();
  });
});
