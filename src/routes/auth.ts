import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";

const router = Router();

// --- Schemas ---

const registerSchema = z.object({
  fullName: z.string().min(1, "Full name is required").max(100),
});

const fcmTokenSchema = z.object({
  token: z.string().min(1, "FCM token is required"),
});

// --- Helpers ---

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// --- Routes ---

// POST /api/auth/register
router.post(
  "/register",
  requireAuth,
  validate({ body: registerSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { fullName } = req.body as z.infer<typeof registerSchema>;
    const firebaseUid = req.user!.uid;

    // Email must come from the verified Firebase token — never trust the request body
    const email = req.user!.email;
    if (!email) {
      res.status(400).json({ error: "Firebase token has no verified email address" });
      return;
    }

    // Idempotent: return existing user if already registered with this firebaseUid
    const existingByUid = await User.findOne({ firebaseUid });
    if (existingByUid) {
      res.status(200).json({ user: existingByUid });
      return;
    }

    // Handle re-registration: user deleted account and signed up again
    // with same email but a new Firebase Auth uid.
    const existingByEmail = await User.findOne({
      email: email.toLowerCase(),
    });
    if (existingByEmail) {
      existingByEmail.firebaseUid = firebaseUid;
      existingByEmail.fullName = fullName;
      existingByEmail.lastActiveAt = new Date();
      await existingByEmail.save();
      res.status(200).json({ user: existingByEmail });
      return;
    }

    const user = await User.create({
      firebaseUid,
      email,
      fullName,
      lastActiveAt: new Date(),
    });

    res.status(201).json({ user });
  })
);

// GET /api/auth/me
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;

    let user = await User.findOneAndUpdate(
      { firebaseUid },
      { $set: { lastActiveAt: new Date() } },
      { new: true }
    ).lean();

    // If not found by firebaseUid, check by email — the user may have
    // re-created their Firebase Auth account (new uid, same email).
    if (!user && req.user!.email) {
      user = await User.findOneAndUpdate(
        { email: req.user!.email.toLowerCase() },
        { $set: { firebaseUid, lastActiveAt: new Date() } },
        { new: true }
      ).lean();
    }

    if (!user) {
      res.status(404).json({ error: "User not found. Please register first." });
      return;
    }

    res.status(200).json({ user });
  })
);

// POST /api/auth/fcm-token
router.post(
  "/fcm-token",
  requireAuth,
  validate({ body: fcmTokenSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.body as z.infer<typeof fcmTokenSchema>;
    const firebaseUid = req.user!.uid;

    const user = await User.findOneAndUpdate(
      { firebaseUid },
      { fcmToken: token, lastActiveAt: new Date() },
      { new: true }
    );

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.status(200).json({ success: true });
  })
);

// DELETE /api/auth/fcm-token — Clear FCM token (call on sign-out)
router.delete(
  "/fcm-token",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;

    await User.findOneAndUpdate(
      { firebaseUid },
      { $unset: { fcmToken: 1 } }
    );

    res.status(200).json({ success: true });
  })
);

export default router;
