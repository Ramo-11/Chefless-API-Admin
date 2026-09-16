import { createHash } from "crypto";
import { Types } from "mongoose";
import User from "../models/User";
import Recipe from "../models/Recipe";
import SavedRecipe from "../models/SavedRecipe";
import ScheduleEntry from "../models/ScheduleEntry";
import CookedPost from "../models/CookedPost";
import RecipeRating from "../models/RecipeRating";
import PantryItem from "../models/PantryItem";
import { hasActivePremium } from "../lib/premium";
import { canonicalDiet, CANONICAL_MEAL_LABELS } from "../lib/diets";
import { getPantryMatches, PantryMatch } from "./pantry-service";
import { forYouFeed } from "./feed-service";
import { getBlockedUserIds } from "./block-service";
import { canScheduleRecipe } from "./schedule-service";

export const MEAL_IDEAS_MAX_LIMIT = 3;
export const PANTRY_IDEAS_MIN_ITEMS = 3;

const PANTRY_MAX_MISSING = 2;
const PANTRY_CANDIDATE_LIMIT = 30;
const PANTRY_RECENT_COOK_DAYS = 7;
const RECENT_COOK_DAYS = 14;
const PLANNED_WINDOW_DAYS = 6;
const RECIPE_BOOK_POOL_LIMIT = 200;
const FOR_YOU_POOL_LIMIT = 50;
const MAX_VALIDATION_ATTEMPTS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

const SUMMARY_FIELDS =
  "_id authorId title photos labels dietaryTags cuisineTags tags difficulty prepTime cookTime totalTime servings baseServings isPrivate isHidden likesCount forksCount avgRating ratingCount createdAt updatedAt";

const CANONICAL_MEAL_LABEL_SET = new Set<string>(CANONICAL_MEAL_LABELS);

interface ServiceError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): ServiceError {
  const error = new Error(message) as ServiceError;
  error.statusCode = statusCode;
  return error;
}

export type MealIdeaReason =
  | { kind: "pantry"; haveCount: number; totalCount: number; missingIngredients: string[] }
  | { kind: "saved" }
  | { kind: "popular" };

