import type { ValidationError } from "./validation";

export interface PublicFormActionState {
  status:
    | "idle"
    | "validation_error"
    | "submitted"
    | "draft_saved"
    | "draft_loaded"
    | "draft_not_found";
  errors: ValidationError[];
  confirmationCode?: string;
  /** Present once after a draft is first saved; shown to the participant. */
  resumeCode?: string;
  /** Ordinary (non-protected, non-file) answers of a loaded draft. */
  draftAnswers?: Record<string, unknown>;
  participantPortal?: {
    trackingCode: string;
    accessSecret: string;
    loginPath: string;
  } | null;
}

export const initialPublicFormActionState: PublicFormActionState = {
  status: "idle",
  errors: [],
  participantPortal: null,
};
