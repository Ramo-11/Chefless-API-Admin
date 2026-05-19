/**
 * Admin "Early Access" tab — manages the early-signup email list.
 *
 * This list is fully separate from app users: it lives in the EmailContact
 * collection and is populated by importing the Google Form CSV. Admins can
 * import contacts, manage subscription status, compose a campaign, and send it
 * to every subscribed contact via Resend (see email-campaign-service.ts).
 */
import { Request, Response } from "express";
import { Types } from "mongoose";
import { logger } from "../../lib/logger";
import AuditLog from "../../models/AuditLog";
import EmailContact from "../../models/EmailContact";
import EmailCampaign from "../../models/EmailCampaign";
import {
  parseContactsCsv,
  personalize,
  renderHtml,
  sendCampaign,
} from "../../services/email-campaign-service";
import { env } from "../../lib/env";

const PAGE_SIZE = 25;
// The admin router parses JSON bodies at a 1 MB limit, which comfortably fits
// a few thousand contact rows. Larger lists can be imported in multiple files —
// the import is an idempotent upsert by email, so re-running never duplicates.
const MAX_CSV_BYTES = 1024 * 1024;

async function audit(
  req: Request,
  action: string,
  targetType: string,
  targetId?: string,
  details?: Record<string, unknown>
): Promise<void> {
  AuditLog.create({
    adminId: req.session.adminId ?? "unknown",
    adminEmail: req.session.adminEmail ?? "unknown",
    action,
    targetType,
    targetId,
    details,
    ipAddress: req.ip,
  }).catch((err: unknown) => {
    logger.error({ err }, "Audit log failed");
  });
}

