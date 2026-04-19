import { Request, Response } from "express";
import Feedback, { FeedbackStatus, FeedbackCategory } from "../../models/Feedback";
import AuditLog from "../../models/AuditLog";
import { logger } from "../../lib/logger";

const ALLOWED_STATUSES: readonly FeedbackStatus[] = [
  "new",
  "triaged",
  "resolved",
  "archived",
];
const ALLOWED_CATEGORIES: readonly FeedbackCategory[] = [
  "bug",
  "idea",
  "improvement",
  "praise",
  "other",
];
const MAX_ADMIN_NOTE_LENGTH = 2000;

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

function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return (
    typeof value === "string" &&
    ALLOWED_STATUSES.includes(value as FeedbackStatus)
  );
}

function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return (
    typeof value === "string" &&
    ALLOWED_CATEGORIES.includes(value as FeedbackCategory)
  );
}

export async function feedbackPage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = 20;

    const statusParam = (req.query.status as string) || "new";
    const categoryParam = (req.query.category as string) || "";

    const query: Record<string, unknown> = {};
    if (statusParam && statusParam !== "all" && isFeedbackStatus(statusParam)) {
      query.status = statusParam;
    }
    if (categoryParam && isFeedbackCategory(categoryParam)) {
      query.category = categoryParam;
    }

    const skip = (page - 1) * limit;

    const [feedbackItems, total, newCount] = await Promise.all([
      Feedback.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "fullName email profilePicture")
        .lean(),
      Feedback.countDocuments(query),
      Feedback.countDocuments({ status: "new" }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.render("feedback/index", {
      page: "feedback",
      pageTitle: "Feedback",
      feedbackItems,
      pagination: { current: page, total: totalPages, totalItems: total },
      status: statusParam,
      category: categoryParam,
      newCount,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load feedback page");
    res.status(500).send("Internal server error");
  }
}

export async function feedbackDetail(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const feedback = await Feedback.findById(req.params.id)
      .populate("userId", "fullName email profilePicture")
      .lean();

    if (!feedback) {
      res.status(404).send("Feedback not found");
      return;
    }

    res.render("feedback/detail", {
      page: "feedback",
      pageTitle: "Feedback Detail",
      feedback,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load feedback detail");
    res.status(500).send("Internal server error");
  }
}

export async function updateFeedbackStatus(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { status } = req.body as { status?: unknown };

    if (!isFeedbackStatus(status)) {
      res.status(400).send("Invalid status");
      return;
    }

    const feedback = await Feedback.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true, runValidators: true }
    );

    if (!feedback) {
      res.status(404).send("Feedback not found");
      return;
    }

    await audit(req, "update_feedback_status", "feedback", req.params.id as string, {
      status,
    });

    res.redirect(`/admin/feedback/${req.params.id}`);
  } catch (error) {
    logger.error({ err: error }, "Failed to update feedback status");
    res.status(500).send("Failed to update feedback status");
  }
}

export async function updateFeedbackNote(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const rawNote = (req.body as { adminNote?: unknown }).adminNote;
    const adminNote =
      typeof rawNote === "string" ? rawNote.trim() : "";

    if (adminNote.length > MAX_ADMIN_NOTE_LENGTH) {
      res
        .status(400)
        .send(`Admin note must be ${MAX_ADMIN_NOTE_LENGTH} characters or fewer`);
      return;
    }

    const update: Record<string, unknown> = adminNote
      ? { $set: { adminNote } }
      : { $unset: { adminNote: 1 } };

    const feedback = await Feedback.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!feedback) {
      res.status(404).send("Feedback not found");
      return;
    }

    await audit(req, "update_feedback_note", "feedback", req.params.id as string, {
      hasNote: adminNote.length > 0,
    });

    res.redirect(`/admin/feedback/${req.params.id}`);
  } catch (error) {
    logger.error({ err: error }, "Failed to update feedback note");
    res.status(500).send("Failed to update feedback note");
  }
}

export async function deleteFeedback(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const feedback = await Feedback.findByIdAndDelete(req.params.id);

    if (!feedback) {
      res.status(404).send("Feedback not found");
      return;
    }

    await audit(req, "delete_feedback", "feedback", req.params.id as string, {
      category: feedback.category,
      status: feedback.status,
    });

    res.redirect("/admin/feedback");
  } catch (error) {
    logger.error({ err: error }, "Failed to delete feedback");
    res.status(500).send("Failed to delete feedback");
  }
}
