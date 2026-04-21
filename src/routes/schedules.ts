import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import {
  addEntry,
  getEntries,
  updateEntry,
  deleteEntry,
  getSuggestions,
  approveSuggestion,
  denySuggestion,
  importToKitchen,
} from "../services/schedule-service";
import {
  markEntryCooked,
  clearEntryCooked,
} from "../services/rating-service";

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

const objectIdParam = z.object({
  id: z.string().refine(isValidObjectId, { message: "Invalid ID format" }),
});

// Date string validation: YYYY-MM-DD format
const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: "Date must be in YYYY-MM-DD format",
  })
  .transform((val) => {
    const date = new Date(val + "T00:00:00.000Z");
    if (isNaN(date.getTime())) {
      throw new Error("Invalid date");
    }
    return date;
  });

// Week view asks for 7 days, month for ~31, year for 366. Capped at 400 so
// a bad query can't ask for decades of entries, but year aggregation works.
const MAX_SCHEDULE_RANGE_DAYS = 400;

// --- Schemas ---

const getEntriesSchema = z
  .object({
    start: dateString,
    end: dateString,
  })
  .refine((data) => data.end >= data.start, {
    message: "end must be on or after start",
    path: ["end"],
  })
  .refine(
    (data) => {
      const diffMs = data.end.getTime() - data.start.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      return diffDays <= MAX_SCHEDULE_RANGE_DAYS;
    },
    { message: `Date range cannot exceed ${MAX_SCHEDULE_RANGE_DAYS} days`, path: ["end"] }
  );

const addEntrySchema = z
  .object({
    date: dateString,
    mealSlot: z.string().min(1).max(50).trim(),
    recipeId: z
      .string()
      .refine(isValidObjectId, { message: "Invalid recipe ID format" })
      .optional(),
    freeformText: z.string().max(500).trim().optional(),
    scheduledTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Time must be in HH:mm format")
      .optional(),
    prepTime: z.number().int().min(0).max(1440).optional(),
  })
  .refine((data) => data.recipeId || data.freeformText, {
    message: "Either recipeId or freeformText must be provided",
  });

const updateEntrySchema = z
  .object({
    date: dateString.optional(),
    mealSlot: z.string().min(1).max(50).trim().optional(),
    recipeId: z
      .string()
      .refine(isValidObjectId, { message: "Invalid recipe ID format" })
      .optional(),
    freeformText: z.string().max(500).trim().optional(),
    scheduledTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Time must be in HH:mm format")
      .optional()
      .nullable(),
    prepTime: z.number().int().min(0).max(1440).optional().nullable(),
  })
  .refine(
    (data) =>
      data.date !== undefined ||
      data.mealSlot !== undefined ||
      data.recipeId !== undefined ||
      data.freeformText !== undefined,
    { message: "At least one field must be provided for update" }
  );

// --- Routes ---

// GET /api/schedule/suggestions — Get pending suggestions (must be before /:id)
router.get(
  "/suggestions",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id kitchenId")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (!currentUser.kitchenId) {
      res
        .status(400)
        .json({ error: "You must join or create a kitchen first" });
      return;
    }

    const suggestions = await getSuggestions(
      currentUser._id.toString(),
      currentUser.kitchenId.toString()
    );

    res.status(200).json({ suggestions });
  })
);

// POST /api/schedule/suggestions/:id/approve — Approve suggestion
router.post(
  "/suggestions/:id/approve",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id kitchenId")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (!currentUser.kitchenId) {
      res
        .status(400)
        .json({ error: "You must join or create a kitchen first" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const entry = await approveSuggestion(currentUser._id.toString(), id);

    res.status(200).json({ entry });
  })
);

// POST /api/schedule/suggestions/:id/deny — Deny suggestion
router.post(
  "/suggestions/:id/deny",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id kitchenId")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (!currentUser.kitchenId) {
      res
        .status(400)
        .json({ error: "You must join or create a kitchen first" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await denySuggestion(currentUser._id.toString(), id);

    res.status(200).json({ success: true });
  })
);

// GET /api/schedule — Get entries for date range
router.get(
  "/",
  requireAuth,
  validate({ query: getEntriesSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id kitchenId")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { start, end } = req.query as unknown as z.infer<
      typeof getEntriesSchema
    >;

    const query = currentUser.kitchenId
      ? { kitchenId: currentUser.kitchenId.toString() }
      : { userId: currentUser._id.toString() };

    const entries = await getEntries(query, start, end);

    res.status(200).json({ entries });
  })
);

// POST /api/schedule — Add entry
router.post(
  "/",
  requireAuth,
  validate({ body: addEntrySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id kitchenId")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const data = req.body as z.infer<typeof addEntrySchema>;
    const kitchenId = currentUser.kitchenId
      ? currentUser.kitchenId.toString()
      : null;

    const entry = await addEntry(
      currentUser._id.toString(),
      kitchenId,
      data
    );

    res.status(201).json({ entry });
  })
);

// PATCH /api/schedule/:id — Update entry
router.patch(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam, body: updateEntrySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id kitchenId")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const updates = req.body as z.infer<typeof updateEntrySchema>;
    const entry = await updateEntry(currentUser._id.toString(), id, updates);

    res.status(200).json({ entry });
  })
);

// DELETE /api/schedule/:id — Delete entry
router.delete(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id kitchenId")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await deleteEntry(currentUser._id.toString(), id);

    res.status(200).json({ success: true });
  })
);

// PATCH /api/schedule/:id/cooked — mark a scheduled meal as cooked
const markCookedSchema = z.object({
  cookedAt: z
    .string()
    .datetime({ message: "cookedAt must be an ISO-8601 timestamp" })
    .optional(),
});

router.patch(
  "/:id/cooked",
  requireAuth,
  validate({ params: objectIdParam, body: markCookedSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id")
      .lean();
    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const body = req.body as z.infer<typeof markCookedSchema>;
    const cookedAt = body.cookedAt ? new Date(body.cookedAt) : undefined;
    await markEntryCooked(currentUser._id.toString(), id, cookedAt);

    res.status(200).json({ success: true });
  })
);

// DELETE /api/schedule/:id/cooked — undo the cooked mark
router.delete(
  "/:id/cooked",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id")
      .lean();
    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await clearEntryCooked(currentUser._id.toString(), id);

    res.status(200).json({ success: true });
  })
);

// POST /api/schedule/import-to-kitchen — Import personal entries into kitchen
const importToKitchenSchema = z
  .object({
    start: dateString,
    end: dateString,
  })
  .refine((data) => data.end >= data.start, {
    message: "end must be on or after start",
    path: ["end"],
  })
  .refine(
    (data) => {
      const diffMs = data.end.getTime() - data.start.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      return diffDays <= MAX_SCHEDULE_RANGE_DAYS;
    },
    { message: `Date range cannot exceed ${MAX_SCHEDULE_RANGE_DAYS} days`, path: ["end"] }
  );

router.post(
  "/import-to-kitchen",
  requireAuth,
  validate({ body: importToKitchenSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id kitchenId")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (!currentUser.kitchenId) {
      res
        .status(400)
        .json({ error: "You must be in a kitchen to import entries" });
      return;
    }

    const { start, end } = req.body as z.infer<typeof importToKitchenSchema>;
    const count = await importToKitchen(
      currentUser._id.toString(),
      currentUser.kitchenId.toString(),
      start,
      end
    );

    res.status(200).json({ imported: count });
  })
);

export default router;
