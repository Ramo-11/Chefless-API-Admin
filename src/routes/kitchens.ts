import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { strictLimiter, joinKitchenLimiter } from "../middleware/rateLimit";
import User from "../models/User";
import Kitchen from "../models/Kitchen";
import ScheduleEntry from "../models/ScheduleEntry";
import {
  createKitchen,
  getMyKitchen,
  updateKitchen,
  deleteKitchen,
  joinKitchen,
  leaveKitchen,
  removeMember,
  transferLead,
  updatePermissions,
  regenerateInviteCode,
  getKitchenRecipes,
  sendKitchenInvite,
  acceptKitchenInvite,
  declineKitchenInvite,
  listPendingInvitesForRecipient,
  cancelKitchenInvite,
  getPublicKitchen,
  getPublicKitchenSchedule,
  getPublicKitchenRecipes,
  getKitchenRatingsHistory,
  uploadKitchenPhoto,
  deleteKitchenPhoto,
  updateMealSlotOrder,
  syncMealSlotOrderWithCustomSlots,
  setHiddenDefaultSlots,
  DEFAULT_MEAL_SLOTS,
  INVITE_CODE_REGEX,
} from "../services/kitchen-service";

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

// --- Schemas ---

const createKitchenSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  // Photo is set via `POST /me/photo` after the kitchen exists (so the
  // Cloudinary folder can be keyed by kitchenId). Accepted on create only
  // as a pass-through URL for legacy clients — new Flutter clients upload
  // separately.
  photo: z.string().url().optional(),
  isPublic: z.boolean().optional(),
});

const updateKitchenSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  // Intentionally omitted: `photo` is now set only through the dedicated
  // upload endpoint so the Cloudinary lifecycle (folder, replace, delete)
  // is owned by the server rather than by arbitrary client-supplied URLs.
  isPublic: z.boolean().optional(),
  scheduleAddPolicy: z.enum(["lead_only", "all"]).optional(),
  slotOrderEditPolicy: z.enum(["lead_only", "editors", "all"]).optional(),
  ratingsVisibility: z.enum(["public", "kitchen_only", "off"]).optional(),
  showMembersPublicly: z.boolean().optional(),
  allowMemberSuggestions: z.boolean().optional(),
  allowAutoScheduleSuggestions: z.boolean().optional(),
});

const mealSlotOrderSchema = z.object({
  // 4 defaults + 20 max customs = 24; allow a small cushion for legacy
  // kitchens with orphan slots the client surfaces alongside known ones.
  mealSlotOrder: z
    .array(z.string().min(1).max(40).trim())
    .min(1)
    .max(30),
});

// Cap: 14MB base64 = ~10MB raw image. Keeps us comfortably under the
// `jsonUpload` 15MB body limit and under Cloudinary's free-tier asset ceiling
// so a pathologically large crop (or a clock-skewed client) can't wedge the
// upload path.
const MAX_KITCHEN_PHOTO_BASE64_BYTES = 14 * 1024 * 1024;

const kitchenPhotoBodySchema = z.object({
  image: z
    .string()
    .min(1, "Image data is required")
    .refine(
      (val) => val.startsWith("data:image/"),
      { message: "Must be a valid base64 data URI (data:image/...)" }
    )
    .refine(
      (val) => val.length <= MAX_KITCHEN_PHOTO_BASE64_BYTES,
      { message: "Photo is too large. Please pick a smaller image." }
    ),
});

const joinKitchenSchema = z.object({
  inviteCode: z
    .string()
    .min(1)
    .regex(INVITE_CODE_REGEX, {
      message: "Invalid invite code format. Expected something like CHEF-AB12CD",
    }),
});

const updatePermissionsSchema = z.object({
  membersWithScheduleEdit: z
    .array(z.string().refine(isValidObjectId, { message: "Invalid ID format" }))
    .optional(),
  membersWithApprovalPower: z
    .array(z.string().refine(isValidObjectId, { message: "Invalid ID format" }))
    .optional(),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  memberId: z
    .string()
    .refine(isValidObjectId, { message: "Invalid ID format" })
    .optional(),
});

// --- Routes ---

// POST /api/kitchens — Create kitchen
router.post(
  "/",
  requireAuth,
  validate({ body: createKitchenSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { name, photo } = req.body as z.infer<typeof createKitchenSchema>;
    const kitchen = await createKitchen(
      currentUser._id.toString(),
      name,
      photo
    );

    res.status(201).json({ kitchen });
  })
);

// GET /api/kitchens/me — Get my kitchen + members
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const result = await getMyKitchen(currentUser._id.toString());

    if (!result) {
      res.status(200).json({ kitchen: null, members: [] });
      return;
    }

    res.status(200).json(result);
  })
);

