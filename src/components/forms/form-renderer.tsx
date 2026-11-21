"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  FormDefinition,
  FormField,
} from "@/modules/forms/definition";
import {
  initialPublicFormActionState,
  type PublicFormActionState,
} from "@/modules/forms/public-action-state";
import { visibleFieldIdsForDefinition } from "@/modules/forms/visibility";
import {
  defaultFormUiStrings,
  type FormUiStrings,
  validationMessage,
} from "@/modules/forms/form-ui-strings";
import type { SealingPublicJwk } from "@/modules/sealed/sealed-crypto";
import { buildSealedContent, type SealedFileInput } from "./sealed-content";

/** Raw bytes of sealed files a participant may attach (matches the server's envelope limit). */
const SEALED_FILES_MAX_BYTES = 20_000_000;
const ADDRESS_PARTS = ["line1", "line2", "city", "region", "postalCode", "country"] as const;

/** Public keys sealed answers are encrypted to; null when sealing is unavailable. */
export interface FormSealing {
  recipients: Array<{ id: string; publicJwk: SealingPublicJwk }>;
}

export function FormRenderer({
  definition,
  action,
  ui = defaultFormUiStrings,
  locale,
  sealing = null,
}: {
  definition: FormDefinition;
  action: (
    previousState: PublicFormActionState,
    formData: FormData,
  ) => Promise<PublicFormActionState>;
  ui?: FormUiStrings;
  locale?: string;
  sealing?: FormSealing | null;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [draftCode, setDraftCode] = useState("");
  const [draftGeneration, setDraftGeneration] = useState(0);
  const [state, formAction, pending] = useActionState(
    action,
    initialPublicFormActionState,
  );
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const draftNoticeRef = useRef<HTMLDivElement>(null);
  const resumable = definition.resumableDrafts !== false;

  // Sealed fields: encrypted on this device; their controls carry no `name`,
  // so a form post (with or without JavaScript) never contains them, and they
  // stay disabled until this browser is known to be able to encrypt.
  const sealedFields = definition.sections
    .flatMap((section) => section.fields)
    .filter((field) => field.sealed === true);
  const hasSealed = sealedFields.length > 0;
  const [sealingChecked, setSealingChecked] = useState(false);
  const [sealingReady, setSealingReady] = useState(false);
  const [sealStatus, setSealStatus] = useState<
    "idle" | "encrypting" | "failed" | "too_large"
  >("idle");
  const sealedFilesRef = useRef(new Map<string, File[]>());

  useEffect(() => {
    if (!hasSealed) return;
    const capable =
      Boolean(sealing && sealing.recipients.length > 0) &&
      globalThis.isSecureContext !== false &&
      typeof globalThis.crypto?.subtle?.encrypt === "function";
    setSealingReady(capable);
    setSealingChecked(true);
  }, [hasSealed, sealing]);

  const record = (fieldId: string, value: unknown) => {
    setAnswers((current) => ({ ...current, [fieldId]: value }));
  };
  const visibleFieldIds = visibleFieldIdsForDefinition(
    definition,
    answers,
  );
  const errorsByField = new Map(
    state.errors.map((error) => [
      error.fieldId,
      validationMessage(error, ui),
    ]),
  );

  useEffect(() => {
    if (state.status === "validation_error") {
      errorSummaryRef.current?.focus();
    }
    if (state.status === "draft_loaded") {
      // Loading a draft re-creates the controls (empty file inputs): forget
      // any sealed files picked before, so nothing unseen is sealed.
      sealedFilesRef.current = new Map();
      setAnswers(state.draftAnswers ?? {});
      setDraftCode(state.resumeCode ?? "");
      setDraftGeneration((value) => value + 1);
      draftNoticeRef.current?.focus();
    }
    if (state.status === "draft_saved") {
      setDraftCode(state.resumeCode ?? "");
      draftNoticeRef.current?.focus();
    }
    if (
      state.status === "draft_not_found" ||
      state.status === "draft_rate_limited"
    ) {
      draftNoticeRef.current?.focus();
    }
  }, [state]);

  const submitWithSealing = async (formData: FormData) => {
    // Never send sealed answers in clear, whatever the controls contain.
    for (const field of sealedFields) {
      formData.delete(field.id);
      for (const part of ADDRESS_PARTS) formData.delete(`${field.id}.${part}`);
    }
    formData.delete("__sealed");
    const intent = formData.get("__intent");
    if (intent !== "save_draft" && hasSealed && sealingReady && sealing) {
      const visible = visibleFieldIdsForDefinition(definition, answers);
      const files: File[] = [];
      for (const field of sealedFields) {
        if (field.type === "file" && visible.has(field.id)) {
          files.push(...(sealedFilesRef.current.get(field.id) ?? []));
        }
      }
      if (files.reduce((total, file) => total + file.size, 0) > SEALED_FILES_MAX_BYTES) {
        setSealStatus("too_large");
        return;
      }
      setSealStatus("encrypting");
      try {
        const fileInputs: SealedFileInput[] = [];
        for (const field of sealedFields) {
          if (field.type !== "file" || !visible.has(field.id)) continue;
          for (const file of sealedFilesRef.current.get(field.id) ?? []) {
            fileInputs.push({
              fieldId: field.id,
              name: file.name,
              type: file.type,
              bytes: new Uint8Array(await file.arrayBuffer()),
            });
          }
        }
        const content = buildSealedContent(sealedFields, visible, answers, fileInputs);
        if (content) {
          const { seal } = await import("@/modules/sealed/sealed-crypto");
          const envelope = await seal(content, sealing.recipients);
          formData.set("__sealed", JSON.stringify(envelope));
        }
        setSealStatus("idle");
      } catch {
        // Nothing is sent when encryption fails.
        setSealStatus("failed");
        return;
      }
    }
    startTransition(() => formAction(formData));
  };
  const busy = pending || sealStatus === "encrypting";

  if (state.status === "submitted") {
    return (
      <section role="status" aria-live="polite">
        <h2>{ui.receivedTitle}</h2>
        {definition.confirmationMessage ? (
          <p>{definition.confirmationMessage}</p>
        ) : (
          <p>{ui.receivedDefault}</p>
        )}
        {state.confirmationCode ? (
          <p>
            {ui.trackingCode}: <strong>{state.confirmationCode}</strong>
          </p>
        ) : null}
        {state.participantPortal ? (
          <>
            <h3>{ui.portalTitle}</h3>
            <p>{ui.portalIntro}</p>
            <p>
              {ui.trackingCode}:{" "}
              <code data-testid="tracking-code">
                {state.participantPortal.trackingCode}
              </code>
            </p>
            <p>
              {ui.accessSecret}:{" "}
              <code data-testid="access-secret">
                {state.participantPortal.accessSecret}
              </code>
            </p>
            <p>
              <a href={state.participantPortal.loginPath}>{ui.openPortal}</a>
            </p>
          </>
        ) : null}
      </section>
    );
  }


  return (
    <>
      {resumable ? (
        <details className="draft-resume">
          <summary>{ui.resumeTitle}</summary>
          <form action={formAction}>
            <input type="hidden" name="__intent" value="resume" />
            <label htmlFor="resume-code">{ui.resumeCodeLabel}</label>
            <input
              id="resume-code"
              name="__resume_code"
              type="text"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={200}
            />
            <button type="submit" disabled={pending}>
              {ui.resumeButton}
            </button>
          </form>
        </details>
      ) : null}

      <div
        ref={draftNoticeRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={
          state.status === "draft_not_found" ||
          state.status === "draft_rate_limited"
            ? "error-summary"
            : undefined
        }
      >
        {state.status === "draft_saved" ? (
          <>
            <h2>{ui.draftSavedTitle}</h2>
            <p>{ui.draftSavedIntro}</p>
            <p>
              {ui.draftResumeCode}:{" "}
              <code data-testid="resume-code">{state.resumeCode}</code>
            </p>
            <p>{ui.draftNotIncluded}</p>
            {hasSealed ? <p>{ui.sealedDraftNotice}</p> : null}
          </>
        ) : null}
        {state.status === "draft_loaded" ? <p>{ui.resumeLoaded}</p> : null}
        {state.status === "draft_not_found" ? (
          <p>{ui.resumeFailed}</p>
        ) : null}
        {state.status === "draft_rate_limited" ? (
          <p>{ui.draftRateLimited}</p>
        ) : null}
      </div>

    <form
      action={formAction}
      encType="multipart/form-data"
      data-testid="report-form"
      onSubmit={
        hasSealed
          ? (event) => {
              // With sealed fields the post is made here, after encryption;
              // preventing the default also stops React's own form action.
              event.preventDefault();
              const submitter = (event.nativeEvent as SubmitEvent).submitter;
              void submitWithSealing(formDataWithSubmitter(event.currentTarget, submitter));
            }
          : undefined
      }
    >
      <input type="hidden" name="__locale" value={locale ?? ""} />
      <input type="hidden" name="__draft" value={draftCode} />
      {definition.intro ? <p>{definition.intro}</p> : null}
      <p className="hint">{ui.costNotice}</p>
      <p className="hint">{ui.requiredHint}</p>
      {hasSealed ? (
        <div id="sealed-notice" className="sealed-notice" data-testid="sealed-notice">
          <p>{ui.sealedNotice}</p>
          <noscript>
            <p>{ui.sealedNeedsScript}</p>
          </noscript>
          {!sealing || (sealingChecked && !sealingReady) ? (
            <p role="note">{ui.sealedUnavailable}</p>
          ) : null}
          {resumable ? <p>{ui.sealedDraftNotice}</p> : null}
        </div>
      ) : null}
      {sealStatus === "failed" || sealStatus === "too_large" ? (
        <div className="error-summary" role="alert">
          <p>
            {sealStatus === "failed"
              ? ui.sealedFailed
              : ui.sealedFilesTooLarge.replace(
                  "{maxMegabytes}",
                  String(SEALED_FILES_MAX_BYTES / 1_000_000),
                )}
          </p>
        </div>
      ) : null}

      {state.status === "validation_error" && state.errors.length ? (
        <div
          className="error-summary"
          role="alert"
          tabIndex={-1}
          ref={errorSummaryRef}
          aria-labelledby="form-error-heading"
        >
          <h2 id="form-error-heading">{ui.errorSummaryTitle}</h2>
          <p>{ui.errorSummaryIntro}</p>
          <ul>
            {state.errors.map((error, index) => (
              <li key={`${error.fieldId}-${index}`}>
                <a href={`#field-${error.fieldId}`}>
                  {validationMessage(error, ui)}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {definition.sections.map((section) => (
        <section key={section.id} aria-labelledby={`section-${section.id}`}>
          <h2 id={`section-${section.id}`}>{section.title}</h2>
          {section.description ? <p>{section.description}</p> : null}

          {section.fields.map((field) =>
            visibleFieldIds.has(field.id) ? (
              <FormFieldControl
                key={`${field.id}-${draftGeneration}`}
                ui={ui}
                field={field}
                value={answers[field.id]}
                error={errorsByField.get(field.id)}
                onValueChange={(value) => record(field.id, value)}
                sealedEnabled={sealingReady}
                onSealedFiles={(files) => {
                  sealedFilesRef.current.set(field.id, files);
                }}
              />
            ) : null,
          )}
        </section>
      ))}

      <button
        type="submit"
        data-testid="submit-report"
        disabled={busy}
        aria-disabled={busy}
      >
        {sealStatus === "encrypting"
          ? ui.sealedEncrypting
          : pending
            ? ui.submitting
            : definition.submitLabel}
      </button>
      {resumable ? (
        <button
          type="submit"
          name="__intent"
          value="save_draft"
          formNoValidate
          className="secondary"
          disabled={busy}
          aria-disabled={busy}
        >
          {pending ? ui.savingDraft : ui.saveDraft}
        </button>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {sealStatus === "encrypting"
          ? ui.sealedEncrypting
          : pending
            ? ui.submissionInProgress
            : ""}
      </span>
    </form>
    </>
  );
}

function formDataWithSubmitter(form: HTMLFormElement, submitter: HTMLElement | null) {
  try {
    return new FormData(form, submitter);
  } catch {
    const data = new FormData(form);
    if (
      submitter instanceof HTMLButtonElement &&
      submitter.name &&
      !data.has(submitter.name)
    ) {
      data.append(submitter.name, submitter.value);
    }
    return data;
  }
}

function RequiredIndicator({
  required,
  text = defaultFormUiStrings.required,
}: {
  required: boolean;
  text?: string;
}) {
  if (!required) return null;
  return (
    <>
      <span className="required-marker" aria-hidden="true">
        {" "}*
      </span>
      <span className="sr-only"> {text}</span>
    </>
  );
}

function SealedMarker({ field, text }: { field: FormField; text: string }) {
  if (!field.sealed) return null;
  return <span className="sealed-badge"> [{text}]</span>;
}

function descriptionIds(
  field: FormField,
  error?: string,
) {
  return [
    field.helpText ? `help-${field.id}` : null,
    field.sealed ? "sealed-notice" : null,
    error ? `error-${field.id}` : null,
  ]
    .filter(Boolean)
    .join(" ") || undefined;
}

function FieldMessages({
  field,
  error,
}: {
  field: FormField;
  error?: string;
}) {
  return (
    <>
      {field.helpText ? (
        <small id={`help-${field.id}`} className="help-text">
          {field.helpText}
        </small>
      ) : null}
      {error ? (
        <span id={`error-${field.id}`} className="field-error">
          {error}
        </span>
      ) : null}
    </>
  );
}

function FormFieldControl({
  field,
  value,
  error,
  onValueChange,
  ui,
  sealedEnabled = false,
  onSealedFiles,
}: {
  ui: FormUiStrings;
  field: FormField;
  value?: unknown;
  error?: string;
  onValueChange: (value: unknown) => void;
  sealedEnabled?: boolean;
  onSealedFiles?: (files: File[]) => void;
}) {
  const required = field.required;
  const controlId = `field-${field.id}`;
  const describedBy = descriptionIds(field, error);
  // A sealed control is never named (never part of a form post) and stays
  // disabled until the browser can encrypt.
  const sealed = field.sealed === true;
  const name = sealed ? undefined : field.id;
  const disabled = sealed && !sealedEnabled ? true : undefined;
  const marker = <SealedMarker field={field} text={ui.sealedBadge} />;

  switch (field.type) {
    case "long_text":
      return (
        <div>
          <label htmlFor={controlId}>
            {field.label}
            <RequiredIndicator required={required} text={ui.required} />
            {marker}
          </label>
          <textarea
            id={controlId}
            name={name}
            disabled={disabled}
            placeholder={field.placeholder}
            required={required}
            minLength={field.validation?.minLength}
            maxLength={field.validation?.maxLength}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onValueChange(event.currentTarget.value)}
          />
          <FieldMessages field={field} error={error} />
        </div>
      );

    case "email":
    case "phone":
    case "date":
    case "number":
    case "short_text": {
      const type =
        field.type === "short_text"
          ? "text"
          : field.type === "phone"
            ? "tel"
            : field.type;

      return (
        <div>
          <label htmlFor={controlId}>
            {field.label}
            <RequiredIndicator required={required} text={ui.required} />
            {marker}
          </label>
          <input
            id={controlId}
            name={name}
            disabled={disabled}
            type={type}
            placeholder={field.placeholder}
            required={required}
            minLength={field.validation?.minLength}
            maxLength={field.validation?.maxLength}
            min={field.validation?.min}
            max={field.validation?.max}
            pattern={field.validation?.pattern}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            value={
              field.type === "number"
                ? typeof value === "number"
                  ? value
                  : ""
                : typeof value === "string"
                  ? value
                  : ""
            }
            onChange={(event) =>
              onValueChange(
                field.type === "number"
                  ? event.currentTarget.value === ""
                    ? undefined
                    : Number(event.currentTarget.value)
                  : event.currentTarget.value,
              )
            }
          />
          <FieldMessages field={field} error={error} />
        </div>
      );
    }

    case "boolean":
      return (
        <div>
          <label htmlFor={controlId}>
            <input
              id={controlId}
              name={name}
              disabled={disabled}
              type="checkbox"
              value="true"
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              checked={value === true}
              onChange={(event) => onValueChange(event.currentTarget.checked)}
            />
            {field.label}
            <RequiredIndicator required={required} text={ui.required} />
            {marker}
          </label>
          <FieldMessages field={field} error={error} />
        </div>
      );

    case "attestation":
      return (
        <div>
          <label htmlFor={controlId}>
            <input
              id={controlId}
              name={name}
              disabled={disabled}
              type="checkbox"
              value="true"
              required={required}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              checked={value === true}
              onChange={(event) => onValueChange(event.currentTarget.checked)}
            />
            {field.attestationText ?? field.label}
            <RequiredIndicator required={required} text={ui.required} />
            {marker}
          </label>
          <FieldMessages field={field} error={error} />
        </div>
      );

    case "select":
      return (
        <div>
          <label htmlFor={controlId}>
            {field.label}
            <RequiredIndicator required={required} text={ui.required} />
            {marker}
          </label>
          <select
            id={controlId}
            name={name}
            disabled={disabled}
            required={required}
            value={typeof value === "string" ? value : ""}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => onValueChange(event.currentTarget.value)}
          >
            <option value="" disabled={required}>
              {ui.selectOption}
            </option>
            {(field.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <FieldMessages field={field} error={error} />
        </div>
      );

    case "multiselect":
      return (
        <fieldset
          id={controlId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          tabIndex={-1}
        >
          <legend>
            {field.label}
            <RequiredIndicator required={required} text={ui.required} />
            {marker}
          </legend>
          {(field.options ?? []).map((option) => (
            <label key={option.value}>
              <input
                name={name}
              disabled={disabled}
                type="checkbox"
                value={option.value}
                checked={
                  Array.isArray(value) &&
                  value.includes(option.value)
                }
                onChange={(event) => {
                  if (sealed) {
                    const current = Array.isArray(value)
                      ? value.filter((item): item is string => typeof item === "string")
                      : [];
                    const checked = event.currentTarget.checked;
                    onValueChange(
                      (field.options ?? [])
                        .map((item) => item.value)
                        .filter((item) =>
                          item === option.value ? checked : current.includes(item),
                        ),
                    );
                    return;
                  }
                  const form = event.currentTarget.form;
                  if (!form) return;
                  const values = new FormData(form)
                    .getAll(field.id)
                    .filter((value): value is string => typeof value === "string");
                  onValueChange(values);
                }}
              />
              {option.label}
            </label>
          ))}
          <FieldMessages field={field} error={error} />
        </fieldset>
      );

    case "address":
      return (
        <AddressFieldControl
          ui={ui}
          field={field}
          required={required}
          value={value}
          error={error}
          onValueChange={onValueChange}
          sealed={sealed}
          disabled={disabled}
        />
      );

    case "file": {
      // A sealed file is read and encrypted in the browser instead of uploaded.
      const publicUploadEnabled = sealed ? sealedEnabled : Boolean(field.publicUpload);
      return (
        <fieldset
          id={controlId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          tabIndex={-1}
        >
          <legend id={`legend-${field.id}`}>
            {field.label}
            <RequiredIndicator required={required} text={ui.required} />
            {marker}
          </legend>
          <input
            name={name}
            type="file"
            aria-labelledby={`legend-${field.id}`}
            disabled={!publicUploadEnabled}
            required={required && publicUploadEnabled}
            multiple={(field.maxFiles ?? 1) > 1}
            accept={field.acceptedMimeTypes?.join(",")}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              if (sealed) {
                onSealedFiles?.(files.slice(0, field.maxFiles ?? 1));
              }
              onValueChange(files.map((file) => file.name));
            }}
          />
          <small>
            {sealed
              ? publicUploadEnabled
                ? ui.sealedFileNotice
                : ui.sealedUnavailable
              : publicUploadEnabled
                ? ui.uploadQuarantineNotice
                : ui.uploadDisabled}
          </small>
          <FieldMessages field={field} error={error} />
        </fieldset>
      );
    }
  }
}

function addressLabel(
  part: "line1" | "line2" | "city" | "region" | "postalCode" | "country",
  ui: FormUiStrings,
) {
  const labels = {
    line1: ui.addressLine1,
    line2: ui.addressLine2,
    city: ui.addressCity,
    region: ui.addressRegion,
    postalCode: ui.addressPostalCode,
    country: ui.addressCountry,
  };
  return labels[part];
}

function AddressFieldControl({
  field,
  required,
  value,
  error,
  onValueChange,
  ui,
  sealed = false,
  disabled,
}: {
  ui: FormUiStrings;
  field: FormField;
  required: boolean;
  value?: unknown;
  error?: string;
  onValueChange: (value: unknown) => void;
  sealed?: boolean;
  disabled?: boolean;
}) {
  const [address, setAddress] = useState<Record<string, string>>(
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {},
  );
  const controlId = `field-${field.id}`;
  const describedBy = descriptionIds(field, error);

  const updatePart = (part: string, value: string) => {
    const next = { ...address, [part]: value };
    setAddress(next);
    onValueChange(next);
  };

  return (
    <fieldset
      id={controlId}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      tabIndex={-1}
    >
      <legend>
        {field.label}
        <RequiredIndicator required={required} text={ui.required} />
        <SealedMarker field={field} text={ui.sealedBadge} />
      </legend>
      {(["line1", "line2", "city", "region", "postalCode", "country"] as const).map(
        (part) => {
          const inputId = `${controlId}-${part}`;
          return (
            <div key={part}>
              <label htmlFor={inputId}>
                {addressLabel(part, ui)}
                <RequiredIndicator
                  text={ui.required}
                  required={
                    required &&
                    ["line1", "city", "region", "postalCode", "country"].includes(
                      part,
                    )
                  }
                />
              </label>
              <input
                id={inputId}
                name={sealed ? undefined : `${field.id}.${part}`}
                disabled={disabled}
                required={
                  required &&
                  ["line1", "city", "region", "postalCode", "country"].includes(
                    part,
                  )
                }
                value={address[part] ?? ""}
                onChange={(event) =>
                  updatePart(part, event.currentTarget.value)
                }
              />
            </div>
          );
        },
      )}
      <FieldMessages field={field} error={error} />
    </fieldset>
  );
}
