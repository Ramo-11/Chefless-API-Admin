import { Types } from "mongoose";
import CookedPost, { ICookedPost } from "../models/CookedPost";
import Recipe from "../models/Recipe";
import User, { IUser } from "../models/User";
import { uploadImage } from "../lib/cloudinary";
import {
  canonicalCuisine,
  regionForCuisine,
  earnedBadgeIds,
  CUISINE_REGIONS,
} from "../lib/cuisines";
import {
  notifyRecipeCooked,
  notifyPassportStamp,
  notifyPassportBadge,
  notifyCookedPostRemoved,
} from "./notification-service";
import { canViewRecipe } from "./visibility-service";

interface AppError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): AppError {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
}

export interface CookedPostAuthor {
  id: string;
  fullName: string;
  profilePicture: string | null;
}

export interface CookedPostView {
  id: string;
  userId: string;
  recipeId: string | null;
  recipeTitle: string;
  recipeAuthorId: string | null;
  photoUrl: string;
  caption?: string;
  cuisineTags: string[];
  createdAt: Date;
  author: CookedPostAuthor | null;
}

interface PaginatedCookedPosts {
  data: CookedPostView[];
  nextCursor: string | null;
}

export interface CreateCookedPostResult {
  post: CookedPostView;
  /** Cuisines the user just unlocked for the first time. */
  newStamps: string[];
  /** Regions the user just completed. */
  newRegions: string[];
  /** Global tier/regional badges unlocked by this post. */
  newBadges: string[];
}

const MAX_CAPTION = 500;

function toView(
  post: ICookedPost,
  author: CookedPostAuthor | null
): CookedPostView {
  return {
    id: post._id.toString(),
    userId: post.userId.toString(),
    recipeId: post.recipeId?.toString() ?? null,
    recipeTitle: post.recipeTitle,
    recipeAuthorId: post.recipeAuthorId?.toString() ?? null,
    photoUrl: post.photoUrl,
    caption: post.caption,
    cuisineTags: post.cuisineTags,
    createdAt: post.createdAt,
    author,
  };
}

/**
 * Upload a raw data-URI image for an "I Cooked It" post and return the
 * Cloudinary secure URL. Upload is kept separate from the post create so the
 * client can show a progress UI and retry independently.
 */
export async function uploadCookedPostPhoto(
  fileData: string,
  userId: string
): Promise<{ publicId: string; secureUrl: string }> {
  const result = await uploadImage(fileData, `cooked-posts/${userId}`);
  return { publicId: result.publicId, secureUrl: result.secureUrl };
}

/**
 * Create an "I Cooked It" post for a recipe. Captures the recipe's cuisine
 * tags at post time, awards passport stamps (and regional/global badges) for
 * newly-unlocked cuisines, and fires notifications to the recipe author and
 * the posting user.
 */
