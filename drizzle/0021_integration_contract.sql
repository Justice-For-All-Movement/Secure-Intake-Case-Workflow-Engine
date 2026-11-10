-- Integration contract: ordered event feed, original-account immutability,
-- request idempotency, service actors, identity links, locale and digest.

CREATE SEQUENCE IF NOT EXISTS "audit_events_sequence_seq";
--> statement-breakpoint
ALTER TABLE "audit_events"
  ADD COLUMN IF NOT EXISTS "sequence" bigint NOT NULL DEFAULT nextval('audit_events_sequence_seq'),
  ADD COLUMN IF NOT EXISTS "txid" bigint NOT NULL DEFAULT txid_current(),
  ADD COLUMN IF NOT EXISTS "event_type" text;
--> statement-breakpoint
ALTER SEQUENCE "audit_events_sequence_seq" OWNED BY "audit_events"."sequence";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_events_sequence_idx"
  ON "audit_events" ("sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_feed_idx"
  ON "audit_events" ("organization_id", "txid", "sequence");
--> statement-breakpoint

-- Stable public event names. Internal audit action names stay unchanged.
CREATE OR REPLACE FUNCTION integration_event_type(
  action text,
  source text,
  new_state jsonb
) RETURNS text AS $$
  SELECT CASE
    WHEN action = 'submission.received' THEN 'submission.created'
    WHEN action = 'case.created' THEN 'case.opened'
    WHEN action = 'document.scan_recorded' THEN
      CASE new_state ->> 'malwareScanStatus'
        WHEN 'clean' THEN 'attachment.released'
        WHEN 'infected' THEN 'attachment.blocked'
        ELSE 'attachment.scan_failed'
      END
    WHEN action = 'correspondence.received' AND source = 'participant_portal'
      THEN 'participant.message.received'
    ELSE action
  END
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION assign_audit_event_type()
RETURNS trigger AS $$
BEGIN
  NEW.event_type := integration_event_type(NEW.action, NEW.source, NEW.new_state);
  NEW.txid := txid_current();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_assign_event_type ON "audit_events";
--> statement-breakpoint
CREATE TRIGGER audit_events_assign_event_type
BEFORE INSERT ON "audit_events"
FOR EACH ROW
EXECUTE FUNCTION assign_audit_event_type();
--> statement-breakpoint
ALTER TABLE "audit_events" DISABLE TRIGGER audit_events_immutable;
--> statement-breakpoint
UPDATE "audit_events"
  SET "event_type" = integration_event_type("action", "source", "new_state")
  WHERE "event_type" IS NULL;
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE TRIGGER audit_events_immutable;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION fanout_audit_event_webhooks()
RETURNS trigger AS $$
BEGIN
  IF NEW.action LIKE 'webhook.delivery.%' THEN
    RETURN NEW;
  END IF;

  WITH created AS (
    INSERT INTO "webhook_deliveries" (
      "organization_id",
      "subscription_id",
      "audit_event_id"
    )
    SELECT
      NEW.organization_id,
      subscription.id,
      NEW.id
    FROM "webhook_subscriptions" AS subscription
    WHERE subscription.organization_id = NEW.organization_id
      AND subscription.status = 'active'
      AND (
        subscription.event_types ? NEW.action
        OR subscription.event_types ? COALESCE(NEW.event_type, NEW.action)
        OR subscription.event_types ? '*'
      )
    ON CONFLICT DO NOTHING
    RETURNING "id", "organization_id"
  )
  INSERT INTO "background_jobs" (
    "organization_id",
    "job_type",
    "payload",
    "priority",
    "dedupe_key",
    "max_attempts"
  )
  SELECT
    created.organization_id,
    'webhook.deliver',
    jsonb_build_object('deliveryId', created.id),
    40,
    'webhook:' || created.id::text,
    8
  FROM created
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Original account: a submitted account can never be rewritten.
ALTER TABLE "intake_submissions"
  ADD COLUMN IF NOT EXISTS "locale" text,
  ADD COLUMN IF NOT EXISTS "original_sha256" text,
  ADD COLUMN IF NOT EXISTS "channel" text NOT NULL DEFAULT 'public_form';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_submitted_original_account()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'submitted'
       AND EXISTS (SELECT 1 FROM "organizations" WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'A submitted original account cannot be deleted.'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'submitted' AND (
       NEW.answers IS DISTINCT FROM OLD.answers
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.form_id IS DISTINCT FROM OLD.form_id
    OR NEW.form_version_id IS DISTINCT FROM OLD.form_version_id
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.confirmation_code IS DISTINCT FROM OLD.confirmation_code
    OR NEW.locale IS DISTINCT FROM OLD.locale
    OR NEW.channel IS DISTINCT FROM OLD.channel
    OR NEW.original_sha256 IS DISTINCT FROM OLD.original_sha256
  ) THEN
    RAISE EXCEPTION 'A submitted original account is immutable.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS intake_submissions_preserve_original ON "intake_submissions";
--> statement-breakpoint
CREATE TRIGGER intake_submissions_preserve_original
BEFORE UPDATE OR DELETE ON "intake_submissions"
FOR EACH ROW
EXECUTE FUNCTION preserve_submitted_original_account();
--> statement-breakpoint

-- Service actors and acknowledged feed position for API clients.
ALTER TABLE "api_clients"
  ADD COLUMN IF NOT EXISTS "service_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "acknowledged_event_cursor" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "api_idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "api_client_id" uuid NOT NULL REFERENCES "api_clients"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "request_method" text NOT NULL,
  "request_path" text NOT NULL,
  "request_sha256" text NOT NULL,
  "response_status" integer,
  "response_body" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  CONSTRAINT "api_idempotency_keys_key_length"
    CHECK (length("idempotency_key") BETWEEN 8 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_idempotency_keys_client_key_idx"
  ON "api_idempotency_keys" ("api_client_id", "idempotency_key");
--> statement-breakpoint

-- Mapping of a submission's participant to an external identity-provider subject.
CREATE TABLE IF NOT EXISTS "participant_identity_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "submission_id" uuid NOT NULL REFERENCES "intake_submissions"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "subject" text NOT NULL,
  "created_by_api_client_id" uuid REFERENCES "api_clients"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "participant_identity_links_provider_check"
    CHECK ("provider" ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'),
  CONSTRAINT "participant_identity_links_subject_check"
    CHECK (length("subject") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "participant_identity_links_submission_provider_idx"
  ON "participant_identity_links" ("submission_id", "provider");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "participant_identity_links_subject_idx"
  ON "participant_identity_links" ("organization_id", "provider", "subject");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_participant_identity_link_tenant()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "intake_submissions"
    WHERE id = NEW.submission_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Participant identity link must match the submission organization.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS participant_identity_links_tenant_trigger ON "participant_identity_links";
--> statement-breakpoint
CREATE TRIGGER participant_identity_links_tenant_trigger
BEFORE INSERT OR UPDATE ON "participant_identity_links"
FOR EACH ROW
EXECUTE FUNCTION enforce_participant_identity_link_tenant();
--> statement-breakpoint

-- Case-level ad hoc deadlines set by staff or services use trigger_type 'manual'.
-- (No schema change: recorded here to document the reserved value.)
SELECT 1;
