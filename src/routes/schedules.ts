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
  redactLockedEntriesForFree,
  setEntryRsvp,
  planLeftovers,
  copyWeek,
  batchDeleteEntries,
} from "../services/schedule-service";
import {
  markEntryCooked,
  clearEntryCooked,
} from "../services/rating-service";
import { getMealIdeas, MEAL_IDEAS_MAX_LIMIT } from "../services/meal-ideas-service";
import { hasActivePremium } from "../lib/premium";
import { normalizeOffset, offsetFromQuery } from "../lib/timezone";

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
  .refine(
    (val) => {
      const date = new Date(val + "T00:00:00.000Z");
      return (
        !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === val
      );
    },
    { message: "Date must be a real calendar date" }
  )
  .transform((val) => new Date(val + "T00:00:00.000Z"));

// Week view asks for 7 days, month for ~31, year for 366. Capped at 400 so
// a bad query can't ask for decades of entries, but year aggregation works.
const MAX_SCHEDULE_RANGE_DAYS = 400;

async function captureTimezoneOffset(
  userId: string,
  raw: number | undefined
): Promise<number | undefined> {
  const normalized = normalizeOffset(raw);
  if (normalized === undefined) {
    return undefined;
  }
  await User.updateOne(
    { _id: userId, timezoneOffsetMinutes: { $ne: normalized } },
    { $set: { timezoneOffsetMinutes: normalized } }
  );
  return normalized;
}

// --- Schemas ---

const timezoneOffsetField = z.number().int().min(-840).max(840).optional();
const timezoneOffsetQueryField = z.coerce
  .number()
  .int()
  .min(-840)
  .max(840)
  .optional();

const getEntriesSchema = z
  .object({
    start: dateString,
    end: dateString,
    timezoneOffsetMinutes: timezoneOffsetQueryField,
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
    servings: z.number().int().min(1).max(100).optional(),
    timezoneOffsetMinutes: timezoneOffsetField,
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
    servings: z.number().int().min(1).max(100).optional(),
    timezoneOffsetMinutes: timezoneOffsetField,
  })
  .refine(
    (data) =>
      data.date !== undefined ||
      data.mealSlot !== undefined ||
      data.recipeId !== undefined ||
      data.freeformText !== undefined ||
      data.scheduledTime !== undefined ||
      data.prepTime !== undefined ||
      data.servings !== undefined,
    { message: "At least one field must be provided for update" }
  );

// RSVP body. `status: null` clears the member's RSVP (a toggle-off).
const rsvpSchema = z.object({
  status: z.enum(["going", "not_going"]).nullable(),
});

const planLeftoversSchema = z.object({
  date: dateString,
  mealSlot: z.string().min(1).max(50).trim(),
  cookExtra: z.boolean(),
  extraServings: z.number().int().min(1).max(100).optional(),
  timezoneOffsetMinutes: timezoneOffsetField,
});

const deleteEntryQuerySchema = z.object({
  withLeftovers: z.union([z.literal("true"), z.literal("false")]).optional(),
  timezoneOffsetMinutes: timezoneOffsetQueryField,
});

// --- Routes ---

// GET /api/schedule/suggestions — Get pending suggestions (must be before /:id)
router.get(
  "/suggestions",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id kitchenId isPremium premiumExpiresAt timezoneOffsetMinutes")
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

    const offsetMinutes =
      (await captureTimezoneOffset(
        currentUser._id.toString(),
        offsetFromQuery(req.query.timezoneOffsetMinutes)
      )) ?? currentUser.timezoneOffsetMinutes;

    const suggestions = redactLockedEntriesForFree(
      await getSuggestions(
        currentUser._id.toString(),
        currentUser.kitchenId.toString()
      ),
      hasActivePremium(currentUser),
      offsetMinutes
    );

    res.status(200).json({ suggestions });
  })
);

const mealIdeasQuerySchema = z.object({
  date: dateString,
  slot: z.string().trim().min(1).max(50).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MEAL_IDEAS_MAX_LIMIT)
    .default(MEAL_IDEAS_MAX_LIMIT),
});

