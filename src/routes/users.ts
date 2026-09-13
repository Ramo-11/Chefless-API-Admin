import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose, { Types } from "mongoose";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import Recipe from "../models/Recipe";
import SavedRecipe from "../models/SavedRecipe";
import ScheduleEntry from "../models/ScheduleEntry";
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
import { syncUserPremiumFromRevenueCat } from "../services/revenuecat-service";
import { getBlockedUserIds } from "../services/block-service";
import { getSuggestedChefs } from "../services/suggested-chefs-service";
import { imageDataUri } from "../lib/image-validation";

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

// strict() rejects unknown fields with a validation error — protects us from
// clients attempting to set fields the server doesn't expose (e.g. isPremium).
const updateProfileSchema = z
  .object({
    fullName: z.string().min(1).max(100).optional(),
    bio: z.string().max(150).nullable().optional(),
    phone: z.string().max(20).nullable().optional(),
    isPublic: z.boolean().optional(),
    dietaryPreferences: z.array(z.string().max(50)).max(20).optional(),
    cuisinePreferences: z.array(z.string().max(50)).max(20).optional(),
    profilePicture: z.string().url().nullable().optional(),
    onboardingComplete: z.boolean().optional(),
    language: z.enum(["en", "ar", "tr", "es"]).optional(),
  })
  .strict();

const searchQuerySchema = z.object({
  q: z.string().min(1, "Search query is required").max(100),
});

const suggestedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const signatureBodySchema = z.object({
  image: imageDataUri(),
});

// --- Routes ---

// GET /api/users/search?q=
router.get(
  "/search",
  requireAuth,
  validate({ query: searchQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { q } = req.query as z.infer<typeof searchQuerySchema>;

    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: "User not found. Please register first." });
      return;
    }

    // Exclude users involved in a block relationship with the caller in either
    // direction, matching the dedicated /api/search route's behavior.
    const blockedIds = await getBlockedUserIds(userId);

    const users = await User.find(
      {
        $text: { $search: q },
        isBanned: { $ne: true },
        _id: { $nin: blockedIds },
      },
      { score: { $meta: "textScore" } }
    )
      .select(
        "fullName profilePicture bio isPublic recipesCount originalRecipesCount followersCount isSeed"
      )
      .sort({ score: { $meta: "textScore" } })
      .limit(20)
      .lean();

    const results = users.map((user) => ({
      ...user,
      spatulaBadge: computeSpatulaBadge(
        user.originalRecipesCount !== undefined && user.originalRecipesCount !== null
          ? user.originalRecipesCount
          : user.recipesCount
      ),
    }));

    res.status(200).json({ users: results });
  })
);

router.get(
  "/suggested",
  requireAuth,
  validate({ query: suggestedQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: "User not found. Please register first." });
      return;
    }

    const { limit } = req.query as unknown as z.infer<
      typeof suggestedQuerySchema
    >;
    const chefs = await getSuggestedChefs(new Types.ObjectId(userId), limit);

    res.status(200).json({ chefs });
  })
);

// POST /api/users/me/sync-subscription
// Deterministically reconciles the caller's premium state with RevenueCat's
// servers. The app calls this right after a purchase / restore so premium
// unlocks immediately instead of waiting on the webhook. Safe to call
// repeatedly; idempotent. Returns the up-to-date user document.
router.post(
  "/me/sync-subscription",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await syncUserPremiumFromRevenueCat(firebaseUid);

    if (!user) {
      res.status(404).json({ error: "User not found. Please register first." });
      return;
    }

    res.status(200).json({ user });
  })
);

// GET /api/users/me/followers
router.get(
  "/me/followers",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: "User not found. Please register first." });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<
      typeof paginationSchema
    >;
    const result = await getFollowers(userId, page, limit);

    res.status(200).json(result);
  })
);

// GET /api/users/me/following
router.get(
  "/me/following",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: "User not found. Please register first." });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<
      typeof paginationSchema
    >;
    const result = await getFollowing(userId, page, limit);

    res.status(200).json(result);
  })
);

// GET /api/users/me/requests
router.get(
  "/me/requests",
  requireAuth,
  validate({ query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: "User not found. Please register first." });
      return;
    }

    const { page, limit } = req.query as unknown as z.infer<typeof paginationSchema>;
    const result = await getPendingRequests(userId, page, limit);

    res.status(200).json(result);
  })
);

router.get(
  "/me/first-steps",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: "User not found. Please register first." });
      return;
    }

    const userObjectId = new Types.ObjectId(userId);

    const [savedRecipe, importedRecipe, plannedMeal, user] = await Promise.all([
      SavedRecipe.exists({ userId: userObjectId }),
      Recipe.exists({ authorId: userObjectId, source: { $exists: true } }),
      ScheduleEntry.exists({ userId: userObjectId }),
      User.findById(userId).select("kitchenId createdAt").lean(),
    ]);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.status(200).json({
      savedRecipe: Boolean(savedRecipe),
      importedRecipe: Boolean(importedRecipe),
      plannedMeal: Boolean(plannedMeal),
      kitchen: Boolean(user.kitchenId),
      createdAt: user.createdAt,
    });
  })
);

