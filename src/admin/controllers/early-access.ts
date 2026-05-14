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
  sendCampaign,
} from "../../services/email-campaign-service";

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
    if (statusFilter !== "all") query.status = statusFilter;
    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(safe, "i");
      query.$or = [{ email: rx }, { firstName: rx }, { lastName: rx }];
    }

    const skip = (page - 1) * PAGE_SIZE;

    const [contacts, total, stats, campaigns] = await Promise.all([
      EmailContact.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(PAGE_SIZE)
        .lean(),
      EmailContact.countDocuments(query),
      EmailContact.aggregate<{ _id: string; count: number }>([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      EmailCampaign.find().sort({ createdAt: -1 }).limit(20).lean(),
    ]);

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

    const { rows, skipped, totalRows } = parseContactsCsv(csv);
    if (rows.length === 0) {
      res.status(400).json({
        error:
          "No valid contacts found. Make sure the file is the Google Form CSV export with an email column.",
      });
      return;
    }

    let imported = 0;
    let updated = 0;
    for (const row of rows) {
      const { email, ...rest } = row;
      // Only set fields that actually have a value, so a re-import never wipes
      // existing data with blank cells.
      const set: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined && value !== "") set[key] = value;
      }
      const result = await EmailContact.updateOne(
        { email },
        { $set: set, $setOnInsert: { email, source: "google_form" } },
        { upsert: true }
      );
      if (result.upsertedCount > 0) imported += 1;
      else if (result.modifiedCount > 0) updated += 1;
    }

    await audit(req, "import_email_contacts", "email_contact", undefined, {
      imported,
      updated,
      skipped,
      totalRows,
    });

    res.json({
      success: true,
      imported,
      updated,
      skipped,
      totalRows,
      message: `Imported ${imported} new, updated ${updated}, skipped ${skipped} without a valid email.`,
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
    contact.status =
      contact.status === "subscribed" ? "unsubscribed" : "subscribed";
    await contact.save();

    await audit(req, "toggle_email_contact_status", "email_contact", id, {
      status: contact.status,
    });

    res.json({ success: true, status: contact.status });
  } catch (error) {
    logger.error({ err: error }, "Failed to toggle contact status");
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
 * POST /admin/api/early-access/send — send a campaign to every subscribed
 * contact. Persists an EmailCampaign record with the outcome.
 */
export async function sendCampaignToList(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { subject, body } = req.body as {
      subject?: unknown;
      body?: unknown;
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

    const contacts = await EmailContact.find({ status: "subscribed" });
    if (contacts.length === 0) {
      res.status(400).json({
        error: "There are no subscribed contacts to send to.",
      });
      return;
    }

    const campaign = await EmailCampaign.create({
      subject: trimmedSubject,
      body: trimmedBody,
      status: "sending",
      recipientCount: contacts.length,
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
      recipientCount: contacts.length,
      sentCount: result.sentCount,
      failedCount: result.failedCount,
    });

    res.json({
      success: true,
      status: campaign.status,
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
    if (contact.status !== "unsubscribed") {
      contact.status = "unsubscribed";
      await contact.save();
    }
    renderResult(
      true,
      "You've been unsubscribed. You won't receive any more emails from Chefless."
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to process unsubscribe");
    renderResult(false, "Something went wrong. Please try again later.");
  }
}
