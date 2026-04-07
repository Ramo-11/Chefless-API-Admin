import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import Kitchen from "../models/Kitchen";
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
  photo: z.string().url().optional(),
  isPublic: z.boolean().optional(),
});

const updateKitchenSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  photo: z.string().url().optional(),
  isPublic: z.boolean().optional(),
});

const joinKitchenSchema = z.object({
  inviteCode: z
    .string()
    .min(1)
    .regex(INVITE_CODE_REGEX, {
      message: "Invalid invite code format. Expected CHEF-XXXXXX",
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

// POST /api/kitchens/join — Join via invite code
router.post(
  "/join",
  requireAuth,
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

// --- Custom Meal Slots ---

const customSlotsSchema = z.object({
  customMealSlots: z
    .array(z.string().min(1).max(50).trim())
    .max(20, { message: "Maximum 20 custom meal slots" }),
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

    const { customMealSlots } = req.body as z.infer<typeof customSlotsSchema>;

    // Deduplicate and normalise to lowercase for consistent matching
    const normalised = [
      ...new Set(customMealSlots.map((s) => s.trim())),
    ].filter((s) => s.length > 0);

    const updated = await Kitchen.findByIdAndUpdate(
      currentUser.kitchenId,
      { customMealSlots: normalised },
      { new: true, select: "customMealSlots" }
    ).lean();

    res.status(200).json({ customMealSlots: updated?.customMealSlots ?? [] });
  })
);

export default router;
