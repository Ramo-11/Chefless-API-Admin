import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requirePremium } from "../middleware/premium";
import { validate } from "../middleware/validate";
import {
  reserveAiQuota,
  releaseAiQuota,
  getAiUsage,
  aiGenerateFromIngredients,
  aiSuggestSubstitutions,
  aiFormatRoughNotes,
} from "../services/ai-recipe-service";
import { askAboutRecipe } from "../services/ask-recipe-service";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

function resolveMongoUserId(req: Request): string | null {
  return req.user?.userId ?? null;
}

/**
 * Minutes east of UTC (Dart's `DateTime.timeZoneOffset.inMinutes`). Clients
 * send it on every AI call so the daily quota resets at the user's local
 * midnight instead of UTC midnight. Clipped on the server to ±14h to catch
 * garbage input, and stored to the User doc for admin visibility.
 */
const timezoneOffsetField = z
  .number()
  .int()
  .min(-840)
  .max(840)
  .optional();

const generateSchema = z.object({
  prompt: z.string().min(1).max(4000),
  timezoneOffsetMinutes: timezoneOffsetField,
});

const substituteSchema = z.object({
  ingredients: z.string().min(1).max(8000),
  dietaryNeed: z.string().min(1).max(500),
  timezoneOffsetMinutes: timezoneOffsetField,
});

const formatSchema = z.object({
  notes: z.string().min(1).max(12000),
  timezoneOffsetMinutes: timezoneOffsetField,
});

const askRecipeSchema = z.object({
  recipeId: z.string().trim().regex(/^[a-f\d]{24}$/i),
  question: z.string().trim().min(1).max(500),
  history: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(500),
        answer: z.string().trim().min(1).max(4000),
      })
    )
    .max(8)
    .optional(),
  servings: z.number().int().min(1).max(100).optional(),
  stepIndex: z.number().int().min(0).max(500).optional(),
  measurementSystem: z.enum(["original", "metric", "imperial"]).optional(),
  locale: z.enum(["en", "ar", "tr", "es"]),
  timezoneOffsetMinutes: timezoneOffsetField,
});

function offsetFromQuery(req: Request): number | undefined {
  const raw = req.query.timezoneOffsetMinutes;
  if (typeof raw !== "string") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

router.get(
  "/usage",
  requireAuth,
  requirePremium,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = resolveMongoUserId(req);
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const usage = await getAiUsage(userId, offsetFromQuery(req));
    res.status(200).json(usage);
  })
);

router.post(
  "/generate-recipe",
  requireAuth,
  requirePremium,
  validate({ body: generateSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = resolveMongoUserId(req);
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const { prompt, timezoneOffsetMinutes: tz } =
      req.body as z.infer<typeof generateSchema>;
    const reservation = await reserveAiQuota(userId, "generate", tz);
    let recipe;
    try {
      recipe = await aiGenerateFromIngredients(prompt, { userId, feature: "generate" });
    } catch (err) {
      await releaseAiQuota(userId, reservation);
      throw err;
    }
    const usage = await getAiUsage(userId, tz);
    res.status(200).json({ recipe, usage });
  })
);

router.post(
  "/suggest-substitutions",
  requireAuth,
  requirePremium,
  validate({ body: substituteSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = resolveMongoUserId(req);
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const body = req.body as z.infer<typeof substituteSchema>;
    const tz = body.timezoneOffsetMinutes;
    const reservation = await reserveAiQuota(userId, "substitutions", tz);
    let result;
    try {
      result = await aiSuggestSubstitutions(body.ingredients, body.dietaryNeed, {
        userId,
        feature: "substitutions",
      });
    } catch (err) {
      await releaseAiQuota(userId, reservation);
      throw err;
    }
    const usage = await getAiUsage(userId, tz);
    res.status(200).json({ ...result, usage });
  })
);

router.post(
  "/format-recipe",
  requireAuth,
  requirePremium,
  validate({ body: formatSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = resolveMongoUserId(req);
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const { notes, timezoneOffsetMinutes: tz } =
      req.body as z.infer<typeof formatSchema>;
    const reservation = await reserveAiQuota(userId, "format", tz);
    let recipe;
    try {
      recipe = await aiFormatRoughNotes(notes, { userId, feature: "format" });
    } catch (err) {
      await releaseAiQuota(userId, reservation);
      throw err;
    }
    const usage = await getAiUsage(userId, tz);
    res.status(200).json({ recipe, usage });
  })
);

router.post(
  "/ask-recipe",
  requireAuth,
  validate({ body: askRecipeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = resolveMongoUserId(req);
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res
      .status(200)
      .json(await askAboutRecipe(userId, req.body as z.infer<typeof askRecipeSchema>));
  })
);

export default router;
