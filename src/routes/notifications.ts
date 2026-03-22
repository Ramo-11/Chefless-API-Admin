import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User, {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferences,
} from "../models/User";
import { NOTIFICATION_TYPES } from "../models/Notification";
import {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
} from "../services/notification-service";

const router = Router();

// --- Helpers ---

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

// --- Schemas ---

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const markReadSchema = z.object({
  ids: z
    .array(
      z.string().refine(isValidObjectId, { message: "Invalid notification ID" })
    )
    .min(1, "At least one notification ID is required")
    .max(100, "Cannot mark more than 100 notifications at once"),
});

// Build a Zod schema that allows any subset of notification type keys as booleans.
const preferencesSchema = z
  .object(
    Object.fromEntries(
      NOTIFICATION_TYPES.map((type) => [type, z.boolean().optional()])
    ) as Record<(typeof NOTIFICATION_TYPES)[number], z.ZodOptional<z.ZodBoolean>>
  )
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "At least one preference must be provided",
  });

// --- Routes ---

// GET /api/notifications — Get notifications (paginated)
router.get(
  "/",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<
      typeof paginationSchema
    >;
    const result = await getNotifications(
      currentUser._id.toString(),
      page,
      limit
    );

    res.status(200).json(result);
  })
);

// GET /api/notifications/unread-count — Get unread count
router.get(
  "/unread-count",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const count = await getUnreadCount(currentUser._id.toString());

    res.status(200).json({ count });
  })
);

// POST /api/notifications/read — Mark specific notifications as read
router.post(
  "/read",
  requireAuth,
  validate({ body: markReadSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { ids } = req.body as z.infer<typeof markReadSchema>;
    const modifiedCount = await markAsRead(currentUser._id.toString(), ids);

    res.status(200).json({ success: true, modifiedCount });
  })
);

// POST /api/notifications/read-all — Mark all notifications as read
router.post(
  "/read-all",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const modifiedCount = await markAllAsRead(currentUser._id.toString());

    res.status(200).json({ success: true, modifiedCount });
  })
);

// GET /api/notifications/preferences — Get notification preferences
router.get(
  "/preferences",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("notificationPreferences")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const preferences: NotificationPreferences =
      currentUser.notificationPreferences ?? { ...DEFAULT_NOTIFICATION_PREFERENCES };

    res.status(200).json({ preferences });
  })
);

// PATCH /api/notifications/preferences — Update notification preferences
router.patch(
  "/preferences",
  requireAuth,
  validate({ body: preferencesSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const updates = req.body as Partial<NotificationPreferences>;

    // Build a $set object with dot notation for partial updates
    const setFields: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (typeof value === "boolean") {
        setFields[`notificationPreferences.${key}`] = value;
      }
    }

    const user = await User.findOneAndUpdate(
      { firebaseUid },
      { $set: setFields },
      { new: true, select: "notificationPreferences" }
    ).lean();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.status(200).json({
      success: true,
      preferences: user.notificationPreferences,
    });
  })
);

export default router;
