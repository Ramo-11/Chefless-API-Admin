import { Types, FilterQuery } from "mongoose";
import Recipe, { IRecipe, IIngredient, IStep } from "../models/Recipe";
import Like from "../models/Like";
import SavedRecipe from "../models/SavedRecipe";
import RecipeShare from "../models/RecipeShare";
import User, { IUser } from "../models/User";
import { canViewRecipe } from "./visibility-service";
import { uploadImage } from "../lib/cloudinary";
import {
  notifyRecipeLiked,
  notifyRecipeForked,
  notifyRecipeSaved,
  notifyRecipeShared,
} from "./notification-service";
import { hasActivePremium } from "../lib/premium";

const FREE_TIER_RECIPE_LIMIT = 10;

interface AppError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): AppError {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
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
  tags?: string[];
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
  tags?: string[];
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
  const author = await User.findById(authorId)
    .select("isPremium premiumExpiresAt originalRecipesCount")
    .lean();
  if (!author) {
    throw createError("User not found", 404);
  }

  const originals = author.originalRecipesCount ?? 0;
  if (!hasActivePremium(author) && originals >= FREE_TIER_RECIPE_LIMIT) {
    throw createError(
      `Free tier is limited to ${FREE_TIER_RECIPE_LIMIT} original recipes. Remixes do not count toward this limit. Upgrade to premium for unlimited recipes.`,
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
    tags: data.tags ?? [],
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

  await User.updateOne(
    { _id: authorId },
    { $inc: { recipesCount: 1, originalRecipesCount: 1 } }
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

  const viewerId = requesterId ? new Types.ObjectId(requesterId) : null;
  const forkedFrom = recipe.forkedFrom;

  // Fan out everything that depends on `recipe` in a single round-trip.
  // Previously we awaited author → fork-author → like/save sequentially,
  // adding ~3× the latency. Now they all run in parallel.
  const [author, forkAuthor, liked, saved] = await Promise.all([
    User.findById(recipe.authorId)
      .select("fullName profilePicture signature isPublic kitchenId")
      .lean(),
    forkedFrom?.authorId
      ? User.findById(forkedFrom.authorId).select("fullName").lean()
      : Promise.resolve(null),
    viewerId
      ? Like.exists({ userId: viewerId, recipeId: recipe._id })
      : Promise.resolve(null),
    viewerId
      ? SavedRecipe.exists({ userId: viewerId, recipeId: recipe._id })
      : Promise.resolve(null),
  ]);

  if (!author) {
    throw createError("Recipe author not found", 404);
  }

  const canView = await canViewRecipe(
    viewerId,
    recipe,
    author as unknown as IUser
  );
  if (!canView) {
    throw createError("You do not have permission to view this recipe", 403);
  }

  const recipeObj = recipe.toObject() as unknown as Record<string, unknown>;
  recipeObj.authorName = author.fullName;
  recipeObj.authorPhoto = author.profilePicture ?? null;
  recipeObj.authorSignatureUrl =
    recipe.showSignature && author.signature ? author.signature : null;

  if (forkAuthor && recipeObj.forkedFrom) {
    (recipeObj.forkedFrom as Record<string, unknown>).authorName =
      forkAuthor.fullName;
  }

  if (viewerId) {
    recipeObj.isLiked = !!liked;
    recipeObj.isSaved = !!saved;
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

  // Delete all likes, saves, and shares associated with this recipe
  // Also clear forkedFrom on any recipes that were forked from this one
  await Promise.all([
    Like.deleteMany({ recipeId: recipe._id }),
    SavedRecipe.deleteMany({ recipeId: recipe._id }),
    RecipeShare.deleteMany({ recipeId: recipe._id }),
    Recipe.updateMany(
      { "forkedFrom.recipeId": recipe._id },
      { $unset: { forkedFrom: 1 } }
    ),
  ]);

  // Delete the recipe
  await Recipe.findByIdAndDelete(recipeId);

  await User.updateOne(
    { _id: userId },
    {
      $inc: {
        recipesCount: -1,
        originalRecipesCount: recipe.forkedFrom ? 0 : -1,
      },
    }
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
  const user = await User.findById(userId).select("fullName").lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  const originalRecipe = await Recipe.findById(recipeId);
  if (!originalRecipe) {
    throw createError("Recipe not found", 404);
  }

  if (originalRecipe.authorId.equals(userId)) {
    throw createError("You cannot remix your own recipe", 400);
  }

  // Visibility check + duplicate-fork check in parallel.
  const [author, existingFork] = await Promise.all([
    User.findById(originalRecipe.authorId)
      .select("fullName isPublic kitchenId")
      .lean(),
    Recipe.findOne({
      authorId: new Types.ObjectId(userId),
      "forkedFrom.recipeId": originalRecipe._id,
    })
      .select("_id")
      .lean(),
  ]);

  if (!author) {
    throw createError("Recipe author not found", 404);
  }

  const canView = await canViewRecipe(
    new Types.ObjectId(userId),
    originalRecipe,
    author as unknown as IUser
  );
  if (!canView) {
    throw createError("You do not have permission to remix this recipe", 403);
  }

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
    .select("isPremium premiumExpiresAt originalRecipesCount")
    .lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  const originals = user.originalRecipesCount ?? 0;
  if (!hasActivePremium(user) && originals >= FREE_TIER_RECIPE_LIMIT) {
    throw createError(
      `Free tier is limited to ${FREE_TIER_RECIPE_LIMIT} original recipes. Upgrade to premium for unlimited recipes.`,
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

  await User.updateOne(
    { _id: userId },
    { $inc: { recipesCount: 1, originalRecipesCount: 1 } }
  );

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

  const author = await User.findById(recipe.authorId)
    .select("isPublic kitchenId")
    .lean();
  if (!author) {
    throw createError("Recipe author not found", 404);
  }

  const canView = await canViewRecipe(
    new Types.ObjectId(userId),
    recipe,
    author as unknown as IUser
  );
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

export async function saveRecipe(
  recipeId: string,
  userId: string
): Promise<void> {
  const recipe = await Recipe.findById(recipeId);
  if (!recipe) {
    throw createError("Recipe not found", 404);
  }

  const author = await User.findById(recipe.authorId)
    .select("isPublic kitchenId")
    .lean();
  if (!author) {
    throw createError("Recipe author not found", 404);
  }

  const canView = await canViewRecipe(
    new Types.ObjectId(userId),
    recipe,
    author as unknown as IUser
  );
  if (!canView) {
    throw createError("You do not have permission to save this recipe", 403);
  }

  try {
    await SavedRecipe.create({
      userId: new Types.ObjectId(userId),
      recipeId: new Types.ObjectId(recipeId),
    });

    notifyRecipeSaved(userId, recipeId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send recipe_saved notification: ${msg}`);
    });
  } catch (err: unknown) {
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

export async function unsaveRecipe(
  recipeId: string,
  userId: string
): Promise<void> {
  const result = await SavedRecipe.findOneAndDelete({
    userId: new Types.ObjectId(userId),
    recipeId: new Types.ObjectId(recipeId),
  });

  if (!result) {
    throw createError("You have not saved this recipe", 404);
  }
}

export async function listSavedRecipes(
  userId: string,
  page: number,
  limit: number
): Promise<PaginatedRecipes> {
  const skip = (page - 1) * limit;
  const objectId = new Types.ObjectId(userId);

  const [saved, total] = await Promise.all([
    SavedRecipe.find({ userId: objectId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    SavedRecipe.countDocuments({ userId: objectId }),
  ]);

  const recipeIds = saved.map((s) => s.recipeId);
  const recipes = await Recipe.find({ _id: { $in: recipeIds } }).lean<IRecipe[]>();

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

export interface SharedRecipeItem {
  shareId: string;
  recipeId: string;
  recipeTitle: string;
  recipePhoto: string | null;
  recipeAuthorId: string;
  recipeAuthorName: string | null;
  senderId: string;
  senderName: string | null;
  senderPhoto: string | null;
  message?: string;
  sharedAt: Date;
}

export async function listSharedWithMe(
  userId: string,
  cursor?: string,
  limit = 20
): Promise<{ items: SharedRecipeItem[]; nextCursor: string | null }> {
  const query: Record<string, unknown> = {
    recipientId: new Types.ObjectId(userId),
  };
  if (cursor) {
    query._id = { $lt: new Types.ObjectId(cursor) };
  }

  const shares = await RecipeShare.find(query)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = shares.length > limit;
  const page = hasMore ? shares.slice(0, limit) : shares;
  const nextCursor = hasMore ? String(page[page.length - 1]._id) : null;

  // Gather unique IDs
  const recipeIds = [...new Set(page.map((s) => s.recipeId.toString()))];
  const senderIds = [...new Set(page.map((s) => s.senderId.toString()))];

  // Batch fetch recipes and senders
  const [recipes, senders] = await Promise.all([
    Recipe.find({ _id: { $in: recipeIds } })
      .select("title photos authorId")
      .lean(),
    User.find({ _id: { $in: senderIds } })
      .select("fullName profilePicture")
      .lean(),
  ]);

  const recipeMap = new Map(recipes.map((r) => [r._id.toString(), r]));
  const senderMap = new Map(senders.map((u) => [u._id.toString(), u]));

  // Fetch author names for recipes
  const authorIds = [
    ...new Set(recipes.map((r) => r.authorId.toString())),
  ];
  const authors = await User.find({ _id: { $in: authorIds } })
    .select("fullName")
    .lean();
  const authorMap = new Map(authors.map((a) => [a._id.toString(), a]));

  const items: SharedRecipeItem[] = [];
  for (const share of page) {
    const recipe = recipeMap.get(share.recipeId.toString());
    if (!recipe) continue; // recipe was deleted
    const sender = senderMap.get(share.senderId.toString());
    const author = authorMap.get(recipe.authorId.toString());
    items.push({
      shareId: share._id.toString(),
      recipeId: recipe._id.toString(),
      recipeTitle: recipe.title,
      recipePhoto: recipe.photos?.[0] ?? null,
      recipeAuthorId: recipe.authorId.toString(),
      recipeAuthorName: author?.fullName ?? null,
      senderId: share.senderId.toString(),
      senderName: sender?.fullName ?? null,
      senderPhoto: sender?.profilePicture ?? null,
      message: share.message,
      sharedAt: share.createdAt,
    });
  }

  return { items, nextCursor };
}

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
