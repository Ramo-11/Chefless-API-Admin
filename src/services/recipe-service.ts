import { Types, FilterQuery } from "mongoose";
import Recipe, { IRecipe, IIngredient, IStep } from "../models/Recipe";
import Like from "../models/Like";
import RecipeShare from "../models/RecipeShare";
import User from "../models/User";
import { canViewRecipe } from "./visibility-service";
import { uploadImage } from "../lib/cloudinary";
import {
  notifyRecipeLiked,
  notifyRecipeForked,
  notifyRecipeShared,
} from "./notification-service";

const FREE_TIER_RECIPE_LIMIT = 10;

interface AppError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): AppError {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
}

/** Checks both isPremium flag AND premiumExpiresAt to determine active premium status. */
function hasActivePremium(user: { isPremium: boolean; premiumExpiresAt?: Date | null }): boolean {
  if (!user.isPremium) return false;
  if (!user.premiumExpiresAt) return true; // lifetime or unset expiry
  return new Date(user.premiumExpiresAt) > new Date();
}

// --- Types ---

interface CreateRecipeData {
  title: string;
  description?: string;
  story?: string;
  photos?: string[];
  showSignature?: boolean;
  labels?: string[];
  dietaryTags?: string[];
  cuisineTags?: string[];
  difficulty?: "easy" | "medium" | "hard";
  ingredients?: IIngredient[];
  steps?: IStep[];
  prepTime?: number;
  cookTime?: number;
  servings?: number;
  calories?: number;
  costEstimate?: "budget" | "moderate" | "expensive";
  baseServings?: number;
  isPrivate?: boolean;
}

interface UpdateRecipeData {
  title?: string;
  description?: string | null;
  story?: string | null;
  photos?: string[];
  showSignature?: boolean;
  labels?: string[];
  dietaryTags?: string[];
  cuisineTags?: string[];
  difficulty?: "easy" | "medium" | "hard" | null;
  ingredients?: IIngredient[];
  steps?: IStep[];
  prepTime?: number | null;
  cookTime?: number | null;
  servings?: number | null;
  calories?: number | null;
  costEstimate?: "budget" | "moderate" | "expensive" | null;
  baseServings?: number;
  isPrivate?: boolean;
}

interface RecipeFilters {
  label?: string;
  dietaryTag?: string;
  cuisineTag?: string;
  sort?: "newest" | "oldest" | "popular";
}

