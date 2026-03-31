import { Document, Types, PipelineStage } from "mongoose";
import Recipe, { IRecipe } from "../models/Recipe";
import User, { IUser } from "../models/User";
import Follow from "../models/Follow";
import Like from "../models/Like";
import SeasonalTag from "../models/SeasonalTag";

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
  createdAt: Date;
  updatedAt: Date;
  authorName: string;
  authorPhoto?: string;
  isLiked: boolean;
}

interface PaginatedFeed {
  recipes: FeedRecipe[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Returns IDs of users the viewer actively follows.
 */
async function getFollowingIds(
  userId: Types.ObjectId
): Promise<Types.ObjectId[]> {
  const follows = await Follow.find({
    followerId: userId,
    status: "active",
  })
    .select("followingId")
    .lean();
  return follows.map((f) => f.followingId);
}

/**
 * Returns the accessible private author IDs: users this viewer follows or
 * shares a kitchen with. Does NOT load all public user IDs.
 */
async function buildAccessiblePrivateIds(
  userId: Types.ObjectId
): Promise<Types.ObjectId[]> {
  const followingIds = await getFollowingIds(userId);

  const viewer = await User.findById(userId).select("kitchenId").lean();
  let kitchenMemberIds: Types.ObjectId[] = [];
  if (viewer?.kitchenId) {
    const members = await User.find({
      kitchenId: viewer.kitchenId,
      _id: { $ne: userId },
    })
      .select("_id")
      .lean();
    kitchenMemberIds = members.map((m) => m._id);
  }

  return [...followingIds, ...kitchenMemberIds];
}

/**
 * Returns aggregation pipeline stages that filter recipes to only those
 * visible to the viewer, using $lookup to check author.isPublic instead
 * of loading all public user IDs into memory.
 */
function buildVisibilityPipelineStages(
  userId: Types.ObjectId,
  accessiblePrivateIds: Types.ObjectId[]
): Record<string, unknown>[] {
  return [
    {
      $lookup: {
        from: "users",
        localField: "authorId",
        foreignField: "_id",
        as: "_author",
        pipeline: [{ $project: { isPublic: 1, isBanned: 1 } }],
      },
    },
    { $unwind: "$_author" },
    {
      $match: {
        "_author.isBanned": { $ne: true },
        $or: [
          { "_author.isPublic": true },
          ...(accessiblePrivateIds.length > 0
            ? [{ authorId: { $in: accessiblePrivateIds } }]
            : []),
        ],
      },
    },
    { $project: { _author: 0 } },
  ];
}

/** Lean recipe shape returned by Mongoose `.lean()`. */
type LeanRecipe = Omit<IRecipe, keyof Document> & { _id: Types.ObjectId };

/**
 * Enriches lean recipe documents with author info and isLiked status.
 */
async function enrichRecipes(
  recipes: LeanRecipe[],
  userId: Types.ObjectId
): Promise<FeedRecipe[]> {
  if (recipes.length === 0) return [];

  // Fetch authors
  const authorIds = [...new Set(recipes.map((r) => r.authorId.toString()))];
  const authors = await User.find({ _id: { $in: authorIds } })
    .select("fullName profilePicture")
    .lean();
  const authorMap = new Map(
    authors.map((a) => [a._id.toString(), a])
  );

  // Fetch user's likes for these recipes
  const recipeIds = recipes.map((r) => r._id);
  const likes = await Like.find({
    userId,
    recipeId: { $in: recipeIds },
  })
    .select("recipeId")
    .lean();
  const likedSet = new Set(likes.map((l) => l.recipeId.toString()));

  return recipes.map((recipe) => {
    const author = authorMap.get(recipe.authorId.toString());
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
      ingredients: recipe.ingredients,
      steps: recipe.steps,
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
      createdAt: recipe.createdAt,
      updatedAt: recipe.updatedAt,
      authorName: author?.fullName ?? "Unknown",
      authorPhoto: author?.profilePicture,
      isLiked: likedSet.has(recipe._id.toString()),
    };
  });
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
  const accessiblePrivateIds = await buildAccessiblePrivateIds(userId);

  // Fetch user preferences
  const currentUser = await User.findById(userId)
    .select("dietaryPreferences cuisinePreferences")
    .lean();
  const userDietary: string[] = currentUser?.dietaryPreferences ?? [];
  const userCuisine: string[] = currentUser?.cuisinePreferences ?? [];

  // Fetch who the user follows, and who *they* follow (2nd-degree)
  const followingIds = await getFollowingIds(userId);
  let followedByFollowingIds: Types.ObjectId[] = [];
  if (followingIds.length > 0) {
    const secondDegree = await Follow.find({
      followerId: { $in: followingIds },
      status: "active",
    })
      .select("followingId")
      .lean();
    followedByFollowingIds = secondDegree.map((f) => f.followingId);
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const skip = (page - 1) * limit;

  const baseMatch = {
    isPrivate: false,
    isHidden: { $ne: true },
    authorId: { $ne: userId },
    createdAt: { $gte: thirtyDaysAgo },
  };

  // First pass: get maxEngagement for normalization
  const maxResult = await Recipe.aggregate([
    { $match: baseMatch },
    ...buildVisibilityPipelineStages(userId, accessiblePrivateIds),
    {
      $group: {
        _id: null,
        max: {
          $max: { $add: ["$likesCount", { $multiply: ["$forksCount", 3] }] },
        },
      },
    },
  ] as unknown[] as PipelineStage[]);
  const maxEngagement = Math.max(1, (maxResult[0]?.max as number) ?? 0);

  // Second pass: score in aggregation and paginate
  const nowMs = Date.now();

  const pipeline = [
    { $match: baseMatch },
    ...buildVisibilityPipelineStages(userId, accessiblePrivateIds),
    // Join author for premium status
    {
      $lookup: {
        from: "users",
        localField: "authorId",
        foreignField: "_id",
        as: "_authorFull",
        pipeline: [{ $project: { isPremium: 1 } }],
      },
    },
    { $unwind: { path: "$_authorFull", preserveNullAndEmpty: false } },
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
        _premiumBoost: { $cond: ["$_authorFull.isPremium", 0.1, 0] },
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
    { $sort: { _score: -1 } },
    // Paginate via $facet
    {
      $facet: {
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              _daysSince: 0,
              _rawEngagement: 0,
              _recencyScore: 0,
              _engagementScore: 0,
              _relevanceScore: 0,
              _premiumBoost: 0,
              _score: 0,
              _authorFull: 0,
            },
          },
        ],
        total: [{ $count: "n" }],
      },
    },
  ];

  const [result] = await Recipe.aggregate(pipeline as unknown as PipelineStage[]);
  const recipes = (result?.data ?? []) as LeanRecipe[];
  const total = (result?.total[0]?.n ?? 0) as number;

  const enriched = await enrichRecipes(recipes, userId);

  return {
    recipes: enriched,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Trending feed — most-engaged recipes from the last 7 days.
 * Uses aggregation with $lookup to avoid loading all public user IDs.
 */
export async function trendingFeed(
  userId: Types.ObjectId,
  page: number,
  limit: number
): Promise<PaginatedFeed> {
  const accessiblePrivateIds = await buildAccessiblePrivateIds(userId);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const skip = (page - 1) * limit;

  const baseMatch = {
    isPrivate: false,
    isHidden: { $ne: true },
    authorId: { $ne: userId },
    createdAt: { $gte: sevenDaysAgo },
  };

  const [result] = await Recipe.aggregate([
    { $match: baseMatch },
    ...buildVisibilityPipelineStages(userId, accessiblePrivateIds),
    { $sort: { likesCount: -1, forksCount: -1 } },
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: limit }],
        total: [{ $count: "n" }],
      },
    },
  ] as unknown as PipelineStage[]);

  const recipes = (result?.data ?? []) as LeanRecipe[];
  const total = (result?.total[0]?.n ?? 0) as number;

  const enriched = await enrichRecipes(recipes, userId);

  return {
    recipes: enriched,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Friends feed — recipes from users the current user follows, reverse chrono.
 */
export async function friendsFeed(
  userId: Types.ObjectId,
  page: number,
  limit: number
): Promise<PaginatedFeed> {
  const followingIds = await getFollowingIds(userId);
  const skip = (page - 1) * limit;

  if (followingIds.length === 0) {
    return { recipes: [], page, limit, total: 0, totalPages: 0 };
  }

  const filter = {
    authorId: { $in: followingIds },
    isPrivate: false,
    isHidden: { $ne: true },
  };

  const [recipes, total] = await Promise.all([
    Recipe.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Recipe.countDocuments(filter),
  ]);

  const enriched = await enrichRecipes(
    recipes as LeanRecipe[],
    userId
  );

  return {
    recipes: enriched,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
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
  const accessiblePrivateIds = await buildAccessiblePrivateIds(userId);
  const skip = (page - 1) * limit;

  // Find currently active seasonal tags
  const now = new Date();
  const activeTags = await SeasonalTag.find({
    isActive: true,
    startDate: { $lte: now },
    endDate: { $gte: now },
  })
    .select("slug")
    .lean();

  const baseMatch: Record<string, unknown> = {
    isPrivate: false,
    isHidden: { $ne: true },
    authorId: { $ne: userId },
  };

  if (activeTags.length > 0) {
    const slugs = activeTags.map((t) => t.slug);
    baseMatch.labels = { $in: slugs };
  } else {
    // Fallback: recent 14 days
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    baseMatch.createdAt = { $gte: fourteenDaysAgo };
  }

  const [result] = await Recipe.aggregate([
    { $match: baseMatch },
    ...buildVisibilityPipelineStages(userId, accessiblePrivateIds),
    { $sort: { likesCount: -1, createdAt: -1 } },
    {
      $facet: {
        data: [{ $skip: skip }, { $limit: limit }],
        total: [{ $count: "n" }],
      },
    },
  ] as unknown as PipelineStage[]);

  const recipes = (result?.data ?? []) as LeanRecipe[];
  const total = (result?.total[0]?.n ?? 0) as number;

  const enriched = await enrichRecipes(recipes, userId);

  return {
    recipes: enriched,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}