export async function createCookedPost(params: {
  userId: string;
  recipeId: string;
  photoUrl: string;
  caption?: string;
}): Promise<CreateCookedPostResult> {
  const { userId, recipeId, photoUrl, caption } = params;
  const userOid = new Types.ObjectId(userId);

  const [recipe, user] = await Promise.all([
    Recipe.findById(recipeId),
    User.findById(userId).select("fullName profilePicture").lean(),
  ]);
  if (!recipe) throw createError("Recipe not found", 404);
  if (!user) throw createError("User not found", 404);

  // Visibility check — a user can only post about recipes they can actually see.
  const recipeAuthor = await User.findById(recipe.authorId)
    .select("fullName isPublic kitchenId isBanned")
    .lean();
  if (!recipeAuthor) throw createError("Recipe author not found", 404);

  const canView = await canViewRecipe(
    userOid,
    recipe,
    recipeAuthor as unknown as IUser
  );
  if (!canView) {
    throw createError(
      "You do not have permission to post about this recipe",
      403
    );
  }

  if (caption && caption.length > MAX_CAPTION) {
    throw createError(
      `Caption must be ${MAX_CAPTION} characters or fewer`,
      400
    );
  }

  // Snapshot cuisine tags (canonicalized) from the recipe. Unknown tags are
  // preserved as-is so user-created regional tags aren't dropped — but only
  // canonicalized ones contribute to passport stamps.
  const cuisineTags = Array.from(
    new Set(
      (recipe.cuisineTags ?? []).map((t) => canonicalCuisine(t) ?? t.trim())
    )
  ).filter((t) => t.length > 0);

  // Determine which cuisines / region are NEW for this user — done *before*
  // inserting the post so we can accurately detect first unlocks.
  const priorCuisines = await CookedPost.distinct("cuisineTags", {
    userId: userOid,
    removedAt: null,
  });
  const priorSet = new Set<string>(
    priorCuisines
      .map((c) => (typeof c === "string" ? canonicalCuisine(c) ?? c : null))
      .filter((c): c is string => c !== null)
  );

  const priorEarnedBadges = earnedBadgeIds(priorSet);

  const post = await CookedPost.create({
    userId: userOid,
    recipeId: recipe._id,
    recipeTitle: recipe.title,
    recipeAuthorId: recipe.authorId,
    photoUrl,
    caption,
    cuisineTags,
  });

  // ── Derive unlocks ───────────────────────────────────────────────────
  const newStamps: string[] = [];
  for (const tag of cuisineTags) {
    const canonical = canonicalCuisine(tag);
    if (!canonical) continue;
    if (!priorSet.has(canonical)) {
      newStamps.push(canonical);
      priorSet.add(canonical);
    }
  }

  const newRegions: string[] = [];
  for (const region of CUISINE_REGIONS) {
    const justCompleted = region.cuisines.every((c) => priorSet.has(c));
    if (!justCompleted) continue;
    // Only treat as "new" if at least one of the cuisines that just unlocked
    // belongs to this region — otherwise the region was already complete.
    const anyNewInRegion = newStamps.some((s) =>
      region.cuisines.includes(s)
    );
    if (anyNewInRegion) newRegions.push(region.id);
  }

  const afterEarnedBadges = earnedBadgeIds(priorSet);
  const newBadges: string[] = [];
  for (const badgeId of afterEarnedBadges) {
    if (!priorEarnedBadges.has(badgeId)) newBadges.push(badgeId);
  }

  // ── Notifications (fire-and-forget) ──────────────────────────────────
  // Recipe author gets notified someone cooked their recipe.
  notifyRecipeCooked({
    actorId: userId,
    recipeId,
    recipeTitle: recipe.title,
    recipeAuthorId: recipe.authorId.toString(),
    photoUrl,
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`notifyRecipeCooked failed: ${msg}`);
  });

  // User gets a per-stamp notification for each newly-unlocked cuisine.
  for (const stamp of newStamps) {
    const region = regionForCuisine(stamp);
    notifyPassportStamp({
      userId,
      cuisine: stamp,
      regionName: region?.name ?? null,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`notifyPassportStamp failed: ${msg}`);
    });
  }

  for (const badgeId of newBadges) {
    notifyPassportBadge({ userId, badgeId }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`notifyPassportBadge failed: ${msg}`);
    });
  }

  return {
    post: toView(post, {
      id: user._id.toString(),
      fullName: user.fullName,
      profilePicture: user.profilePicture ?? null,
    }),
    newStamps,
    newRegions,
    newBadges,
  };
}

/**
 * List the public "I Cooked It" gallery for a recipe. Any authenticated user
 * can view these posts once they can view the recipe itself.
 */
export async function listCookedPostsForRecipe(
  recipeId: string,
  viewerId: string,
  cursor?: string,
  limit = 20
): Promise<PaginatedCookedPosts> {
  const recipe = await Recipe.findById(recipeId);
  if (!recipe) throw createError("Recipe not found", 404);

  const author = await User.findById(recipe.authorId)
    .select("fullName isPublic kitchenId isBanned")
    .lean();
  if (!author) throw createError("Recipe author not found", 404);

  const canView = await canViewRecipe(
    new Types.ObjectId(viewerId),
    recipe,
    author as unknown as IUser
  );
  if (!canView) {
    throw createError(
      "You do not have permission to view this recipe's gallery",
      403
    );
  }

  const query: Record<string, unknown> = {
    recipeId: new Types.ObjectId(recipeId),
    removedAt: null,
  };
  if (cursor) {
    query._id = { $lt: new Types.ObjectId(cursor) };
  }

  const rows = await CookedPost.find(query)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean<ICookedPost[]>();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]._id.toString() : null;

  const authorIds = [
    ...new Set(page.map((p) => p.userId.toString())),
  ].map((id) => new Types.ObjectId(id));
  const authors = await User.find({ _id: { $in: authorIds } })
    .select("fullName profilePicture")
    .lean();
  const authorMap = new Map(
    authors.map((a) => [
      a._id.toString(),
      {
        id: a._id.toString(),
        fullName: a.fullName,
        profilePicture: a.profilePicture ?? null,
      } as CookedPostAuthor,
    ])
  );

  return {
    data: page.map((p) => toView(p, authorMap.get(p.userId.toString()) ?? null)),
    nextCursor,
  };
}