router.get(
  "/ideas",
  requireAuth,
  validate({ query: mealIdeasQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { date, slot, limit } = req.query as unknown as z.infer<
      typeof mealIdeasQuerySchema
    >;

    const result = await getMealIdeas(userId, { date, slot, limit });

    res.status(200).json(result);
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

// POST /api/schedule/:id/rsvp — Set or clear the member's dinner RSVP
router.post(
  "/:id/rsvp",
  requireAuth,
  validate({ params: objectIdParam, body: rsvpSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const { status } = req.body as z.infer<typeof rsvpSchema>;
    const entry = await setEntryRsvp(userId, id, status);

    res.status(200).json({ entry });
  })
);

router.post(
  "/:id/leftovers",
  requireAuth,
  validate({ params: objectIdParam, body: planLeftoversSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const data = req.body as z.infer<typeof planLeftoversSchema>;

    await captureTimezoneOffset(userId, data.timezoneOffsetMinutes);

    const { leftover, source } = await planLeftovers(userId, id, data);

    res.status(201).json({ leftover, source });
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
      .select("_id kitchenId isPremium premiumExpiresAt timezoneOffsetMinutes")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { start, end, timezoneOffsetMinutes } = req.query as unknown as z.infer<
      typeof getEntriesSchema
    >;

    const offsetMinutes =
      (await captureTimezoneOffset(
        currentUser._id.toString(),
        timezoneOffsetMinutes
      )) ?? currentUser.timezoneOffsetMinutes;

    const query = currentUser.kitchenId
      ? { kitchenId: currentUser.kitchenId.toString() }
      : { userId: currentUser._id.toString() };

    const entries = redactLockedEntriesForFree(
      await getEntries(query, start, end),
      hasActivePremium(currentUser),
      offsetMinutes
    );

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

    await captureTimezoneOffset(
      currentUser._id.toString(),
      data.timezoneOffsetMinutes
    );

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

    await captureTimezoneOffset(
      currentUser._id.toString(),
      updates.timezoneOffsetMinutes
    );

    const entry = await updateEntry(currentUser._id.toString(), id, updates);

    res.status(200).json({ entry });
  })
);

// DELETE /api/schedule/:id — Delete entry
router.delete(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam, query: deleteEntryQuerySchema }),
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
    const { withLeftovers, timezoneOffsetMinutes } = req.query as unknown as z.infer<
      typeof deleteEntryQuerySchema
    >;

    await captureTimezoneOffset(currentUser._id.toString(), timezoneOffsetMinutes);

    const { removedLeftovers } = await deleteEntry(
      currentUser._id.toString(),
      id,
      { withLeftovers: withLeftovers === "true" }
    );

    res.status(200).json({ success: true, removedLeftovers });
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
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const body = req.body as z.infer<typeof markCookedSchema>;
    const cookedAt = body.cookedAt ? new Date(body.cookedAt) : undefined;
    await markEntryCooked(userId, id, cookedAt);

    res.status(200).json({ success: true });
  })
);

// DELETE /api/schedule/:id/cooked — undo the cooked mark
router.delete(
  "/:id/cooked",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await clearEntryCooked(userId, id);

    res.status(200).json({ success: true });
  })
);

// POST /api/schedule/import-to-kitchen — Import personal entries into kitchen
const importToKitchenSchema = z
  .object({
    start: dateString,
    end: dateString,
    timezoneOffsetMinutes: timezoneOffsetField,
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

const copyWeekSchema = z.object({
  sourceStart: dateString,
  targetStart: dateString,
  skipFilledSlots: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  timezoneOffsetMinutes: timezoneOffsetField,
});

const batchDeleteSchema = z.object({
  ids: z
    .array(z.string().refine(isValidObjectId, { message: "Invalid ID format" }))
    .min(1)
    .max(500),
  timezoneOffsetMinutes: timezoneOffsetField,
});

router.post(
  "/copy-week",
  requireAuth,
  validate({ body: copyWeekSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id kitchenId timezoneOffsetMinutes")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const data = req.body as z.infer<typeof copyWeekSchema>;

    await captureTimezoneOffset(
      currentUser._id.toString(),
      data.timezoneOffsetMinutes
    );

    const result = await copyWeek(currentUser._id.toString(), {
      sourceStart: data.sourceStart,
      targetStart: data.targetStart,
      skipFilledSlots: data.skipFilledSlots ?? true,
      dryRun: data.dryRun ?? false,
    });

    res.status(200).json(result);
  })
);

router.post(
  "/batch-delete",
  requireAuth,
  validate({ body: batchDeleteSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id kitchenId timezoneOffsetMinutes")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const data = req.body as z.infer<typeof batchDeleteSchema>;

    await captureTimezoneOffset(
      currentUser._id.toString(),
      data.timezoneOffsetMinutes
    );

    const { deleted } = await batchDeleteEntries(
      currentUser._id.toString(),
      data.ids
    );

    res.status(200).json({ deleted });
  })
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

    const { start, end, timezoneOffsetMinutes } = req.body as z.infer<
      typeof importToKitchenSchema
    >;

    await captureTimezoneOffset(currentUser._id.toString(), timezoneOffsetMinutes);

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