// PATCH /api/users/me
router.patch(
  "/me",
  requireAuth,
  validate({ body: updateProfileSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const updates = req.body as z.infer<typeof updateProfileSchema>;
    const user = await updateProfile(userId, updates);

    res.status(200).json({ user });
  })
);

// DELETE /api/users/me
router.delete(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await deleteAccount(userId);

    res.status(200).json({ success: true });
  })
);

// POST /api/users/me/profile-picture
router.post(
  "/me/profile-picture",
  requireAuth,
  validate({ body: signatureBodySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { image } = req.body as z.infer<typeof signatureBodySchema>;

    const result = await uploadImage(image, `users/${userId}/profile-pictures`);

    const user = await User.findByIdAndUpdate(
      userId,
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
    const userId = req.user?.userId;

    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { image } = req.body as z.infer<typeof signatureBodySchema>;

    const result = await uploadImage(image, `users/${userId}/signatures`);

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { signature: result.secureUrl } },
      { new: true }
    );

    res.status(200).json({ user });
  })
);

// DELETE /api/users/me/signature — remove stored recipe watermark image
router.delete(
  "/me/signature",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $unset: { signature: 1 } },
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
    const userId = req.user?.userId;

    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const follow = await acceptFollowRequest(userId, id);

    res.status(200).json({ follow });
  })
);

// POST /api/users/requests/:id/deny
router.post(
  "/requests/:id/deny",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await denyFollowRequest(userId, id);

    res.status(200).json({ success: true });
  })
);

// GET /api/users/:id
router.get(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    const { id } = req.params as z.infer<typeof objectIdParam>;

    const profile = await getUserById(id, userId);

    if (!profile) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Include follow status if viewing another user
    let followStatus: { following: boolean; status: "active" | "pending" | null } | undefined;
    if (userId && !new Types.ObjectId(userId).equals(id)) {
      followStatus = await isFollowing(userId, id);
    }

    res.status(200).json({ user: profile, followStatus });
  })
);

// GET /api/users/:id/recipes — List a user's public (non-private) recipes
router.get(
  "/:id/recipes",
  requireAuth,
  validate({ params: objectIdParam, query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as z.infer<typeof objectIdParam>;
    const { page, limit } = req.query as unknown as z.infer<
      typeof paginationSchema
    >;

    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ error: "User not found. Please register first." });
      return;
    }

    const targetUser = await User.findById(id)
      .select("_id fullName profilePicture isPublic kitchenId")
      .lean();
    if (!targetUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Enforce visibility rules matching canViewRecipe
    const isSelf = new Types.ObjectId(userId).equals(id);
    if (!isSelf) {
      if (!targetUser.isPublic) {
        // Check if requester follows the target
        const follow = await (await import("../models/Follow")).default.findOne({
          followerId: new Types.ObjectId(userId),
          followingId: targetUser._id,
          status: "active",
        }).lean();

        // Check if they share a kitchen
        const viewer = await User.findById(userId).select("kitchenId").lean();
        const sameKitchen =
          targetUser.kitchenId &&
          viewer?.kitchenId &&
          targetUser.kitchenId.equals(viewer.kitchenId);

        if (!follow && !sameKitchen) {
          res.status(403).json({ error: "This account is private." });
          return;
        }
      }
    }

    const skip = (page - 1) * limit;
    // Build the Mongo query explicitly — relying on `undefined` values to be
    // stripped is brittle and broke at least once when Mongoose kept them.
    const query: Record<string, unknown> = {
      authorId: targetUser._id,
      isHidden: { $ne: true },
    };
    if (!isSelf) query.isPrivate = false;

    // Hide recipes by users involved in a block relationship with the viewer.
    // Import lazily to keep this route file from pulling in unused services.
    const { getBlockedUserIds } = await import(
      "../services/block-service"
    );
    const blockedIds = await getBlockedUserIds(userId);
    if (blockedIds.some((id) => id.equals(targetUser._id))) {
      // Any block either direction hides the whole profile listing
      res.status(200).json({ data: [], page, limit, total: 0, totalPages: 0 });
      return;
    }

    const [recipes, total] = await Promise.all([
      Recipe.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Recipe.countDocuments(query),
    ]);

    // Attach author info to each recipe
    const data = recipes.map((r) => ({
      ...r,
      authorName: targetUser.fullName,
      authorPhoto: targetUser.profilePicture,
    }));

    res.status(200).json({
      data,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  })
);

// GET /api/users/:id/cookbooks — List a user's public cookbooks
router.get(
  "/:id/cookbooks",
  requireAuth,
  validate({ params: objectIdParam, query: paginationSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as z.infer<typeof objectIdParam>;
    const { page, limit } = req.query as unknown as z.infer<
      typeof paginationSchema
    >;

    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: "User not found. Please register first." });
      return;
    }

    const { listUserCookbooks } = await import(
      "../services/cookbook-service"
    );
    const result = await listUserCookbooks(
      id,
      userId,
      page,
      limit
    );
    res.status(200).json(result);
  })
);

// POST /api/users/:id/follow
router.post(
  "/:id/follow",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    const result = await followUser(userId, id);

    res.status(201).json(result);
  })
);

// DELETE /api/users/:id/follow
router.delete(
  "/:id/follow",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { id } = req.params as z.infer<typeof objectIdParam>;
    await unfollowUser(userId, id);

    res.status(200).json({ success: true });
  })
);

export default router;
