import type { FormDefinition } from "./definition";
import {
  resolveFormUiStrings,
  type FormUiStrings,
} from "./form-ui-strings";

export interface LocalizedForm {
  locale: string;
  direction: "ltr" | "rtl";
  availableLocales: string[];
  name: string | null;
  description: string | null;
  definition: FormDefinition;
  ui: FormUiStrings;
}

export function availableFormLocales(definition: FormDefinition) {
  const base = definition.defaultLocale ?? "en";
  return [
    base,
    ...Object.keys(definition.translations ?? {}).filter(
      (locale) => locale.toLowerCase() !== base.toLowerCase(),
    ),
  ];
}

/** Picks the requested locale, a base-language match, or the default. */
export function resolveFormLocale(
  definition: FormDefinition,
  requested: readonly (string | null | undefined)[],
) {
  const available = availableFormLocales(definition);
  for (const candidate of requested) {
    const wanted = candidate?.trim().toLowerCase();
    if (!wanted) continue;
    const exact = available.find((locale) => locale.toLowerCase() === wanted);
    if (exact) return exact;
    const base = wanted.split("-")[0];
    const partial = available.find(
      (locale) => locale.toLowerCase().split("-")[0] === base,
    );
    if (partial) return partial;
  }
  return available[0];
}

export function parseAcceptLanguage(header: string | null | undefined) {
  return (header ?? "")
    .split(",")
    .map((part) => {
      const [tag, quality] = part.trim().split(";q=");
      return { tag: tag.trim(), q: quality ? Number(quality) : 1 };
    })
    .filter((entry) => /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(entry.tag))
    .sort((a, b) => b.q - a.q)
    .slice(0, 10)
    .map((entry) => entry.tag);
}

/** Display name of a locale written in that locale, e.g. "español". */
export function localeDisplayName(locale: string) {
  try {
    return (
      new Intl.DisplayNames([locale], { type: "language" }).of(locale) ??
      locale
    );
  } catch {
    return locale;
  }
}

export function localizeFormDefinition(
  definition: FormDefinition,
  locale: string,
): LocalizedForm {
  const availableLocales = availableFormLocales(definition);
  const resolved = resolveFormLocale(definition, [locale]);
  const translation =
    Object.entries(definition.translations ?? {}).find(
      ([key]) => key.toLowerCase() === resolved.toLowerCase(),
    )?.[1] ?? null;

  if (!translation) {
    return {
      locale: resolved,
      direction: "ltr",
      availableLocales,
      name: null,
      description: null,
      definition,
      ui: resolveFormUiStrings(null),
    };
  }

  return {
    locale: resolved,
    direction: translation.direction ?? "ltr",
    availableLocales,
    name: translation.name ?? null,
    description: translation.description ?? null,
    ui: resolveFormUiStrings(translation.ui),
    definition: {
      ...definition,
      intro: translation.intro ?? definition.intro,
      submitLabel: translation.submitLabel ?? definition.submitLabel,
      confirmationMessage:
        translation.confirmationMessage ?? definition.confirmationMessage,
      sections: definition.sections.map((section) => {
        const sectionText = translation.sections?.[section.id];
        return {
          ...section,
          title: sectionText?.title ?? section.title,
          description: sectionText?.description ?? section.description,
          fields: section.fields.map((field) => {
            const text = translation.fields?.[field.id];
            if (!text) return field;
            return {
              ...field,
              label: text.label ?? field.label,
              helpText: text.helpText ?? field.helpText,
              placeholder: text.placeholder ?? field.placeholder,
              attestationText: text.attestationText ?? field.attestationText,
              options: field.options?.map((option) => ({
                value: option.value,
                label: text.options?.[option.value] ?? option.label,
              })),
            };
          }),
        };
      }),
    },
  };
}
