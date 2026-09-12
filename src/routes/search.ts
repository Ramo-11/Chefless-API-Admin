import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Types, PipelineStage } from "mongoose";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import Recipe from "../models/Recipe";
import Kitchen from "../models/Kitchen";
import { getBlockedUserIds } from "../services/block-service";
import { buildAccessiblePrivateIds } from "../services/visibility-service";
import { computeSpatulaBadge } from "../services/user-service";
import { ALL_KNOWN_CUISINES } from "../lib/cuisines";
import { CANONICAL_DIETS, CANONICAL_MEAL_LABELS } from "../lib/diets";
import {
  buildRecipeSearchStage,
  isAtlasSearchAvailable,
  markAtlasSearchUnavailable,
  RecipeSearchFilters,
} from "../lib/atlas-search";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

const CANONICAL_CUISINES = [...ALL_KNOWN_CUISINES].sort();

const DIFFICULTIES = ["easy", "medium", "hard"] as const;

const SORTS = ["relevance", "newest", "popular", "rating", "quickest"] as const;

function commaList(maxEntries: number, maxLen: number) {
  return z
    .string()
    .optional()
    .transform((val) =>
      val === undefined
        ? undefined
        : val
            .split(",")
            .map((v) => v.trim())
            .filter((v) => v.length > 0)
    )
    .refine((arr) => arr === undefined || arr.length <= maxEntries, {
      message: `Maximum ${maxEntries} entries allowed`,
    })
    .refine(
      (arr) => arr === undefined || arr.every((v) => v.length <= maxLen),
      { message: `Each entry must be at most ${maxLen} characters` }
    );
}

const searchQuerySchema = z.object({
  q: z.string().min(1, "Search query is required").max(100).optional(),
  type: z.enum(["all", "recipes", "users", "kitchens"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cuisines: commaList(20, 40),
  diets: commaList(10, 40),
  labels: commaList(10, 40),
  difficulty: z.enum(DIFFICULTIES).optional(),
  maxTotalTime: z.coerce.number().int().min(1).max(1440).optional(),
  minRating: z.coerce.number().min(1).max(5).optional(),
  sort: z.enum(SORTS).default("relevance"),
});

type SearchQuery = z.infer<typeof searchQuerySchema>;
type SortOption = SearchQuery["sort"];

interface RecipeFilters {
  cuisines?: string[];
  diets?: string[];
  labels?: string[];
  difficulty?: "easy" | "medium" | "hard";
  maxTotalTime?: number;
  minRating?: number;
}

function hasRecipeFilter(filters: RecipeFilters): boolean {
  return Boolean(
    (filters.cuisines && filters.cuisines.length > 0) ||
      (filters.diets && filters.diets.length > 0) ||
      (filters.labels && filters.labels.length > 0) ||
      filters.difficulty ||
      filters.maxTotalTime !== undefined ||
      filters.minRating !== undefined
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

interface RecipeSearchResult {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  photos: string[];
  labels: string[];
  dietaryTags: string[];
  cuisineTags: string[];
  difficulty?: string;
  prepTime?: number;
  cookTime?: number;
  totalTime?: number;
  servings?: number;
  likesCount: number;
  forksCount: number;
  createdAt: Date;
  author: {
    _id: Types.ObjectId;
    fullName: string;
    profilePicture?: string;
  };
}

interface UserSearchResult {
  _id: Types.ObjectId;
  fullName: string;
  profilePicture?: string;
  bio?: string;
  isPublic: boolean;
  recipesCount: number;
  followersCount: number;
  spatulaBadge: string | null;
}

interface KitchenSearchResult {
  _id: Types.ObjectId;
  name: string;
  photo?: string;
  memberCount: number;
  lead: {
    _id: Types.ObjectId;
    fullName: string;
    profilePicture?: string;
  };
}

async function getBlockExclusionIds(
  viewerId: Types.ObjectId
): Promise<Types.ObjectId[]> {
  return getBlockedUserIds(viewerId.toString());
}

function buildRecipeVisibilityStages(
  viewerId: Types.ObjectId,
  accessiblePrivateIds: Types.ObjectId[]
): Record<string, unknown>[] {
  const orClauses: Record<string, unknown>[] = [
    { authorId: viewerId },
    { isPrivate: false, "_author.isPublic": true },
  ];

  if (accessiblePrivateIds.length > 0) {
    orClauses.push({
      isPrivate: false,
      authorId: { $in: accessiblePrivateIds },
    });
  }

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
        $or: orClauses,
      },
    },
    { $project: { _author: 0 } },
  ];
}

function buildRecipeFilterClauses(
  filters: RecipeFilters
): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [];

  if (filters.cuisines && filters.cuisines.length > 0) {
    clauses.push({
      $or: filters.cuisines.map((c) => ({
        cuisineTags: { $regex: `^${escapeRegex(c)}$`, $options: "i" },
      })),
    });
  }

  if (filters.diets && filters.diets.length > 0) {
    for (const diet of filters.diets) {
      clauses.push({
        dietaryTags: { $regex: `^${escapeRegex(diet)}$`, $options: "i" },
      });
    }
  }

  if (filters.difficulty) {
    clauses.push({ difficulty: filters.difficulty });
  }

  if (filters.minRating !== undefined) {
    clauses.push({
      avgRating: { $gte: filters.minRating },
      ratingCount: { $gt: 0 },
    });
  }

  return clauses;
}