/** GET /admin/early-access — list page with stats, contacts, and campaigns. */
export async function earlyAccessPage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const search = ((req.query.search as string) || "").trim();
    const statusFilter = (req.query.status as string) || "all";

    const query: Record<string, unknown> = {};
    if (statusFilter === "needsReview") query.needsReview = true;
    else if (statusFilter !== "all") query.status = statusFilter;
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(safe, "i");
      query.$or = [{ email: rx }, { firstName: rx }, { lastName: rx }];
    }

    const skip = (page - 1) * PAGE_SIZE;

    // readyToSendCount must count unique email addresses, not contact rows —
    // sendCampaign dedupes by email and only sends one message per address,
    // so showing "80 subscribed contacts" when there are only 77 unique
    // emails would be misleading.
    const [
      contacts,
      total,
      stats,
      needsReviewCount,
      readyToSendEmails,
      campaigns,
    ] = await Promise.all([
      EmailContact.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(PAGE_SIZE)
        .lean(),
      EmailContact.countDocuments(query),
      EmailContact.aggregate<{ _id: string; count: number }>([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      EmailContact.countDocuments({ needsReview: true }),
      EmailContact.distinct("email", {
        status: "subscribed",
        needsReview: { $ne: true },
      }),
      EmailCampaign.find().sort({ createdAt: -1 }).limit(20).lean(),
    ]);
    const readyToSendCount = readyToSendEmails.length;

    const counts = { subscribed: 0, unsubscribed: 0, bounced: 0 };
    for (const s of stats) {
      if (s._id in counts) counts[s._id as keyof typeof counts] = s.count;
    }
    const totalContacts =
      counts.subscribed + counts.unsubscribed + counts.bounced;

    res.render("early-access", {
      page: "early-access",
      pageTitle: "Early Access",
      contacts,
      campaigns,
      counts,
      needsReviewCount,
      readyToSendCount,
      totalContacts,
      search,
      statusFilter,
      pagination: {
        current: page,
        total: Math.max(1, Math.ceil(total / PAGE_SIZE)),
        totalItems: total,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load early-access page");
    res.status(500).send("Internal server error");
  }
}

/** POST /admin/api/early-access/import — parse CSV text and upsert contacts. */
export async function importContacts(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { csv } = req.body as { csv?: unknown };
    if (typeof csv !== "string" || csv.trim().length === 0) {
      res.status(400).json({ error: "No CSV content was provided." });
      return;
    }
    if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) {
      res
        .status(413)
        .json({ error: "CSV is too large. Split it into smaller files." });
      return;
    }

    const { rows, skipped, skippedRows, totalRows } = parseContactsCsv(csv);
    if (rows.length === 0) {
      res.status(400).json({
        error:
          "No valid contacts found. Make sure the file is the Google Form CSV export with an email column.",
      });
      return;
    }

    let imported = 0;
    let updated = 0;
    let flagged = 0;
    for (const row of rows) {
      const { email, needsReview, signedUpAt, ...rest } = row;
      if (needsReview) flagged += 1;
      // Each form submission becomes its own row, keyed by (email, signedUpAt)
      // so the same person submitting the form twice creates two contacts.
      // Sends/unsubs dedupe by email. Rows without a timestamp (rare; only
      // legacy data or a malformed CSV) fall back to email-only upsert.
      const filter: Record<string, unknown> = signedUpAt
        ? { email, signedUpAt }
        : { email };
      // Only set fields that actually have a value, so a re-import never wipes
      // existing data with blank cells. `needsReview` is set explicitly each
      // time so that fixing the form and re-importing clears the flag.
      const set: Record<string, unknown> = { needsReview: needsReview === true };
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined && value !== "") set[key] = value;
      }
      if (signedUpAt) set.signedUpAt = signedUpAt;
      const result = await EmailContact.updateOne(
        filter,
        { $set: set, $setOnInsert: { email, source: "google_form" } },
        { upsert: true }
      );
      if (result.upsertedCount > 0) imported += 1;
      else if (result.modifiedCount > 0) updated += 1;
    }

    await audit(req, "import_email_contacts", "email_contact", undefined, {
      imported,
      updated,
      flagged,
      skipped,
      totalRows,
    });

    const parts = [`${imported} new`, `${updated} updated`];
    if (flagged > 0) parts.push(`${flagged} flagged for review`);
    if (skipped > 0) parts.push(`${skipped} dropped (no email)`);
    const message = `Imported ${parts.join(', ')}.`;

    res.json({
      success: true,
      imported,
      updated,
      flagged,
      skipped,
      skippedRows,
      totalRows,
      message,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to import email contacts");
    res.status(500).json({ error: "Failed to import contacts." });
  }
}

/** POST /admin/api/early-access/contacts/:id/toggle — flip subscribed state. */
export async function toggleContactStatus(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const id = req.params.id as string;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid contact id." });
      return;
    }
    const contact = await EmailContact.findById(id);
    if (!contact) {
      res.status(404).json({ error: "Contact not found." });
      return;
    }
    const nextStatus =
      contact.status === "subscribed" ? "unsubscribed" : "subscribed";
    // Cascade by email: the same person may appear as multiple rows (one per
    // Google-Form submission). Flipping one row's status must flip all of
    // them, otherwise sends would still target the duplicates.
    await EmailContact.updateMany(
      { email: contact.email },
      { $set: { status: nextStatus } }
    );

    await audit(req, "toggle_email_contact_status", "email_contact", id, {
      email: contact.email,
      status: nextStatus,
    });

    res.json({ success: true, status: nextStatus });
  } catch (error) {
    logger.error({ err: error }, "Failed to toggle contact status");
    res.status(500).json({ error: "Failed to update contact." });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LEN = 120;
const MAX_PHONE_LEN = 40;

/**
 * POST /admin/api/early-access/contacts — manually add a single contact.
 * Email is required (it's an email list); first/last name and phone are optional.
 */
export async function addContact(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const body = req.body as {
      email?: unknown;
      firstName?: unknown;
      lastName?: unknown;
      phone?: unknown;
    };

    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: "A valid email address is required." });
      return;
    }

    const str = (v: unknown, max: number): string | undefined => {
      if (typeof v !== "string") return undefined;
      const trimmed = v.trim();
      return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
    };

    const existing = await EmailContact.findOne({ email }).lean();
    if (existing) {
      res
        .status(409)
        .json({ error: "A contact with that email is already on the list." });
      return;
    }

    const contact = await EmailContact.create({
      email,
      firstName: str(body.firstName, MAX_NAME_LEN),
      lastName: str(body.lastName, MAX_NAME_LEN),
      phone: str(body.phone, MAX_PHONE_LEN),
      source: "manual",
    });

    await audit(req, "add_email_contact", "email_contact", contact._id.toString(), {
      email,
    });

    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to add email contact");
    res.status(500).json({ error: "Failed to add contact." });
  }
}

/**
 * PATCH /admin/api/early-access/contacts/:id — edit any of name/email/phone.
 * Only provided fields are written. Editing the email re-evaluates the
 * `needsReview` flag, so cleaning up a typo here clears the warning badge.
 */