export interface MealIdeaRecipe {
  _id: string;
  authorId: string;
  title: string;
  photos: string[];
  labels: string[];
  dietaryTags: string[];
  cuisineTags: string[];
  tags: string[];
  difficulty: string | null;
  prepTime: number | null;
  cookTime: number | null;
  totalTime: number | null;
  servings: number | null;
  baseServings: number;
  isPrivate: boolean;
  likesCount: number;
  forksCount: number;
  avgRating: number;
  ratingCount: number;
  authorName: string;
  authorPhoto: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MealIdea {
  recipe: MealIdeaRecipe;
  reason: MealIdeaReason;
}

export interface MealIdeasOptions {
  date: Date;
  slot?: string;
  limit: number;
  now?: Date;
}

interface SummaryRecipeDoc {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  title: string;
  photos: string[];
  labels: string[];
  dietaryTags: string[];
  cuisineTags: string[];
  tags: string[];
  difficulty?: "easy" | "medium" | "hard";
  prepTime?: number;
  cookTime?: number;
  totalTime?: number;
  servings?: number;
  baseServings: number;
  isPrivate: boolean;
  isHidden: boolean;
  likesCount: number;
  forksCount: number;
  avgRating: number;
  ratingCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface AuthorLean {
  _id: Types.ObjectId;
  fullName: string;
  profilePicture?: string;
}

interface Candidate {
  doc: SummaryRecipeDoc;
  reason: MealIdeaReason;
  missingCount: number;
  fit: 0 | 1;
  key: string;
}

interface CandidateContext {
  mealLabel: string | null;
  diets: string[];
  userOid: Types.ObjectId;
  blockedIdSet: Set<string>;
  userId: string;
  dateKey: string;
}

type CookedWithinFn = (id: string, days: number) => boolean;

export function ideaRankKey(
  userId: string,
  dateKey: string,
  recipeId: string
): string {
  return createHash("sha256")
    .update(`${userId}:${dateKey}:${recipeId}`)
    .digest("hex");
}

export function slotMealLabel(slot?: string | null): string | null {
  if (!slot) return null;
  const normalized = slot.trim().toLowerCase();
  return CANONICAL_MEAL_LABEL_SET.has(normalized) ? normalized : null;
}

export function slotFit(
  recipe: { labels?: string[] | null; tags?: string[] | null },
  mealLabel: string | null
): 0 | 1 | null {
  if (mealLabel === null) return 0;

  const recipeMealLabels = new Set<string>();
  for (const raw of [...(recipe.labels ?? []), ...(recipe.tags ?? [])]) {
    const normalized = raw.trim().toLowerCase();
    if (CANONICAL_MEAL_LABEL_SET.has(normalized)) {
      recipeMealLabels.add(normalized);
    }
  }

  if (recipeMealLabels.has(mealLabel)) return 0;
  if (recipeMealLabels.size === 0) return 1;
  return null;
}

export function canonicalDietaryPreferences(
  raw: string[] | null | undefined
): string[] {
  if (!raw || raw.length === 0) return [];
  const canonical = new Set<string>();
  for (const preference of raw) {
    const match = canonicalDiet(preference);
    if (match) canonical.add(match);
  }
  return Array.from(canonical);
}

export function matchesDietaryPreferences(
  recipeDietaryTags: string[] | null | undefined,
  preferences: string[]
): boolean {
  if (preferences.length === 0) return true;
  const tagSet = new Set(
    (recipeDietaryTags ?? []).map((tag) => tag.trim().toLowerCase())
  );
  return preferences.every((preference) =>
    tagSet.has(preference.trim().toLowerCase())
  );
}

async function loadPlannedRecipeIds(
  scopeFilter: Record<string, unknown>,
  date: Date
): Promise<Set<string>> {
  const windowStart = new Date(date.getTime() - PLANNED_WINDOW_DAYS * DAY_MS);
  const windowEnd = new Date(date.getTime() + PLANNED_WINDOW_DAYS * DAY_MS);
  const ids = await ScheduleEntry.distinct("recipeId", {
    ...scopeFilter,
    date: { $gte: windowStart, $lte: windowEnd },
    recipeId: { $ne: null },
  });
  return new Set(ids.map((id) => id.toString()));
}

async function loadRecentlyCooked(
  scopeFilter: Record<string, unknown>,
  userOid: Types.ObjectId,
  since: Date
): Promise<Map<string, number>> {
  const [scheduleCooked, cookedPosts, ratings] = await Promise.all([
    ScheduleEntry.find({
      cookedAt: { $gte: since },
      recipeId: { $ne: null },
      $or: [scopeFilter, { userId: userOid }],
    })
      .select("recipeId cookedAt")
      .lean(),
    CookedPost.find({
      userId: userOid,
      recipeId: { $ne: null },
      createdAt: { $gte: since },
    })
      .select("recipeId createdAt")
      .lean(),
    RecipeRating.find({ userId: userOid, cookedAt: { $gte: since } })
      .select("recipeId cookedAt")
      .lean(),
  ]);

  const cookedMap = new Map<string, number>();

  function record(
    id: Types.ObjectId | null | undefined,
    timestamp: Date | null | undefined
  ): void {
    if (!id || !timestamp) return;
    const key = id.toString();
    const time = timestamp.getTime();
    const existing = cookedMap.get(key);
    if (existing === undefined || time > existing) {
      cookedMap.set(key, time);
    }
  }

  for (const entry of scheduleCooked) {
    record(entry.recipeId, entry.cookedAt);
  }
  for (const post of cookedPosts) {
    record(post.recipeId, post.createdAt);
  }
  for (const rating of ratings) {
    record(rating.recipeId, rating.cookedAt);
  }

  return cookedMap;
}

function buildCandidateList(
  docs: SummaryRecipeDoc[],
  reasonFor: (doc: SummaryRecipeDoc) => MealIdeaReason,
  missingCountFor: (doc: SummaryRecipeDoc) => number,
  ctx: CandidateContext
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const doc of docs) {
    if (doc.isHidden) continue;
    if (ctx.blockedIdSet.has(doc.authorId.toString())) continue;

    const isOwnRecipe = doc.authorId.equals(ctx.userOid);
    if (!isOwnRecipe && !matchesDietaryPreferences(doc.dietaryTags, ctx.diets)) {
      continue;
    }

    const fit = slotFit(doc, ctx.mealLabel);
    if (fit === null) continue;

    candidates.push({
      doc,
      reason: reasonFor(doc),
      missingCount: missingCountFor(doc),
      fit,
      key: ideaRankKey(ctx.userId, ctx.dateKey, doc._id.toString()),
    });
  }

