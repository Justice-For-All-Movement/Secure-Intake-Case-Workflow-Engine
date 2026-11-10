import { headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  localeDisplayName,
  localizeFormDefinition,
  parseAcceptLanguage,
  resolveFormLocale,
} from "@/modules/forms/localization";
import { getRuntimeDatabase } from "@/db/runtime";
import { FormRenderer } from "@/components/forms/form-renderer";
import { fieldsInDefinition } from "@/modules/forms/definition";
import { findApplicationProfileByOrganizationSlug } from "@/modules/application/repository";
import { findPublishedFormBySlugs } from "@/modules/forms/repository";
import { submitPublicFormAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function PublicIntakePage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string; formSlug: string }>;
  searchParams?: Promise<{ lang?: string | string[] }>;
}) {
  const { organizationSlug, formSlug } = await params;
  const query = (await searchParams) ?? {};
  const requestedLocale = Array.isArray(query.lang)
    ? query.lang[0]
    : query.lang;

  const db = getRuntimeDatabase();
  const [published, application] = await Promise.all([
    findPublishedFormBySlugs(
      db,
      organizationSlug,
      formSlug,
      { publicOnly: true },
    ),
    findApplicationProfileByOrganizationSlug(db, organizationSlug),
  ]);

  if (!published) {
    notFound();
  }

  const branding = application?.profile?.branding ?? {};
  const logoUrl =
    typeof branding.logoUrl === "string" &&
    (branding.logoUrl.startsWith("/") ||
      branding.logoUrl.startsWith("https://"))
      ? branding.logoUrl
      : null;
  const accentColor =
    typeof branding.accentColor === "string" &&
    /^#[0-9a-f]{6}$/i.test(branding.accentColor)
      ? branding.accentColor
      : null;
  const homeTitle =
    typeof branding.homeTitle === "string"
      ? branding.homeTitle
      : null;
  const homeDescription =
    typeof branding.homeDescription === "string"
      ? branding.homeDescription
      : null;
  const applicationName =
    application?.profile?.applicationName ??
    published.organization.name;

  const action = submitPublicFormAction.bind(
    null,
    organizationSlug,
    formSlug,
  );
  // A required file field can only be satisfied when public upload is bound.
  const requiresAttachmentAdapter = fieldsInDefinition(
    published.definition,
  ).some(
    (field) => field.type === "file" && field.required && !field.publicUpload,
  );
  const localized = localizeFormDefinition(
    published.definition,
    resolveFormLocale(published.definition, [
      requestedLocale,
      ...parseAcceptLanguage((await headers()).get("accept-language")),
    ]),
  );
  const formName = localized.name ?? published.form.name;
  const formDescription =
    localized.description ?? published.form.description;
  const basePath = `/intake/${encodeURIComponent(
    organizationSlug,
  )}/${encodeURIComponent(formSlug)}`;

  return (
    <main
      lang={localized.locale}
      dir={localized.direction}
      style={
        accentColor
          ? { borderTop: `4px solid ${accentColor}`, paddingTop: "1rem" }
          : undefined
      }
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          style={{ maxHeight: "64px", maxWidth: "240px" }}
        />
      ) : null}
      {localized.availableLocales.length > 1 ? (
        <nav aria-label={localized.ui.language} className="language-switcher">
          <ul>
            {localized.availableLocales.map((locale) => (
              <li key={locale}>
                <a
                  href={`${basePath}?lang=${encodeURIComponent(locale)}`}
                  lang={locale}
                  hrefLang={locale}
                  aria-current={
                    locale === localized.locale ? "page" : undefined
                  }
                >
                  {localeDisplayName(locale)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <h1>{homeTitle ?? formName}</h1>
      {homeDescription ? <p>{homeDescription}</p> : null}
      {homeTitle ? <h2>{formName}</h2> : null}
      {formDescription ? <p>{formDescription}</p> : null}
      <p>This form is provided by {applicationName}.</p>
      <details>
        <summary>Form information</summary>
        <p>Published form version {published.version.versionNumber}.</p>
      </details>

      {requiresAttachmentAdapter ? (
        <p role="alert">
          This form requires secure attachments. The generic intake renderer
          cannot accept it until the document/evidence storage adapter is
          configured.
        </p>
      ) : (
        <FormRenderer
          definition={localized.definition}
          action={action}
          ui={localized.ui}
          locale={localized.locale}
        />
      )}
    </main>
  );
}
