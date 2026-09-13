import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth";
import { strictLimiter } from "../middleware/rateLimit";
import { validate } from "../middleware/validate";
import {
  createRecipe,
  getRecipe,
  updateRecipe,
  deleteRecipe,
  listMyRecipes,
  forkRecipe,
  duplicateRecipe,
  likeRecipe,
  unlikeRecipe,
  listLikedRecipes,
  saveRecipe,
  unsaveRecipe,
  listSavedRecipes,
  listForkedRecipes,
  shareRecipe,
  listSharedWithMe,
  uploadRecipePhoto,
} from "../services/recipe-service";
import {
  upsertRating,
  deleteRating,
  getRatingAggregateForViewer,
  getKitchenCookHistoryForRecipe,
} from "../services/rating-service";
import {
  extractFromUrl,
  detectSource,
  type ImportErrorCode,
} from "../services/recipe-import-service";
import {
  reserveImportQuota,
  releaseAiQuota,
  aiExtractRecipeFromCaption,
  aiExtractRecipeFromImages,
  getAiUsage,
  type RecipeImageMediaType,
} from "../services/ai-recipe-service";
import { imageDataUri } from "../lib/image-validation";

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
  unit: z.string().max(50),
  group: z.string().max(100).optional(),
});

const stepSchema = z.object({
  order: z.number().int().min(0),
  instruction: z.string().min(1).max(5000),
  photo: z.string().url().optional(),
});

const recipeSourceSchema = z.object({
  type: z.enum([
    "website",
    "instagram",
    "tiktok",
    "youtube",
    "pinterest",
    "facebook",
    "other",
  ]),
  url: z.string().url().max(2048),
  siteName: z.string().max(100).optional(),
  author: z.string().max(100).optional(),
  importedVia: z.enum(["structured", "ai"]),
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
  tags: z.array(z.string().max(50)).max(30).optional(),
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
  source: recipeSourceSchema.optional(),
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
  tags: z.array(z.string().max(50)).max(30).optional(),
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

const sharedWithMeQuerySchema = z.object({
  cursor: z
    .string()
    .refine(isValidObjectId, { message: "Invalid cursor" })
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const uploadPhotoSchema = z.object({
  image: imageDataUri(),
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
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { page, limit, label, dietaryTag, cuisineTag, sort } =
      req.query as unknown as z.infer<typeof listRecipesQuerySchema>;

    const result = await listMyRecipes(userId, page, limit, {
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
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const data = req.body as z.infer<typeof createRecipeSchema>;
    const recipe = await createRecipe(userId, data);

    res.status(201).json({ recipe });
  })
);

// GET /api/recipes/liked — List liked recipes
router.get(
  "/liked",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<typeof paginationSchema>;
    const result = await listLikedRecipes(userId, page, limit);

    res.status(200).json(result);
  })
);

// GET /api/recipes/saved — List saved recipes
router.get(
  "/saved",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<typeof paginationSchema>;
    const result = await listSavedRecipes(userId, page, limit);

    res.status(200).json(result);
  })
);

// GET /api/recipes/forked — List forked recipes
router.get(
  "/forked",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<typeof paginationSchema>;
    const result = await listForkedRecipes(userId, page, limit);

    res.status(200).json(result);
  })
);

// POST /api/recipes/upload-photo — Upload photo
router.post(
  "/upload-photo",
  requireAuth,
  validate({ body: uploadPhotoSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { image } = req.body as z.infer<typeof uploadPhotoSchema>;
    const result = await uploadRecipePhoto(image, `recipes/${userId}`);

    res.status(200).json(result);
  })
);

// GET /api/recipes/shared-with-me — List recipes shared with the current user
router.get(
  "/shared-with-me",
  requireAuth,
  validate({ query: sharedWithMeQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { cursor, limit } = req.query as unknown as z.infer<
      typeof sharedWithMeQuerySchema
    >;

    const result = await listSharedWithMe(userId, cursor, limit);
    res.status(200).json(result);
  })
);

// GET /api/recipes/:id — Get recipe detail
router.get(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as z.infer<typeof objectIdParam>;
    const requesterId = req.user?.userId;
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
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const updates = req.body as z.infer<typeof updateRecipeSchema>;
    const recipe = await updateRecipe(id, userId, updates);

    res.status(200).json({ recipe });
  })
);

// DELETE /api/recipes/:id — Delete recipe
router.delete(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await deleteRecipe(id, userId);

    res.status(200).json({ success: true });
  })
);

// POST /api/recipes/:id/fork — Fork recipe
router.post(
  "/:id/fork",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const recipe = await forkRecipe(id, userId);

    res.status(201).json({ recipe });
  })
);

// POST /api/recipes/:id/duplicate — Duplicate own recipe
router.post(
  "/:id/duplicate",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const recipe = await duplicateRecipe(id, userId);

    res.status(201).json({ recipe });
  })
);

