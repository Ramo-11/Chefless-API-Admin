import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import { uploadImage } from "../lib/cloudinary";
import {
  getUserById,
  updateProfile,
  deleteAccount,
  getFollowers,
  getFollowing,
  getPendingRequests,
  followUser,
  unfollowUser,
  acceptFollowRequest,
  denyFollowRequest,
  isFollowing,
  computeSpatulaBadge,
} from "../services/user-service";

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

const objectIdParam = z.object({
  id: z.string().refine(isValidObjectId, { message: "Invalid ID format" }),
});

// --- Schemas ---

const updateProfileSchema = z.object({
  fullName: z.string().min(1).max(100).optional(),
  bio: z.string().max(150).nullable().optional(),
  phone: z.string().max(20).nullable().optional(),
  isPublic: z.boolean().optional(),
  dietaryPreferences: z.array(z.string().max(50)).max(20).optional(),
  cuisinePreferences: z.array(z.string().max(50)).max(20).optional(),
  profilePicture: z.string().url().nullable().optional(),
  onboardingComplete: z.boolean().optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1, "Search query is required").max(100),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const signatureBodySchema = z.object({
  image: z
    .string()
    .min(1, "Image data is required")
    .refine(
      (val) => val.startsWith("data:image/"),
      { message: "Must be a valid base64 data URI (data:image/...)" }
    ),
});

// --- Routes ---

// GET /api/users/search?q=
router.get(
  "/search",
  requireAuth,
  validate({ query: searchQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { q } = req.query as z.infer<typeof searchQuerySchema>;

    const users = await User.find(
      { $text: { $search: q } },
      { score: { $meta: "textScore" } }
    )
      .select("fullName profilePicture bio isPublic recipesCount followersCount")
      .sort({ score: { $meta: "textScore" } })
      .limit(20)
      .lean();

    const results = users.map((user) => ({
      ...user,
      spatulaBadge: computeSpatulaBadge(user.recipesCount),
    }));

    res.status(200).json({ users: results });
  })
);

// GET /api/users/me/followers
router.get(
  "/me/followers",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<
      typeof paginationSchema
    >;
    const result = await getFollowers(user._id.toString(), page, limit);

    res.status(200).json(result);
  })
);

// GET /api/users/me/following
router.get(
  "/me/following",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<
      typeof paginationSchema
    >;
    const result = await getFollowing(user._id.toString(), page, limit);

    res.status(200).json(result);
  })
);

// GET /api/users/me/requests
router.get(
  "/me/requests",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const requests = await getPendingRequests(user._id.toString());

    res.status(200).json({ requests });
  })
);

// PATCH /api/users/me
router.patch(
  "/me",
  requireAuth,
  validate({ body: updateProfileSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const updates = req.body as z.infer<typeof updateProfileSchema>;
    const user = await updateProfile(currentUser._id.toString(), updates);

    res.status(200).json({ user });
  })
);

// DELETE /api/users/me
router.delete(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await deleteAccount(currentUser._id.toString());

    res.status(200).json({ success: true });
  })
);

// POST /api/users/me/profile-picture
router.post(
  "/me/profile-picture",
  requireAuth,
  validate({ body: signatureBodySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { image } = req.body as z.infer<typeof signatureBodySchema>;

    const result = await uploadImage(image, `users/${currentUser._id}/profile-pictures`);

    const user = await User.findByIdAndUpdate(
      currentUser._id,
      { $set: { profilePicture: result.secureUrl } },
      { new: true }
    );

    res.status(200).json({ user });
  })
);

// POST /api/users/me/signature
router.post(
  "/me/signature",
  requireAuth,
  validate({ body: signatureBodySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { image } = req.body as z.infer<typeof signatureBodySchema>;

    const result = await uploadImage(image, `users/${currentUser._id}/signatures`);

    const user = await User.findByIdAndUpdate(
      currentUser._id,
      { $set: { signature: result.secureUrl } },
      { new: true }
    );

    res.status(200).json({ user });
  })
);

// POST /api/users/requests/:id/accept
router.post(
  "/requests/:id/accept",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const follow = await acceptFollowRequest(currentUser._id.toString(), id);

    res.status(200).json({ follow });
  })
);

// POST /api/users/requests/:id/deny
router.post(
  "/requests/:id/deny",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await denyFollowRequest(currentUser._id.toString(), id);

    res.status(200).json({ success: true });
  })
);

// GET /api/users/:id
router.get(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    const { id } = req.params as z.infer<typeof objectIdParam>;

    const requesterId = currentUser ? currentUser._id.toString() : undefined;
    const profile = await getUserById(id, requesterId);

    if (!profile) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Include follow status if viewing another user
    let followStatus: { following: boolean; status: "active" | "pending" | null } | undefined;
    if (currentUser && !currentUser._id.equals(id)) {
      followStatus = await isFollowing(currentUser._id.toString(), id);
    }

    res.status(200).json({ user: profile, followStatus });
  })
);

// POST /api/users/:id/follow
router.post(
  "/:id/follow",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const result = await followUser(currentUser._id.toString(), id);

    res.status(201).json(result);
  })
);

// DELETE /api/users/:id/follow
router.delete(
  "/:id/follow",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid }).select("_id").lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await unfollowUser(currentUser._id.toString(), id);

    res.status(200).json({ success: true });
  })
);

export default router;
