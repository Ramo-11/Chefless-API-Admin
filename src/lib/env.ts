import "dotenv/config";
import { z } from "zod";

const nodeEnvSchema = z.enum(["development", "production", "test"]);

/**
 * ALLOWED_ORIGINS is a comma-separated list of origins that are permitted
 * for browser CORS access. Each origin must be a valid absolute URL.
 * Empty / unset in production is allowed by schema but is guarded at runtime
 * in `index.ts` (browsers get `origin: false`).
 */
const allowedOriginsSchema = z
  .string()
  .optional()
  .transform((val) => {
    if (!val) return [] as string[];
    return val
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  })
  .refine(
    (origins) =>
      origins.every((o) => {
        try {
          // eslint-disable-next-line no-new
          new URL(o);
          return true;
        } catch {
          return false;
        }
      }),
    {
      message:
        "ALLOWED_ORIGINS must be a comma-separated list of absolute URLs (e.g. https://app.example.com,https://admin.example.com)",
    }
  );

const envSchema = z.object({
  NODE_ENV: nodeEnvSchema.default("development"),
  PORT: z.coerce.number().default(3001),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  CLOUDINARY_CLOUD_NAME: z.string().min(1, "CLOUDINARY_CLOUD_NAME is required"),
  CLOUDINARY_API_KEY: z.string().min(1, "CLOUDINARY_API_KEY is required"),
  CLOUDINARY_API_SECRET: z.string().min(1, "CLOUDINARY_API_SECRET is required"),
  FIREBASE_PROJECT_ID: z.string().min(1, "FIREBASE_PROJECT_ID is required"),
  FIREBASE_SERVICE_ACCOUNT_KEY: z.string().optional(),
  REVENUECAT_WEBHOOK_SECRET: z
    .string()
    .min(1, "REVENUECAT_WEBHOOK_SECRET is required"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),
  /** Optional — AI Recipe Helper returns 503 when unset */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Optional — comma-separated list of browser origins permitted via CORS */
  ALLOWED_ORIGINS: allowedOriginsSchema,
  /** Optional — Resend API key for transactional emails (crash alerts). */
  RESEND_API_KEY: z.string().optional(),
  /** Optional — `from` address for outbound alert emails. Accepts either a
   * bare email (`alerts@chefless.org`) or RFC-style display name format
   * (`Chefless Alerts <alerts@chefless.org>`). Resend supports both. */
  ALERT_EMAIL_FROM: z
    .string()
    .refine(
      (val) => {
        const bare = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const display = /^.+<[^\s@]+@[^\s@]+\.[^\s@]+>$/;
        return bare.test(val) || display.test(val.trim());
      },
      { message: "must be a valid email or 'Name <email@addr>' format" }
    )
    .optional()
    .default("Chefless Alerts <alerts@chefless.org>"),
  /** Optional — comma-separated `to` addresses for crash alerts. */
  ALERT_EMAIL_TO: z
    .string()
    .optional()
    .default("admin@chefless.org")
    .transform((val) =>
      val
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    ),
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Environment validation failed:\n${formatted}`);
    process.exit(1);
  }

  const parsed = result.data;

  // Production safety: if browser access is expected but no origins are
  // configured, surface a loud warning. The runtime in index.ts will still
  // refuse browser requests — this makes the misconfiguration discoverable.
  if (parsed.NODE_ENV === "production" && parsed.ALLOWED_ORIGINS.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[env] ALLOWED_ORIGINS is empty in production — browser CORS will be refused. " +
        "Set ALLOWED_ORIGINS to a comma-separated list of absolute URLs to allow web clients."
    );
  }

  return parsed;
}

export const env: Env = validateEnv();
