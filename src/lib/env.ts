import { z } from "zod";

const applicationBaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.search &&
      !url.hash
    );
  }, "APP_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment.");

const schema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .or(z.string().startsWith("postgres://"))
    .optional(),
  APP_BASE_URL: applicationBaseUrlSchema.default("http://localhost:3000"),
  AUTH_SESSION_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .default("sicwe_session"),
  AUTH_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  PARTICIPANT_SESSION_COOKIE_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .default("sicwe_participant_session"),
  PARTICIPANT_SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .max(168)
    .default(8),
  AUTH_LOGIN_FAILURE_LIMIT: z.coerce.number().int().min(2).max(100).default(5),
  AUTH_LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().max(1440).default(15),
  AUTH_LOGIN_BLOCK_MINUTES: z.coerce.number().int().positive().max(1440).default(15),
  AUTH_TRUST_PROXY_HEADERS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  BACKGROUND_JOB_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  BACKGROUND_JOB_POLL_MS: z.coerce.number().int().positive().default(1000),
  BACKGROUND_JOB_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),
  BACKGROUND_DEADLINE_SWEEP_SECONDS: z.coerce.number().int().positive().default(60),
  API_DEFAULT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(10000).default(120),
  PUBLIC_DRAFT_CREATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(10000).default(30),
  WEBHOOK_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  PROTECTED_DATA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});

export const env = schema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AUTH_SESSION_COOKIE_NAME: process.env.AUTH_SESSION_COOKIE_NAME,
  AUTH_SESSION_TTL_HOURS: process.env.AUTH_SESSION_TTL_HOURS,
  PARTICIPANT_SESSION_COOKIE_NAME:
    process.env.PARTICIPANT_SESSION_COOKIE_NAME,
  PARTICIPANT_SESSION_TTL_HOURS:
    process.env.PARTICIPANT_SESSION_TTL_HOURS,
  AUTH_LOGIN_FAILURE_LIMIT: process.env.AUTH_LOGIN_FAILURE_LIMIT,
  AUTH_LOGIN_WINDOW_MINUTES: process.env.AUTH_LOGIN_WINDOW_MINUTES,
  AUTH_LOGIN_BLOCK_MINUTES: process.env.AUTH_LOGIN_BLOCK_MINUTES,
  AUTH_TRUST_PROXY_HEADERS: process.env.AUTH_TRUST_PROXY_HEADERS,
  BACKGROUND_JOB_LEASE_SECONDS: process.env.BACKGROUND_JOB_LEASE_SECONDS,
  BACKGROUND_JOB_POLL_MS: process.env.BACKGROUND_JOB_POLL_MS,
  BACKGROUND_JOB_BATCH_SIZE: process.env.BACKGROUND_JOB_BATCH_SIZE,
  BACKGROUND_DEADLINE_SWEEP_SECONDS:
    process.env.BACKGROUND_DEADLINE_SWEEP_SECONDS,
  API_DEFAULT_RATE_LIMIT_PER_MINUTE:
    process.env.API_DEFAULT_RATE_LIMIT_PER_MINUTE,
  PUBLIC_DRAFT_CREATE_LIMIT_PER_HOUR:
    process.env.PUBLIC_DRAFT_CREATE_LIMIT_PER_HOUR || undefined,
  WEBHOOK_ENCRYPTION_KEY:
    process.env.WEBHOOK_ENCRYPTION_KEY || undefined,
  PROTECTED_DATA_ENCRYPTION_KEY:
    process.env.PROTECTED_DATA_ENCRYPTION_KEY || undefined,
});
