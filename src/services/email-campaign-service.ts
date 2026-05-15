/**
 * Email campaign service — powers the admin "Early Access" tab.
 *
 * Two responsibilities:
 *   1. Parse a Google-Forms CSV export into structured contact rows.
 *   2. Send a composed campaign to the early-access list via Resend.
 *
 * This is fully decoupled from app users — it only touches the EmailContact
 * and EmailCampaign collections.
 */
import { Resend } from "resend";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { escapeHtml } from "../lib/email";
import EmailContact, { IEmailContact } from "../models/EmailContact";

// ── CSV parsing ──────────────────────────────────────────────────────

/** A single parsed contact row, ready to upsert. */
export interface ParsedContactRow {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  excitedAbout?: string;
  hearAbout?: string;
  notify?: string;
  ethnicity?: string;
  country?: string;
  phoneType?: string;
  signedUpAt?: Date;
  /** True if the email value is present but doesn't pass basic validation. */
  needsReview?: boolean;
}

export interface CsvParseResult {
  rows: ParsedContactRow[];
  /** Rows that were dropped because they had no usable email address. */
  skipped: number;
  /** Short human-readable labels for the skipped rows so admins can fix them. */
  skippedRows: string[];
  /** Total data rows seen (excludes the header). */
  totalRows: number;
}

/**
 * RFC-4180-style CSV tokenizer. Handles quoted fields containing commas,
 * newlines, and escaped quotes ("") — all of which appear in Google Forms
 * exports (free-text answers, multi-line column headers).
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Normalise newlines so \r\n and \r both behave as \n.
  const src = text.replace(/\r\n?/g, "\n");

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // Flush the trailing field/row if the file didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A CSV column maps to one of these real input fields; never to `needsReview`,
 *  which is derived from the parsed email value, not pulled from a column. */
type ParsedCsvField = Exclude<keyof ParsedContactRow, "needsReview">;

