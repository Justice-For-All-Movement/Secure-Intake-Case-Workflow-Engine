import { describe, expect, it } from "vitest";
import { parseFormDefinition } from "./definition";
import {
  availableFormLocales,
  localizeFormDefinition,
  parseAcceptLanguage,
  resolveFormLocale,
} from "./localization";

const definition = parseFormDefinition({
  schemaVersion: 1,
  defaultLocale: "en",
  submitLabel: "Send",
  sections: [
    {
      id: "main",
      title: "Main",
      fields: [
        {
          id: "mode",
          type: "select",
          label: "Mode",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
        { id: "story", type: "long_text", label: "Story", required: true },
      ],
    },
  ],
  translations: {
    uk: {
      name: "Форма",
      submitLabel: "Надіслати",
      sections: { main: { title: "Головне" } },
      fields: { mode: { label: "Режим", options: { a: "А" } } },
      ui: { saveDraft: "Зберегти", notAKey: "ignored" },
    },
    ar: { direction: "rtl" },
  },
});

describe("form localization as data", () => {
  it("lists the default locale first and resolves requests with fallback", () => {
    expect(availableFormLocales(definition)).toEqual(["en", "uk", "ar"]);
    expect(resolveFormLocale(definition, ["uk-UA"])).toBe("uk");
    expect(resolveFormLocale(definition, [null, "zz", "AR"])).toBe("ar");
    expect(resolveFormLocale(definition, ["zz"])).toBe("en");
    expect(parseAcceptLanguage("fr;q=0.2, uk-UA;q=0.9, <x>, en")).toEqual([
      "en",
      "uk-UA",
      "fr",
    ]);
  });

  it("replaces only translated text and never changes ids, values or rules", () => {
    const localized = localizeFormDefinition(definition, "uk");
    expect(localized.locale).toBe("uk");
    expect(localized.name).toBe("Форма");
    expect(localized.definition.submitLabel).toBe("Надіслати");
    const [mode, story] = localized.definition.sections[0].fields;
    expect(localized.definition.sections[0].title).toBe("Головне");
    expect(mode.label).toBe("Режим");
    expect(mode.options).toEqual([
      { value: "a", label: "А" },
      { value: "b", label: "B" },
    ]);
    expect(story).toEqual(definition.sections[0].fields[1]);
    expect(localized.ui.saveDraft).toBe("Зберегти");
    expect("notAKey" in localized.ui).toBe(false);
    expect(localizeFormDefinition(definition, "ar").direction).toBe("rtl");
    expect(localizeFormDefinition(definition, "en").definition).toBe(definition);
  });

  it("rejects translations for unknown fields, sections or malformed locales", () => {
    const base = {
      schemaVersion: 1,
      sections: [
        { id: "main", title: "Main", fields: [{ id: "x", type: "short_text", label: "X" }] },
      ],
    };
    expect(() =>
      parseFormDefinition({ ...base, translations: { es: { fields: { nope: { label: "?" } } } } }),
    ).toThrow();
    expect(() =>
      parseFormDefinition({ ...base, translations: { es: { sections: { nope: { title: "?" } } } } }),
    ).toThrow();
    expect(() =>
      parseFormDefinition({ ...base, translations: { "not a locale": {} } }),
    ).toThrow();
  });
});