// PATCH /api/kitchens/me — Update kitchen (lead only)
router.patch(
  "/me",
  requireAuth,
  validate({ body: updateKitchenSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const updates = req.body as z.infer<typeof updateKitchenSchema>;
    const kitchen = await updateKitchen(currentUser._id.toString(), updates);

    res.status(200).json({ kitchen });
  })
);

// PATCH /api/kitchens/me/slot-order — Reorder meal slots (policy-gated)
router.patch(
  "/me/slot-order",
  requireAuth,
  validate({ body: mealSlotOrderSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { mealSlotOrder } = req.body as z.infer<typeof mealSlotOrderSchema>;
    const kitchen = await updateMealSlotOrder(
      currentUser._id.toString(),
      mealSlotOrder
    );

    res.status(200).json({ kitchen });
  })
);

// DELETE /api/kitchens/me — Delete kitchen (lead only)
router.delete(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await deleteKitchen(currentUser._id.toString());

    res.status(200).json({ success: true });
  })
);

// POST /api/kitchens/me/photo — Upload (or replace) the kitchen photo.
// Lead-only. Replaces any prior photo in Cloudinary so we don't leak assets.
router.post(
  "/me/photo",
  requireAuth,
  strictLimiter,
  validate({ body: kitchenPhotoBodySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id")
      .lean();
    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { image } = req.body as z.infer<typeof kitchenPhotoBodySchema>;
    const kitchen = await uploadKitchenPhoto(
      currentUser._id.toString(),
      image
    );

    res.status(200).json({ kitchen });
  })
);

// DELETE /api/kitchens/me/photo — Remove the kitchen photo and destroy the
// Cloudinary asset. Lead-only. Idempotent — returns 200 even if no photo.
router.delete(
  "/me/photo",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id")
      .lean();
    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const kitchen = await deleteKitchenPhoto(currentUser._id.toString());
    res.status(200).json({ kitchen });
  })
);

// POST /api/kitchens/join — Join via invite code
// `joinKitchenLimiter` is applied per-IP so an attacker cannot brute-force the
// 6-character invite code space (36^6 ≈ 2.2B, but 30 attempts/15min caps the
// realistic throughput to < 3k/day per IP).
router.post(
  "/join",
  requireAuth,
  joinKitchenLimiter,
  validate({ body: joinKitchenSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { inviteCode } = req.body as z.infer<typeof joinKitchenSchema>;
    const kitchen = await joinKitchen(currentUser._id.toString(), inviteCode);

    res.status(200).json({ kitchen });
  })
);

// POST /api/kitchens/leave — Leave kitchen
router.post(
  "/leave",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await leaveKitchen(currentUser._id.toString());

    res.status(200).json({ success: true });
  })
);

// POST /api/kitchens/members/:id/remove — Remove member (lead only)
router.post(
  "/members/:id/remove",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await removeMember(currentUser._id.toString(), id);

    res.status(200).json({ success: true });
  })
);

// POST /api/kitchens/members/:id/transfer — Transfer lead
router.post(
  "/members/:id/transfer",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const kitchen = await transferLead(currentUser._id.toString(), id);

    res.status(200).json({ kitchen });
  })
);

// PATCH /api/kitchens/permissions — Update permissions (lead only)
router.patch(
  "/permissions",
  requireAuth,
  validate({ body: updatePermissionsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const permissions = req.body as z.infer<typeof updatePermissionsSchema>;
    const kitchen = await updatePermissions(
      currentUser._id.toString(),
      permissions
    );

    res.status(200).json({ kitchen });
  })
);

// POST /api/kitchens/regenerate-code — New invite code (lead only)
router.post(
  "/regenerate-code",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const kitchen = await regenerateInviteCode(currentUser._id.toString());

    res.status(200).json({ kitchen });
  })
);

// GET /api/kitchens/recipes — Kitchen members' shared recipes (paginated)
router.get(
  "/recipes",
  requireAuth,
  validate({ query: paginationSchema }),
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
      res.status(400).json({ error: "You are not in a kitchen" });
      return;
    }

    const { page, limit, memberId } = req.query as unknown as z.infer<
      typeof paginationSchema
    >;
    const result = await getKitchenRecipes(
      currentUser.kitchenId.toString(),
      page,
      limit,
      memberId
    );

    res.status(200).json({
      recipes: result.data,
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    });
  })
);

// --- In-App Invites ---

const sendInviteSchema = z.object({
  recipientUserId: z
    .string()
    .refine(isValidObjectId, { message: "Invalid user ID format" }),
});

// POST /api/kitchens/invites — Send an in-app invite to another user (lead only)
// `strictLimiter` applied because this endpoint triggers a push notification
// on success; tighter rate limit prevents abuse.
router.post(
  "/invites",
  requireAuth,
  strictLimiter,
  validate({ body: sendInviteSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { recipientUserId } = req.body as z.infer<typeof sendInviteSchema>;
    const invite = await sendKitchenInvite(
      currentUser._id.toString(),
      recipientUserId
    );

    res.status(201).json({ invite });
  })
);

