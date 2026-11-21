"use server";

import { redirect } from "next/navigation";
import { getRuntimeDatabase } from "@/db/runtime";
import {
  hasPermission,
  requireTenantScope,
} from "@/modules/auth/authorization";
import { getCurrentAuthorizationContext } from "@/modules/auth/server-session";
import { parseFormDefinition } from "@/modules/forms/definition";
import {
  createDraftFormVersion,
  createForm,
  publishFormVersion,
} from "@/modules/forms/repository";

import { SealingUnavailableError } from "@/modules/sealed/recipients";
import { SealedRoutingError } from "@/modules/sealed/policy";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function requireFormManager() {
  const context = await getCurrentAuthorizationContext();
  if (!context) redirect("/login");
  if (!context.tenantScope) redirect("/select-organization");
  if (!hasPermission(context, "form:manage")) redirect("/forbidden");
  return context;
}

function parseDefinitionJson(raw: string) {
  try {
    return parseFormDefinition(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function createFormAction(formData: FormData) {
  const context = await requireFormManager();
  const name = String(formData.get("name") ?? "").trim();
  const slug = String(formData.get("slug") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const accessModeRaw = String(formData.get("accessMode") ?? "public");
  const definition = parseDefinitionJson(
    String(formData.get("definition") ?? ""),
  );

  const accessMode =
    accessModeRaw === "authenticated" ? "authenticated" : "public";

  if (!name || !slugPattern.test(slug) || !definition) {
    redirect("/admin/forms?error=invalid_form");
  }

  const scope = requireTenantScope(context);

  try {
    const form = await createForm(getRuntimeDatabase(), scope, {
      name,
      slug,
      description: description || null,
      accessMode,
      createdByUserId: context.user.id,
    });

    await createDraftFormVersion(getRuntimeDatabase(), scope, {
      formId: form.id,
      definition,
      createdByUserId: context.user.id,
    });
  } catch {
    redirect("/admin/forms?error=create_failed");
  }

  redirect("/admin/forms");
}

export async function createDraftVersionAction(formData: FormData) {
  const context = await requireFormManager();
  const formId = String(formData.get("formId") ?? "");
  const definition = parseDefinitionJson(
    String(formData.get("definition") ?? ""),
  );

  if (!formId || !definition) {
    redirect("/admin/forms?error=invalid_definition");
  }

  try {
    await createDraftFormVersion(
      getRuntimeDatabase(),
      requireTenantScope(context),
      {
        formId,
        definition,
        createdByUserId: context.user.id,
      },
    );
  } catch {
    redirect("/admin/forms?error=create_version_failed");
  }

  redirect("/admin/forms");
}

export async function publishVersionAction(formData: FormData) {
  const context = await requireFormManager();
  const versionId = String(formData.get("versionId") ?? "");

  if (!versionId) {
    redirect("/admin/forms?error=invalid_version");
  }

  try {
    await publishFormVersion(
      getRuntimeDatabase(),
      requireTenantScope(context),
      versionId,
      context.user.id,
    );
  } catch (error) {
    if (error instanceof SealingUnavailableError) {
      redirect("/admin/forms?error=sealing_unavailable");
    }
    if (error instanceof SealedRoutingError) {
      redirect("/admin/forms?error=sealed_field_used_by_routing");
    }
    redirect("/admin/forms?error=publish_failed");
  }

  redirect("/admin/forms");
}
