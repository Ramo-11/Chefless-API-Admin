import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import {
  createList,
  getLists,
  getList,
  updateList,
  deleteList,
  duplicateList,
  uncheckAll,
  addItem,
  removeItem,
  updateItem,
  clearCompleted,
  toggleItem,
  generateFromSchedule,
} from "../services/shopping-list-service";

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

const objectIdParam = z.object({
  id: z.string().refine(isValidObjectId, { message: "Invalid ID format" }),
});

const itemIdParams = z.object({
  id: z.string().refine(isValidObjectId, { message: "Invalid list ID format" }),
  itemId: z.string().refine(isValidObjectId, { message: "Invalid item ID format" }),
});

const createListSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  kitchenId: z
    .string()
    .refine(isValidObjectId, { message: "Invalid kitchen ID format" })
    .optional(),
  isPrivate: z.boolean().optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(200).trim(),
        quantity: z.number().min(0).optional(),
        unit: z.string().max(50).trim().optional(),
        category: z.string().max(50).trim().optional(),
      })
    )
    .optional(),
});

const updateListSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  isPrivate: z.boolean().optional(),
});

const duplicateListSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
});

const addItemSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  quantity: z.number().min(0).optional(),
  unit: z.string().max(50).trim().optional(),
  recipeId: z
    .string()
    .refine(isValidObjectId, { message: "Invalid recipe ID format" })
    .optional(),
  category: z.string().max(50).trim().optional(),
  notes: z.string().max(500).trim().optional(),
  imageUrl: z.string().url().optional(),
});

const updateItemSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  quantity: z.number().min(0).nullable().optional(),
  unit: z.string().max(50).trim().nullable().optional(),
  category: z.string().max(50).trim().nullable().optional(),
  notes: z.string().max(500).trim().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
});

const generateSchema = z.object({
  kitchenId: z
    .string()
    .refine(isValidObjectId, { message: "Invalid kitchen ID format" })
    .optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  name: z.string().min(1).max(200).trim().optional(),
});

// --- Helper to resolve Firebase UID to Mongo user ID ---

async function resolveUserId(req: Request, res: Response): Promise<string | null> {
  const firebaseUid = req.user!.uid;
  const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

  if (!currentUser) {
    res.status(404).json({ error: "User not found" });
    return null;
  }

  return currentUser._id.toString();
}

// --- Routes ---

// POST /api/shopping-lists/generate — Generate from schedule (MUST be before /:id)
router.post(
  "/generate",
  requireAuth,
  validate({ body: generateSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const data = req.body as z.infer<typeof generateSchema>;
    const list = await generateFromSchedule(userId, {
      kitchenId: data.kitchenId,
      startDate: data.startDate,
      endDate: data.endDate,
      name: data.name,
    });

    res.status(201).json({ list });
  })
);

// GET /api/shopping-lists — Get all lists
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const lists = await getLists(userId);

    res.status(200).json({ lists });
  })
);

// POST /api/shopping-lists — Create new list
router.post(
  "/",
  requireAuth,
  validate({ body: createListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const data = req.body as z.infer<typeof createListSchema>;
    const list = await createList(userId, {
      name: data.name,
      kitchenId: data.kitchenId,
      isPrivate: data.isPrivate,
      items: data.items,
    });

    res.status(201).json({ list });
  })
);

// GET /api/shopping-lists/:id — Get single list
router.get(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const list = await getList(id, userId);

    res.status(200).json({ list });
  })
);

// PATCH /api/shopping-lists/:id — Update list
router.patch(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam, body: updateListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const updates = req.body as z.infer<typeof updateListSchema>;
    const list = await updateList(id, userId, updates);

    res.status(200).json({ list });
  })
);

// DELETE /api/shopping-lists/:id — Delete list
router.delete(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await deleteList(id, userId);

    res.status(200).json({ success: true });
  })
);

// POST /api/shopping-lists/:id/items — Add item
router.post(
  "/:id/items",
  requireAuth,
  validate({ params: objectIdParam, body: addItemSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const item = req.body as z.infer<typeof addItemSchema>;
    const list = await addItem(id, userId, item);

    res.status(201).json({ list });
  })
);

// DELETE /api/shopping-lists/:id/items/:itemId — Remove item
router.delete(
  "/:id/items/:itemId",
  requireAuth,
  validate({ params: itemIdParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const { id, itemId } = req.params as z.infer<typeof itemIdParams>;
    const list = await removeItem(id, userId, itemId);

    res.status(200).json({ list });
  })
);

// PATCH /api/shopping-lists/:id/items/:itemId/toggle — Toggle item checked
router.patch(
  "/:id/items/:itemId/toggle",
  requireAuth,
  validate({ params: itemIdParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const { id, itemId } = req.params as z.infer<typeof itemIdParams>;
    const list = await toggleItem(id, userId, itemId);

    res.status(200).json({ list });
  })
);

// PATCH /api/shopping-lists/:id/items/:itemId — Update item
router.patch(
  "/:id/items/:itemId",
  requireAuth,
  validate({ params: itemIdParams, body: updateItemSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const { id, itemId } = req.params as z.infer<typeof itemIdParams>;
    const updates = req.body as z.infer<typeof updateItemSchema>;
    const list = await updateItem(id, userId, itemId, updates);

    res.status(200).json({ list });
  })
);

// POST /api/shopping-lists/:id/duplicate — Duplicate a list
router.post(
  "/:id/duplicate",
  requireAuth,
  validate({ params: objectIdParam, body: duplicateListSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const { name } = req.body as z.infer<typeof duplicateListSchema>;
    const list = await duplicateList(id, userId, name);

    res.status(201).json({ list });
  })
);

// POST /api/shopping-lists/:id/uncheck-all — Uncheck all items
router.post(
  "/:id/uncheck-all",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const list = await uncheckAll(id, userId);

    res.status(200).json({ list });
  })
);

// POST /api/shopping-lists/:id/clear-completed — Remove all checked items
router.post(
  "/:id/clear-completed",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveUserId(req, res);
    if (!userId) return;

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const list = await clearCompleted(id, userId);

    res.status(200).json({ list });
  })
);

export default router;
