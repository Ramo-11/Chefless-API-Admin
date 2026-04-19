import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import {
  createFeedback,
  getMyFeedback,
} from "../services/feedback-service";

const router = Router();

// ── User-facing: submit feedback ───────────────────────────────────

const createFeedbackSchema = z.object({
  category: z
    .enum(["bug", "idea", "improvement", "praise", "other"])
    .optional(),
  message: z.string().trim().min(10).max(2000),
  appVersion: z.string().trim().max(50).optional(),
  platform: z.enum(["ios", "android", "web"]).optional(),
});

router.post(
  "/",
  requireAuth,
  validate({ body: createFeedbackSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await User.findOne({ firebaseUid: req.user!.uid })
        .select("_id")
        .lean();
      if (!user) {
        res.status(401).json({ error: "User not found" });
        return;
      }

      const feedback = await createFeedback({
        userId: user._id.toString(),
        ...req.body,
      });

      res.status(201).json({ feedback });
    } catch (error) {
      next(error);
    }
  }
);

// ── User-facing: list my feedback submissions ──────────────────────

const listMineSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get(
  "/mine",
  requireAuth,
  validate({ query: listMineSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await User.findOne({ firebaseUid: req.user!.uid })
        .select("_id")
        .lean();
      if (!user) {
        res.status(401).json({ error: "User not found" });
        return;
      }

      const { page, limit } = req.query as unknown as z.infer<
        typeof listMineSchema
      >;

      const result = await getMyFeedback({
        userId: user._id.toString(),
        page,
        limit,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
