import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import {
  createReport,
  getReports,
  getReportById,
  reviewReport,
} from "../services/report-service";

const router = Router();

// ── User-facing: create a report ────────────────────────────────────

const createReportSchema = z.object({
  targetType: z.enum(["recipe", "user"]),
  targetId: z.string().min(1),
  reason: z.enum(["spam", "inappropriate", "copyright", "harassment", "other"]),
  description: z.string().max(500).optional(),
});

router.post(
  "/",
  requireAuth,
  validate({ body: createReportSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await User.findOne({ firebaseUid: req.user!.uid }).lean();
      if (!user) {
        res.status(401).json({ error: "User not found" });
        return;
      }

      const report = await createReport({
        reporterId: user._id.toString(),
        ...req.body,
      });

      res.status(201).json({ report });
    } catch (error) {
      next(error);
    }
  }
);

// ── Admin-facing endpoints — require auth + admin session ──────────

router.get(
  "/",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string | undefined;
      const targetType = req.query.targetType as string | undefined;

      const result = await getReports({
        page,
        limit,
        status: status as "pending" | "reviewed" | "dismissed" | "action_taken" | undefined,
        targetType: targetType as "recipe" | "user" | undefined,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/:id",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const report = await getReportById(id);
      res.json({ report });
    } catch (error) {
      next(error);
    }
  }
);

const reviewSchema = z.object({
  status: z.enum(["reviewed", "dismissed", "action_taken"]),
  reviewNote: z.string().max(1000).optional(),
});

router.patch(
  "/:id",
  requireAuth,
  validate({ body: reviewSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const adminUserId = req.adminUserId;
      const report = await reviewReport(
        id,
        adminUserId || "system",
        req.body.status,
        req.body.reviewNote
      );

      res.json({ report });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