function buildLabelsFilterClause(
  labels: string[] | undefined
): Record<string, unknown> | null {
  if (!labels || labels.length === 0) return null;

  return {
    $or: labels.flatMap((label) => {
      const pattern = `^${escapeRegex(label)}$`;
      return [
        { labels: { $regex: pattern, $options: "i" } },
        { tags: { $regex: pattern, $options: "i" } },
      ];
    }),
  };
}

function isSetExpr(field: string): Record<string, unknown> {
  return { $ne: [{ $ifNull: [field, null] }, null] };
}

const EFFECTIVE_TIME_FIELDS = {
  _hasTimeInfo: {
    $or: [
      isSetExpr("$totalTime"),
      isSetExpr("$prepTime"),
      isSetExpr("$cookTime"),
    ],
  },
  _effectiveTime: {
    $cond: [
      isSetExpr("$totalTime"),
      "$totalTime",
      {
        $cond: [
          { $or: [isSetExpr("$prepTime"), isSetExpr("$cookTime")] },
          {
            $add: [{ $ifNull: ["$prepTime", 0] }, { $ifNull: ["$cookTime", 0] }],
          },
          null,
        ],
      },
    ],
  },
};

function buildRecipeSortStage(
  sort: SortOption,
  hasQuery: boolean
): Record<string, 1 | -1> {
  const effectiveSort = sort === "relevance" && !hasQuery ? "popular" : sort;

  if (effectiveSort === "relevance") {
    return {
      isSeed: 1,
      _relevance: -1,
      likesCount: -1,
      createdAt: -1,
      _id: 1,
    };
  }
  if (effectiveSort === "newest") {
    return { createdAt: -1, _id: 1 };
  }
  if (effectiveSort === "rating") {
    return { avgRating: -1, ratingCount: -1, _id: 1 };
  }
  if (effectiveSort === "quickest") {
    return { _hasTimeInfo: -1, _effectiveTime: 1, _id: 1 };
  }
  return { likesCount: -1, createdAt: -1, _id: 1 };
}

interface SearchRecipesParams {
  query: string | undefined;
  viewerId: Types.ObjectId;
  page: number;
  limit: number;
  blockExclusionIds: Types.ObjectId[];
  filters: RecipeFilters;
  sort: SortOption;
}

