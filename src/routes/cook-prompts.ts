import { Router, Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import { requireAuth } from "../middleware/auth";
import User from "../models/User";
import {
  listPendingCookPrompts,
  skipCookPrompt,
} from "../services/rating-service";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// GET /api/cook-prompts — past scheduled recipes awaiting cook confirmation
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const prompts = await listPendingCookPrompts(user._id.toString());
    res.status(200).json({ prompts });
  })
);

// POST /api/cook-prompts/:id/skip — permanently dismiss the rating prompt for
// one entry so it never resurfaces on app reopen.
router.post(
  "/:id/skip",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const idParam = req.params.id;
    const id = typeof idParam === "string" ? idParam : "";
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid entry id" });
      return;
    }

    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await skipCookPrompt(user._id.toString(), id);
    res.status(204).end();
  })
);

export default router;
