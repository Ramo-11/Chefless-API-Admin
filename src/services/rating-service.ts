import { Types } from "mongoose";
import RecipeRating, { IRecipeRating } from "../models/RecipeRating";
import Recipe from "../models/Recipe";
import Kitchen from "../models/Kitchen";
import ScheduleEntry from "../models/ScheduleEntry";
import User from "../models/User";

interface AppError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): AppError {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
}

/**
 * Ratings are "public" when either (a) the rater had no kitchen at rating time
 * (solo cook — treat as public) or (b) the rater's kitchen has visibility set
 * to "public". These are the ratings that feed `Recipe.avgRating` shown to
 * everyone discovering the recipe.
 */
async function isRatingPublic(
  kitchenId: Types.ObjectId | null | undefined
): Promise<boolean> {
  if (!kitchenId) return true;
  const kitchen = await Kitchen.findById(kitchenId)
    .select("ratingsVisibility")
    .lean();
  return (kitchen?.ratingsVisibility ?? "kitchen_only") === "public";
}

/**
 * Recomputes `avgRating` + `ratingCount` on the Recipe doc using only ratings
 * flagged as public. Called after every rating mutation so clients reading
 * the recipe always see fresh aggregates.
 *
 * We recompute from scratch rather than $inc because ratings can change
 * kitchens / visibility over time and a running delta would drift.
 */
async function recomputePublicAggregate(recipeId: Types.ObjectId): Promise<void> {
  // Find the kitchens that currently consent to public aggregation.
  const publicKitchens = await Kitchen.find({
    ratingsVisibility: "public",
  })
    .select("_id")
    .lean();
  const publicKitchenIds = publicKitchens.map((k) => k._id);

  const result = await RecipeRating.aggregate([
    {
      $match: {
        recipeId,
        $or: [
          { kitchenId: null },
          ...(publicKitchenIds.length > 0
            ? [{ kitchenId: { $in: publicKitchenIds } }]
            : []),
        ],
      },
    },
    {
      $group: {
        _id: "$recipeId",
        avg: { $avg: "$stars" },
        count: { $sum: 1 },
      },
    },
  ]);

  const agg = result[0] as { avg?: number; count?: number } | undefined;
  const avg = agg?.avg ? Number(agg.avg.toFixed(2)) : 0;
  const count = agg?.count ?? 0;

  await Recipe.updateOne(
    { _id: recipeId },
    { $set: { avgRating: avg, ratingCount: count } }
  );
}

export interface UpsertRatingInput {
  recipeId: string;
  userId: string;
  stars: number;
  note?: string;
  scheduleEntryId?: string;
}