async function searchRecipes(
  params: SearchRecipesParams
): Promise<{ recipes: RecipeSearchResult[]; total: number }> {
  const { query, viewerId, page, limit, blockExclusionIds, filters, sort } =
    params;

  const providedQuery = query !== undefined;
  let terms: string[] = [];
  if (providedQuery) {
    terms = parseTerms(query as string);
    if (terms.length === 0) {
      return { recipes: [], total: 0 };
    }
  }
  const hasQuery = providedQuery;

  const escapedTerms = terms.map(escapeRegex);
  const fullQueryEscaped = hasQuery ? escapeRegex((query as string).trim()) : "";

  const atlasSearchFilters: RecipeSearchFilters = {
    cuisines: filters.cuisines,
    diets: filters.diets,
    difficulty: filters.difficulty,
    minRating: filters.minRating,
  };
  const atlasAvailable = await isAtlasSearchAvailable();
  const atlasStage = atlasAvailable
    ? buildRecipeSearchStage({
        query: hasQuery ? (query as string) : undefined,
        filters: atlasSearchFilters,
      })
    : null;

  const accessiblePrivateIds = await buildAccessiblePrivateIds(viewerId);

  const needsEffectiveTime =
    filters.maxTotalTime !== undefined || sort === "quickest";

  const useRelevance = sort === "relevance" && hasQuery;

  function buildPipeline(useSearchStage: boolean): Record<string, unknown>[] {
    const andClauses: Record<string, unknown>[] = [];

    if (hasQuery && !useSearchStage) {
      andClauses.push(
        ...escapedTerms.map((term) => ({
          $or: [
            { title: { $regex: term, $options: "i" } },
            { description: { $regex: term, $options: "i" } },
            { "ingredients.name": { $regex: term, $options: "i" } },
            { dietaryTags: { $regex: term, $options: "i" } },
            { cuisineTags: { $regex: term, $options: "i" } },
            { tags: { $regex: term, $options: "i" } },
            { labels: { $regex: term, $options: "i" } },
          ],
        }))
      );
    }

    andClauses.push(...buildRecipeFilterClauses(filters));

    const initialMatch: Record<string, unknown> = { isHidden: { $ne: true } };
    if (blockExclusionIds.length > 0) {
      initialMatch.authorId = { $nin: blockExclusionIds };
    }
    if (andClauses.length > 0) {
      initialMatch.$and = andClauses;
    }

    const pipeline: Record<string, unknown>[] = [];
    if (useSearchStage && atlasStage) {
      pipeline.push(atlasStage);
    }
    pipeline.push({ $match: initialMatch });

    const labelsClause = buildLabelsFilterClause(filters.labels);
    if (labelsClause) {
      pipeline.push({ $match: labelsClause });
    }

    if (needsEffectiveTime) {
      pipeline.push({ $addFields: EFFECTIVE_TIME_FIELDS });
    }

    if (filters.maxTotalTime !== undefined) {
      pipeline.push({
        $match: {
          _effectiveTime: { $ne: null, $lte: filters.maxTotalTime },
        },
      });
    }

    pipeline.push(
      ...buildRecipeVisibilityStages(viewerId, accessiblePrivateIds)
    );

    if (useRelevance) {
      if (useSearchStage && atlasStage) {
        pipeline.push({
          $addFields: { _relevance: { $meta: "searchScore" } },
        });
      } else {
        pipeline.push({
          $addFields: {
            _relevance: {
              $sum: [
                {
                  $cond: [
                    {
                      $regexMatch: {
                        input: "$title",
                        regex: fullQueryEscaped,
                        options: "i",
                      },
                    },
                    100,
                    0,
                  ],
                },
                {
                  $cond: [
                    {
                      $regexMatch: {
                        input: "$title",
                        regex: `^${escapedTerms[0]}`,
                        options: "i",
                      },
                    },
                    50,
                    0,
                  ],
                },
                {
                  $multiply: [
                    {
                      $ln: {
                        $add: [{ $add: ["$likesCount", "$forksCount"] }, 2],
                      },
                    },
                    5,
                  ],
                },
              ],
            },
          },
        });
      }
    }

    pipeline.push({
      $facet: {
        results: [
          { $sort: buildRecipeSortStage(sort, hasQuery) },
          { $limit: Math.min(page * limit, 1000) },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              title: 1,
              description: 1,
              photos: 1,
              labels: 1,
              dietaryTags: 1,
              cuisineTags: 1,
              difficulty: 1,
              prepTime: 1,
              cookTime: 1,
              totalTime: 1,
              servings: 1,
              likesCount: 1,
              forksCount: 1,
              createdAt: 1,
              authorId: 1,
            },
          },
        ],
        count: [{ $limit: 1000 }, { $count: "total" }],
      },
    });

    return pipeline;
  }

  const useAtlasPipeline = Boolean(atlasStage);
  let pipeline = buildPipeline(useAtlasPipeline);
  let result: { results: unknown[]; count: Array<{ total?: number }> };
  try {
    [result] = await Recipe.aggregate(pipeline as unknown as PipelineStage[]);
  } catch (err) {
    if (useAtlasPipeline) {
      markAtlasSearchUnavailable(err);
      pipeline = buildPipeline(false);
      [result] = await Recipe.aggregate(
        pipeline as unknown as PipelineStage[]
      );
    } else {
      throw err;
    }
  }

  const recipes = result.results as Array<
    Record<string, unknown> & { authorId: Types.ObjectId }
  >;
  const total = (result.count[0]?.total as number) ?? 0;

  const authorIds = [...new Set(recipes.map((r) => r.authorId.toString()))];
  const authors = await User.find({ _id: { $in: authorIds } })
    .select("fullName profilePicture")
    .lean();
  const authorMap = new Map(authors.map((a) => [a._id.toString(), a]));

  const results: RecipeSearchResult[] = recipes.map((recipe) => {
    const author = authorMap.get(recipe.authorId.toString());
    return {
      _id: recipe._id as Types.ObjectId,
      title: recipe.title as string,
      description: recipe.description as string | undefined,
      photos: recipe.photos as string[],
      labels: recipe.labels as string[],
      dietaryTags: recipe.dietaryTags as string[],
      cuisineTags: recipe.cuisineTags as string[],
      difficulty: recipe.difficulty as string | undefined,
      prepTime: recipe.prepTime as number | undefined,
      cookTime: recipe.cookTime as number | undefined,
      totalTime: recipe.totalTime as number | undefined,
      servings: recipe.servings as number | undefined,
      likesCount: recipe.likesCount as number,
      forksCount: recipe.forksCount as number,
      createdAt: recipe.createdAt as Date,
      author: {
        _id: author?._id ?? recipe.authorId,
        fullName: author?.fullName ?? "Unknown",
        profilePicture: author?.profilePicture,
      },
    };
  });

  return { recipes: results, total };
}