/**
 * List a single user's "I Cooked It" history (newest first).
 */
export async function listCookedPostsForUser(
  userId: string,
  cursor?: string,
  limit = 20
): Promise<PaginatedCookedPosts> {
  const query: Record<string, unknown> = {
    userId: new Types.ObjectId(userId),
    removedAt: null,
  };
  if (cursor) {
    query._id = { $lt: new Types.ObjectId(cursor) };
  }

  const rows = await CookedPost.find(query)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean<ICookedPost[]>();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]._id.toString() : null;

  const user = await User.findById(userId)
    .select("fullName profilePicture")
    .lean();
  const author: CookedPostAuthor | null = user
    ? {
        id: user._id.toString(),
        fullName: user.fullName,
        profilePicture: user.profilePicture ?? null,
      }
    : null;

  return {
    data: page.map((p) => toView(p, author)),
    nextCursor,
  };
}

/**
 * Delete an "I Cooked It" post. Only the author of the post may delete it.
 * Note: cuisine stamps earned through this post may collapse back if this
 * was the only post covering a given cuisine — stamps are always computed
 * freshly on each passport read, so no extra bookkeeping is needed here.
 */
export async function deleteCookedPost(
  postId: string,
  userId: string
): Promise<void> {
  const post = await CookedPost.findById(postId);
  if (!post) throw createError("Post not found", 404);
  if (!post.userId.equals(userId)) {
    throw createError("You can only delete your own posts", 403);
  }
  await CookedPost.findByIdAndDelete(postId);
}

/** Total count of cooked posts across a recipe — for quick display. */
export async function countCookedPostsForRecipe(
  recipeId: string
): Promise<number> {
  return CookedPost.countDocuments({
    recipeId: new Types.ObjectId(recipeId),
    removedAt: null,
  });
}

/**
 * Recipe-owner moderation: flag an "I Cooked It" post as removed, capturing
 * the owner's mandatory reason. The uploader gets a push notification; the
 * post stays in Mongo so admins can audit the action. Passport stamps earned
 * through a removed post collapse because every read path filters them out.
 */
export async function removeCookedPostByOwner(params: {
  postId: string;
  ownerId: string;
  reason: string;
}): Promise<{ ok: true }> {
  const { postId, ownerId, reason } = params;
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw createError("A reason is required to remove this post.", 400);
  }
  if (trimmed.length > 500) {
    throw createError("Reason must be 500 characters or fewer.", 400);
  }

  const post = await CookedPost.findById(postId);
  if (!post) throw createError("Post not found", 404);
  if (post.removedAt) {
    throw createError("This post has already been removed.", 409);
  }
  if (!post.recipeAuthorId || !post.recipeAuthorId.equals(ownerId)) {
    throw createError(
      "Only the recipe owner can remove a cooked-it post.",
      403
    );
  }
  if (post.userId.equals(ownerId)) {
    throw createError(
      "Use delete instead of remove on your own post.",
      400
    );
  }

  post.removedAt = new Date();
  post.removedBy = new Types.ObjectId(ownerId);
  post.removalReason = trimmed;
  await post.save();

  const owner = await User.findById(ownerId).select("fullName").lean();
  notifyCookedPostRemoved({
    uploaderId: post.userId.toString(),
    recipeId: post.recipeId?.toString() ?? null,
    recipeTitle: post.recipeTitle,
    ownerName: owner?.fullName ?? "The recipe owner",
    reason: trimmed,
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`notifyCookedPostRemoved failed: ${msg}`);
  });

  return { ok: true };
}