export async function upsertRating(
  input: UpsertRatingInput
): Promise<IRecipeRating> {
  const recipeOid = new Types.ObjectId(input.recipeId);
  const userOid = new Types.ObjectId(input.userId);

  const recipe = await Recipe.findById(recipeOid).select("_id").lean();
  if (!recipe) throw createError("Recipe not found", 404);

  const user = await User.findById(userOid).select("kitchenId").lean();
  if (!user) throw createError("User not found", 404);

  const kitchenId = user.kitchenId ?? null;

  // Refuse to rate when the current kitchen has ratings disabled.
  if (kitchenId) {
    const kitchen = await Kitchen.findById(kitchenId)
      .select("ratingsVisibility")
      .lean();
    if (kitchen?.ratingsVisibility === "off") {
      throw createError("Ratings are disabled for your kitchen", 403);
    }
  }

  const scheduleOid = input.scheduleEntryId
    ? new Types.ObjectId(input.scheduleEntryId)
    : null;

  const rating = await RecipeRating.findOneAndUpdate(
    { recipeId: recipeOid, userId: userOid },
    {
      $set: {
        stars: input.stars,
        note: input.note,
        kitchenId,
        scheduleEntryId: scheduleOid,
        ratedAt: new Date(),
      },
      $setOnInsert: { cookedAt: new Date() },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  if (!rating) throw createError("Failed to save rating", 500);

  await recomputePublicAggregate(recipeOid);

  return rating;
}

export async function deleteRating(
  recipeId: string,
  userId: string
): Promise<void> {
  const recipeOid = new Types.ObjectId(recipeId);
  const userOid = new Types.ObjectId(userId);

  const result = await RecipeRating.findOneAndDelete({
    recipeId: recipeOid,
    userId: userOid,
  });

  if (!result) throw createError("You have not rated this recipe", 404);

  await recomputePublicAggregate(recipeOid);
}

export interface ViewerRatingContext {
  userId: string;
  recipeId: string;
}

export interface ViewerRatingAggregate {
  /** The viewer's personal star rating, or null if they haven't rated. */
  personal: number | null;
  /** Aggregate score shown to the viewer (respects kitchen-only visibility). */
  avg: number;
  /** How many ratings are feeding `avg`. */
  count: number;
  /** Whose ratings are feeding `avg` — useful for the UI label. */
  scope: "public" | "kitchen";
}

/**
 * Returns the aggregate the viewer is allowed to see:
 *   - If their kitchen sets visibility to `kitchen_only`, show the kitchen's
 *     average (even if global avg is zero).
 *   - Otherwise show the recipe's public aggregate.
 * Always includes the viewer's personal rating for the "You rated …" UI.
 */
export async function getRatingAggregateForViewer(
  ctx: ViewerRatingContext
): Promise<ViewerRatingAggregate> {
  const recipeOid = new Types.ObjectId(ctx.recipeId);
  const userOid = new Types.ObjectId(ctx.userId);

  const [recipe, user, personal] = await Promise.all([
    Recipe.findById(recipeOid).select("avgRating ratingCount").lean(),
    User.findById(userOid).select("kitchenId").lean(),
    RecipeRating.findOne({ recipeId: recipeOid, userId: userOid })
      .select("stars")
      .lean(),
  ]);

  if (!recipe) throw createError("Recipe not found", 404);

  const kitchenId = user?.kitchenId ?? null;
  let scope: "public" | "kitchen" = "public";
  let avg = recipe.avgRating ?? 0;
  let count = recipe.ratingCount ?? 0;

  if (kitchenId) {
    const kitchen = await Kitchen.findById(kitchenId)
      .select("ratingsVisibility")
      .lean();
    const visibility = kitchen?.ratingsVisibility ?? "kitchen_only";
    if (visibility === "kitchen_only") {
      const agg = await RecipeRating.aggregate([
        { $match: { recipeId: recipeOid, kitchenId } },
        {
          $group: {
            _id: "$recipeId",
            avg: { $avg: "$stars" },
            count: { $sum: 1 },
          },
        },
      ]);
      const row = agg[0] as { avg?: number; count?: number } | undefined;
      avg = row?.avg ? Number(row.avg.toFixed(2)) : 0;
      count = row?.count ?? 0;
      scope = "kitchen";
    }
  }

  return {
    personal: personal?.stars ?? null,
    avg,
    count,
    scope,
  };
}

/**
 * Finds the viewer's confirmed-but-uncooked past entries that should surface
 * as cook prompts. Limits to the most recent `limit` entries to keep the
 * payload small; the client cycles through them one at a time.
 *
 * Scope mirrors the schedule GET endpoint: kitchen members see every
 * uncooked meal from their kitchen (not just ones they personally added),
 * solo cooks see only their own. Without this breadth a meal the kitchen
 * lead scheduled would never prompt the member who actually cooked it.
 */
export async function listPendingCookPrompts(
  userId: string,
  limit = 10
): Promise<unknown[]> {
  const userOid = new Types.ObjectId(userId);
  const now = new Date();
  // 7 days is our "nag cutoff" — older uncooked entries quietly expire so the
  // user doesn't return from a vacation to a 30-item prompt queue.
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const user = await User.findById(userOid).select("kitchenId").lean();

  // Respect the kitchen's "off" toggle — don't surface prompts from a kitchen
  // that has disabled rating flows.
  if (user?.kitchenId) {
    const kitchen = await Kitchen.findById(user.kitchenId)
      .select("ratingsVisibility")
      .lean();
    if (kitchen?.ratingsVisibility === "off") return [];
  }

  const scopeFilter = user?.kitchenId
    ? { kitchenId: user.kitchenId }
    : { userId: userOid, kitchenId: { $exists: false } };

  const entries = await ScheduleEntry.find({
    ...scopeFilter,
    status: "confirmed",
    cookedAt: null,
    recipeId: { $ne: null },
    date: { $gte: cutoff, $lt: now },
  })
    .sort({ date: -1 })
    .limit(limit)
    .lean();

  return entries;
}

/**
 * Ensures the current user is allowed to toggle `cookedAt` on [entry].
 * Cooking is a shared kitchen action — any member of the entry's kitchen
 * can mark it cooked (or undo), not just whoever originally added it.
 * Personal entries remain owner-only.
 */
async function assertCanToggleCooked(
  entry: { userId: Types.ObjectId; kitchenId?: Types.ObjectId | null },
  userId: string
): Promise<void> {
  if (!entry.kitchenId) {
    if (!entry.userId.equals(userId)) {
      throw createError("You can only modify your own entries", 403);
    }
    return;
  }
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user?.kitchenId || !user.kitchenId.equals(entry.kitchenId)) {
    throw createError("You are not a member of this kitchen", 403);
  }
}

export async function markEntryCooked(
  userId: string,
  entryId: string,
  cookedAt?: Date
): Promise<void> {
  const entry = await ScheduleEntry.findById(entryId);
  if (!entry) throw createError("Schedule entry not found", 404);
  await assertCanToggleCooked(entry, userId);
  entry.cookedAt = cookedAt ?? new Date();
  await entry.save();
}

export async function clearEntryCooked(
  userId: string,
  entryId: string
): Promise<void> {
  const entry = await ScheduleEntry.findById(entryId);
  if (!entry) throw createError("Schedule entry not found", 404);
  await assertCanToggleCooked(entry, userId);
  entry.cookedAt = null;
  await entry.save();
}