async function searchUsers(
  query: string,
  viewerId: Types.ObjectId,
  page: number,
  limit: number,
  blockExclusionIds: Types.ObjectId[]
): Promise<{ users: UserSearchResult[]; total: number }> {
  const terms = parseTerms(query);
  if (!terms.length) return { users: [], total: 0 };

  const escapedTerms = terms.map(escapeRegex);
  const fullQueryEscaped = escapeRegex(query.trim());

  const termFilter = {
    $and: escapedTerms.map((term) => ({
      fullName: { $regex: term, $options: "i" },
    })),
  };

  const idExcluder: Record<string, unknown> =
    blockExclusionIds.length > 0
      ? { $nin: [viewerId, ...blockExclusionIds] }
      : { $ne: viewerId };

  const pipeline = [
    {
      $match: {
        $and: [
          termFilter,
          { _id: idExcluder },
          { isBanned: { $ne: true } },
        ],
      },
    },
    {
      $addFields: {
        _relevance: {
          $sum: [
            {
              $cond: [
                {
                  $regexMatch: {
                    input: "$fullName",
                    regex: fullQueryEscaped,
                    options: "i",
                  },
                },
                100,
                0,
              ],
            },
            {
              $cond: [
                {
                  $regexMatch: {
                    input: "$fullName",
                    regex: `^${escapedTerms[0]}`,
                    options: "i",
                  },
                },
                50,
                0,
              ],
            },
            {
              $multiply: [
                { $ln: { $add: ["$followersCount", 2] } },
                3,
              ],
            },
          ],
        },
      },
    },
    {
      $sort: {
        isSeed: 1 as const,
        _relevance: -1 as const,
        followersCount: -1 as const,
      },
    },
    { $limit: Math.min(page * limit, 1000) },
    {
      $facet: {
        results: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              fullName: 1,
              profilePicture: 1,
              bio: 1,
              isPublic: 1,
              recipesCount: 1,
              originalRecipesCount: 1,
              followersCount: 1,
            },
          },
        ],
        count: [{ $count: "total" }],
      },
    },
  ];

  const [result] = await User.aggregate(pipeline);
  const users = result.results as Array<Record<string, unknown>>;
  const total = (result.count[0]?.total as number) ?? 0;

  const results: UserSearchResult[] = users.map((user) => ({
    _id: user._id as Types.ObjectId,
    fullName: user.fullName as string,
    profilePicture: user.profilePicture as string | undefined,
    bio: user.bio as string | undefined,
    isPublic: user.isPublic as boolean,
    recipesCount: user.recipesCount as number,
    followersCount: user.followersCount as number,
    spatulaBadge: computeSpatulaBadge(
      (user.originalRecipesCount as number | undefined) !== undefined &&
        (user.originalRecipesCount as number | undefined) !== null
        ? (user.originalRecipesCount as number)
        : ((user.recipesCount as number) ?? 0)
    ),
  }));

  return { users: results, total };
}