  return candidates;
}

function compareCandidates(
  a: Candidate,
  b: Candidate,
  useMissingCount: boolean
): number {
  if (useMissingCount && a.missingCount !== b.missingCount) {
    return a.missingCount - b.missingCount;
  }
  if (a.fit !== b.fit) {
    return a.fit - b.fit;
  }
  if (a.key !== b.key) {
    return a.key < b.key ? -1 : 1;
  }
  const aId = a.doc._id.toString();
  const bId = b.doc._id.toString();
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

function wholeNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : null;
}

function toIdeaRecipe(
  doc: SummaryRecipeDoc,
  author: AuthorLean | undefined
): MealIdeaRecipe {
  return {
    _id: doc._id.toString(),
    authorId: doc.authorId.toString(),
    title: doc.title,
    photos: doc.photos ?? [],
    labels: doc.labels ?? [],
    dietaryTags: doc.dietaryTags ?? [],
    cuisineTags: doc.cuisineTags ?? [],
    tags: doc.tags ?? [],
    difficulty: doc.difficulty ?? null,
    prepTime: wholeNumberOrNull(doc.prepTime),
    cookTime: wholeNumberOrNull(doc.cookTime),
    totalTime: wholeNumberOrNull(doc.totalTime),
    servings: wholeNumberOrNull(doc.servings),
    baseServings:
      wholeNumberOrNull(doc.baseServings) ?? wholeNumberOrNull(doc.servings) ?? 1,
    isPrivate: doc.isPrivate ?? false,
    likesCount: doc.likesCount ?? 0,
    forksCount: doc.forksCount ?? 0,
    avgRating: doc.avgRating ?? 0,
    ratingCount: doc.ratingCount ?? 0,
    authorName: author?.fullName ?? "",
    authorPhoto: author?.profilePicture ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function pantryCandidates(
  userId: string,
  userOid: Types.ObjectId,
  user: { isPremium: boolean; premiumExpiresAt?: Date | null },
  plannedIds: Set<string>,
  cookedWithin: CookedWithinFn,
  ctx: CandidateContext
): Promise<Candidate[]> {
  if (!hasActivePremium(user)) {
    return [];
  }

  const pantryItemCount = await PantryItem.countDocuments({ userId: userOid });
  if (pantryItemCount < PANTRY_IDEAS_MIN_ITEMS) {
    return [];
  }

  const { matches } = await getPantryMatches(userId, {
    scope: "all",
    maxMissing: PANTRY_MAX_MISSING,
    limit: PANTRY_CANDIDATE_LIMIT,
  });

  const keptMatches = new Map<string, PantryMatch>();
  for (const match of matches) {
    if (match.haveCount <= match.missingCount) continue;
    if (plannedIds.has(match.recipe.id)) continue;
    if (cookedWithin(match.recipe.id, PANTRY_RECENT_COOK_DAYS)) continue;
    keptMatches.set(match.recipe.id, match);
  }

  if (keptMatches.size === 0) {
    return [];
  }

  const docs = await Recipe.find({ _id: { $in: Array.from(keptMatches.keys()) } })
    .select(SUMMARY_FIELDS)
    .lean<SummaryRecipeDoc[]>();

  const candidates = buildCandidateList(
    docs,
    (doc) => {
      const match = keptMatches.get(doc._id.toString())!;
      return {
        kind: "pantry",
        haveCount: match.haveCount,
        totalCount: match.totalCount,
        missingIngredients: match.missingIngredients,
      };
    },
    (doc) => keptMatches.get(doc._id.toString())!.missingCount,
    ctx
  );

  candidates.sort((a, b) => compareCandidates(a, b, true));
  return candidates;
}

async function recipeBookCandidates(
  userOid: Types.ObjectId,
  isKitchenPlan: boolean,
  blockedIds: Types.ObjectId[],
  plannedIds: Set<string>,
  cookedWithin: CookedWithinFn,
  ctx: CandidateContext
): Promise<Candidate[]> {
  const [ownRecipes, savedRefs] = await Promise.all([
    Recipe.find({
      authorId: userOid,
      isHidden: { $ne: true },
      ...(isKitchenPlan ? { isPrivate: { $ne: true } } : {}),
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(RECIPE_BOOK_POOL_LIMIT)
      .select(SUMMARY_FIELDS)
      .lean<SummaryRecipeDoc[]>(),
    SavedRecipe.find({ userId: userOid })
      .sort({ createdAt: -1, _id: -1 })
      .limit(RECIPE_BOOK_POOL_LIMIT)
      .select("recipeId")
      .lean<{ recipeId: Types.ObjectId }[]>(),
  ]);

  const savedIds = savedRefs.map((ref) => ref.recipeId);
  const savedDocs = savedIds.length
    ? await Recipe.find({
        _id: { $in: savedIds },
        authorId: { $ne: userOid, $nin: blockedIds },
        isHidden: { $ne: true },
        isPrivate: { $ne: true },
      })
        .select(SUMMARY_FIELDS)
        .lean<SummaryRecipeDoc[]>()
    : [];

  const pool = [...ownRecipes, ...savedDocs].filter((doc) => {
    const id = doc._id.toString();
    return !plannedIds.has(id) && !cookedWithin(id, RECENT_COOK_DAYS);
  });

  const candidates = buildCandidateList(
    pool,
    () => ({ kind: "saved" }),
    () => 0,
    ctx
  );

  candidates.sort((a, b) => compareCandidates(a, b, false));
  return candidates;
}

async function forYouCandidates(
  userOid: Types.ObjectId,
  plannedIds: Set<string>,
  cookedWithin: CookedWithinFn,
  ctx: CandidateContext
): Promise<Candidate[]> {
  const feed = await forYouFeed(userOid, 1, FOR_YOU_POOL_LIMIT);
  const ids = feed.recipes.map((recipe) => recipe._id);
  if (ids.length === 0) {
    return [];
  }

  const docs = await Recipe.find({ _id: { $in: ids } })
    .select(SUMMARY_FIELDS)
    .lean<SummaryRecipeDoc[]>();

  const pool = docs.filter((doc) => {
    const id = doc._id.toString();
    return !plannedIds.has(id) && !cookedWithin(id, RECENT_COOK_DAYS);
  });

  const candidates = buildCandidateList(
    pool,
    () => ({ kind: "popular" }),
    () => 0,
    ctx
  );

  candidates.sort((a, b) => compareCandidates(a, b, false));
  return candidates;
}

export async function getMealIdeas(
  userId: string,
  options: MealIdeasOptions
): Promise<{ ideas: MealIdea[] }> {
  const user = await User.findById(userId)
    .select("_id kitchenId isPremium premiumExpiresAt dietaryPreferences")
    .lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  const userOid = user._id;
  const dateKey = options.date.toISOString().slice(0, 10);
  const now = options.now ?? new Date();
  const isKitchenPlan = Boolean(user.kitchenId);

  const scopeFilter: Record<string, unknown> = isKitchenPlan
    ? { kitchenId: user.kitchenId }
    : { userId: userOid, kitchenId: { $exists: false } };

  const mealLabel = slotMealLabel(options.slot);
  const diets = canonicalDietaryPreferences(user.dietaryPreferences);
  const limit = Math.min(
    Math.max(Math.trunc(options.limit), 1),
    MEAL_IDEAS_MAX_LIMIT
  );

  const since = new Date(now.getTime() - RECENT_COOK_DAYS * DAY_MS);

  const [plannedIds, cookedMap, blockedIds] = await Promise.all([
    loadPlannedRecipeIds(scopeFilter, options.date),
    loadRecentlyCooked(scopeFilter, userOid, since),
    getBlockedUserIds(userId),
  ]);

  const cookedWithin: CookedWithinFn = (id, days) => {
    const timestamp = cookedMap.get(id);
    return timestamp !== undefined && timestamp >= now.getTime() - days * DAY_MS;
  };

  const blockedIdSet = new Set(blockedIds.map((id) => id.toString()));
  const ctx: CandidateContext = {
    mealLabel,
    diets,
    userOid,
    blockedIdSet,
    userId,
    dateKey,
  };

  const tierProducers: Array<() => Promise<Candidate[]>> = [
    () => pantryCandidates(userId, userOid, user, plannedIds, cookedWithin, ctx),
    () =>
      recipeBookCandidates(
        userOid,
        isKitchenPlan,
        blockedIds,
        plannedIds,
        cookedWithin,
        ctx
      ),
    () => forYouCandidates(userOid, plannedIds, cookedWithin, ctx),
  ];

  const picked: Candidate[] = [];
  const pickedIds = new Set<string>();
  let attempts = 0;

  for (const produceTier of tierProducers) {
    if (picked.length >= limit || attempts >= MAX_VALIDATION_ATTEMPTS) break;

    const candidates = (await produceTier()).filter(
      (candidate) => !pickedIds.has(candidate.doc._id.toString())
    );

    let index = 0;
    while (
      index < candidates.length &&
      picked.length < limit &&
      attempts < MAX_VALIDATION_ATTEMPTS
    ) {
      const batchSize = Math.min(
        limit - picked.length,
        MAX_VALIDATION_ATTEMPTS - attempts,
        candidates.length - index
      );
      const batch = candidates.slice(index, index + batchSize);
      index += batchSize;
      attempts += batch.length;

      const verdicts = await Promise.all(
        batch.map((candidate) =>
          canScheduleRecipe(candidate.doc._id.toString(), userId, isKitchenPlan)
        )
      );

      batch.forEach((candidate, position) => {
        const id = candidate.doc._id.toString();
        if (verdicts[position] && !pickedIds.has(id)) {
          picked.push(candidate);
          pickedIds.add(id);
        }
      });
    }
  }

  const pickedAuthorIds = Array.from(
    new Set(picked.map((candidate) => candidate.doc.authorId.toString()))
  ).map((id) => new Types.ObjectId(id));

  const authors = pickedAuthorIds.length
    ? await User.find({ _id: { $in: pickedAuthorIds } })
        .select("fullName profilePicture")
        .lean<AuthorLean[]>()
    : [];
  const authorMap = new Map(authors.map((author) => [author._id.toString(), author]));

  const ideas: MealIdea[] = picked.map((candidate) => ({
    recipe: toIdeaRecipe(
      candidate.doc,
      authorMap.get(candidate.doc.authorId.toString())
    ),
    reason: candidate.reason,
  }));

  return { ideas };
}
