import { Document, Types, PipelineStage } from "mongoose";
import Recipe, { IRecipe } from "../models/Recipe";
import User, { IUser } from "../models/User";
import Follow from "../models/Follow";
import Like from "../models/Like";
import SavedRecipe from "../models/SavedRecipe";
import SeasonalTag from "../models/SeasonalTag";
import { getBlockedUserIds } from "./block-service";
import { getKitchenMemberIds } from "./visibility-service";

// ── Types ──────────────────────────────────────────────────────────────────────

interface FeedRecipe {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  title: string;
  description?: string;
  photos: string[];
  showSignature: boolean;
  labels: string[];
  dietaryTags: string[];
  cuisineTags: string[];
  difficulty?: string;
  ingredients: IRecipe["ingredients"];
  ingredientCount: number;
  steps: IRecipe["steps"];
  prepTime?: number;
  cookTime?: number;
  totalTime?: number;
  servings?: number;
  calories?: number;
  costEstimate?: string;
  baseServings: number;
  forkedFrom?: IRecipe["forkedFrom"];
  isModifiedFork: boolean;
  isPrivate: boolean;
  likesCount: number;
  forksCount: number;
  commentsCount: number;
  createdAt: Date;
  updatedAt: Date;
  authorName: string;
  authorPhoto?: string;
  isLiked: boolean;
  isSaved: boolean;
}

