import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { validate } from "../middleware/validate";
import { recordClientError } from "../services/error-report-service";
import { logger } from "../lib/logger";

const router = Router();

const isDev = process.env.NODE_ENV !== "production";

/**
 * Crash reports come in from the unauthenticated `ErrorWidget.builder` path,
 * so we can't gate by Firebase token. Cap by IP to keep a misbehaving client
 * from drowning the queue. 60 per 5min per IP is enough for legitimate burst
 * (a user can't crash twice per second without help).
 */
const errorReportLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: isDev ? 1000 : 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${req.ip ?? "unknown"}`,
  message: { error: "Too many error reports, slow down" },
});

const reportSchema = z.object({
  platform: z.enum(["ios", "android", "web"]),
  source: z
    .enum([
      "flutter_error",
      "platform_error",
      "widget_build",
      "auth_google",
      "auth_apple",
      "auth_email",
      "manual",
      "other",
    ])
    .optional(),
  exception: z.string().trim().min(1).max(4000),
  reason: z.string().trim().max(500).optional(),
  stack: z.string().max(20000).optional(),
  route: z.string().trim().max(500).optional(),
  appVersion: z.string().trim().max(50).optional(),
  buildMode: z.string().trim().max(30).optional(),
  osVersion: z.string().trim().max(100).optional(),
  deviceModel: z.string().trim().max(200).optional(),
  firebaseUid: z.string().trim().max(128).optional(),
});

router.post(
  "/",
  errorReportLimiter,
  validate({ body: reportSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await recordClientError(req.body);
      // 202 — accepted; the alert is async, the client never waits on it.
      res.status(202).json({ ok: true, ...result });
    } catch (error) {
      logger.error({ err: error }, "Failed to record client error");
      next(error);
    }
  }
);

export default router;
