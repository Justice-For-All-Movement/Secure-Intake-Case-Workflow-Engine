-- Sealed submissions: answers and files a participant's form marks `sealed`
-- are encrypted in the participant's browser to the deployment's sealing
-- recipients (public keys only). This table holds the ciphertext envelope;
-- the application has no key that opens it.
CREATE TABLE IF NOT EXISTS "submission_sealed_envelopes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "submission_id" uuid NOT NULL REFERENCES "intake_submissions"("id") ON DELETE CASCADE,
  "envelope_json" text NOT NULL,
  "commitment" text NOT NULL,
  "recipient_key_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "size_bytes" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "submission_sealed_envelopes_commitment_check"
    CHECK ("commitment" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "submission_sealed_envelopes_format_check"
    CHECK (left("envelope_json", 21) = '{"format":"pam-sealed'),
  CONSTRAINT "submission_sealed_envelopes_recipients_check"
    CHECK (jsonb_typeof("recipient_key_ids") = 'array' AND jsonb_array_length("recipient_key_ids") BETWEEN 1 AND 50),
  CONSTRAINT "submission_sealed_envelopes_size_check"
    CHECK ("size_bytes" > 0 AND "size_bytes" <= 41000000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submission_sealed_envelopes_org_idx"
  ON "submission_sealed_envelopes" ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "submission_sealed_envelopes_submission_idx"
  ON "submission_sealed_envelopes" ("submission_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_submission_sealed_envelope"()
RETURNS trigger
LANGUAGE plpgsql
AS $sealed_envelope$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A sealed envelope is immutable.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "intake_submissions" s
      WHERE s."id" = OLD."submission_id" AND s."status" = 'submitted'
    ) AND EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organization_id") THEN
      RAISE EXCEPTION 'A sealed envelope of a submitted account cannot be deleted.'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "intake_submissions" s
    WHERE s."id" = NEW."submission_id"
      AND s."organization_id" = NEW."organization_id"
      AND s."status" = 'submitted'
  ) THEN
    RAISE EXCEPTION 'A sealed envelope belongs to a submitted submission of the same organization.';
  END IF;
  RETURN NEW;
END;
$sealed_envelope$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "submission_sealed_envelopes_guard"
  ON "submission_sealed_envelopes";
--> statement-breakpoint
CREATE TRIGGER "submission_sealed_envelopes_guard"
BEFORE INSERT OR UPDATE OR DELETE
ON "submission_sealed_envelopes"
FOR EACH ROW
EXECUTE FUNCTION "enforce_submission_sealed_envelope"();