// POST /api/recipes/:id/like — Like recipe
router.post(
  "/:id/like",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await likeRecipe(id, userId);

    res.status(200).json({ success: true });
  })
);

// DELETE /api/recipes/:id/like — Unlike recipe
router.delete(
  "/:id/like",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await unlikeRecipe(id, userId);

    res.status(200).json({ success: true });
  })
);

// POST /api/recipes/:id/save — Save recipe
router.post(
  "/:id/save",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await saveRecipe(id, userId);

    res.status(200).json({ success: true });
  })
);

// DELETE /api/recipes/:id/save — Unsave recipe
router.delete(
  "/:id/save",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await unsaveRecipe(id, userId);

    res.status(200).json({ success: true });
  })
);

// ── Ratings ─────────────────────────────────────────────────────────

const rateSchema = z.object({
  stars: z.number().int().min(1).max(5),
  note: z.string().max(500).optional(),
  scheduleEntryId: z
    .string()
    .refine(isValidObjectId, { message: "Invalid schedule entry ID" })
    .optional(),
});

// POST /api/recipes/:id/rate — upsert viewer's rating
router.post(
  "/:id/rate",
  requireAuth,
  validate({ params: objectIdParam, body: rateSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const body = req.body as z.infer<typeof rateSchema>;
    const rating = await upsertRating({
      recipeId: id,
      userId,
      stars: body.stars,
      note: body.note,
      scheduleEntryId: body.scheduleEntryId,
    });

    res.status(200).json({ rating });
  })
);

// DELETE /api/recipes/:id/rate — remove viewer's rating
router.delete(
  "/:id/rate",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await deleteRating(id, userId);
    res.status(200).json({ success: true });
  })
);

// GET /api/recipes/:id/rating — aggregate + viewer's personal rating
router.get(
  "/:id/rating",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const aggregate = await getRatingAggregateForViewer({
      userId,
      recipeId: id,
    });
    res.status(200).json(aggregate);
  })
);

// GET /api/recipes/:id/kitchen-cook-history — prior cook + rating stats for
// this recipe within the viewer's kitchen. Drives the "last time your family
// rated this" nudge shown when scheduling a previously-cooked recipe.
router.get(
  "/:id/kitchen-cook-history",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const history = await getKitchenCookHistoryForRecipe(
      userId,
      id
    );
    res.status(200).json(history);
  })
);

// POST /api/recipes/:id/share — Share recipe with user
router.post(
  "/:id/share",
  requireAuth,
  validate({ params: objectIdParam, body: shareRecipeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const { recipientId, message } = req.body as z.infer<typeof shareRecipeSchema>;
    const share = await shareRecipe(id, userId, recipientId, message);

    res.status(201).json({ share });
  })
);

// --- Recipe Import ---

/** Block internal/private IPs and enforce HTTPS for recipe import URLs. */
function isSafeImportUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    // Block private/internal hosts
    if (
      host === "localhost" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("172.") ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

const timezoneOffsetField = z.number().int().min(-840).max(840).optional();

const importRecipeSchema = z.object({
  url: z
    .string()
    .url({ message: "A valid HTTP/HTTPS URL is required." })
    .max(2048)
    .refine(isSafeImportUrl, {
      message: "URL must be a public HTTP/HTTPS address",
    }),
  timezoneOffsetMinutes: timezoneOffsetField,
});

const importFromTextSchema = z.object({
  text: z.string().min(1).max(12000),
  sourceUrl: z.string().url().max(2048).optional(),
  timezoneOffsetMinutes: timezoneOffsetField,
});

function hasImageSignature(bytes: Buffer, mediaType: RecipeImageMediaType): boolean {
  if (mediaType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mediaType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}

const imageDataUriSchema = z
  .string()
  .max(4_200_000)
  .transform((value, context) => {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Use a JPEG, PNG, or WebP image" });
      return z.NEVER;
    }
    const mediaType = match[1] as RecipeImageMediaType;
    const data = match[2];
    const bytes = Buffer.from(data, "base64");
    if (bytes.length <= 0 || bytes.length > 3_000_000) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Each image must be 3 MB or smaller" });
      return z.NEVER;
    }
    if (!hasImageSignature(bytes, mediaType)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "The image data does not match its format" });
      return z.NEVER;
    }
    return { mediaType, data };
  });

const importFromImagesSchema = z.object({
  images: z.array(z.object({ data: imageDataUriSchema })).min(1).max(4).transform((images, context) => {
    const decodedBytes = images.reduce((total, image) => total + Math.ceil(image.data.data.length * 0.75), 0);
    if (decodedBytes > 10_000_000) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Images must total 10 MB or smaller" });
      return z.NEVER;
    }
    return images.map((image) => image.data);
  }),
  timezoneOffsetMinutes: timezoneOffsetField,
});

/** Maps an extractor error code to the HTTP status the client expects. */
const IMPORT_ERROR_STATUS: Record<ImportErrorCode, number> = {
  INVALID_URL: 400,
  UNREACHABLE: 502,
  PRIVATE_OR_BLOCKED: 422,
  NO_CAPTION: 422,
  NO_RECIPE_FOUND: 422,
  TIMEOUT: 504,
};

