import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { Types, PipelineStage } from "mongoose";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import Recipe from "../models/Recipe";
import Kitchen from "../models/Kitchen";
import Follow from "../models/Follow";
import { computeSpatulaBadge } from "../services/user-service";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

const searchQuerySchema = z.object({
  q: z.string().min(1, "Search query is required").max(100),
  type: z.enum(["all", "recipes", "users", "kitchens"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

type SearchQuery = z.infer<typeof searchQuerySchema>;

// ── Utilities ───────────────────────────────────────────────────────────────

/** Escape regex special characters so user input is treated literally. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split a query string into non-empty terms. */
function parseTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ── Result Interfaces ───────────────────────────────────────────────────────

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

// ── Visibility ──────────────────────────────────────────────────────────────

/**
 * Returns the accessible private author IDs (follows + kitchen members)
 * for the viewer. Does NOT load all public/banned user IDs into memory.
 */
async function buildAccessiblePrivateIds(
  viewerId: Types.ObjectId
): Promise<Types.ObjectId[]> {
  const follows = await Follow.find({
    followerId: viewerId,
    status: "active",
  })
    .select("followingId")
    .lean();
  const followedIds = follows.map((f) => f.followingId);

  const viewer = await User.findById(viewerId).select("kitchenId").lean();
  let kitchenMemberIds: Types.ObjectId[] = [];
  if (viewer?.kitchenId) {
    const members = await User.find({
      kitchenId: viewer.kitchenId,
      _id: { $ne: viewerId },
    })
      .select("_id")
      .lean();
    kitchenMemberIds = members.map((m) => m._id);
  }

  return [...followedIds, ...kitchenMemberIds];
}

/**
 * Returns aggregation pipeline stages that enforce recipe visibility using
 * $lookup on the author document instead of loading all public/banned IDs.
 */
function buildRecipeVisibilityStages(
  viewerId: Types.ObjectId,
  accessiblePrivateIds: Types.ObjectId[]
): Record<string, unknown>[] {
  const orClauses: Record<string, unknown>[] = [
    { authorId: viewerId }, // own recipes (including private)
    { isPrivate: false, "_author.isPublic": true }, // public account
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
        isHidden: { $ne: true },
        $or: orClauses,
      },
    },
    { $project: { _author: 0 } },
  ];
}

// ── Search Functions ────────────────────────────────────────────────────────

async function searchRecipes(
  query: string,
  viewerId: Types.ObjectId,
  page: number,
  limit: number
): Promise<{ recipes: RecipeSearchResult[]; total: number }> {
  const terms = parseTerms(query);
  if (!terms.length) return { recipes: [], total: 0 };

  const escapedTerms = terms.map(escapeRegex);
  const fullQueryEscaped = escapeRegex(query.trim());

  // Every term must match at least one searchable field
  const termFilter = {
    $and: escapedTerms.map((term) => ({
      $or: [
        { title: { $regex: term, $options: "i" } },
        { description: { $regex: term, $options: "i" } },
        { "ingredients.name": { $regex: term, $options: "i" } },
        { dietaryTags: { $regex: term, $options: "i" } },
        { cuisineTags: { $regex: term, $options: "i" } },
      ],
    })),
  };

  const accessiblePrivateIds = await buildAccessiblePrivateIds(viewerId);

  const pipeline = [
    { $match: termFilter },
    // Enforce visibility via $lookup instead of loading all public user IDs
    ...buildRecipeVisibilityStages(viewerId, accessiblePrivateIds),
    // Relevance scoring: title match quality + engagement
    {
      $addFields: {
        _relevance: {
          $sum: [
            // Full query appears in title (highest signal)
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
            // Title starts with the first search term
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
            // Engagement bonus (log-scaled so high-like recipes don't dominate)
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
    },
    { $sort: { _relevance: -1 as const, likesCount: -1 as const, createdAt: -1 as const } },
    // Cap documents flowing into facet to prevent memory exhaustion
    { $limit: Math.min(page * limit, 1000) },
    {
      $facet: {
        results: [
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
        count: [{ $count: "total" }],
      },
    },
  ];

  const [result] = await Recipe.aggregate(pipeline as unknown as PipelineStage[]);
  const recipes = result.results as Array<
    Record<string, unknown> & { authorId: Types.ObjectId }
  >;
  const total = (result.count[0]?.total as number) ?? 0;

  // Populate author info
  const authorIds = [
    ...new Set(recipes.map((r) => r.authorId.toString())),
  ];
  const authors = await User.find({ _id: { $in: authorIds } })
    .select("fullName profilePicture")
    .lean();
  const authorMap = new Map(
    authors.map((a) => [a._id.toString(), a])
  );

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
  limit: number
): Promise<{ users: UserSearchResult[]; total: number }> {
  const terms = parseTerms(query);
  if (!terms.length) return { users: [], total: 0 };

  const escapedTerms = terms.map(escapeRegex);
  const fullQueryEscaped = escapeRegex(query.trim());

  // Search by name only — email is a sensitive field and must not be exposed
  const termFilter = {
    $and: escapedTerms.map((term) => ({
      fullName: { $regex: term, $options: "i" },
    })),
  };

  const pipeline = [
    {
      $match: {
        $and: [
          termFilter,
          { _id: { $ne: viewerId } },
          { isBanned: { $ne: true } },
        ],
      },
    },
    {
      $addFields: {
        _relevance: {
          $sum: [
            // Full name contains full query
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
            // Name starts with first term
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
            // Followers bonus
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
    { $sort: { _relevance: -1 as const, followersCount: -1 as const } },
    // Cap documents flowing into facet to prevent memory exhaustion
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
    spatulaBadge: computeSpatulaBadge((user.recipesCount as number) ?? 0),
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

  // Every term must match the kitchen name
  const termFilter = {
    $and: escapedTerms.map((term) => ({
      name: { $regex: term, $options: "i" },
    })),
  };

  // Show public kitchens + kitchens the viewer belongs to
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
    // Cap documents flowing into facet to prevent memory exhaustion
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

// ── Route Handler ───────────────────────────────────────────────────────────

router.get(
  "/",
  requireAuth,
  validate({ query: searchQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { q, type, page, limit } = req.query as unknown as SearchQuery;

    const firebaseUid = req.user!.uid;
    const currentUser = await User.findOne({ firebaseUid })
      .select("_id")
      .lean();

    if (!currentUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const viewerId = currentUser._id;

    let recipes: RecipeSearchResult[] = [];
    let users: UserSearchResult[] = [];
    let kitchens: KitchenSearchResult[] = [];
    let recipesTotal = 0;
    let usersTotal = 0;
    let kitchensTotal = 0;

    if (type === "all") {
      // Fetch all types in parallel
      const [recipeResults, userResults, kitchenResults] =
        await Promise.all([
          searchRecipes(q, viewerId, page, limit),
          searchUsers(q, viewerId, page, limit),
          searchKitchens(q, viewerId, page, limit),
        ]);
      recipes = recipeResults.recipes;
      recipesTotal = recipeResults.total;
      users = userResults.users;
      usersTotal = userResults.total;
      kitchens = kitchenResults.kitchens;
      kitchensTotal = kitchenResults.total;
    } else if (type === "recipes") {
      const recipeResults = await searchRecipes(q, viewerId, page, limit);
      recipes = recipeResults.recipes;
      recipesTotal = recipeResults.total;
    } else if (type === "users") {
      const userResults = await searchUsers(q, viewerId, page, limit);
      users = userResults.users;
      usersTotal = userResults.total;
    } else {
      const kitchenResults = await searchKitchens(
        q,
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