interface PaginatedFeed {
  recipes: FeedRecipe[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

interface ViewerContext {
  blockExclusionIds: Types.ObjectId[];
  followingIds: Types.ObjectId[];
  kitchenId?: Types.ObjectId;
  dietaryPreferences: string[];
  cuisinePreferences: string[];
}

interface PoolDoc {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  likesCount?: number;
  forksCount?: number;
}

interface AuthorProfile {
  _id: Types.ObjectId;
  fullName?: string;
  profilePicture?: string;
  isPublic?: boolean;
  isBanned?: boolean;
  isPremium?: boolean;
}

interface ViewerRecipeState {
  authors: Map<string, AuthorProfile>;
  liked: Set<string>;
  saved: Set<string>;
}

interface VisiblePool {
  docs: PoolDoc[];
  state: ViewerRecipeState;
}

interface RankedPage {
  docs: LeanRecipe[];
  total: number;
  hasMore: boolean;
  state: ViewerRecipeState;
  accessiblePrivateIds: Types.ObjectId[];
  blockExclusionIds: Types.ObjectId[];
}

interface FeedPage {
  docs: LeanRecipe[];
  total: number;
  hasMore: boolean;
  state: ViewerRecipeState;
}

interface FeaturedCandidate {
  recipe: LeanRecipe;
  state: ViewerRecipeState;
}

export const FEED_POOL_SIZE = 2000;

export const FEED_INGREDIENT_PREVIEW = 4;

export const TRENDING_HALF_LIFE_DAYS = 14;
export const TRENDING_DECAY_RATE = Math.LN2 / TRENDING_HALF_LIFE_DAYS;

const TRENDING_SCORE_STALE_MS = 4 * 24 * 60 * 60 * 1000;

const POOL_FIELDS = "_id authorId";
const FOR_YOU_POOL_FIELDS = "_id authorId likesCount forksCount";
const POOL_AUTHOR_FIELDS = "fullName profilePicture isPublic isBanned isPremium";
const FEATURED_AUTHOR_FIELDS = "fullName profilePicture isPublic isBanned";
const PAGE_AUTHOR_FIELDS = "fullName profilePicture";

const FEED_RECIPE_FIELDS = [
  "authorId",
  "title",
  "description",
  "photos",
  "showSignature",
  "labels",
  "dietaryTags",
  "cuisineTags",
  "difficulty",
  "prepTime",
  "cookTime",
  "totalTime",
  "servings",
  "calories",
  "costEstimate",
  "baseServings",
  "forkedFrom",
  "isModifiedFork",
  "isPrivate",
  "likesCount",
  "forksCount",
  "commentsCount",
  "createdAt",
  "updatedAt",
] as const;

const FEED_RECIPE_INCLUDE = Object.fromEntries(
  FEED_RECIPE_FIELDS.map((field) => [field, 1])
);

const INGREDIENT_COUNT_EXPRESSION = {
  $cond: [{ $isArray: "$ingredients" }, { $size: "$ingredients" }, 0],
};

const FEED_RECIPE_SELECT = {
  ...FEED_RECIPE_INCLUDE,
  ingredients: { $slice: FEED_INGREDIENT_PREVIEW },
  ingredientCount: INGREDIENT_COUNT_EXPRESSION,
  steps: { $slice: 1 },
};

const FEED_RECIPE_PREVIEW_STAGE = {
  $project: {
    ...FEED_RECIPE_INCLUDE,
    ingredientCount: INGREDIENT_COUNT_EXPRESSION,
    ingredients: {
      $cond: [
        { $isArray: "$ingredients" },
        { $slice: ["$ingredients", FEED_INGREDIENT_PREVIEW] },
        "$ingredients",
      ],
    },
    steps: {
      $cond: [{ $isArray: "$steps" }, { $slice: ["$steps", 1] }, "$steps"],
    },
  },
};

const EMPTY_VIEWER_RECIPE_STATE: ViewerRecipeState = {
  authors: new Map(),
  liked: new Set(),
  saved: new Set(),
};

function dedupePool(docs: PoolDoc[], limit: number): PoolDoc[] {
  const seen = new Set<string>();
  const unique: PoolDoc[] = [];
  for (const doc of docs) {
    if (unique.length >= limit) break;
    const key = doc._id.toString();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(doc);
    }
  }
  return unique;
}

function uniqueIds(ids: Types.ObjectId[]): Types.ObjectId[] {
  const seen = new Map<string, Types.ObjectId>();
  for (const id of ids) seen.set(id.toString(), id);
  return Array.from(seen.values());
}

function findPool(
  filter: Record<string, unknown>,
  sort: Record<string, 1 | -1>,
  fields: string
) {
  return Recipe.find(filter)
    .select(fields)
    .sort(sort)
    .limit(FEED_POOL_SIZE)
    .batchSize(FEED_POOL_SIZE)
    .lean<PoolDoc[]>();
}

async function getRecencyPopularityPool(
  baseMatch: Record<string, unknown>,
  fields: string
): Promise<PoolDoc[]> {
  const [recent, popular] = await Promise.all([
    findPool(baseMatch, { createdAt: -1 }, fields),
    findPool(baseMatch, { likesCount: -1 }, fields),
  ]);
  return dedupePool([...recent, ...popular], FEED_POOL_SIZE);
}

async function getForYouPool(
  baseMatch: Record<string, unknown>,
  userDietary: string[],
  userCuisine: string[]
): Promise<PoolDoc[]> {
  if (userDietary.length === 0 && userCuisine.length === 0) {
    return getRecencyPopularityPool(baseMatch, FOR_YOU_POOL_FIELDS);
  }

  const preferenceMatch: Record<string, unknown> = {
    ...baseMatch,
    $or: [
      ...(userDietary.length > 0 ? [{ dietaryTags: { $in: userDietary } }] : []),
      ...(userCuisine.length > 0 ? [{ cuisineTags: { $in: userCuisine } }] : []),
    ],
  };

  return findPool(preferenceMatch, { createdAt: -1 }, FOR_YOU_POOL_FIELDS);
}

async function isTrendingScoreFresh(): Promise<boolean> {
  const freshest = await Recipe.findOne({ trendingScore: { $gt: 0 } })
    .select("trendingScoreUpdatedAt")
    .sort({ trendingScore: -1 })
    .lean();

  const updatedAt = freshest?.trendingScoreUpdatedAt;
  return (
    updatedAt !== undefined &&
    updatedAt !== null &&
    Date.now() - updatedAt.getTime() <= TRENDING_SCORE_STALE_MS
  );
}

async function getTrendingPool(
  baseMatch: Record<string, unknown>,
  materialized: boolean
): Promise<PoolDoc[]> {
  if (!materialized) {
    return getRecencyPopularityPool(baseMatch, POOL_FIELDS);
  }
  return findPool(baseMatch, { trendingScore: -1 }, POOL_FIELDS);
}

async function getActiveSeasonalSlugs(): Promise<string[]> {
  const now = new Date();
  const activeTags = await SeasonalTag.find({
    isActive: true,
    startDate: { $lte: now },
    endDate: { $gte: now },
  })
    .select("slug")
    .lean();
  return activeTags.map((t) => t.slug);
}

async function getSeasonalPool(
  baseMatch: Record<string, unknown>,
  activeSlugs: string[]
): Promise<PoolDoc[]> {
  if (activeSlugs.length === 0) {
    return getRecencyPopularityPool(baseMatch, POOL_FIELDS);
  }

  return findPool(
    { ...baseMatch, seasonalTags: { $in: activeSlugs } },
    { likesCount: -1, createdAt: -1 },
    POOL_FIELDS
  );
}

function splitHasMore<T>(docs: T[], limit: number): { page: T[]; hasMore: boolean } {
  if (docs.length > limit) {
    return { page: docs.slice(0, limit), hasMore: true };
  }
  return { page: docs, hasMore: false };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Returns IDs of users the viewer actively follows.
 * Filters on `status: "active"` so pending follow requests on private accounts
 * do NOT count — a pending requester is not yet a follower.
 */
async function getFollowingIds(
  userId: Types.ObjectId
): Promise<Types.ObjectId[]> {
  const follows = await Follow.find({
    followerId: userId,
    status: "active",
  })
    .select("followingId")
    .batchSize(FEED_POOL_SIZE)
    .lean();
  return follows.map((f) => f.followingId);
}

async function getSecondDegreeFollowingIds(
  followingIds: Types.ObjectId[]
): Promise<Types.ObjectId[]> {
  if (followingIds.length === 0) return [];
  const secondDegree = await Follow.find({
    followerId: { $in: followingIds },
    status: "active",
  })
    .select("followingId")
    .batchSize(FEED_POOL_SIZE)
    .lean();
  return secondDegree.map((f) => f.followingId);
}

/**
 * Returns the bidirectional block exclusion set for the viewer. The
 * block-service's `getBlockedUserIds` is already bidirectional, so a single
 * call yields both "users I blocked" and "users who blocked me".
 */
async function getBlockExclusionIds(
  viewerId: Types.ObjectId
): Promise<Types.ObjectId[]> {
  return getBlockedUserIds(viewerId.toString());
}

async function loadViewerContext(userId: Types.ObjectId): Promise<ViewerContext> {
  const [blockExclusionIds, followingIds, viewer] = await Promise.all([
    getBlockExclusionIds(userId),
    getFollowingIds(userId),
    User.findById(userId)
      .select("kitchenId dietaryPreferences cuisinePreferences")
      .lean<Pick<IUser, "kitchenId" | "dietaryPreferences" | "cuisinePreferences"> | null>(),
  ]);
  return {
    blockExclusionIds,
    followingIds,
    kitchenId: viewer?.kitchenId,
    dietaryPreferences: viewer?.dietaryPreferences ?? [],
    cuisinePreferences: viewer?.cuisinePreferences ?? [],
  };
}

function buildBaseMatch(
  userId: Types.ObjectId,
  blockExclusionIds: Types.ObjectId[]
): Record<string, unknown> {
  return {
    isPrivate: false,
    isHidden: { $ne: true },
    authorId:
      blockExclusionIds.length > 0
        ? { $ne: userId, $nin: blockExclusionIds }
        : { $ne: userId },
  };
}

async function loadViewerRecipeState(
  userId: Types.ObjectId,
  recipeIds: Types.ObjectId[],
  authorIds: Types.ObjectId[],
  authorFields: string
): Promise<ViewerRecipeState> {
  if (recipeIds.length === 0) return EMPTY_VIEWER_RECIPE_STATE;

  const [authors, likes, saves] = await Promise.all([
    User.find({ _id: { $in: authorIds } })
      .select(authorFields)
      .batchSize(FEED_POOL_SIZE)
      .lean<AuthorProfile[]>(),
    Like.find({
      userId,
      recipeId: { $in: recipeIds },
    })
      .select("recipeId")
      .batchSize(FEED_POOL_SIZE)
      .lean(),
    SavedRecipe.find({
      userId,
      recipeId: { $in: recipeIds },
    })
      .select("recipeId")
      .batchSize(FEED_POOL_SIZE)
      .lean(),
  ]);

  return {
    authors: new Map(authors.map((a) => [a._id.toString(), a])),
    liked: new Set(likes.map((l) => l.recipeId.toString())),
    saved: new Set(saves.map((s) => s.recipeId.toString())),
  };
}

function mergeViewerRecipeState(
  base: ViewerRecipeState,
  extra: ViewerRecipeState
): ViewerRecipeState {
  return {
    authors: new Map([...base.authors, ...extra.authors]),
    liked: new Set([...base.liked, ...extra.liked]),
    saved: new Set([...base.saved, ...extra.saved]),
  };
}

function isVisibleAuthor(
  author: AuthorProfile | undefined,
  accessibleKeys: Set<string>
): boolean {
  if (!author || author.isBanned === true) return false;
  return author.isPublic === true || accessibleKeys.has(author._id.toString());
}

async function resolveVisiblePool(
  userId: Types.ObjectId,
  pool: PoolDoc[],
  accessiblePrivateIds: Types.ObjectId[]
): Promise<VisiblePool> {
  const state = await loadViewerRecipeState(
    userId,
    pool.map((doc) => doc._id),
    uniqueIds(pool.map((doc) => doc.authorId)),
    POOL_AUTHOR_FIELDS
  );
  const accessibleKeys = new Set(accessiblePrivateIds.map((id) => id.toString()));
  const docs = pool.filter((doc) =>
    isVisibleAuthor(state.authors.get(doc.authorId.toString()), accessibleKeys)
  );
  return { docs, state };
}

function maxEngagementOf(docs: PoolDoc[]): number {
  let max: number | null = null;
  for (const doc of docs) {
    if (typeof doc.likesCount !== "number" || typeof doc.forksCount !== "number") {
      continue;
    }
    const engagement = doc.likesCount + doc.forksCount * 3;
    if (max === null || engagement > max) max = engagement;
  }
  return Math.max(1, max ?? 0);
}

function premiumAuthorIdsOf(
  docs: PoolDoc[],
  state: ViewerRecipeState
): Types.ObjectId[] {
  return uniqueIds(docs.map((doc) => doc.authorId)).filter((id) =>
    Boolean(state.authors.get(id.toString())?.isPremium)
  );
}

/** Lean recipe shape returned by Mongoose `.lean()`. */
type LeanRecipe = Omit<IRecipe, keyof Document> & {
  _id: Types.ObjectId;
  ingredientCount?: number;
};

function previewIngredients(recipe: LeanRecipe): IRecipe["ingredients"] {
  return Array.isArray(recipe.ingredients)
    ? recipe.ingredients.slice(0, FEED_INGREDIENT_PREVIEW)
    : recipe.ingredients;
}

function previewSteps(recipe: LeanRecipe): IRecipe["steps"] {
  if (!Array.isArray(recipe.steps)) return recipe.steps;
  if (Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0) {
    return [];
  }
  return recipe.steps.slice(0, 1);
}

function toFeedRecipe(
  recipe: LeanRecipe,
  state: ViewerRecipeState
): FeedRecipe {
  const author = state.authors.get(recipe.authorId.toString());
  const id = recipe._id.toString();
  return {
    _id: recipe._id,
    authorId: recipe.authorId,
    title: recipe.title,
    description: recipe.description,
    photos: recipe.photos,
    showSignature: recipe.showSignature,
    labels: recipe.labels,
    dietaryTags: recipe.dietaryTags,
    cuisineTags: recipe.cuisineTags,
    difficulty: recipe.difficulty,
    ingredients: previewIngredients(recipe),
    ingredientCount: recipe.ingredientCount ?? 0,
    steps: previewSteps(recipe),
    prepTime: recipe.prepTime,
    cookTime: recipe.cookTime,
    totalTime: recipe.totalTime,
    servings: recipe.servings,
    calories: recipe.calories,
    costEstimate: recipe.costEstimate,
    baseServings: recipe.baseServings,
    forkedFrom: recipe.forkedFrom,
    isModifiedFork: recipe.isModifiedFork,
    isPrivate: recipe.isPrivate,
    likesCount: recipe.likesCount,
    forksCount: recipe.forksCount,
    commentsCount: recipe.commentsCount ?? 0,
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
    authorName: author?.fullName ?? "Unknown",
    authorPhoto: author?.profilePicture,
    isLiked: state.liked.has(id),
    isSaved: state.saved.has(id),
  };
}

async function findFeaturedCandidate(
  userId: Types.ObjectId
): Promise<FeaturedCandidate | null> {
  const featured = await Recipe.findOne({
    isFeatured: true,
    isHidden: { $ne: true },
    isPrivate: false,
  })
    .sort({ featuredAt: -1 })
    .select(FEED_RECIPE_SELECT)
    .lean<LeanRecipe | null>();

  if (!featured) return null;

  // Feeds always exclude the viewer's own recipes — keep parity here.
  if (featured.authorId.equals(userId)) return null;

  const state = await loadViewerRecipeState(
    userId,
    [featured._id],
    [featured.authorId],
    FEATURED_AUTHOR_FIELDS
  );
  return { recipe: featured, state };
}

function resolveFeaturedForViewer(
  candidate: FeaturedCandidate | null,
  accessiblePrivateIds: Types.ObjectId[],
  blockExclusionIds: Types.ObjectId[]
): FeaturedCandidate | null {
  if (!candidate) return null;
  const { recipe, state } = candidate;

  // Exclude any recipe whose author is on either side of a block.
  if (blockExclusionIds.some((id) => id.equals(recipe.authorId))) {
    return null;
  }

  const author = state.authors.get(recipe.authorId.toString());
  if (!author || author.isBanned) return null;

  const authorIsPublic = author.isPublic === true;
  const viewerHasAccess = accessiblePrivateIds.some((id) =>
    id.equals(recipe.authorId)
  );
  if (!authorIsPublic && !viewerHasAccess) return null;

  return candidate;
}

/**
 * Prepends the featured recipe to a page-1 result set, deduplicating it from
 * the algorithmic result if it was already included. Adjusts `total` only
 * when the featured recipe was NOT already in the base list.
 */
function applyFeaturedToPage<T extends { _id: Types.ObjectId }>(
  recipes: T[],
  total: number,
  featured: T | null,
  page: number
): { recipes: T[]; total: number } {
  if (!featured || page !== 1) {
    return { recipes, total };
  }
  const featuredId = featured._id.toString();
  const existedInBase = recipes.some((r) => r._id.toString() === featuredId);
  const deduped = existedInBase
    ? recipes.filter((r) => r._id.toString() !== featuredId)
    : recipes;
  return {
    recipes: [featured, ...deduped],
    total: existedInBase ? total : total + 1,
  };
}

async function loadFeedPage(
  userId: Types.ObjectId,
  page: number,
  rank: () => Promise<RankedPage>
): Promise<FeedPage> {
  const [ranked, featuredCandidate] = await Promise.all([
    rank(),
    page === 1 ? findFeaturedCandidate(userId) : null,
  ]);
  const featured = resolveFeaturedForViewer(
    featuredCandidate,
    ranked.accessiblePrivateIds,
    ranked.blockExclusionIds
  );
  const { recipes, total } = applyFeaturedToPage(
    ranked.docs,
    ranked.total,
    featured?.recipe ?? null,
    page
  );
  return {
    docs: recipes,
    total,
    hasMore: ranked.hasMore,
    state: featured
      ? mergeViewerRecipeState(ranked.state, featured.state)
      : ranked.state,
  };
}

function toPaginatedFeed(
  page: number,
  limit: number,
  feed: FeedPage
): PaginatedFeed {
  return {
    recipes: feed.docs.map((doc) => toFeedRecipe(doc, feed.state)),
    page,
    limit,
    total: feed.total,
    totalPages: Math.ceil(feed.total / limit),
    hasMore: feed.hasMore,
  };
}

async function aggregateVisiblePool(
  visibleDocs: PoolDoc[],
  rankingStages: Record<string, unknown>[],
  page: number,
  limit: number
): Promise<{ docs: LeanRecipe[]; total: number; hasMore: boolean }> {
  if (visibleDocs.length === 0) return { docs: [], total: 0, hasMore: false };
  const skip = (page - 1) * limit;
  const [result] = await Recipe.aggregate([
    { $match: { _id: { $in: visibleDocs.map((doc) => doc._id) } } },
    ...rankingStages,
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: limit + 1 }, FEED_RECIPE_PREVIEW_STAGE],
        count: [{ $limit: 1000 }, { $count: "n" }],
      },
    },
  ] as unknown as PipelineStage[]).allowDiskUse(true);

  const { page: docs, hasMore } = splitHasMore(
    (result?.data ?? []) as LeanRecipe[],
    limit
  );
  return { docs, total: (result?.count[0]?.n ?? 0) as number, hasMore };
}