interface PaginatedRecipes {
  data: IRecipe[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// --- Helpers ---

function computeTotalTime(prepTime?: number | null, cookTime?: number | null): number | undefined {
  if (prepTime != null && cookTime != null) {
    return prepTime + cookTime;
  }
  if (prepTime != null) return prepTime;
  if (cookTime != null) return cookTime;
  return undefined;
}

/** Fields that constitute recipe "content" — changes to these mark a fork as modified */
const CONTENT_FIELDS: ReadonlyArray<keyof UpdateRecipeData> = [
  "title",
  "description",
  "story",
  "ingredients",
  "steps",
  "prepTime",
  "cookTime",
  "servings",
  "calories",
  "baseServings",
];

// --- Service Functions ---

export async function createRecipe(
  authorId: string,
  data: CreateRecipeData
): Promise<IRecipe> {
  const author = await User.findById(authorId).select("isPremium premiumExpiresAt recipesCount").lean();
  if (!author) {
    throw createError("User not found", 404);
  }

  if (!hasActivePremium(author) && author.recipesCount >= FREE_TIER_RECIPE_LIMIT) {
    throw createError(
      `Free tier is limited to ${FREE_TIER_RECIPE_LIMIT} recipes. Upgrade to premium for unlimited recipes.`,
      403
    );
  }

  const totalTime = computeTotalTime(data.prepTime, data.cookTime);

  const recipe = await Recipe.create({
    authorId: new Types.ObjectId(authorId),
    title: data.title,
    description: data.description,
    story: data.story,
    photos: data.photos ?? [],
    showSignature: data.showSignature ?? false,
    labels: data.labels ?? [],
    dietaryTags: data.dietaryTags ?? [],
    cuisineTags: data.cuisineTags ?? [],
    difficulty: data.difficulty,
    ingredients: data.ingredients ?? [],
    steps: data.steps ?? [],
    prepTime: data.prepTime,
    cookTime: data.cookTime,
    totalTime,
    servings: data.servings,
    calories: data.calories,
    costEstimate: data.costEstimate,
    baseServings: data.baseServings ?? 1,
    isPrivate: data.isPrivate ?? false,
  });

  // Increment user's recipe count atomically
  await User.updateOne(
    { _id: authorId },
    { $inc: { recipesCount: 1 } }
  );

  return recipe;
}

export async function getRecipe(
  recipeId: string,
  requesterId?: string
): Promise<IRecipe> {
  const recipe = await Recipe.findById(recipeId);
  if (!recipe) {
    throw createError("Recipe not found", 404);
  }

  const author = await User.findById(recipe.authorId);
  if (!author) {
    throw createError("Recipe author not found", 404);
  }

  const viewerId = requesterId ? new Types.ObjectId(requesterId) : null;
  const canView = await canViewRecipe(viewerId, recipe, author);

  if (!canView) {
    throw createError("You do not have permission to view this recipe", 403);
  }

  // Attach author info to the response.
  const recipeObj = recipe.toObject() as unknown as Record<string, unknown>;
  recipeObj.authorName = author.fullName;
  recipeObj.authorPhoto = author.profilePicture ?? null;

  // Dynamically populate forkedFrom.authorName to prevent stale names after renames
  const forkedFrom = recipeObj.forkedFrom as { recipeId: Types.ObjectId; authorId: Types.ObjectId; authorName: string } | undefined;
  if (forkedFrom?.authorId) {
    const forkAuthor = await User.findById(forkedFrom.authorId)
      .select("fullName")
      .lean();
    if (forkAuthor) {
      (recipeObj.forkedFrom as Record<string, unknown>).authorName = forkAuthor.fullName;
    }
  }

  // Check if the requester has liked this recipe.
  if (viewerId) {
    const Like = (await import("../models/Like")).default;
    const liked = await Like.exists({
      userId: viewerId,
      recipeId: recipe._id,
    });
    recipeObj.isLiked = !!liked;
  }

  return recipeObj as unknown as IRecipe;
}

export async function updateRecipe(
  recipeId: string,
  userId: string,
  updates: UpdateRecipeData
): Promise<IRecipe> {
  const recipe = await Recipe.findById(recipeId);
  if (!recipe) {
    throw createError("Recipe not found", 404);
  }

  if (!recipe.authorId.equals(userId)) {
    throw createError("Only the author can update this recipe", 403);
  }

  // Build update object, handling null values as unset
  const setFields: Record<string, unknown> = {};
  const unsetFields: Record<string, 1> = {};

  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      unsetFields[key] = 1;
    } else if (value !== undefined) {
      setFields[key] = value;
    }
  }

  // Auto-calculate totalTime
  const newPrepTime = updates.prepTime !== undefined
    ? (updates.prepTime === null ? undefined : updates.prepTime)
    : recipe.prepTime;
  const newCookTime = updates.cookTime !== undefined
    ? (updates.cookTime === null ? undefined : updates.cookTime)
    : recipe.cookTime;
  const totalTime = computeTotalTime(newPrepTime, newCookTime);

  if (totalTime !== undefined) {
    setFields.totalTime = totalTime;
  } else {
    unsetFields.totalTime = 1;
  }

  // If this is a fork and content fields changed, mark as modified
  if (recipe.forkedFrom) {
    const contentChanged = CONTENT_FIELDS.some((field) => updates[field] !== undefined);
    if (contentChanged) {
      setFields.isModifiedFork = true;
    }
  }

  const updateQuery: Record<string, unknown> = {};
  if (Object.keys(setFields).length > 0) {
    updateQuery.$set = setFields;
  }
  if (Object.keys(unsetFields).length > 0) {
    updateQuery.$unset = unsetFields;
  }

  const updatedRecipe = await Recipe.findByIdAndUpdate(
    recipeId,
    updateQuery,
    { new: true, runValidators: true }
  );

