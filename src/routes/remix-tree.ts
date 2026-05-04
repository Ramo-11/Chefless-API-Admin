import { Router, Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { requirePremium } from "../middleware/premium";
import { validate } from "../middleware/validate";
import User from "../models/User";
import { getRemixTree } from "../services/remix-tree-service";

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

const objectIdParam = z.object({
  id: z.string().refine(isValidObjectId, { message: "Invalid ID format" }),
});

// GET /api/remix-tree/:id — return the ancestor + descendant graph for a recipe.
// Premium-only: the lineage view is a power-user surface, gated to drive
// upgrades. Clients should pre-empt with a paywall sheet rather than letting
// the request 403.
router.get(
  "/:id",
  requireAuth,
  requirePremium,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const { id } = req.params as z.infer<typeof objectIdParam>;
    const tree = await getRemixTree(id, user._id.toString());
    res.status(200).json(tree);
  })
);

export default router;