export async function updateContact(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const id = req.params.id as string;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid contact id." });
      return;
    }
    const body = req.body as {
      firstName?: unknown;
      lastName?: unknown;
      email?: unknown;
      phone?: unknown;
    };

    const update: Record<string, unknown> = {};
    const unset: Record<string, unknown> = {};

    const applyOptional = (
      key: "firstName" | "lastName" | "phone",
      max: number
    ): void => {
      const v = body[key];
      if (v === undefined) return;
      if (typeof v !== "string") return;
      const trimmed = v.trim();
      if (trimmed.length === 0) unset[key] = "";
      else update[key] = trimmed.slice(0, max);
    };
    applyOptional("firstName", MAX_NAME_LEN);
    applyOptional("lastName", MAX_NAME_LEN);
    applyOptional("phone", MAX_PHONE_LEN);

    if (typeof body.email === "string") {
      const email = body.email.trim().toLowerCase();
      if (email.length === 0) {
        res.status(400).json({ error: "Email cannot be empty." });
        return;
      }
      update.email = email;
      update.needsReview = !EMAIL_RE.test(email);
    }

    if (Object.keys(update).length === 0 && Object.keys(unset).length === 0) {
      res.status(400).json({ error: "Nothing to update." });
      return;
    }

    const mongoUpdate: Record<string, unknown> = {};
    if (Object.keys(update).length > 0) mongoUpdate.$set = update;
    if (Object.keys(unset).length > 0) mongoUpdate.$unset = unset;

    try {
      const contact = await EmailContact.findByIdAndUpdate(id, mongoUpdate, {
        new: true,
        runValidators: true,
      });
      if (!contact) {
        res.status(404).json({ error: "Contact not found." });
        return;
      }
      await audit(req, "update_email_contact", "email_contact", id, {
        fields: Object.keys(update).concat(Object.keys(unset)),
      });
      res.json({ success: true });
    } catch (err) {
      if (
        err !== null &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: number }).code === 11000
      ) {
        res.status(409).json({
          error:
            "Another contact already has that email. Delete or merge one of them first.",
        });
        return;
      }
      throw err;
    }
  } catch (error) {
    logger.error({ err: error }, "Failed to update email contact");
    res.status(500).json({ error: "Failed to update contact." });
  }
}

/** DELETE /admin/api/early-access/contacts/:id — permanently remove a contact. */
export async function deleteContact(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const id = req.params.id as string;
    if (!id || !Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid contact id." });
      return;
    }
    const contact = await EmailContact.findByIdAndDelete(id);
    if (!contact) {
      res.status(404).json({ error: "Contact not found." });
      return;
    }
    await audit(req, "delete_email_contact", "email_contact", id, {
      email: contact.email,
    });
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to delete contact");
    res.status(500).json({ error: "Failed to delete contact." });
  }
}

/**
 * POST /admin/api/early-access/send — send a campaign. By default it goes to
 * every subscribed contact; pass `contactIds` to send to a hand-picked subset.
 * Unsubscribed/bounced contacts are always excluded, even if explicitly picked.
 * Persists an EmailCampaign record with the outcome.
 */