  if (!updatedRecipe) {
    throw createError("Recipe not found", 404);
  }

  return updatedRecipe;
}

export async function deleteRecipe(
  recipeId: string,
  userId: string
): Promise<void> {
  const recipe = await Recipe.findById(recipeId);
  if (!recipe) {
    throw createError("Recipe not found", 404);
  }

  if (!recipe.authorId.equals(userId)) {
    throw createError("Only the author can delete this recipe", 403);
  }

  // If this recipe was forked from another, decrement the original's forksCount
  if (recipe.forkedFrom) {
    await Recipe.updateOne(
      { _id: recipe.forkedFrom.recipeId },
      { $inc: { forksCount: -1 } }
    );
  }

  // Delete all likes and shares associated with this recipe
  // Also clear forkedFrom on any recipes that were forked from this one
  await Promise.all([
    Like.deleteMany({ recipeId: recipe._id }),
    RecipeShare.deleteMany({ recipeId: recipe._id }),
    Recipe.updateMany(
      { "forkedFrom.recipeId": recipe._id },
      { $unset: { forkedFrom: 1 } }
    ),
  ]);

  // Delete the recipe
  await Recipe.findByIdAndDelete(recipeId);

  // Decrement author's recipe count atomically
  await User.updateOne(
    { _id: userId },
    { $inc: { recipesCount: -1 } }
  );
}

export async function listMyRecipes(
  userId: string,
  page: number,
  limit: number,
  filters: RecipeFilters
): Promise<PaginatedRecipes> {
  const skip = (page - 1) * limit;
  const query: FilterQuery<IRecipe> = { authorId: new Types.ObjectId(userId) };

  if (filters.label) {
    query.labels = filters.label;
  }
  if (filters.dietaryTag) {
    query.dietaryTags = filters.dietaryTag;
  }
  if (filters.cuisineTag) {
    query.cuisineTags = filters.cuisineTag;
  }

  let sortOption: Record<string, 1 | -1>;
  switch (filters.sort) {
    case "oldest":
      sortOption = { createdAt: 1 };
      break;
    case "popular":
      sortOption = { likesCount: -1 };
      break;
    case "newest":
    default:
      sortOption = { createdAt: -1 };
      break;
  }

  const [data, total] = await Promise.all([
    Recipe.find(query)
      .sort(sortOption)
      .skip(skip)
      .limit(limit)
      .lean<IRecipe[]>(),
    Recipe.countDocuments(query),
  ]);

  return {
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

export async function forkRecipe(
  recipeId: string,
  userId: string
): Promise<IRecipe> {
  const user = await User.findById(userId).select("isPremium premiumExpiresAt recipesCount fullName").lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  if (!hasActivePremium(user) && user.recipesCount >= FREE_TIER_RECIPE_LIMIT) {
    throw createError(
      `Free tier is limited to ${FREE_TIER_RECIPE_LIMIT} recipes. Upgrade to premium for unlimited recipes.`,
      403
    );
  }

  const originalRecipe = await Recipe.findById(recipeId);
  if (!originalRecipe) {
    throw createError("Recipe not found", 404);
  }

  // Check visibility
  const author = await User.findById(originalRecipe.authorId);
  if (!author) {
    throw createError("Recipe author not found", 404);
  }

  const canView = await canViewRecipe(new Types.ObjectId(userId), originalRecipe, author);
  if (!canView) {
    throw createError("You do not have permission to fork this recipe", 403);
  }

  // Cannot fork your own recipe
  if (originalRecipe.authorId.equals(userId)) {
    throw createError("You cannot fork your own recipe", 400);
  }

  // Prevent duplicate forks — one remix per recipe per user
  const existingFork = await Recipe.findOne({
    authorId: new Types.ObjectId(userId),
    "forkedFrom.recipeId": originalRecipe._id,
  }).lean();
  if (existingFork) {
    throw createError("You have already remixed this recipe", 400);
  }

  const totalTime = computeTotalTime(originalRecipe.prepTime, originalRecipe.cookTime);

  const forkedRecipe = await Recipe.create({
    authorId: new Types.ObjectId(userId),
    title: originalRecipe.title,
    description: originalRecipe.description,
    story: originalRecipe.story,
    photos: originalRecipe.photos,
    showSignature: false,
    labels: originalRecipe.labels,
    dietaryTags: originalRecipe.dietaryTags,
    cuisineTags: originalRecipe.cuisineTags,
    difficulty: originalRecipe.difficulty,
    ingredients: originalRecipe.ingredients,
    steps: originalRecipe.steps,
    prepTime: originalRecipe.prepTime,
    cookTime: originalRecipe.cookTime,
    totalTime,
    servings: originalRecipe.servings,
    calories: originalRecipe.calories,
    costEstimate: originalRecipe.costEstimate,
    baseServings: originalRecipe.baseServings,
    forkedFrom: {
      recipeId: originalRecipe._id,
      authorId: originalRecipe.authorId,
      authorName: author.fullName,
    },
    isModifiedFork: false,
    isPrivate: false,
  });

  // Increment forksCount on original recipe and user's recipe count atomically
  await Promise.all([
    Recipe.updateOne(
      { _id: originalRecipe._id },
      { $inc: { forksCount: 1 } }
    ),
    User.updateOne(
      { _id: userId },
      { $inc: { recipesCount: 1 } }
    ),
  ]);

  // Fire-and-forget notification
  notifyRecipeForked(userId, recipeId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`Failed to send recipe_forked notification: ${msg}`);
  });

  return forkedRecipe;
}

