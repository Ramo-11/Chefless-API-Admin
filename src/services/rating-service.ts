import { Types } from "mongoose";
import RecipeRating, { IRecipeRating } from "../models/RecipeRating";
import Recipe from "../models/Recipe";
import Kitchen from "../models/Kitchen";
import ScheduleEntry from "../models/ScheduleEntry";
import User, { IUser } from "../models/User";
import { canViewRecipe } from "./visibility-service";
import { resolveSlotTime } from "./kitchen-service";
import { normalizeOffset } from "../lib/timezone";

/**
 * UTC instant (ms) at which a scheduled meal's cook prompt becomes due.
 * `entryDateMs` is the entry's `date` — UTC midnight of the local calendar day
 * the user picked. Adding the slot's minute-of-day and subtracting the user's
 * offset (minutes east of UTC) yields the wall-clock slot time, in that user's
 * zone, as a UTC instant. Pure + exported so the gating math is unit-testable.
 *
 * Example: New York (`offset = -240`), dinner `18:00`, entry dated today ->
 * fires at 22:00 UTC (18:00 local). Tokyo (`offset = 540`), breakfast `08:00`
 * -> fires before UTC midnight of the entry's date, which is why the candidate
 * window must look ahead of `now`.
 */
export function cookPromptFireTimeMs(
  entryDateMs: number,
  hhmm: string,
  offsetMinutes: number
): number {
  const [h, m] = hhmm.split(":").map((n) => Number.parseInt(n, 10));
  const minuteOfDay = (h || 0) * 60 + (m || 0);
  return entryDateMs + minuteOfDay * 60_000 - offsetMinutes * 60_000;
}

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
export async function recomputePublicAggregate(recipeId: Types.ObjectId): Promise<void> {
  const result = await RecipeRating.aggregate([
    { $match: { recipeId } },
    {
      $lookup: {
        from: "kitchens",
        localField: "kitchenId",
        foreignField: "_id",
        as: "_kitchen",
        pipeline: [{ $project: { ratingsVisibility: 1 } }],
      },
    },
    {
      $match: {
        $or: [
          { kitchenId: null },
          { "_kitchen.ratingsVisibility": "public" },
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

  const recipe = await Recipe.findById(recipeOid)
    .select("authorId isPrivate")
    .lean();
  if (!recipe) throw createError("Recipe not found", 404);

  // Only viewers who can actually open the recipe may rate it — mirror the
  // visibility gate used by likeRecipe / saveRecipe.
  const author = await User.findById(recipe.authorId)
    .select("isPublic kitchenId")
    .lean();
  if (!author) throw createError("Recipe author not found", 404);

  const canView = await canViewRecipe(
    userOid,
    recipe,
    author as unknown as IUser
  );
  if (!canView) {
    throw createError("You do not have permission to rate this recipe", 403);
  }

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
  requestOffsetMinutes?: number,
  limit = 10
): Promise<unknown[]> {
  const userOid = new Types.ObjectId(userId);
  const nowMs = Date.now();

  const user = await User.findById(userOid)
    .select("kitchenId timezoneOffsetMinutes")
    .lean();

  // Timezone offset (minutes east of UTC). The live device offset wins (it is
  // DST-correct for "now"); fall back to the last-known stored offset, then UTC.
  const normalizedOverride = normalizeOffset(requestOffsetMinutes);
  const offset =
    normalizedOverride ?? user?.timezoneOffsetMinutes ?? 0;

  // Opportunistically keep the user's last-known zone fresh (fire-and-forget,
  // mirrors reserveAiQuota). Only when a fresh override differs from stored.
  if (
    normalizedOverride !== undefined &&
    normalizedOverride !== user?.timezoneOffsetMinutes
  ) {
    User.updateOne(
      { _id: userOid },
      { $set: { timezoneOffsetMinutes: normalizedOverride } }
    ).catch(() => {
      /* non-critical — the gate already used the live offset */
    });
  }

  // Respect the kitchen's "off" toggle and load its per-slot times for gating.
  let kitchen: { mealSlotTimes?: Map<string, string> } | null = null;
  if (user?.kitchenId) {
    const k = await Kitchen.findById(user.kitchenId)
      .select("ratingsVisibility mealSlotTimes")
      .lean();
    if (k?.ratingsVisibility === "off") return [];
    kitchen = k as { mealSlotTimes?: Map<string, string> } | null;
  }

  const scopeFilter = user?.kitchenId
    ? { kitchenId: user.kitchenId }
    : { userId: userOid, kitchenId: { $exists: false } };

  // Coarse window — a deliberate SUPERSET; the precise per-entry fire-time
  // filter below is the source of truth. 7-day nag cutoff + 1 day slack on the
  // low end; +36h on the high end so "today" survives for users far east of
  // UTC whose early-slot meals fire before the entry's UTC-midnight date.
  const cutoffLower = new Date(nowMs - 8 * 24 * 60 * 60 * 1000);
  const cutoffUpper = new Date(nowMs + 36 * 60 * 60 * 1000);

  // Fetch a generous cap BEFORE filtering — the fire-time filter discards
  // not-yet-due entries, and we must not let a page of future dinners starve
  // earlier breakfasts. Slice to `limit` after the precise pass.
  const GENEROUS_CAP = 60;
  const candidates = await ScheduleEntry.find({
    ...scopeFilter,
    status: "confirmed",
    cookedAt: null,
    // Skip prompts the viewer has already dismissed — this persists across
    // app restarts so we never nag twice for the same meal.
    $or: [
      { ratingPromptSkippedAt: null },
      { ratingPromptSkippedAt: { $exists: false } },
    ],
    recipeId: { $ne: null },
    leftoverOfEntryId: { $exists: false },
    date: { $gte: cutoffLower, $lt: cutoffUpper },
  })
    .sort({ date: -1 })
    .limit(GENEROUS_CAP)
    .lean();

  const result: unknown[] = [];
  for (const entry of candidates) {
    const hhmm = resolveSlotTime(kitchen, entry.mealSlot);
    const fireMs = cookPromptFireTimeMs(entry.date.getTime(), hhmm, offset);
    if (fireMs <= nowMs) {
      result.push(entry);
      if (result.length === limit) break;
    }
  }

  return result;
}

/**
 * Marks the cook prompt for [entryId] as dismissed by the user. Same kitchen /
 * ownership check as cooking toggles — if you can cook it, you can skip it.
 * Idempotent: skipping an already-skipped entry is a no-op.
 */
export async function skipCookPrompt(
  userId: string,
  entryId: string
): Promise<void> {
  const entry = await ScheduleEntry.findById(entryId);
  if (!entry) throw createError("Schedule entry not found", 404);
  await assertCanToggleCooked(entry, userId);
  entry.ratingPromptSkippedAt = new Date();
  await entry.save();
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

export interface KitchenCookHistory {
  /** Aggregate stars across every prior rating of this recipe within the kitchen. */
  avg: number;
  /** How many member ratings are feeding `avg`. */
  count: number;
  /** Date the recipe was last marked cooked in this kitchen, if ever. */
  lastCookedAt: Date | null;
}

/**
 * Prior cook + rating history for `recipeId` within the viewer's current
 * kitchen. Powers the "last time your family rated this 4.5" hint that surfaces
 * when someone schedules a recipe the kitchen has cooked before.
 *
 * Returns `{ avg: 0, count: 0, lastCookedAt: null }` for solo cooks (no
 * kitchen) or when the recipe hasn't been cooked here yet — so the client
 * can call this unconditionally and decide whether to show the hint.
 */
export async function getKitchenCookHistoryForRecipe(
  userId: string,
  recipeId: string
): Promise<KitchenCookHistory> {
  const recipeOid = new Types.ObjectId(recipeId);
  const user = await User.findById(userId).select("kitchenId").lean();
  const kitchenId = user?.kitchenId ?? null;

  if (!kitchenId) {
    return { avg: 0, count: 0, lastCookedAt: null };
  }

  const [aggRow, lastEntry] = await Promise.all([
    RecipeRating.aggregate([
      { $match: { recipeId: recipeOid, kitchenId } },
      {
        $group: {
          _id: "$recipeId",
          avg: { $avg: "$stars" },
          count: { $sum: 1 },
        },
      },
    ]),
    ScheduleEntry.findOne({
      kitchenId,
      recipeId: recipeOid,
      cookedAt: { $ne: null },
    })
      .sort({ cookedAt: -1 })
      .select("cookedAt")
      .lean(),
  ]);

  const row = aggRow[0] as { avg?: number; count?: number } | undefined;
  const avg = row?.avg ? Number(row.avg.toFixed(2)) : 0;
  const count = row?.count ?? 0;
  const lastCookedAt = lastEntry?.cookedAt ?? null;

  return { avg, count, lastCookedAt };
}