const IMPORT_ERROR_MESSAGE: Record<ImportErrorCode, string> = {
  INVALID_URL: "That link does not look right.",
  UNREACHABLE: "We could not open that page.",
  PRIVATE_OR_BLOCKED: "This post is private, so we cannot read it.",
  NO_CAPTION: "There is no caption to read on that post.",
  NO_RECIPE_FOUND: "We could not find a recipe here.",
  TIMEOUT: "That took too long. Please try again.",
};

// POST /api/recipes/import — Fetch and parse a recipe from an external URL.
// Structured (JSON-LD) results are free; social captions go through the gated
// AI extractor. Returns pre-fill data for the creation form; does NOT save.
router.post(
  "/import",
  requireAuth,
  strictLimiter,
  validate({ body: importRecipeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { url, timezoneOffsetMinutes: tz } =
      req.body as z.infer<typeof importRecipeSchema>;

    const result = await extractFromUrl(url);

    if (result.kind === "error") {
      res.status(IMPORT_ERROR_STATUS[result.code]).json({
        code: result.code,
        error: IMPORT_ERROR_MESSAGE[result.code],
      });
      return;
    }

    if (result.kind === "structured") {
      res.status(200).json({
        recipe: result.recipe,
        source: { ...result.source, importedVia: "structured" as const },
      });
      return;
    }

    // Caption path — gated AI extraction. The quota unit is reserved before
    // the billable call and handed back on any failure, so failed extractions
    // never burn the cap and concurrent requests cannot overshoot it.
    const reservation = await reserveImportQuota(userId, tz);

    let recipe;
    try {
      recipe = await aiExtractRecipeFromCaption(result.text, url, {
        userId,
        feature: "import",
      });
    } catch (err) {
      await releaseAiQuota(userId, reservation);
      throw err;
    }
    if (!recipe) {
      await releaseAiQuota(userId, reservation);
      res.status(IMPORT_ERROR_STATUS.NO_RECIPE_FOUND).json({
        code: "NO_RECIPE_FOUND",
        error: IMPORT_ERROR_MESSAGE.NO_RECIPE_FOUND,
      });
      return;
    }

    const usage = await getAiUsage(userId, tz).catch(() => undefined);

    res.status(200).json({
      recipe,
      source: { ...result.source, importedVia: "ai" as const },
      usage,
    });
  })
);

// POST /api/recipes/import/from-text — Manual-paste fallback. Runs the same
// gated AI extractor over a caption the user pasted in by hand.
router.post(
  "/import/from-text",
  requireAuth,
  strictLimiter,
  validate({ body: importFromTextSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { text, sourceUrl, timezoneOffsetMinutes: tz } =
      req.body as z.infer<typeof importFromTextSchema>;

    // Reserve before the billable call, release on any failure (same contract
    // as the URL import above).
    const reservation = await reserveImportQuota(userId, tz);

    let recipe;
    try {
      recipe = await aiExtractRecipeFromCaption(text, sourceUrl ?? "", {
        userId,
        feature: "import",
      });
    } catch (err) {
      await releaseAiQuota(userId, reservation);
      throw err;
    }
    if (!recipe) {
      await releaseAiQuota(userId, reservation);
      res.status(IMPORT_ERROR_STATUS.NO_RECIPE_FOUND).json({
        code: "NO_RECIPE_FOUND",
        error: IMPORT_ERROR_MESSAGE.NO_RECIPE_FOUND,
      });
      return;
    }

    const usage = await getAiUsage(userId, tz).catch(() => undefined);

    const source = sourceUrl
      ? { ...detectSource(sourceUrl), importedVia: "ai" as const }
      : { type: "other" as const, url: sourceUrl ?? "", importedVia: "ai" as const };

    res.status(200).json({ recipe, source, usage });
  })
);

router.post(
  "/import/from-images",
  requireAuth,
  strictLimiter,
  validate({ body: importFromImagesSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const { images, timezoneOffsetMinutes: tz } = req.body as z.infer<typeof importFromImagesSchema>;
    const reservation = await reserveImportQuota(userId, tz);
    let extraction;
    try {
      extraction = await aiExtractRecipeFromImages(images, {
        userId,
        feature: "import",
      });
    } catch (error) {
      await releaseAiQuota(userId, reservation);
      throw error;
    }
    if (!extraction) {
      await releaseAiQuota(userId, reservation);
      res.status(422).json({
        code: "IMAGE_NOT_READABLE",
        error: "We could not read a complete recipe from those images.",
      });
      return;
    }
    const usage = await getAiUsage(userId, tz).catch(() => undefined);
    res.status(200).json({
      recipe: extraction.recipe,
      usage,
      review: {
        needsReview: true,
        missingFields: extraction.missingFields,
        warnings: extraction.warnings,
      },
    });
  })
);

export default router;