async function rankForYou(
  userId: Types.ObjectId,
  page: number,
  limit: number
): Promise<RankedPage> {
  const viewer = await loadViewerContext(userId);
  const userDietary = viewer.dietaryPreferences;
  const userCuisine = viewer.cuisinePreferences;

  // No hard recency cutoff: the whole visible catalog is eligible. Recency
  // still shapes ranking via `_recencyScore` below, but never hides a recipe.
  const baseMatch = buildBaseMatch(userId, viewer.blockExclusionIds);

  const [kitchenMemberIds, followedByFollowingIds, pool] = await Promise.all([
    getKitchenMemberIds(userId, viewer.kitchenId),
    getSecondDegreeFollowingIds(viewer.followingIds),
    getForYouPool(baseMatch, userDietary, userCuisine),
  ]);
  const accessiblePrivateIds = [...viewer.followingIds, ...kitchenMemberIds];
  const visible = await resolveVisiblePool(userId, pool, accessiblePrivateIds);
  const maxEngagement = maxEngagementOf(visible.docs);
  const premiumAuthorIds = premiumAuthorIdsOf(visible.docs, visible.state);
  const nowMs = Date.now();

  const rankingStages: Record<string, unknown>[] = [
    // Compute scoring components
    {
      $addFields: {
        _daysSince: {
          $divide: [
            { $subtract: [new Date(nowMs), "$createdAt"] },
            1000 * 60 * 60 * 24,
          ],
        },
        _rawEngagement: {
          $add: ["$likesCount", { $multiply: ["$forksCount", 3] }],
        },
      },
    },
    {
      $addFields: {
        _recencyScore: {
          $max: [0, { $subtract: [1, { $divide: ["$_daysSince", 30] }] }],
        },
        _engagementScore: { $divide: ["$_rawEngagement", maxEngagement] },
        _relevanceScore: {
          $add: [
            // 0.3 if any dietaryTag matches user preferences
            {
              $cond: [
                userDietary.length > 0
                  ? {
                      $gt: [
                        {
                          $size: {
                            $filter: {
                              input: "$dietaryTags",
                              as: "t",
                              cond: { $in: ["$$t", userDietary] },
                            },
                          },
                        },
                        0,
                      ],
                    }
                  : false,
                0.3,
                0,
              ],
            },
            // 0.3 if any cuisineTag matches
            {
              $cond: [
                userCuisine.length > 0
                  ? {
                      $gt: [
                        {
                          $size: {
                            $filter: {
                              input: "$cuisineTags",
                              as: "t",
                              cond: { $in: ["$$t", userCuisine] },
                            },
                          },
                        },
                        0,
                      ],
                    }
                  : false,
                0.3,
                0,
              ],
            },
            // 0.2 if followed-by-following
            {
              $cond: [
                followedByFollowingIds.length > 0
                  ? { $in: ["$authorId", followedByFollowingIds] }
                  : false,
                0.2,
                0,
              ],
            },
            // 0.2 if any label matches dietary or cuisine prefs
            {
              $cond: [
                userDietary.length > 0 || userCuisine.length > 0
                  ? {
                      $gt: [
                        {
                          $size: {
                            $filter: {
                              input: "$labels",
                              as: "l",
                              cond: {
                                $or: [
                                  ...(userDietary.length > 0
                                    ? [{ $in: ["$$l", userDietary] }]
                                    : []),
                                  ...(userCuisine.length > 0
                                    ? [{ $in: ["$$l", userCuisine] }]
                                    : []),
                                ],
                              },
                            },
                          },
                        },
                        0,
                      ],
                    }
                  : false,
                0.2,
                0,
              ],
            },
          ],
        },
        _premiumBoost: {
          $cond: [
            premiumAuthorIds.length > 0
              ? { $in: ["$authorId", premiumAuthorIds] }
              : false,
            0.1,
            0,
          ],
        },
      },
    },
    {
      $addFields: {
        _score: {
          $add: [
            { $multiply: ["$_recencyScore", 0.25] },
            { $multiply: ["$_engagementScore", 0.25] },
            { $multiply: ["$_relevanceScore", 0.3] },
            0.1, // diversity constant (simplified)
            { $multiply: ["$_premiumBoost", 0.1] },
          ],
        },
      },
    },
    // Real (non-seed) recipes rank ahead of seed recipes, then by score.
    // `isSeed` sorts ascending: missing/false (real) before true (seed).
    { $sort: { isSeed: 1, _score: -1 } },
  ];

  const ranked = await aggregateVisiblePool(visible.docs, rankingStages, page, limit);
  return {
    ...ranked,
    state: visible.state,
    accessiblePrivateIds,
    blockExclusionIds: viewer.blockExclusionIds,
  };
}

