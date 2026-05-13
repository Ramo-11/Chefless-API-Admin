import { Resend } from "resend";
import { env } from "./env";
import { logger } from "./logger";

let client: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

export interface SendEmailInput {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

/**
 * Send an email through Resend. No-ops when RESEND_API_KEY is unset so the
 * app stays deployable without email credentials; the caller still records the
 * underlying event in the database, so we never silently drop signal.
 */
export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const c = getClient();
  if (!c) {
    logger.warn(
      { to: input.to, subject: input.subject },
      "Email not sent — RESEND_API_KEY is unset"
    );
    return false;
  }
  if (env.ALERT_EMAIL_TO.length === 0) {
    logger.warn({ subject: input.subject }, "Email not sent — no recipients");
    return false;
  }
  try {
    const result = await c.emails.send({
      from: env.ALERT_EMAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    if (result.error) {
      logger.error(
        { err: result.error, to: input.to, subject: input.subject },
        "Resend rejected email"
      );
      return false;
    }
    logger.info(
      { id: result.data?.id, to: input.to, subject: input.subject },
      "Email sent"
    );
    return true;
  } catch (err) {
    logger.error(
      { err, to: input.to, subject: input.subject },
      "Failed to send email"
    );
    return false;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