// GET /api/kitchens/invites — Pending invites for the current user (recipient view)
router.get(
  "/invites",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const invites = await listPendingInvitesForRecipient(
      currentUser._id.toString()
    );

    res.status(200).json({ invites });
  })
);

// POST /api/kitchens/invites/:id/accept — Accept a pending invite
router.post(
  "/invites/:id/accept",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const result = await acceptKitchenInvite(currentUser._id.toString(), id);

    res.status(200).json(result);
  })
);

// POST /api/kitchens/invites/:id/decline — Decline a pending invite
router.post(
  "/invites/:id/decline",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const result = await declineKitchenInvite(currentUser._id.toString(), id);

    res.status(200).json(result);
  })
);

// DELETE /api/kitchens/invites/:id — Cancel a pending invite (sender only)
router.delete(
  "/invites/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await cancelKitchenInvite(currentUser._id.toString(), id);

    res.status(200).json({ success: true });
  })
);

// --- Custom Meal Slots ---

const customSlotsSchema = z.object({
  customMealSlots: z
    .array(z.string().min(1).max(50).trim())
    .max(20, { message: "Maximum 20 custom meal slots" }),
  /**
   * When true, the server cascade-deletes any schedule entries still using
   * a slot that's being removed. When false (default), the server rejects
   * the request with 409 if any removal would orphan meals — the client
   * must re-submit with force=true after the user confirms.
   */
  force: z.boolean().optional(),
});

// GET /api/kitchens/slots — Get the kitchen's custom meal slots
router.get(
  "/slots",
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
      res.status(400).json({ error: "You are not in a kitchen" });
      return;
    }

    const kitchen = await Kitchen.findById(currentUser.kitchenId)
      .select("customMealSlots")
      .lean();

    if (!kitchen) {
      res.status(404).json({ error: "Kitchen not found" });
      return;
    }

    res.status(200).json({ customMealSlots: kitchen.customMealSlots ?? [] });
  })
);

// PUT /api/kitchens/slots — Replace custom meal slots (lead only)
router.put(
  "/slots",
  requireAuth,
  validate({ body: customSlotsSchema }),
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
      res.status(400).json({ error: "You are not in a kitchen" });
      return;
    }

    const kitchen = await Kitchen.findById(currentUser.kitchenId)
      .select("leadId")
      .lean();

    if (!kitchen) {
      res.status(404).json({ error: "Kitchen not found" });
      return;
    }

    if (kitchen.leadId.toString() !== currentUser._id.toString()) {
      res.status(403).json({ error: "Only the kitchen lead can manage meal slots" });
      return;
    }

    const { customMealSlots, force } = req.body as z.infer<
      typeof customSlotsSchema
    >;

    // Deduplicate and normalise (trim only — slot names preserve the lead's
    // chosen casing, e.g. "Pre-Workout").
    const normalised = [
      ...new Set(customMealSlots.map((s) => s.trim())),
    ].filter((s) => s.length > 0);

    // ── Compute which slots are being removed ────────────────────────
    const previous = await Kitchen.findById(currentUser.kitchenId)
      .select("customMealSlots")
      .lean();
    const previousSlots = previous?.customMealSlots ?? [];
    const normalisedSet = new Set(normalised.map((s) => s.toLowerCase()));
    const removedSlots = previousSlots.filter(
      (s) => !normalisedSet.has(s.toLowerCase())
    );

    // ── Preflight: count affected schedule entries per removed slot ──
    let affectedCount = 0;
    const affectedBySlot: Record<string, number> = {};
    if (removedSlots.length > 0) {
      for (const slot of removedSlots) {
        const count = await ScheduleEntry.countDocuments({
          kitchenId: currentUser.kitchenId,
          mealSlot: slot,
        });
        affectedBySlot[slot] = count;
        affectedCount += count;
      }
    }

    // If removing a slot would orphan meals and the caller hasn't opted in
    // to cascade deletion, reject with 409 so the client can surface a
    // clearer confirmation to the user.
    if (affectedCount > 0 && force !== true) {
      res.status(409).json({
        error:
          `${affectedCount} meal${affectedCount === 1 ? " is" : "s are"} ` +
          `planned in ${removedSlots.length === 1 ? "this slot" : "these slots"}. ` +
          "Re-submit with force=true to delete them.",
        needsConfirmation: true,
        affectedCount,
        removedSlots,
        affectedBySlot,
      });
      return;
    }

    // Save the new slot list first. If the subsequent cascade-delete fails,
    // the orphaned entries stay invisible (since their slot is no longer in
    // the list) and a retry will clean them up. Reversing this order risks
    // deleting entries then failing to save, which would be worse.
    const updated = await Kitchen.findByIdAndUpdate(
      currentUser.kitchenId,
      { customMealSlots: normalised },
      { new: true, select: "customMealSlots" }
    ).lean();

    // Keep the ordered view (`mealSlotOrder`) in lockstep with the set of
    // actual slots. No-op for grandfathered kitchens that never reordered.
    await syncMealSlotOrderWithCustomSlots(currentUser.kitchenId, normalised);

    let deletedEntries = 0;
    if (removedSlots.length > 0 && affectedCount > 0) {
      const deleteResult = await ScheduleEntry.deleteMany({
        kitchenId: currentUser.kitchenId,
        mealSlot: { $in: removedSlots },
      });
      deletedEntries = deleteResult.deletedCount ?? 0;
    }

    res.status(200).json({
      customMealSlots: updated?.customMealSlots ?? [],
      deletedEntries,
      removedSlots,
    });
  })
);