async function searchKitchens(
  query: string,
  viewerId: Types.ObjectId,
  page: number,
  limit: number
): Promise<{ kitchens: KitchenSearchResult[]; total: number }> {
  const terms = parseTerms(query);
  if (!terms.length) return { kitchens: [], total: 0 };

  const escapedTerms = terms.map(escapeRegex);
  const fullQueryEscaped = escapeRegex(query.trim());

  const termFilter = {
    $and: escapedTerms.map((term) => ({
      name: { $regex: term, $options: "i" },
    })),
  };

  const viewer = await User.findById(viewerId).select("kitchenId").lean();

  const visibilityFilter: Record<string, unknown> = viewer?.kitchenId
    ? { $or: [{ isPublic: true }, { _id: viewer.kitchenId }] }
    : { isPublic: true };

  const pipeline = [
    {
      $match: {
        $and: [termFilter, visibilityFilter],
      },
    },
    {
      $addFields: {
        _relevance: {
          $sum: [
            {
              $cond: [
                {
                  $regexMatch: {
                    input: "$name",
                    regex: fullQueryEscaped,
                    options: "i",
                  },
                },
                100,
                0,
              ],
            },
            {
              $cond: [
                {
                  $regexMatch: {
                    input: "$name",
                    regex: `^${escapedTerms[0]}`,
                    options: "i",
                  },
                },
                50,
                0,
              ],
            },
            { $multiply: ["$memberCount", 2] },
          ],
        },
      },
    },
    { $sort: { _relevance: -1 as const, memberCount: -1 as const } },
    { $limit: Math.min(page * limit, 1000) },
    {
      $facet: {
        results: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $lookup: {
              from: "users",
              localField: "leadId",
              foreignField: "_id",
              as: "_lead",
              pipeline: [
                { $project: { fullName: 1, profilePicture: 1 } },
              ],
            },
          },
          {
            $addFields: {
              lead: { $arrayElemAt: ["$_lead", 0] },
            },
          },
          {
            $project: {
              name: 1,
              photo: 1,
              memberCount: 1,
              "lead._id": 1,
              "lead.fullName": 1,
              "lead.profilePicture": 1,
            },
          },
        ],
        count: [{ $count: "total" }],
      },
    },
  ];

  const [result] = await Kitchen.aggregate(pipeline);
  const kitchens = result.results as KitchenSearchResult[];
  const total = (result.count[0]?.total as number) ?? 0;

  return { kitchens, total };
}