export async function duplicateRecipe(
  recipeId: string,
  userId: string
): Promise<IRecipe> {
  const user = await User.findById(userId)
    .select("isPremium premiumExpiresAt recipesCount")
    .lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  if (!hasActivePremium(user) && user.recipesCount >= FREE_TIER_RECIPE_LIMIT) {
    throw createError(
      `Free tier is limited to ${FREE_TIER_RECIPE_LIMIT} recipes. Upgrade to premium for unlimited recipes.`,
      403
    );
  }

  const originalRecipe = await Recipe.findById(recipeId);
  if (!originalRecipe) {
    throw createError("Recipe not found", 404);
  }

  // Can only duplicate your own recipe
  if (!originalRecipe.authorId.equals(userId)) {
    throw createError("You can only duplicate your own recipes", 403);
  }

  const totalTime = computeTotalTime(
    originalRecipe.prepTime,
    originalRecipe.cookTime
  );

  const duplicated = await Recipe.create({
    authorId: new Types.ObjectId(userId),
    title: `${originalRecipe.title} (Copy)`,
    description: originalRecipe.description,
    story: originalRecipe.story,
    photos: originalRecipe.photos,
    showSignature: originalRecipe.showSignature,
    labels: originalRecipe.labels,
    dietaryTags: originalRecipe.dietaryTags,
    cuisineTags: originalRecipe.cuisineTags,
    difficulty: originalRecipe.difficulty,
    ingredients: originalRecipe.ingredients,
    steps: originalRecipe.steps,
    prepTime: originalRecipe.prepTime,
    cookTime: originalRecipe.cookTime,
    totalTime,
    servings: originalRecipe.servings,
    calories: originalRecipe.calories,
    costEstimate: originalRecipe.costEstimate,
    baseServings: originalRecipe.baseServings,
    isPrivate: originalRecipe.isPrivate,
  });

  // Increment user's recipe count
  await User.updateOne({ _id: userId }, { $inc: { recipesCount: 1 } });

  return duplicated;
}

