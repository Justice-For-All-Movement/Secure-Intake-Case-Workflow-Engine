"use client";

import {
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
} from "@/modules/forms/form-ui-strings";

export function FormRenderer({
  definition,
  action,
  ui = defaultFormUiStrings,
  locale,
}: {
  definition: FormDefinition;
  action: (
    previousState: PublicFormActionState,
    formData: FormData,
  ) => Promise<PublicFormActionState>;
  ui?: FormUiStrings;
  locale?: string;
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

  const record = (fieldId: string, value: unknown) => {
    setAnswers((current) => ({ ...current, [fieldId]: value }));
  };
  const visibleFieldIds = visibleFieldIdsForDefinition(
    definition,
    answers,
  );
  const translateError = (message: string) =>
    message === defaultFormUiStrings.validationRequired
      ? ui.validationRequired
      : message;
  const errorsByField = new Map(
    state.errors.map((error) => [
      error.fieldId,
      translateError(error.message),
    ]),
  );

  useEffect(() => {
    if (state.status === "validation_error") {
      errorSummaryRef.current?.focus();
    }
    if (state.status === "draft_loaded") {
      setAnswers(state.draftAnswers ?? {});
      setDraftCode(state.resumeCode ?? "");
      setDraftGeneration((value) => value + 1);
      draftNoticeRef.current?.focus();
    }
    if (state.status === "draft_saved") {
      setDraftCode(state.resumeCode ?? "");
      draftNoticeRef.current?.focus();
    }
    if (state.status === "draft_not_found") {
      draftNoticeRef.current?.focus();
    }
  }, [state]);

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
          state.status === "draft_not_found" ? "error-summary" : undefined
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
          </>
        ) : null}
        {state.status === "draft_loaded" ? <p>{ui.resumeLoaded}</p> : null}
        {state.status === "draft_not_found" ? (
          <p>{ui.resumeFailed}</p>
        ) : null}
      </div>

    <form
      action={formAction}
      encType="multipart/form-data"
      data-testid="report-form"
    >
      <input type="hidden" name="__locale" value={locale ?? ""} />
      <input type="hidden" name="__draft" value={draftCode} />
      {definition.intro ? <p>{definition.intro}</p> : null}
      <p className="hint">{ui.costNotice}</p>
      <p className="hint">{ui.requiredHint}</p>

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
                  {translateError(error.message)}
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
              />
            ) : null,
          )}
        </section>
      ))}

      <button
        type="submit"
        data-testid="submit-report"
        disabled={pending}
        aria-disabled={pending}
      >
        {pending ? ui.submitting : definition.submitLabel}
      </button>
      {resumable ? (
        <button
          type="submit"
          name="__intent"
          value="save_draft"
          formNoValidate
          className="secondary"
          disabled={pending}
          aria-disabled={pending}
        >
          {pending ? ui.savingDraft : ui.saveDraft}
        </button>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {pending ? ui.submissionInProgress : ""}
      </span>
    </form>
    </>
  );
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

function descriptionIds(
  field: FormField,
  error?: string,
) {
  return [
    field.helpText ? `help-${field.id}` : null,
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
}: {
  ui: FormUiStrings;
  field: FormField;
  value?: unknown;
  error?: string;
  onValueChange: (value: unknown) => void;
}) {
  const required = field.required;
  const controlId = `field-${field.id}`;
  const describedBy = descriptionIds(field, error);

  switch (field.type) {
    case "long_text":
      return (
        <div>
          <label htmlFor={controlId}>
            {field.label}
            <RequiredIndicator required={required} text={ui.required} />
          </label>
          <textarea
            id={controlId}
            name={field.id}
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
          </label>
          <input
            id={controlId}
            name={field.id}
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
              name={field.id}
              type="checkbox"
              value="true"
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              checked={value === true}
              onChange={(event) => onValueChange(event.currentTarget.checked)}
            />
            {field.label}
            <RequiredIndicator required={required} text={ui.required} />
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
              name={field.id}
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
          </label>
          <select
            id={controlId}
            name={field.id}
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
          </legend>
          {(field.options ?? []).map((option) => (
            <label key={option.value}>
              <input
                name={field.id}
                type="checkbox"
                value={option.value}
                checked={
                  Array.isArray(value) &&
                  value.includes(option.value)
                }
                onChange={(event) => {
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
        />
      );

    case "file": {
      const publicUploadEnabled = Boolean(field.publicUpload);
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
          </legend>
          <input
            name={field.id}
            type="file"
            aria-labelledby={`legend-${field.id}`}
            disabled={!publicUploadEnabled}
            required={required && publicUploadEnabled}
            multiple={(field.maxFiles ?? 1) > 1}
            accept={field.acceptedMimeTypes?.join(",")}
            onChange={(event) =>
              onValueChange(
                Array.from(event.currentTarget.files ?? []).map(
                  (file) => file.name,
                ),
              )
            }
          />
          <small>
            {publicUploadEnabled
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
}: {
  ui: FormUiStrings;
  field: FormField;
  required: boolean;
  value?: unknown;
  error?: string;
  onValueChange: (value: unknown) => void;
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
                name={`${field.id}.${part}`}
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