export async function sendCampaignToList(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { subject, body, contactIds } = req.body as {
      subject?: unknown;
      body?: unknown;
      contactIds?: unknown;
    };
    const trimmedSubject =
      typeof subject === "string" ? subject.trim() : "";
    const trimmedBody = typeof body === "string" ? body.trim() : "";

    if (trimmedSubject.length === 0 || trimmedSubject.length > 200) {
      res
        .status(400)
        .json({ error: "Subject is required and must be under 200 characters." });
      return;
    }
    if (trimmedBody.length === 0 || trimmedBody.length > 20000) {
      res
        .status(400)
        .json({ error: "Message body is required and must be under 20,000 characters." });
      return;
    }

    // Resolve the audience: a non-empty contactIds array means "selected only".
    let selectedIds: string[] | null = null;
    if (contactIds !== undefined && contactIds !== null) {
      if (
        !Array.isArray(contactIds) ||
        !contactIds.every(
          (id) => typeof id === "string" && Types.ObjectId.isValid(id)
        )
      ) {
        res.status(400).json({ error: "Invalid contact selection." });
        return;
      }
      if (contactIds.length > 0) selectedIds = contactIds as string[];
    }
    const audience = selectedIds ? "selected" : "all";

    // Always skip contacts whose email is flagged for review — sending to
    // "lexiehuys@ gmail.com" would just bounce. The admin must fix the
    // address in the UI before they can receive a campaign.
    const filter: Record<string, unknown> = {
      status: "subscribed",
      needsReview: { $ne: true },
    };
    if (selectedIds) filter._id = { $in: selectedIds };

    const contacts = await EmailContact.find(filter);
    // Recipient count is unique email addresses — duplicate rows for the same
    // person collapse into one send.
    const uniqueRecipientCount = new Set(
      contacts.map((c) => c.email.toLowerCase())
    ).size;
    if (uniqueRecipientCount === 0) {
      res.status(400).json({
        error: selectedIds
          ? "None of the selected contacts can receive emails right now (check for unsubscribed or flagged addresses)."
          : "There are no subscribed contacts to send to.",
      });
      return;
    }

    const campaign = await EmailCampaign.create({
      subject: trimmedSubject,
      body: trimmedBody,
      status: "sending",
      audience,
      recipientCount: uniqueRecipientCount,
      sentByEmail: req.session.adminEmail ?? "unknown",
    });

    const result = await sendCampaign(trimmedSubject, trimmedBody, contacts);

    campaign.sentCount = result.sentCount;
    campaign.failedCount = result.failedCount;
    campaign.errorSummary = result.errorSummary;
    if (result.failedCount === 0) campaign.status = "sent";
    else if (result.sentCount === 0) campaign.status = "failed";
    else campaign.status = "partial";
    await campaign.save();

    await audit(req, "send_email_campaign", "email_campaign", campaign._id.toString(), {
      subject: trimmedSubject,
      audience,
      recipientCount: uniqueRecipientCount,
      sentCount: result.sentCount,
      failedCount: result.failedCount,
    });

    res.json({
      success: true,
      status: campaign.status,
      audience,
      recipientCount: uniqueRecipientCount,
      sentCount: result.sentCount,
      failedCount: result.failedCount,
      errorSummary: result.errorSummary,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to send email campaign");
    res.status(500).json({ error: "Failed to send campaign." });
  }
}

/**
 * POST /admin/api/early-access/preview — render the same HTML shell Resend
 * sends, using the admin-supplied subject/body. Sample firstName/lastName
 * substitute for the personalization placeholders so the admin sees how a
 * real recipient would receive the email. No side effects: nothing is sent
 * or persisted.
 */
export async function previewCampaign(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const {
      subject,
      body,
      firstName,
      lastName,
    } = req.body as {
      subject?: unknown;
      body?: unknown;
      firstName?: unknown;
      lastName?: unknown;
    };
    const trimmedSubject =
      typeof subject === "string" ? subject.trim() : "";
    const trimmedBody = typeof body === "string" ? body.trim() : "";
    if (trimmedSubject.length === 0 || trimmedSubject.length > 200) {
      res
        .status(400)
        .json({ error: "Subject is required and must be under 200 characters." });
      return;
    }
    if (trimmedBody.length === 0 || trimmedBody.length > 20000) {
      res
        .status(400)
        .json({ error: "Message body is required and must be under 20,000 characters." });
      return;
    }
    const sampleFirst =
      typeof firstName === "string" && firstName.trim().length > 0
        ? firstName.trim().slice(0, 80)
        : "Sarah";
    const sampleLast =
      typeof lastName === "string" && lastName.trim().length > 0
        ? lastName.trim().slice(0, 80)
        : "";
    // Fake contact only used by personalize(); never touches the database.
    const sampleContact = {
      firstName: sampleFirst,
      lastName: sampleLast,
    } as unknown as Parameters<typeof personalize>[1];
    const personalSubject = personalize(trimmedSubject, sampleContact);
    const personalBody = personalize(trimmedBody, sampleContact);
    // Use a placeholder unsubscribe URL so the link is visually present but
    // does not resolve to a real token.
    const unsubUrl = `${env.PUBLIC_BASE_URL}/email/unsubscribe?preview=1`;
    const html = renderHtml(personalBody, unsubUrl);
    res.json({ subject: personalSubject, html, firstName: sampleFirst });
  } catch (error) {
    logger.error({ err: error }, "Failed to render campaign preview");
    res.status(500).json({ error: "Failed to render preview." });
  }
}

/**
 * GET/POST /email/unsubscribe — public, no auth. Honors the one-click
 * unsubscribe link (and List-Unsubscribe-Post header) in marketing emails.
 */
export async function unsubscribeContact(
  req: Request,
  res: Response
): Promise<void> {
  const renderResult = (ok: boolean, message: string): void => {
    res.status(ok ? 200 : 400).render("pages/unsubscribe", {
      title: "Unsubscribe — Chefless",
      ok,
      message,
    });
  };
  try {
    const id = (req.query.c as string) || (req.body?.c as string) || "";
    const token = (req.query.t as string) || (req.body?.t as string) || "";
    if (!id || !Types.ObjectId.isValid(id) || !token) {
      renderResult(false, "This unsubscribe link is invalid or incomplete.");
      return;
    }
    const contact = await EmailContact.findById(id);
    if (!contact || contact.unsubToken !== token) {
      renderResult(false, "This unsubscribe link is invalid or has expired.");
      return;
    }
    // Cascade by email so every duplicate row for this address is silenced —
    // not just the row whose token was in the unsubscribe link.
    await EmailContact.updateMany(
      { email: contact.email, status: { $ne: "unsubscribed" } },
      { $set: { status: "unsubscribed" } }
    );
    renderResult(
      true,
      "You've been unsubscribed. You won't receive any more emails from Chefless."
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to process unsubscribe");
    renderResult(false, "Something went wrong. Please try again later.");
  }
}
