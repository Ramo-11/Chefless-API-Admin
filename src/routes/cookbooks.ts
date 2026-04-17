import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import {
  createCookbook,
  updateCookbook,
  deleteCookbook,
  listMyCookbooks,
  getCookbook,
  addRecipesToCookbook,
  removeRecipeFromCookbook,
  listCookbookRecipes,
  listCookbooksContainingRecipe,
} from "../services/cookbook-service";

const router = Router();

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

const recipeIdParam = z.object({
  id: z.string().refine(isValidObjectId, { message: "Invalid ID format" }),
  recipeId: z
    .string()
    .refine(isValidObjectId, { message: "Invalid recipe ID format" }),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// Cookbook recipe lists are rendered as one scrollable view (no pagination
// UI), so allow a larger window than the default list endpoints.
const cookbookRecipesPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const createCookbookSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  description: z.string().max(500).optional(),
  coverPhoto: z.string().url().optional(),
  isPrivate: z.boolean().optional(),
  recipeIds: z
    .array(z.string().refine(isValidObjectId, { message: "Invalid recipe ID" }))
    .max(500)
    .optional(),
});

const updateCookbookSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).nullable().optional(),
  coverPhoto: z.string().url().nullable().optional(),
  isPrivate: z.boolean().optional(),
});

const addRecipesSchema = z.object({
  recipeIds: z
    .array(z.string().refine(isValidObjectId, { message: "Invalid recipe ID" }))
    .min(1)
    .max(100),
});

const filterRecipesSchema = cookbookRecipesPaginationSchema.extend({
  label: z.string().max(50).optional(),
  dietaryTag: z.string().max(50).optional(),
  cuisineTag: z.string().max(50).optional(),
  maxCookTime: z.coerce.number().int().min(1).max(1440).optional(),
  sort: z.enum(["newest", "oldest", "popular", "alphabetical"]).optional(),
});

const containingRecipeQuery = z.object({
  recipeId: z.string().refine(isValidObjectId, { message: "Invalid recipe ID" }),
});

// --- Routes ---

// GET /api/cookbooks — own cookbooks
router.get(
  "/",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<
      typeof paginationSchema
    >;
    const result = await listMyCookbooks(user._id.toString(), page, limit);
    res.status(200).json(result);
  })
);

// POST /api/cookbooks — create
router.post(
  "/",
  requireAuth,
  validate({ body: createCookbookSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const data = req.body as z.infer<typeof createCookbookSchema>;
    const cookbook = await createCookbook(user._id.toString(), data);
    res.status(201).json({ cookbook });
  })
);

// GET /api/cookbooks/containing — cookbook IDs that hold a given recipe
router.get(
  "/containing",
  requireAuth,
  validate({ query: containingRecipeQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { recipeId } = req.query as unknown as z.infer<
      typeof containingRecipeQuery
    >;
    const ids = await listCookbooksContainingRecipe(
      user._id.toString(),
      recipeId
    );
    res.status(200).json({ cookbookIds: ids });
  })
);

// GET /api/cookbooks/:id — detail
router.get(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const viewerId = user ? user._id.toString() : null;
    const cookbook = await getCookbook(id, viewerId);
    res.status(200).json({ cookbook });
  })
);

// PATCH /api/cookbooks/:id — update
router.patch(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam, body: updateCookbookSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const updates = req.body as z.infer<typeof updateCookbookSchema>;
    const cookbook = await updateCookbook(id, user._id.toString(), updates);
    res.status(200).json({ cookbook });
  })
);

// DELETE /api/cookbooks/:id — delete
router.delete(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await deleteCookbook(id, user._id.toString());
    res.status(200).json({ success: true });
  })
);

// GET /api/cookbooks/:id/recipes — recipes in cookbook with filters
router.get(
  "/:id/recipes",
  requireAuth,
  validate({ params: objectIdParam, query: filterRecipesSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const filters = req.query as unknown as z.infer<typeof filterRecipesSchema>;
    const viewerId = user ? user._id.toString() : null;

    const result = await listCookbookRecipes(
      id,
      viewerId,
      filters.page,
      filters.limit,
      {
        label: filters.label,
        dietaryTag: filters.dietaryTag,
        cuisineTag: filters.cuisineTag,
        maxCookTime: filters.maxCookTime,
        sort: filters.sort,
      }
    );
    res.status(200).json(result);
  })
);

// POST /api/cookbooks/:id/recipes — add recipes
router.post(
  "/:id/recipes",
  requireAuth,
  validate({ params: objectIdParam, body: addRecipesSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const { recipeIds } = req.body as z.infer<typeof addRecipesSchema>;
    const cookbook = await addRecipesToCookbook(
      id,
      user._id.toString(),
      recipeIds
    );
    res.status(200).json({ cookbook });
  })
);

// DELETE /api/cookbooks/:id/recipes/:recipeId — remove recipe
router.delete(
  "/:id/recipes/:recipeId",
  requireAuth,
  validate({ params: recipeIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id, recipeId } = req.params as z.infer<typeof recipeIdParam>;
    const cookbook = await removeRecipeFromCookbook(
      id,
      user._id.toString(),
      recipeId
    );
    res.status(200).json({ cookbook });
  })
);

export default router;
