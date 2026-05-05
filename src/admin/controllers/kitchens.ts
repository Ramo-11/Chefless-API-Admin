import { Request, Response } from "express";
import { isValidObjectId } from "mongoose";
import Kitchen from "../../models/Kitchen";
import User from "../../models/User";
import ScheduleEntry from "../../models/ScheduleEntry";
import ShoppingList from "../../models/ShoppingList";
import AuditLog from "../../models/AuditLog";
import { logger } from "../../lib/logger";
import {
  adminDeleteKitchenPhoto,
  adminTransferLead,
  TransferLeadWarningError,
} from "../../services/kitchen-service";
import { publicIdFromUrl, deleteImage } from "../../lib/cloudinary";

/** Escape user input for use inside a MongoDB `$regex` expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

export async function kitchensPage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = 20;
    const search = (req.query.search as string) || "";

    const query: Record<string, unknown> = {};

    if (search) {
      query.name = { $regex: escapeRegex(search), $options: "i" };
    }

    const skip = (page - 1) * limit;

    const [kitchens, total] = await Promise.all([
      Kitchen.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("leadId", "fullName email profilePicture")
        .lean(),
      Kitchen.countDocuments(query),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.render("kitchens", {
      page: "kitchens",
      pageTitle: "Kitchens",
      kitchens,
      pagination: { current: page, total: totalPages, totalItems: total },
      search,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load kitchens page");
    res.status(500).send("Internal server error");
  }
}

export async function kitchenDetail(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const kitchen = await Kitchen.findById(req.params.id)
      .populate("leadId", "fullName email profilePicture")
      .lean();

    if (!kitchen) {
      res.status(404).json({ error: "Kitchen not found" });
      return;
    }

    const members = await User.find({ kitchenId: req.params.id })
      .select("_id fullName email profilePicture")
      .lean();

    res.json({ kitchen, members });
  } catch (error) {
    logger.error({ err: error }, "Failed to get kitchen detail");
    res.status(500).json({ error: "Failed to load kitchen" });
  }
}

/**
 * Read-only listing of pending schedule suggestions for a kitchen. Surfaced
 * inside the admin kitchen detail modal. Admin cannot approve/deny here —
 * this is for visibility and moderation triage only.
 */
export async function kitchenSuggestions(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const kitchen = await Kitchen.findById(req.params.id).select("_id").lean();
    if (!kitchen) {
      res.status(404).json({ error: "Kitchen not found" });
      return;
    }

    const suggestions = await ScheduleEntry.find({
      kitchenId: kitchen._id,
      status: "suggested",
    })
      .sort({ date: 1, createdAt: 1 })
      .populate<{
        suggestedBy: { _id: string; fullName: string; profilePicture?: string } | null;
      }>("suggestedBy", "fullName profilePicture")
      .lean();

    res.json({ suggestions });
  } catch (error) {
    logger.error({ err: error }, "Failed to load kitchen suggestions");
    res.status(500).json({ error: "Failed to load suggestions" });
  }
}

export async function updateKitchen(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const allowedFields = ["name", "photo"] as const;

    const sanitized: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        sanitized[field] = req.body[field];
      }
    }

    const kitchen = await Kitchen.findByIdAndUpdate(
      req.params.id,
      { $set: sanitized },
      { new: true, runValidators: true }
    );

    if (!kitchen) {
      res.status(404).json({ error: "Kitchen not found" });
      return;
    }

    await audit(req, "update_kitchen", "kitchen", req.params.id as string, sanitized);
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to update kitchen");
    res.status(500).json({ error: "Failed to update kitchen" });
  }
}

