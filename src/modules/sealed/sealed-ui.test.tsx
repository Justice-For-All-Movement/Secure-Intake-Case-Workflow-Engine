import React from "react";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { FormRenderer } from "@/components/forms/form-renderer";
import { parseFormDefinition } from "@/modules/forms/definition";
import { SealedAnswersPanel } from "@/app/admin/cases/[caseId]/sealed-answers-panel";

const definition = parseFormDefinition({
  schemaVersion: 1,
  sections: [{
    id: "s", title: "S", fields: [
      { id: "summary", type: "long_text", label: "Summary" },
      { id: "story", type: "long_text", label: "What happened", sealed: true, required: true },
      { id: "where", type: "multiselect", label: "Where", sealed: true, options: [{ value: "a", label: "A" }] },
      { id: "home", type: "address", label: "Address", sealed: true },
      { id: "proof", type: "file", label: "Files", sealed: true },
    ],
  }],
});

describe("sealed fields on the participant form (server-rendered, before any script runs)", () => {
  it("renders sealed controls disabled and without names, with the plain notice and a no-script explanation", () => {
    const html = renderToStaticMarkup(
      <FormRenderer definition={definition} action={async (state) => state} sealing={{ recipients: [] }} />,
    );
    const document = new JSDOM(html).window.document;
    const form = document.querySelector('[data-testid="report-form"]') as HTMLFormElement;
    for (const id of ["story", "where", "home", "proof"]) {
      const controls = [...form.querySelectorAll(`#field-${id}, #field-${id} input, #field-${id} textarea`)]
        .filter((element) => ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
      expect(controls.length, id).toBeGreaterThan(0);
      for (const control of controls) {
        expect(control.hasAttribute("name"), id).toBe(false);
        expect(control.hasAttribute("disabled"), id).toBe(true);
      }
    }
    expect(form.querySelector("#field-summary")?.getAttribute("name")).toBe("summary");
    expect(html).toContain("Only the research team can read them");
    expect(html).toContain("need JavaScript");
    expect(html).toContain("never saved in a draft");
    // A native (script-less) post of this form can never contain a sealed field.
    const names = [...form.querySelectorAll("[name]")].map((element) => element.getAttribute("name"));
    expect(names.filter((name) => /^(story|where|home|proof)(\.|$)/.test(name ?? ""))).toEqual([]);
  });

  it("says sealing is unavailable when the deployment has no sealing recipients", () => {
    const html = renderToStaticMarkup(<FormRenderer definition={definition} action={async (state) => state} sealing={null} />);
    expect(html).toContain("Sealed answers cannot be accepted right now");
  });
});

describe("staff view of a sealed submission", () => {
  it("shows where it can be read and a download, never plaintext", () => {
    const html = renderToStaticMarkup(
      <SealedAnswersPanel
        submissionId="0b6e5de7-0000-4000-8000-000000000001"
        summary={{ commitment: "a".repeat(64), recipientKeyIds: ["b".repeat(64)], sizeBytes: 1234, receivedAt: new Date("2026-11-20T10:00:00Z") }}
      />,
    );
    expect(html).toContain("Sealed answers — readable only in PAM (Sealed sources) or with the offline sealed reader");
    expect(html).toContain('href="/admin/sealed/0b6e5de7-0000-4000-8000-000000000001"');
    expect(html).toContain("Download sealed file");
  });
});