export async function likeRecipe(
  recipeId: string,
  userId: string
): Promise<void> {
  const recipe = await Recipe.findById(recipeId);
  if (!recipe) {
    throw createError("Recipe not found", 404);
  }

  // Check visibility before allowing like
  const author = await User.findById(recipe.authorId);
  if (!author) {
    throw createError("Recipe author not found", 404);
  }

  const canView = await canViewRecipe(new Types.ObjectId(userId), recipe, author);
  if (!canView) {
    throw createError("You do not have permission to like this recipe", 403);
  }

  try {
    await Like.create({
      userId: new Types.ObjectId(userId),
      recipeId: new Types.ObjectId(recipeId),
    });

    // Increment likesCount atomically
    await Recipe.updateOne(
      { _id: recipeId },
      { $inc: { likesCount: 1 } }
    );

    // Fire-and-forget notification
    notifyRecipeLiked(userId, recipeId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send recipe_liked notification: ${msg}`);
    });
  } catch (err: unknown) {
    // Duplicate key error means already liked — idempotent success
    if (
      err instanceof Error &&
      "code" in err &&
      (err as Error & { code: number }).code === 11000
    ) {
      return;
    }
    throw err;
  }
}

export async function unlikeRecipe(
  recipeId: string,
  userId: string
): Promise<void> {
  const result = await Like.findOneAndDelete({
    userId: new Types.ObjectId(userId),
    recipeId: new Types.ObjectId(recipeId),
  });

  if (!result) {
    throw createError("You have not liked this recipe", 404);
  }

  // Decrement likesCount atomically
  await Recipe.updateOne(
    { _id: recipeId },
    { $inc: { likesCount: -1 } }
  );
}

export async function listLikedRecipes(
  userId: string,
  page: number,
  limit: number
): Promise<PaginatedRecipes> {
  const skip = (page - 1) * limit;
  const objectId = new Types.ObjectId(userId);

  const [likes, total] = await Promise.all([
    Like.find({ userId: objectId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Like.countDocuments({ userId: objectId }),
  ]);

  const recipeIds = likes.map((like) => like.recipeId);
  const recipes = await Recipe.find({ _id: { $in: recipeIds } }).lean<IRecipe[]>();

  // Maintain the order from likes (newest liked first)
  const recipeMap = new Map(recipes.map((r) => [r._id.toString(), r]));
  const orderedRecipes = recipeIds
    .map((id) => recipeMap.get(id.toString()))
    .filter((r): r is IRecipe => r !== undefined);

  return {
    data: orderedRecipes,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

export async function listForkedRecipes(
  userId: string,
  page: number,
  limit: number
): Promise<PaginatedRecipes> {
  const skip = (page - 1) * limit;
  const query: FilterQuery<IRecipe> = {
    authorId: new Types.ObjectId(userId),
    forkedFrom: { $exists: true },
  };

  const [data, total] = await Promise.all([
    Recipe.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<IRecipe[]>(),
    Recipe.countDocuments(query),
  ]);

  return {
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

export async function shareRecipe(
  recipeId: string,
  senderId: string,
  recipientId: string,
  message?: string
): Promise<IRecipeShare> {
  if (senderId === recipientId) {
    throw createError("Cannot share a recipe with yourself", 400);
  }

  const recipe = await Recipe.findById(recipeId);
  if (!recipe) {
    throw createError("Recipe not found", 404);
  }

  // Check the sender can view the recipe
  const author = await User.findById(recipe.authorId);
  if (!author) {
    throw createError("Recipe author not found", 404);
  }

  const canView = await canViewRecipe(new Types.ObjectId(senderId), recipe, author);
  if (!canView) {
    throw createError("You do not have permission to share this recipe", 403);
  }

  // Verify recipient exists
  const recipient = await User.findById(recipientId).select("_id").lean();
  if (!recipient) {
    throw createError("Recipient not found", 404);
  }

  const share = await RecipeShare.create({
    senderId: new Types.ObjectId(senderId),
    recipientId: new Types.ObjectId(recipientId),
    recipeId: new Types.ObjectId(recipeId),
    message,
  });

  // Fire-and-forget notification
  notifyRecipeShared(senderId, recipientId, recipeId, message).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`Failed to send recipe_shared notification: ${msg}`);
  });

  return share;
}

import type { IRecipeShare } from "../models/RecipeShare";

export async function uploadRecipePhoto(
  fileData: string,
  folder: string
): Promise<{ publicId: string; secureUrl: string }> {
  const result = await uploadImage(fileData, folder);
  return {
    publicId: result.publicId,
    secureUrl: result.secureUrl,
  };
}