async function rankTrending(
  userId: Types.ObjectId,
  page: number,
  limit: number
): Promise<RankedPage> {
  const [viewer, materialized] = await Promise.all([
    loadViewerContext(userId),
    isTrendingScoreFresh(),
  ]);

  // Rank by engagement across the whole visible catalog rather than a fixed
  // recent window, so the feed is never emptied out as recipes age.
  const baseMatch = buildBaseMatch(userId, viewer.blockExclusionIds);

  const [kitchenMemberIds, pool] = await Promise.all([
    getKitchenMemberIds(userId, viewer.kitchenId),
    getTrendingPool(baseMatch, materialized),
  ]);
  const accessiblePrivateIds = [...viewer.followingIds, ...kitchenMemberIds];
  const visible = await resolveVisiblePool(userId, pool, accessiblePrivateIds);
  const nowMs = Date.now();

  const rankingStages: Record<string, unknown>[] = materialized
    ? [{ $sort: { isSeed: 1, trendingScore: -1 } }]
    : [
        {
          $addFields: {
            _ageDays: {
              $divide: [
                { $subtract: [new Date(nowMs), "$createdAt"] },
                1000 * 60 * 60 * 24,
              ],
            },
          },
        },
        {
          $addFields: {
            _trendScore: {
              $multiply: [
                { $add: ["$likesCount", { $multiply: ["$forksCount", 3] }] },
                { $exp: { $multiply: ["$_ageDays", -TRENDING_DECAY_RATE] } },
              ],
            },
          },
        },
        // Real (non-seed) recipes rank ahead of seed recipes, then by engagement.
        { $sort: { isSeed: 1, _trendScore: -1 } },
      ];

  const ranked = await aggregateVisiblePool(visible.docs, rankingStages, page, limit);
  return {
    ...ranked,
    state: visible.state,
    accessiblePrivateIds,
    blockExclusionIds: viewer.blockExclusionIds,
  };
}