export async function removeKitchenMember(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { id } = req.params;
    const { memberId } = req.body;

    if (!memberId) {
      res.status(400).json({ error: "memberId is required" });
      return;
    }

    const kitchen = await Kitchen.findById(id);
    if (!kitchen) {
      res.status(404).json({ error: "Kitchen not found" });
      return;
    }

    if (kitchen.leadId.toString() === memberId) {
      res.status(400).json({ error: "Cannot remove the kitchen lead" });
      return;
    }

    await User.updateOne(
      { _id: memberId, kitchenId: id },
      { $unset: { kitchenId: 1 } }
    );

    await Kitchen.updateOne(
      { _id: id },
      {
        $inc: { memberCount: -1 },
        $pull: {
          membersWithScheduleEdit: memberId,
          membersWithApprovalPower: memberId,
        },
      }
    );

    await audit(req, "remove_kitchen_member", "kitchen", id as string, { memberId });
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to remove kitchen member");
    res.status(500).json({ error: "Failed to remove member" });
  }
}

export async function transferKitchenLead(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { id } = req.params;
    const { newLeadId, force } = req.body as {
      newLeadId?: unknown;
      force?: unknown;
    };

    if (!newLeadId || typeof newLeadId !== "string") {
      res.status(400).json({ error: "newLeadId is required" });
      return;
    }

    if (!isValidObjectId(id) || !isValidObjectId(newLeadId)) {
      res.status(400).json({ error: "Invalid kitchen or member id" });
      return;
    }

    const kitchen = await Kitchen.findById(id).select("leadId").lean();
    const previousLeadId = kitchen?.leadId.toString();

    const { warnings } = await adminTransferLead(id as string, newLeadId, {
      force: force === true,
    });

    await audit(req, "transfer_kitchen_lead", "kitchen", id as string, {
      previousLeadId,
      newLeadId,
      forced: force === true,
      warnings: warnings.map((w) => w.code),
    });
    res.json({ success: true, warnings });
  } catch (error) {
    if (error instanceof TransferLeadWarningError) {
      res.status(409).json({
        error: "Transfer has warnings",
        warnings: error.warnings,
        canForce: true,
      });
      return;
    }

    // Service-thrown HTTP errors (createError) carry a `statusCode`. Surface
    // them as-is so the admin UI shows the real reason ("already the lead",
    // "not a member", etc.) instead of a generic 500.
    const status = (error as { statusCode?: number })?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({
        error: error instanceof Error ? error.message : "Failed to transfer lead",
      });
      return;
    }

    logger.error({ err: error }, "Failed to transfer kitchen lead");
    const message = error instanceof Error ? error.message : "Failed to transfer lead";
    res.status(500).json({ error: message });
  }
}

export async function deleteKitchen(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { id } = req.params;

    const kitchen = await Kitchen.findById(id);
    if (!kitchen) {
      res.status(404).json({ error: "Kitchen not found" });
      return;
    }

    await User.updateMany({ kitchenId: id }, { $unset: { kitchenId: 1 } });
    await ScheduleEntry.deleteMany({ kitchenId: id });
    await ShoppingList.deleteMany({ kitchenId: id });

    // Destroy the Cloudinary photo before dropping the kitchen doc so we
    // don't leak assets when an admin deletes a kitchen for moderation.
    if (kitchen.photo) {
      const publicId = publicIdFromUrl(kitchen.photo);
      if (publicId) {
        void deleteImage(publicId);
      }
    }

    await Kitchen.findByIdAndDelete(id);

    await audit(req, "delete_kitchen", "kitchen", id as string, { name: kitchen.name });
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to delete kitchen");
    res.status(500).json({ error: "Failed to delete kitchen" });
  }
}

/**
 * Moderation action: strip the photo from any kitchen. Bypasses the lead-
 * ownership check in the service layer and destroys the Cloudinary asset.
 */
export async function removeKitchenPhoto(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { id } = req.params;
    const kitchen = await adminDeleteKitchenPhoto(id as string);
    if (!kitchen) {
      res.status(404).json({ error: "Kitchen not found" });
      return;
    }

    await audit(req, "remove_kitchen_photo", "kitchen", id as string);
    res.json({ success: true, kitchen });
  } catch (error) {
    logger.error({ err: error }, "Failed to remove kitchen photo");
    res.status(500).json({ error: "Failed to remove photo" });
  }
}