router.get(
  "/filters",
  requireAuth,
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json({
      cuisines: CANONICAL_CUISINES,
      diets: [...CANONICAL_DIETS],
      labels: [...CANONICAL_MEAL_LABELS],
      difficulties: [...DIFFICULTIES],
      sorts: [...SORTS],
    });
  })
);

router.get(
  "/",
  requireAuth,
  validate({ query: searchQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const {
      q,
      type,
      page,
      limit,
      cuisines,
      diets,
      labels,
      difficulty,
      maxTotalTime,
      minRating,
      sort,
    } = req.query as unknown as SearchQuery;

    const userId = req.user?.userId;
    if (!userId) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const filters: RecipeFilters = {
      cuisines,
      diets,
      labels,
      difficulty,
      maxTotalTime,
      minRating,
    };
    const browseMode = q === undefined;

    if (
      browseMode &&
      (type === "users" || type === "kitchens" || !hasRecipeFilter(filters))
    ) {
      res.status(400).json({
        error: "Provide a search query or at least one recipe filter",
        code: "SEARCH_EMPTY_QUERY",
      });
      return;
    }

    const viewerId = new Types.ObjectId(userId);
    const blockExclusionIds = await getBlockExclusionIds(viewerId);

    let recipes: RecipeSearchResult[] = [];
    let users: UserSearchResult[] = [];
    let kitchens: KitchenSearchResult[] = [];
    let recipesTotal = 0;
    let usersTotal = 0;
    let kitchensTotal = 0;

    if (browseMode) {
      const recipeResults = await searchRecipes({
        query: undefined,
        viewerId,
        page,
        limit,
        blockExclusionIds,
        filters,
        sort,
      });
      recipes = recipeResults.recipes;
      recipesTotal = recipeResults.total;
    } else if (type === "all") {
      const [recipeResults, userResults, kitchenResults] = await Promise.all([
        searchRecipes({
          query: q,
          viewerId,
          page,
          limit,
          blockExclusionIds,
          filters,
          sort,
        }),
        searchUsers(q as string, viewerId, page, limit, blockExclusionIds),
        searchKitchens(q as string, viewerId, page, limit),
      ]);
      recipes = recipeResults.recipes;
      recipesTotal = recipeResults.total;
      users = userResults.users;
      usersTotal = userResults.total;
      kitchens = kitchenResults.kitchens;
      kitchensTotal = kitchenResults.total;
    } else if (type === "recipes") {
      const recipeResults = await searchRecipes({
        query: q,
        viewerId,
        page,
        limit,
        blockExclusionIds,
        filters,
        sort,
      });
      recipes = recipeResults.recipes;
      recipesTotal = recipeResults.total;
    } else if (type === "users") {
      const userResults = await searchUsers(
        q as string,
        viewerId,
        page,
        limit,
        blockExclusionIds
      );
      users = userResults.users;
      usersTotal = userResults.total;
    } else {
      const kitchenResults = await searchKitchens(
        q as string,
        viewerId,
        page,
        limit
      );
      kitchens = kitchenResults.kitchens;
      kitchensTotal = kitchenResults.total;
    }

    res.status(200).json({
      recipes,
      users,
      kitchens,
      totals: {
        recipes: recipesTotal,
        users: usersTotal,
        kitchens: kitchensTotal,
      },
    });
  })
);

export default router;