// --- Hidden default meal slots (lead only) ---

const hiddenDefaultsSchema = z.object({
  hiddenDefaultSlots: z
    .array(z.string().trim().toLowerCase())
    .max(DEFAULT_MEAL_SLOTS.length, {
      message: `At most ${DEFAULT_MEAL_SLOTS.length} default slots can be hidden`,
    })
    .refine(
      (arr) => arr.every((s) => DEFAULT_MEAL_SLOTS.includes(s)),
      {
        message: `hiddenDefaultSlots may only contain ${DEFAULT_MEAL_SLOTS.join(", ")}`,
      }
    ),
  /**
   * When true, the server cascade-deletes any schedule entries planned in a
   * default that's being newly hidden. When false (default), the server
   * rejects with 409 if any meal would be orphaned — the client must
   * re-submit with `force=true` after the user confirms.
   */
  force: z.boolean().optional(),
});

// PUT /api/kitchens/slots/defaults — Replace hidden-default-slot list (lead only)
router.put(
  "/slots/defaults",
  requireAuth,
  validate({ body: hiddenDefaultsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { hiddenDefaultSlots, force } = req.body as z.infer<
      typeof hiddenDefaultsSchema
    >;

    const result = await setHiddenDefaultSlots(
      currentUser._id.toString(),
      hiddenDefaultSlots,
      { force }
    );

    if (result.kind === "needs_confirmation") {
      res.status(409).json({
        error:
          `${result.affectedCount} meal${result.affectedCount === 1 ? " is" : "s are"} ` +
          `planned in ${result.removedSlots.length === 1 ? "this slot" : "these slots"}. ` +
          "Re-submit with force=true to delete them.",
        needsConfirmation: true,
        affectedCount: result.affectedCount,
        removedSlots: result.removedSlots,
        affectedBySlot: result.affectedBySlot,
      });
      return;
    }

    res.status(200).json({
      hiddenDefaultSlots: result.kitchen.hiddenDefaultSlots ?? [],
      deletedEntries: result.deletedEntries,
      removedSlots: result.removedSlots,
    });
  })
);

// --- Members' shared rating history ---

// GET /api/kitchens/ratings-history — full rating history for the viewer's
// kitchen. Members-only: non-members get 400 from the service.
//
// IMPORTANT: must be declared BEFORE the `/:id` route below so Express doesn't
// try to interpret "ratings-history" as a kitchen id param.
router.get(
  "/ratings-history",
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
    const result = await getKitchenRatingsHistory(
      currentUser._id.toString(),
      page,
      limit
    );

    res.status(200).json(result);
  })
);

// --- Public kitchen discovery ---

// GET /api/kitchens/:id — discoverable view of any kitchen.
// Public kitchens are visible to any signed-in user; private kitchens return
// 404 to everyone except current members.
router.get(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const view = await getPublicKitchen(currentUser._id.toString(), id);
    res.status(200).json(view);
  })
);

// GET /api/kitchens/:id/schedule — recent + upcoming schedule entries for a
// public kitchen. Same privacy gate as `/:id`.
router.get(
  "/:id/schedule",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const entries = await getPublicKitchenSchedule(
      currentUser._id.toString(),
      id
    );
    res.status(200).json({ entries });
  })
);

// GET /api/kitchens/:id/recipes — discoverable recipes from this kitchen's
// members. Same privacy gate as `/:id`.
router.get(
  "/:id/recipes",
  requireAuth,
  validate({ params: objectIdParam, query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const { page, limit } = req.query as unknown as z.infer<
      typeof paginationSchema
    >;
    const result = await getPublicKitchenRecipes(
      currentUser._id.toString(),
      id,
      page,
      limit
    );

    res.status(200).json({
      recipes: result.data,
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    });
  })
);

export default router;
