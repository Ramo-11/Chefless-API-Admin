import { Request, Response, NextFunction } from "express";
import User from "../models/User";
import { hasActivePremium } from "../lib/premium";

/**
 * Middleware that checks if the authenticated user has an active premium
 * subscription. Returns 403 if the user is not premium.
 *
 * Must be used after `requireAuth` so that `req.user` is populated.
 */
export async function requirePremium(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const firebaseUid = req.user?.uid;
  if (!firebaseUid) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const user = await User.findOne({ firebaseUid })
    .select("isPremium premiumExpiresAt")
    .lean();
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (!hasActivePremium(user)) {
    res.status(403).json({
      error: "This feature requires a premium subscription.",
    });
    return;
  }

  next();
}
