/**
 * Interface strings of the public form renderer and participant pages. The
 * built-in text is the fallback; every key can be overridden per locale in a
 * form definition's `translations.<locale>.ui`, so languages are deployment
 * data rather than code.
 */
export const defaultFormUiStrings = {
  requiredHint: "Fields marked * are required.",
  required: "(required)",
  selectOption: "Select an option",
  submitting: "Submitting…",
  submissionInProgress: "Form submission in progress.",
  errorSummaryTitle: "Check your answers",
  errorSummaryIntro: "Correct the following and submit the form again.",
  language: "Language",
  costNotice:
    "Submitting this form is free. You do not need a lawyer, and you do not need polished paperwork: describe what happened in your own words.",
  saveDraft: "Save and continue later",
  savingDraft: "Saving…",
  draftSavedTitle: "Draft saved",
  draftSavedIntro:
    "Keep this resume code somewhere safe. Anyone with the code can open the draft. It is shown only now.",
  draftResumeCode: "Resume code",
  draftNotIncluded:
    "Files and protected answers are not stored in a draft; add them again before you submit.",
  resumeTitle: "Continue a saved draft",
  resumeCodeLabel: "Resume code",
  resumeButton: "Open draft",
  resumeFailed:
    "That code does not open a saved draft for this form. Check the code and try again.",
  resumeLoaded: "Your saved draft has been loaded.",
  receivedTitle: "Submission received",
  receivedDefault: "Your submission has been recorded.",
  trackingCode: "Tracking code",
  portalTitle: "Follow-up access",
  portalIntro:
    "Save both values below. The access secret is shown only now and cannot be recovered later.",
  accessSecret: "Access secret",
  openPortal: "Open follow-up page",
  uploadQuarantineNotice:
    "Uploaded files are held in quarantine and checked before anyone can open them.",
  uploadDisabled: "File upload is not enabled for this field.",
  addressLine1: "Address line 1",
  addressLine2: "Address line 2",
  addressCity: "City",
  addressRegion: "State / region",
  addressPostalCode: "Postal code",
  addressCountry: "Country",
  validationRequired: "This field is required.",
} as const;

export type FormUiStringKey = keyof typeof defaultFormUiStrings;
export type FormUiStrings = Record<FormUiStringKey, string>;

export function resolveFormUiStrings(
  overrides?: Record<string, string> | null,
): FormUiStrings {
  const result: Record<string, string> = { ...defaultFormUiStrings };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (key in defaultFormUiStrings && value.trim()) result[key] = value;
  }
  return result as FormUiStrings;
}
