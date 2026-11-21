import { beforeAll, describe, expect, it } from "vitest";
import { parseFormDefinition } from "@/modules/forms/definition";
import { answersFromFormData } from "@/modules/forms/form-data";
import { validateSubmissionAnswers } from "@/modules/forms/validation";
import { visibleFieldIdsForDefinition } from "@/modules/forms/visibility";
import { buildSealedContent } from "@/components/forms/sealed-content";
import { open, importPrivate, seal } from "./sealed-crypto";
import { parseSealingRecipients, type SealingConfig } from "./recipients";
import { checkSealedSubmission } from "./service";
import { testSealingKeys } from "./test-keys";

const definition = parseFormDefinition({
  schemaVersion: 1,
  sections: [{
    id: "s", title: "S", fields: [
      { id: "kind", type: "select", label: "Kind", required: true, options: [{ value: "abuse", label: "Abuse" }, { value: "other", label: "Other" }] },
      { id: "story", type: "long_text", label: "What happened", sealed: true, required: true, condition: { fieldId: "kind", operator: "equals", value: "abuse" } },
      { id: "where", type: "select", label: "Where", sealed: true, options: [{ value: "depot", label: "The depot" }] },
      { id: "proof", type: "file", label: "Files", sealed: true, maxFiles: 2 },
    ],
  }],
});

let keys: Awaited<ReturnType<typeof testSealingKeys>>;
let ready: SealingConfig;
beforeAll(async () => {
  keys = await testSealingKeys(2);
  ready = parseSealingRecipients(keys.config);
});

describe("sealed answers on the server", () => {
  it("never reads sealed fields from a form post and never validates them in clear", () => {
    const form = new FormData();
    form.set("kind", "abuse");
    form.set("story", "PLAINTEXT-STORY");
    form.set("where", "depot");
    const answers = answersFromFormData(definition, form);
    expect(answers).toEqual({ kind: "abuse" });
    const validation = validateSubmissionAnswers(definition, { kind: "abuse", story: "PLAINTEXT-STORY" });
    expect(validation.answers).toEqual({ kind: "abuse" });
    expect(JSON.stringify(validation)).not.toContain("PLAINTEXT");
  });

  it("refuses sealed fields sent in clear, also for drafts", () => {
    for (const draft of [false, true]) {
      const result = checkSealedSubmission(definition, { rawAnswers: { kind: "abuse", story: "PLAINTEXT" }, ordinaryAnswers: { kind: "abuse" }, envelope: null, draft }, ready);
      expect(result).toMatchObject({ ok: false, errors: [{ fieldId: "story", code: "sealed" }] });
      expect(JSON.stringify(result)).not.toContain("PLAINTEXT");
    }
  });

  it("never accepts an envelope into a draft", async () => {
    const envelope = await seal({ text: "x" }, keys.recipients);
    const result = checkSealedSubmission(definition, { rawAnswers: {}, ordinaryAnswers: {}, envelope: JSON.stringify(envelope), draft: true }, ready);
    expect(result.ok).toBe(false);
    expect(checkSealedSubmission(definition, { rawAnswers: { kind: "abuse" }, ordinaryAnswers: { kind: "abuse" }, envelope: null, draft: true }, ready)).toEqual({ ok: true, sealed: null });
  });

  it("requires an envelope only when a required sealed field is visible", () => {
    expect(checkSealedSubmission(definition, { rawAnswers: {}, ordinaryAnswers: { kind: "abuse" }, envelope: null }, ready))
      .toMatchObject({ ok: false, errors: [{ fieldId: "story", code: "required" }] });
    expect(checkSealedSubmission(definition, { rawAnswers: {}, ordinaryAnswers: { kind: "other" }, envelope: null }, ready))
      .toEqual({ ok: true, sealed: null });
    expect(checkSealedSubmission(definition, { rawAnswers: {}, ordinaryAnswers: { kind: "abuse" }, envelope: null }, { status: "unconfigured" }))
      .toMatchObject({ ok: false, errors: [{ code: "sealed_unavailable" }] });
  });

  it("accepts a valid envelope, refuses a tampered one or one when sealing is unavailable", async () => {
    const envelope = await seal({ text: "x" }, keys.recipients);
    const ok = checkSealedSubmission(definition, { rawAnswers: {}, ordinaryAnswers: { kind: "abuse" }, envelope: JSON.stringify(envelope) }, ready);
    expect(ok.ok && ok.sealed?.commitment).toBe(envelope.commitment);
    const tampered = { ...envelope, text: "PLAINTEXT" };
    expect(checkSealedSubmission(definition, { rawAnswers: {}, ordinaryAnswers: { kind: "abuse" }, envelope: JSON.stringify(tampered) }, ready))
      .toMatchObject({ ok: false, errors: [{ code: "sealed_invalid" }] });
    expect(checkSealedSubmission(definition, { rawAnswers: {}, ordinaryAnswers: { kind: "abuse" }, envelope: JSON.stringify(envelope) }, { status: "unconfigured" }))
      .toMatchObject({ ok: false, errors: [{ code: "sealed_unavailable" }] });
    const plainForm = parseFormDefinition({ schemaVersion: 1, sections: [{ id: "s", title: "S", fields: [{ id: "a", type: "short_text", label: "A" }] }] });
    expect(checkSealedSubmission(plainForm, { rawAnswers: {}, ordinaryAnswers: {}, envelope: JSON.stringify(envelope) }, ready).ok).toBe(false);
  });

  it("the browser seals all visible sealed answers and files together; every recipient can open them", async () => {
    const answers = { kind: "abuse", story: "It happened at night.", where: "depot" };
    const visible = visibleFieldIdsForDefinition(definition, answers);
    const sealedFields = definition.sections[0].fields.filter((f) => f.sealed);
    const content = buildSealedContent(sealedFields, visible, answers, [
      { fieldId: "proof", name: "photo.jpg", type: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) },
    ]);
    expect(content).toMatchObject({
      answers: { story: "It happened at night.", where: "depot", proof: ["photo.jpg"] },
      files: [{ fieldId: "proof", name: "photo.jpg", type: "image/jpeg", base64: "AQID" }],
    });
    expect(content?.text).toContain("What happened\nIt happened at night.");
    expect(content?.text).toContain("Where\nThe depot");
    const envelope = await seal(content, keys.recipients);
    for (const pair of keys.pairs) {
      const opened = await open(envelope, pair.id, await importPrivate(pair.privateJwk));
      expect(opened.commitmentVerified).toBe(true);
      expect(opened.content).toEqual(content);
    }
    // Hidden sealed fields are not sealed; nothing to seal gives no envelope.
    const hidden = buildSealedContent(sealedFields, visibleFieldIdsForDefinition(definition, { kind: "other" }), { kind: "other", story: "stale" }, []);
    expect(hidden).toBeNull();
  });
});
