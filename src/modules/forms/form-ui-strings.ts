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
  validationText: "Enter a text value.",
  validationDate: "Enter a valid date.",
  validationEmail: "Enter a valid email address.",
  validationNumber: "Enter a valid number.",
  validationMin: "Value must be at least {min}.",
  validationMax: "Value must be no more than {max}.",
  validationBoolean: "Choose yes or no.",
  validationAttestation: "You must affirm this statement to continue.",
  validationOption: "Choose a valid option.",
  validationOptions: "Choose valid options.",
  validationAddress: "Enter a valid address.",
  validationAddressIncomplete: "Complete all required address fields.",
  validationAttachments: "Attachment references are invalid.",
  validationMaxFiles: "Attach no more than {maxFiles} files.",
  validationMinLength: "Enter at least {minLength} characters.",
  validationMaxLength: "Enter no more than {maxLength} characters.",
  validationPattern: "The value does not match the required format.",
  draftRateLimited:
    "Too many drafts were started from this connection. Try again later.",
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

/** Stable, language-neutral validation codes and their UI string keys. */
export const validationMessageKeys = {
  required: "validationRequired",
  text: "validationText",
  date: "validationDate",
  email: "validationEmail",
  number: "validationNumber",
  min: "validationMin",
  max: "validationMax",
  boolean: "validationBoolean",
  attestation: "validationAttestation",
  option: "validationOption",
  options: "validationOptions",
  address: "validationAddress",
  address_incomplete: "validationAddressIncomplete",
  attachments: "validationAttachments",
  max_files: "validationMaxFiles",
  min_length: "validationMinLength",
  max_length: "validationMaxLength",
  pattern: "validationPattern",
} as const satisfies Record<string, FormUiStringKey>;

export type ValidationCode = keyof typeof validationMessageKeys;

/**
 * Renders a validation error in the participant's language: the locale's
 * `translations.<locale>.ui.validation*` string when present, else English.
 * `{name}` placeholders are replaced with the error's numeric parameters.
 */
export function validationMessage(
  error: { code?: string; params?: Record<string, number>; message: string },
  strings: Record<FormUiStringKey, string> = defaultFormUiStrings,
): string {
  if (!error.code || !Object.hasOwn(validationMessageKeys, error.code)) {
    return error.message;
  }
  const template = strings[validationMessageKeys[error.code as ValidationCode]];
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
    const value = error.params?.[name];
    return typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : whole;
  });
}