async function rankFriends(
  userId: Types.ObjectId,
  page: number,
  limit: number
): Promise<RankedPage> {
  const viewer = await loadViewerContext(userId);
  const skip = (page - 1) * limit;

  // Remove blocked (either direction) authors from the followed-author set.
  const blockedKeys = new Set(
    viewer.blockExclusionIds.map((id) => id.toString())
  );
  const visibleFollowing = viewer.followingIds.filter(
    (id) => !blockedKeys.has(id.toString())
  );

  const filter = {
    authorId: { $in: visibleFollowing },
    isPrivate: false,
    isHidden: { $ne: true },
  };

  const [docs, total, kitchenMemberIds] = await Promise.all([
    visibleFollowing.length > 0
      ? Recipe.find(filter)
          // Real (non-seed) recipes rank ahead of seed recipes, then newest first.
          .sort({ isSeed: 1, createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .select(FEED_RECIPE_SELECT)
          .lean<LeanRecipe[]>()
      : [],
    visibleFollowing.length > 0 ? Recipe.countDocuments(filter) : 0,
    page === 1 ? getKitchenMemberIds(userId, viewer.kitchenId) : [],
  ]);

  const state = await loadViewerRecipeState(
    userId,
    docs.map((doc) => doc._id),
    uniqueIds(docs.map((doc) => doc.authorId)),
    PAGE_AUTHOR_FIELDS
  );

  return {
    docs,
    total,
    hasMore: skip + docs.length < total,
    state,
    accessiblePrivateIds: [...viewer.followingIds, ...kitchenMemberIds],
    blockExclusionIds: viewer.blockExclusionIds,
  };
}

async function rankSeasonal(
  userId: Types.ObjectId,
  page: number,
  limit: number
): Promise<RankedPage> {
  const [viewer, activeSlugs] = await Promise.all([
    loadViewerContext(userId),
    getActiveSeasonalSlugs(),
  ]);
  const baseMatch = buildBaseMatch(userId, viewer.blockExclusionIds);

  // No active seasonal tags: fall back to the full visible catalog rather than
  // an empty feed. The sort below still ranks user recipes ahead of seed.
  const [kitchenMemberIds, pool] = await Promise.all([
    getKitchenMemberIds(userId, viewer.kitchenId),
    getSeasonalPool(baseMatch, activeSlugs),
  ]);
  const accessiblePrivateIds = [...viewer.followingIds, ...kitchenMemberIds];
  const visible = await resolveVisiblePool(userId, pool, accessiblePrivateIds);

  const ranked = await aggregateVisiblePool(
    visible.docs,
    // Real (non-seed) recipes rank ahead of seed recipes.
    [{ $sort: { isSeed: 1, likesCount: -1, createdAt: -1 } }],
    page,
    limit
  );
  return {
    ...ranked,
    state: visible.state,
    accessiblePrivateIds,
    blockExclusionIds: viewer.blockExclusionIds,
  };
}

// ── Feed Algorithms ────────────────────────────────────────────────────────────

/**
 * Algorithmic "For You" feed.
 *
 * Scoring is performed in MongoDB aggregation to avoid loading large candidate
 * sets into memory. The score uses:
 * - recency (0.25): newer recipes score higher
 * - engagement (0.25): normalized likes + weighted forks
 * - relevance (0.30): dietary/cuisine/label match + followed-by-following
 * - premium boost (0.10): small bonus for premium authors
 * - diversity constant (0.10): simplified constant (stateful windowing not
 *   feasible in aggregation)
 */
export async function forYouFeed(
  userId: Types.ObjectId,
  page: number,
  limit: number
): Promise<PaginatedFeed> {
  const feed = await loadFeedPage(userId, page, () =>
    rankForYou(userId, page, limit)
  );
  return toPaginatedFeed(page, limit, feed);
}

export async function forYouFeedRecipeIds(
  userId: Types.ObjectId,
  limit: number
): Promise<Types.ObjectId[]> {
  const feed = await loadFeedPage(userId, 1, () => rankForYou(userId, 1, limit));
  return feed.docs.map((doc) => doc._id);
}

/**
 * Trending feed — most-engaged recipes from the last 7 days.
 */
export async function trendingFeed(
  userId: Types.ObjectId,
  page: number,
  limit: number
): Promise<PaginatedFeed> {
  const feed = await loadFeedPage(userId, page, () =>
    rankTrending(userId, page, limit)
  );
  return toPaginatedFeed(page, limit, feed);
}

/**
 * Friends feed — recipes from users the current user follows, reverse chrono.
 */
export async function friendsFeed(
  userId: Types.ObjectId,
  page: number,
  limit: number
): Promise<PaginatedFeed> {
  const feed = await loadFeedPage(userId, page, () =>
    rankFriends(userId, page, limit)
  );
  return toPaginatedFeed(page, limit, feed);
}

/**
 * Seasonal feed — recipes tagged with currently active seasonal tags.
 * Falls back to recent popular recipes if no active seasonal tags exist.
 */
export async function seasonalFeed(
  userId: Types.ObjectId,
  page: number,
  limit: number
): Promise<PaginatedFeed> {
  const feed = await loadFeedPage(userId, page, () =>
    rankSeasonal(userId, page, limit)
  );
  return toPaginatedFeed(page, limit, feed);
}
