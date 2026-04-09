import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requirePremium } from "../middleware/premium";
import { validate } from "../middleware/validate";
import User from "../models/User";
import {
  assertAiQuota,
  recordAiUsage,
  aiGenerateFromIngredients,
  aiSuggestSubstitutions,
  aiFormatRoughNotes,
} from "../services/ai-recipe-service";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

async function resolveMongoUserId(req: Request): Promise<string | null> {
  const firebaseUid = req.user?.uid;
  if (!firebaseUid) return null;
  const u = await User.findOne({ firebaseUid }).select("_id").lean();
  return u?._id.toString() ?? null;
}

const generateSchema = z.object({
  prompt: z.string().min(1).max(4000),
});

const substituteSchema = z.object({
  ingredients: z.string().min(1).max(8000),
  dietaryNeed: z.string().min(1).max(500),
});

const formatSchema = z.object({
  notes: z.string().min(1).max(12000),
});

router.post(
  "/generate-recipe",
  requireAuth,
  requirePremium,
  validate({ body: generateSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveMongoUserId(req);
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    await assertAiQuota(userId);
    const { prompt } = req.body as z.infer<typeof generateSchema>;
    const recipe = await aiGenerateFromIngredients(prompt);
    await recordAiUsage(userId);
    res.status(200).json({ recipe });
  })
);

router.post(
  "/suggest-substitutions",
  requireAuth,
  requirePremium,
  validate({ body: substituteSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveMongoUserId(req);
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    await assertAiQuota(userId);
    const body = req.body as z.infer<typeof substituteSchema>;
    const result = await aiSuggestSubstitutions(body.ingredients, body.dietaryNeed);
    await recordAiUsage(userId);
    res.status(200).json(result);
  })
);

router.post(
  "/format-recipe",
  requireAuth,
  requirePremium,
  validate({ body: formatSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = await resolveMongoUserId(req);
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    await assertAiQuota(userId);
    const { notes } = req.body as z.infer<typeof formatSchema>;
    const recipe = await aiFormatRoughNotes(notes);
    await recordAiUsage(userId);
    res.status(200).json({ recipe });
  })
);

export default router;
