import { Request, Response } from "express";
import ClientError, {
  ClientErrorStatus,
  ClientErrorPlatform,
} from "../../models/ClientError";
import AuditLog from "../../models/AuditLog";
import { logger } from "../../lib/logger";

const ALLOWED_STATUSES: readonly ClientErrorStatus[] = [
  "new",
  "triaged",
  "resolved",
  "ignored",
];
const ALLOWED_PLATFORMS: readonly ClientErrorPlatform[] = [
  "ios",
  "android",
  "web",
];
const MAX_NOTE_LENGTH = 2000;

async function audit(
  req: Request,
  action: string,
  targetId?: string,
  details?: Record<string, unknown>
): Promise<void> {
  AuditLog.create({
    adminId: req.session.adminId ?? "unknown",
    adminEmail: req.session.adminEmail ?? "unknown",
    action,
    targetType: "client_error",
    targetId,
    details,
    ipAddress: req.ip,
  }).catch((err: unknown) => {
    logger.error({ err }, "Audit log failed");
  });
}

function isStatus(value: unknown): value is ClientErrorStatus {
  return (
    typeof value === "string" &&
    ALLOWED_STATUSES.includes(value as ClientErrorStatus)
  );
}

function isPlatform(value: unknown): value is ClientErrorPlatform {
  return (
    typeof value === "string" &&
    ALLOWED_PLATFORMS.includes(value as ClientErrorPlatform)
  );
}

export async function errorsPage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = 25;

    const statusParam = (req.query.status as string) || "new";
    const platformParam = (req.query.platform as string) || "";

    const query: Record<string, unknown> = {};
    if (statusParam && statusParam !== "all" && isStatus(statusParam)) {
      query.status = statusParam;
    }
    if (platformParam && isPlatform(platformParam)) {
      query.platform = platformParam;
    }

    const skip = (page - 1) * limit;

    const [items, total, newCount] = await Promise.all([
      ClientError.find(query)
        .sort({ lastSeenAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ClientError.countDocuments(query),
      ClientError.countDocuments({ status: "new" }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.render("errors/index", {
      page: "errors",
      pageTitle: "Crashes",
      items,
      pagination: { current: page, total: totalPages, totalItems: total },
      status: statusParam,
      platform: platformParam,
      newCount,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load errors page");
    res.status(500).send("Internal server error");
  }
}

export async function errorDetail(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const item = await ClientError.findById(req.params.id)
      .populate("userId", "fullName email profilePicture")
      .lean();

    if (!item) {
      res.status(404).send("Crash not found");
      return;
    }

    res.render("errors/detail", {
      page: "errors",
      pageTitle: "Crash detail",
      item,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load crash detail");
    res.status(500).send("Internal server error");
  }
}

export async function updateErrorStatus(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { status } = req.body as { status?: unknown };

    if (!isStatus(status)) {
      res.status(400).send("Invalid status");
      return;
    }

    const update: Record<string, unknown> = { $set: { status } };
    if (status === "resolved") {
      (update.$set as Record<string, unknown>).resolvedAt = new Date();
    } else {
      update.$unset = { resolvedAt: 1 };
    }

    const item = await ClientError.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!item) {
      res.status(404).send("Crash not found");
      return;
    }

    await audit(req, "update_error_status", req.params.id as string, {
      status,
    });

    res.redirect(`/admin/errors/${req.params.id}`);
  } catch (error) {
    logger.error({ err: error }, "Failed to update crash status");
    res.status(500).send("Failed to update crash status");
  }
}

export async function updateErrorNote(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const rawNote = (req.body as { adminNote?: unknown }).adminNote;
    const adminNote = typeof rawNote === "string" ? rawNote.trim() : "";

    if (adminNote.length > MAX_NOTE_LENGTH) {
      res
        .status(400)
        .send(`Admin note must be ${MAX_NOTE_LENGTH} characters or fewer`);
      return;
    }

    const update: Record<string, unknown> = adminNote
      ? { $set: { adminNote } }
      : { $unset: { adminNote: 1 } };

    const item = await ClientError.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!item) {
      res.status(404).send("Crash not found");
      return;
    }

    await audit(req, "update_error_note", req.params.id as string, {
      hasNote: adminNote.length > 0,
    });

    res.redirect(`/admin/errors/${req.params.id}`);
  } catch (error) {
    logger.error({ err: error }, "Failed to update crash note");
    res.status(500).send("Failed to update crash note");
  }
}

export async function deleteError(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const item = await ClientError.findByIdAndDelete(req.params.id);

    if (!item) {
      res.status(404).send("Crash not found");
      return;
    }

    await audit(req, "delete_error", req.params.id as string, {
      fingerprint: item.fingerprint,
    });

    res.redirect("/admin/errors");
  } catch (error) {
    logger.error({ err: error }, "Failed to delete crash");
    res.status(500).send("Failed to delete crash");
  }
}

export async function deleteAllErrors(
  req: Request,
  res: Response
): Promise<void> {
  try {
    // Bulk-clear every crash matching the list view's active filters. Mirrors
    // the exact query logic in errorsPage so "clear all" deletes precisely the
    // rows the admin is looking at — nothing more.
    const body = req.body as { status?: unknown; platform?: unknown };
    const statusParam =
      typeof body.status === "string" ? body.status : "new";
    const platformParam =
      typeof body.platform === "string" ? body.platform : "";

    const query: Record<string, unknown> = {};
    if (statusParam && statusParam !== "all" && isStatus(statusParam)) {
      query.status = statusParam;
    }
    if (platformParam && isPlatform(platformParam)) {
      query.platform = platformParam;
    }

    const result = await ClientError.deleteMany(query);

    await audit(req, "delete_all_errors", undefined, {
      status: statusParam,
      platform: platformParam || "all",
      deleted: result.deletedCount,
    });

    const redirectQuery = `status=${encodeURIComponent(statusParam)}${
      platformParam ? `&platform=${encodeURIComponent(platformParam)}` : ""
    }`;
    res.redirect(`/admin/errors?${redirectQuery}`);
  } catch (error) {
    logger.error({ err: error }, "Failed to clear crashes");
    res.status(500).send("Failed to clear crashes");
  }
}