/** Maps a CSV header cell to one of our known fields, or null if unknown. */
function classifyHeader(header: string): ParsedCsvField | null {
  const h = header.toLowerCase().replace(/[^a-z]/g, "");
  if (h.includes("timestamp")) return "signedUpAt";
  if (h.includes("firstname")) return "firstName";
  if (h.includes("lastname")) return "lastName";
  if (h.includes("emailaddress") || h === "email") return "email";
  if (h.includes("phonenumber")) return "phone";
  if (h.includes("excited")) return "excitedAbout";
  if (h.includes("hearabout")) return "hearAbout";
  if (h.includes("notified")) return "notify";
  if (h.includes("originallyfrom") || h.includes("ethnicity"))
    return "ethnicity";
  if (h.includes("currentlylive") || h.includes("country")) return "country";
  if (h.includes("typeofphone")) return "phoneType";
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse a raw Google-Forms CSV string into contact rows. Header matching is
 * fuzzy (case-insensitive, punctuation-stripped) so it survives the trailing
 * colons and parenthetical hints in the form's column labels.
 */
export function parseContactsCsv(text: string): CsvParseResult {
  const grid = parseCsv(text);
  if (grid.length < 2) {
    return { rows: [], skipped: 0, skippedRows: [], totalRows: 0 };
  }

  const headerRow = grid[0] ?? [];
  const columnMap = headerRow.map(classifyHeader);

  const rows: ParsedContactRow[] = [];
  const skippedRows: string[] = [];
  let totalRows = 0;

  for (let r = 1; r < grid.length; r += 1) {
    const cells = grid[r] ?? [];
    // Skip fully empty lines (common trailing artefact of CSV exports).
    if (cells.every((c) => c.trim() === "")) continue;
    totalRows += 1;

    const parsed: ParsedContactRow = { email: "" };
    for (let c = 0; c < columnMap.length; c += 1) {
      const field = columnMap[c];
      if (!field) continue;
      const value = (cells[c] ?? "").trim();
      if (!value) continue;
      if (field === "signedUpAt") {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) parsed.signedUpAt = date;
      } else {
        parsed[field] = value;
      }
    }

    const rawEmail = parsed.email.trim();
    if (rawEmail.length === 0) {
      // No email at all — there is nothing to key the contact by, so this row
      // genuinely has to be dropped. Surface it so admins can chase it down.
      const name = [parsed.firstName, parsed.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      skippedRows.push(`${name || `(row ${r + 1})`} — no email provided`);
      continue;
    }
    // Lowercase so the unique key is case-insensitive, but otherwise keep the
    // value exactly as the form respondent typed it (including stray spaces),
    // and flag it for review when it doesn't pass basic validation.
    parsed.email = rawEmail.toLowerCase();
    if (!EMAIL_RE.test(parsed.email)) parsed.needsReview = true;
    rows.push(parsed);
  }

  return { rows, skipped: skippedRows.length, skippedRows, totalRows };
}

// ── Campaign sending ─────────────────────────────────────────────────

let resendClient: Resend | null = null;
function getResend(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(env.RESEND_API_KEY);
  return resendClient;
}

/** Resend caps batch sends at 100 messages per request. */
const BATCH_SIZE = 100;

function personalize(template: string, contact: IEmailContact): string {
  const first = contact.firstName?.trim() || "there";
  const last = contact.lastName?.trim() || "";
  return template
    .replace(/\{\{\s*firstName\s*\}\}/gi, first)
    .replace(/\{\{\s*lastName\s*\}\}/gi, last);
}

/** Wrap the admin's plain-text body in a branded, responsive HTML shell. */
function renderHtml(body: string, unsubUrl: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => {
      const safe = escapeHtml(block.trim()).replace(/\n/g, "<br>");
      return `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#2b2b2b;">${safe}</p>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f1ec;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="background:#e8623c;padding:28px 32px;">
          <span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">Chefless</span>
        </td></tr>
        <tr><td style="padding:32px;">
          ${paragraphs}
        </td></tr>
        <tr><td style="padding:0 32px 32px;">
          <hr style="border:none;border-top:1px solid #ece8e1;margin:0 0 16px;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#9a948c;">
            You're receiving this because you signed up for early access to Chefless.<br>
            <a href="${unsubUrl}" style="color:#9a948c;">Unsubscribe</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function renderText(body: string, unsubUrl: string): string {
  return `${body.trim()}\n\n—\nYou're receiving this because you signed up for early access to Chefless.\nUnsubscribe: ${unsubUrl}`;
}

export interface CampaignSendResult {
  sentCount: number;
  failedCount: number;
  errorSummary?: string;
}

/**
 * Send a campaign to every supplied contact. The list is first deduped by
 * email — the same address may appear multiple times because each Google-Form
 * submission imports as its own EmailContact row, and we never want to send
 * the same person two copies of the same campaign. Splits into batches of
 * 100, personalizes per recipient, and attaches a List-Unsubscribe header so
 * the email is treated as legitimate bulk mail by inbox providers.
 *
 * After a successful batch, lastEmailedAt/emailsSent are updated on every row
 * sharing one of the batch's email addresses, so the admin UI consistently
 * shows "emailed" status for every duplicate row.
 *
 * Returns counts based on unique email addresses sent to; the caller persists
 * them on the EmailCampaign record.
 */
export async function sendCampaign(
  subject: string,
  body: string,
  contacts: IEmailContact[]
): Promise<CampaignSendResult> {
  // Dedupe by email — keep the first contact we see for each address so the
  // unsubscribe link is stable across re-sends (token on a specific row).
  const recipients: IEmailContact[] = [];
  const seenEmails = new Set<string>();
  for (const contact of contacts) {
    const key = contact.email.toLowerCase();
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    recipients.push(contact);
  }

  const client = getResend();
  if (!client) {
    return {
      sentCount: 0,
      failedCount: recipients.length,
      errorSummary: "RESEND_API_KEY is not configured on the server.",
    };
  }

  const from = env.MARKETING_EMAIL_FROM || env.ALERT_EMAIL_FROM;
  let sentCount = 0;
  let failedCount = 0;
  let errorSummary: string | undefined;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const payload = batch.map((contact) => {
      const unsubUrl = `${env.PUBLIC_BASE_URL}/email/unsubscribe?c=${contact._id.toString()}&t=${contact.unsubToken}`;
      return {
        from,
        to: [contact.email],
        subject: personalize(subject, contact),
        html: renderHtml(personalize(body, contact), unsubUrl),
        text: renderText(personalize(body, contact), unsubUrl),
        headers: {
          "List-Unsubscribe": `<${unsubUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };
    });

    try {
      const result = await client.batch.send(payload);
      if (result.error) {
        failedCount += batch.length;
        errorSummary = errorSummary || result.error.message;
        logger.error(
          { err: result.error, batchStart: i },
          "Resend rejected campaign batch"
        );
      } else {
        sentCount += batch.length;
        const emails = batch.map((c) => c.email.toLowerCase());
        await EmailContact.updateMany(
          { email: { $in: emails } },
          { $set: { lastEmailedAt: new Date() }, $inc: { emailsSent: 1 } }
        );
      }
    } catch (err) {
      failedCount += batch.length;
      errorSummary =
        errorSummary ||
        (err instanceof Error ? err.message : "Unknown send error");
      logger.error({ err, batchStart: i }, "Failed to send campaign batch");
    }
  }

  return { sentCount, failedCount, errorSummary };
}
