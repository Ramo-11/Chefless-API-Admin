import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import {
  createRecipe,
  getRecipe,
  updateRecipe,
  deleteRecipe,
  listMyRecipes,
  forkRecipe,
  likeRecipe,
  unlikeRecipe,
  listLikedRecipes,
  listForkedRecipes,
  shareRecipe,
  uploadRecipePhoto,
} from "../services/recipe-service";

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

// --- Zod Schemas ---

const objectIdParam = z.object({
  id: z.string().refine(isValidObjectId, { message: "Invalid ID format" }),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const ingredientSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().min(0),
  unit: z.string().min(1).max(50),
  group: z.string().max(100).optional(),
});

const stepSchema = z.object({
  order: z.number().int().min(0),
  instruction: z.string().min(1).max(5000),
  photo: z.string().url().optional(),
});

const createRecipeSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(2000).optional(),
  story: z.string().max(5000).optional(),
  photos: z.array(z.string().url()).max(5).optional(),
  showSignature: z.boolean().optional(),
  labels: z.array(z.string().max(50)).max(20).optional(),
  dietaryTags: z.array(z.string().max(50)).max(20).optional(),
  cuisineTags: z.array(z.string().max(50)).max(20).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  ingredients: z.array(ingredientSchema).optional(),
  steps: z.array(stepSchema).optional(),
  prepTime: z.number().int().min(0).optional(),
  cookTime: z.number().int().min(0).optional(),
  servings: z.number().int().min(1).optional(),
  calories: z.number().int().min(0).optional(),
  costEstimate: z.enum(["budget", "moderate", "expensive"]).optional(),
  baseServings: z.number().int().min(1).optional(),
  isPrivate: z.boolean().optional(),
});

const updateRecipeSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  story: z.string().max(5000).nullable().optional(),
  photos: z.array(z.string().url()).max(5).optional(),
  showSignature: z.boolean().optional(),
  labels: z.array(z.string().max(50)).max(20).optional(),
  dietaryTags: z.array(z.string().max(50)).max(20).optional(),
  cuisineTags: z.array(z.string().max(50)).max(20).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).nullable().optional(),
  ingredients: z.array(ingredientSchema).optional(),
  steps: z.array(stepSchema).optional(),
  prepTime: z.number().int().min(0).nullable().optional(),
  cookTime: z.number().int().min(0).nullable().optional(),
  servings: z.number().int().min(1).nullable().optional(),
  calories: z.number().int().min(0).nullable().optional(),
  costEstimate: z.enum(["budget", "moderate", "expensive"]).nullable().optional(),
  baseServings: z.number().int().min(1).optional(),
  isPrivate: z.boolean().optional(),
});

const listRecipesQuerySchema = paginationSchema.extend({
  label: z.string().max(50).optional(),
  dietaryTag: z.string().max(50).optional(),
  cuisineTag: z.string().max(50).optional(),
  sort: z.enum(["newest", "oldest", "popular"]).optional(),
});

const shareRecipeSchema = z.object({
  recipientId: z.string().refine(isValidObjectId, { message: "Invalid recipient ID" }),
  message: z.string().max(500).optional(),
});

const uploadPhotoSchema = z.object({
  image: z
    .string()
    .min(1, "Image data is required")
    .refine(
      (val) => val.startsWith("data:image/"),
      { message: "Must be a valid base64 data URI (data:image/...)" }
    ),
  folder: z.string().max(100).optional(),
});

// --- Routes ---
// IMPORTANT: Static routes (liked, forked, upload-photo) MUST come before /:id

// GET /api/recipes — List own recipes
router.get(
  "/",
  requireAuth,
  validate({ query: listRecipesQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { page, limit, label, dietaryTag, cuisineTag, sort } =
      req.query as unknown as z.infer<typeof listRecipesQuerySchema>;

    const result = await listMyRecipes(user._id.toString(), page, limit, {
      label,
      dietaryTag,
      cuisineTag,
      sort,
    });

    res.status(200).json(result);
  })
);

// POST /api/recipes — Create recipe
router.post(
  "/",
  requireAuth,
  validate({ body: createRecipeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const data = req.body as z.infer<typeof createRecipeSchema>;
    const recipe = await createRecipe(user._id.toString(), data);

    res.status(201).json({ recipe });
  })
);

// GET /api/recipes/liked — List liked recipes
router.get(
  "/liked",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<typeof paginationSchema>;
    const result = await listLikedRecipes(user._id.toString(), page, limit);

    res.status(200).json(result);
  })
);

// GET /api/recipes/forked — List forked recipes
router.get(
  "/forked",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<typeof paginationSchema>;
    const result = await listForkedRecipes(user._id.toString(), page, limit);

    res.status(200).json(result);
  })
);

// POST /api/recipes/upload-photo — Upload photo
router.post(
  "/upload-photo",
  requireAuth,
  validate({ body: uploadPhotoSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { image } = req.body as z.infer<typeof uploadPhotoSchema>;
    const result = await uploadRecipePhoto(image, `recipes/${user._id}`);

    res.status(200).json(result);
  })
);

// GET /api/recipes/:id — Get recipe detail
router.get(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const requesterId = user ? user._id.toString() : undefined;
    const recipe = await getRecipe(id, requesterId);

    res.status(200).json({ recipe });
  })
);

// PATCH /api/recipes/:id — Update recipe
router.patch(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam, body: updateRecipeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const updates = req.body as z.infer<typeof updateRecipeSchema>;
    const recipe = await updateRecipe(id, user._id.toString(), updates);

    res.status(200).json({ recipe });
  })
);

// DELETE /api/recipes/:id — Delete recipe
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
    await deleteRecipe(id, user._id.toString());

    res.status(200).json({ success: true });
  })
);

// POST /api/recipes/:id/fork — Fork recipe
router.post(
  "/:id/fork",
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
    const recipe = await forkRecipe(id, user._id.toString());

    res.status(201).json({ recipe });
  })
);

// POST /api/recipes/:id/like — Like recipe
router.post(
  "/:id/like",
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
    await likeRecipe(id, user._id.toString());

    res.status(200).json({ success: true });
  })
);

// DELETE /api/recipes/:id/like — Unlike recipe
router.delete(
  "/:id/like",
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
    await unlikeRecipe(id, user._id.toString());

    res.status(200).json({ success: true });
  })
);

// POST /api/recipes/:id/share — Share recipe with user
router.post(
  "/:id/share",
  requireAuth,
  validate({ params: objectIdParam, body: shareRecipeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const { recipientId, message } = req.body as z.infer<typeof shareRecipeSchema>;
    const share = await shareRecipe(id, user._id.toString(), recipientId, message);

    res.status(201).json({ share });
  })
);

export default router;
