import { Types, FilterQuery } from "mongoose";
import Cookbook, { ICookbook } from "../models/Cookbook";
import Recipe, { IRecipe } from "../models/Recipe";
import User, { IUser } from "../models/User";
import { canViewProfile, canViewRecipe } from "./visibility-service";
import { isBlocked } from "./block-service";
import { hydrateListForViewer } from "./recipe-service";
import { hasActivePremium } from "../lib/premium";

/** Max cookbooks a free user can own. Premium is unlimited. */
const FREE_TIER_COOKBOOK_LIMIT = 1;

interface AppError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): AppError {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
}

export interface CreateCookbookData {
  name: string;
  description?: string;
  coverPhoto?: string;
  isPrivate?: boolean;
  recipeIds?: string[];
}

export interface UpdateCookbookData {
  name?: string;
  description?: string | null;
  coverPhoto?: string | null;
  isPrivate?: boolean;
}

export interface CookbookFilters {
  label?: string;
  dietaryTag?: string;
  cuisineTag?: string;
  maxCookTime?: number;
  sort?: "newest" | "oldest" | "popular" | "alphabetical";
}

export interface PaginatedCookbooks {
  data: ICookbook[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Verify the requested cookbook exists and the viewer can see it. */
async function loadVisibleCookbook(
  cookbookId: string,
  viewerId: string | null
): Promise<{ cookbook: ICookbook; owner: IUser; isOwner: boolean }> {
  if (!Types.ObjectId.isValid(cookbookId)) {
    throw createError("Invalid cookbook ID", 400);
  }

  const cookbook = await Cookbook.findById(cookbookId);
  if (!cookbook) {
    throw createError("Cookbook not found", 404);
  }

  const owner = await User.findById(cookbook.ownerId);
  if (!owner) {
    throw createError("Cookbook owner not found", 404);
  }

  const isOwner = !!viewerId && cookbook.ownerId.equals(viewerId);

  if (!isOwner) {
    if (cookbook.isPrivate) {
      throw createError("You do not have permission to view this cookbook", 403);
    }
    // Bidirectional block check: either side blocking hides the cookbook.
    // Surface as 404 so the UI doesn't leak the fact that the cookbook
    // exists — identical to how a deleted cookbook responds.
    if (viewerId) {
      const blocked = await isBlocked(viewerId, cookbook.ownerId.toString());
      if (blocked) {
        throw createError("Cookbook not found", 404);
      }
    }
    const canSeeProfile = await canViewProfile(viewerId, owner);
    if (!canSeeProfile) {
      throw createError("You do not have permission to view this cookbook", 403);
    }
  }

  return { cookbook, owner, isOwner };
}

export async function createCookbook(
  ownerId: string,
  data: CreateCookbookData
): Promise<ICookbook> {
  // Free-tier cap: 1 cookbook. Premium = unlimited. We don't denormalize a
  // cookbooksCount on User (cookbook creation is rare), so we read directly
  // from the Cookbook collection. There is a small race window between count
  // and create — acceptable given the low volume of cookbook creation.
  const owner = await User.findById(ownerId)
    .select("isPremium premiumExpiresAt")
    .lean();
  if (!owner) {
    throw createError("User not found", 404);
  }
  if (!hasActivePremium(owner)) {
    const existing = await Cookbook.countDocuments({
      ownerId: new Types.ObjectId(ownerId),
    });
    if (existing >= FREE_TIER_COOKBOOK_LIMIT) {
      throw createError(
        `Free tier cap reached — limited to ${FREE_TIER_COOKBOOK_LIMIT} cookbook. Upgrade to premium for unlimited cookbooks.`,
        403
      );
    }
  }

  const recipeIds = (data.recipeIds ?? [])
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));

  // Only allow recipes owned by the cookbook owner
  let validIds: Types.ObjectId[] = [];
  if (recipeIds.length > 0) {
    const ownedRecipes = await Recipe.find({
      _id: { $in: recipeIds },
      authorId: new Types.ObjectId(ownerId),
    })
      .select("_id")
      .lean();
    validIds = ownedRecipes.map((r) => r._id);
  }

  const cookbook = await Cookbook.create({
    ownerId: new Types.ObjectId(ownerId),
    name: data.name.trim(),
    description: data.description?.trim() || undefined,
    coverPhoto: data.coverPhoto?.trim() || undefined,
    isPrivate: data.isPrivate ?? false,
    recipeIds: validIds,
    recipesCount: validIds.length,
  });

  return cookbook;
}

export async function updateCookbook(
  cookbookId: string,
  userId: string,
  updates: UpdateCookbookData
): Promise<ICookbook> {
  const cookbook = await Cookbook.findById(cookbookId);
  if (!cookbook) {
    throw createError("Cookbook not found", 404);
  }
  if (!cookbook.ownerId.equals(userId)) {
    throw createError("Only the owner can update this cookbook", 403);
  }

  const setFields: Record<string, unknown> = {};
  const unsetFields: Record<string, 1> = {};

  if (updates.name !== undefined) setFields.name = updates.name.trim();
  if (updates.description !== undefined) {
    if (updates.description === null || updates.description.trim() === "") {
      unsetFields.description = 1;
    } else {
      setFields.description = updates.description.trim();
    }
  }
  if (updates.coverPhoto !== undefined) {
    if (updates.coverPhoto === null || updates.coverPhoto.trim() === "") {
      unsetFields.coverPhoto = 1;
    } else {
      setFields.coverPhoto = updates.coverPhoto.trim();
    }
  }
  if (updates.isPrivate !== undefined) setFields.isPrivate = updates.isPrivate;

  const query: Record<string, unknown> = {};
  if (Object.keys(setFields).length > 0) query.$set = setFields;
  if (Object.keys(unsetFields).length > 0) query.$unset = unsetFields;

  const updated = await Cookbook.findByIdAndUpdate(cookbookId, query, {
    new: true,
    runValidators: true,
  });
  if (!updated) throw createError("Cookbook not found", 404);
  return updated;
}

export async function deleteCookbook(
  cookbookId: string,
  userId: string
): Promise<void> {
  const cookbook = await Cookbook.findById(cookbookId);
  if (!cookbook) throw createError("Cookbook not found", 404);
  if (!cookbook.ownerId.equals(userId)) {
    throw createError("Only the owner can delete this cookbook", 403);
  }
  await Cookbook.findByIdAndDelete(cookbookId);
}

export async function listMyCookbooks(
  userId: string,
  page: number,
  limit: number
): Promise<PaginatedCookbooks> {
  const skip = (page - 1) * limit;
  const query: FilterQuery<ICookbook> = { ownerId: new Types.ObjectId(userId) };

  const [data, total] = await Promise.all([
    Cookbook.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<ICookbook[]>(),
    Cookbook.countDocuments(query),
  ]);

  return {
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

/** Public-facing list of another user's cookbooks. Filters out private. */
export async function listUserCookbooks(
  ownerId: string,
  viewerId: string | null,
  page: number,
  limit: number
): Promise<PaginatedCookbooks> {
  if (!Types.ObjectId.isValid(ownerId)) {
    throw createError("Invalid owner ID", 400);
  }

  const owner = await User.findById(ownerId);
  if (!owner) throw createError("User not found", 404);

  const isOwner = !!viewerId && owner._id.equals(viewerId);
  if (!isOwner) {
    // Bidirectional block: return empty rather than 403 so the privacy wall
    // renders identically to "no cookbooks yet".
    if (viewerId) {
      const blocked = await isBlocked(viewerId, owner._id.toString());
      if (blocked) {
        return { data: [], page, limit, total: 0, totalPages: 0 };
      }
    }
    const canSee = await canViewProfile(viewerId, owner);
    if (!canSee) {
      // Mirror profile privacy — return empty rather than 403 so the UI can
      // render the privacy wall consistently.
      return { data: [], page, limit, total: 0, totalPages: 0 };
    }
  }

  const skip = (page - 1) * limit;
  const query: FilterQuery<ICookbook> = {
    ownerId: new Types.ObjectId(ownerId),
  };
  if (!isOwner) query.isPrivate = false;

  const [data, total] = await Promise.all([
    Cookbook.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<ICookbook[]>(),
    Cookbook.countDocuments(query),
  ]);

  return {
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getCookbook(
  cookbookId: string,
  viewerId: string | null
): Promise<ICookbook & { ownerName?: string; ownerPhoto?: string | null }> {
  const { cookbook, owner, isOwner } = await loadVisibleCookbook(
    cookbookId,
    viewerId
  );
  const obj = cookbook.toObject() as unknown as ICookbook & {
    ownerName?: string;
    ownerPhoto?: string | null;
  };
  obj.ownerName = owner.fullName;
  obj.ownerPhoto = owner.profilePicture ?? null;

  // Owners see everything; non-owners must never learn the IDs of private
  // recipes inside a cookbook. Filter `recipeIds` to the subset the viewer is
  // actually allowed to see (visibility applied per-recipe via canViewRecipe).
  // Mutate only the returned plain object, never the Mongoose document.
  if (!isOwner && cookbook.recipeIds.length > 0) {
    const recipes = await Recipe.find({
      _id: { $in: cookbook.recipeIds },
    })
      .select("_id authorId isPrivate")
      .lean<
        { _id: Types.ObjectId; authorId: Types.ObjectId; isPrivate: boolean }[]
      >();

    const visibleIds: Types.ObjectId[] = [];
    for (const r of recipes) {
      const canSee = await canViewRecipe(viewerId, r, owner);
      if (canSee) visibleIds.push(r._id);
    }
    obj.recipeIds = visibleIds;
  }

  return obj;
}

/** Add one or more recipes to a cookbook. Owner-only; ignores duplicates. */
export async function addRecipesToCookbook(
  cookbookId: string,
  userId: string,
  recipeIds: string[]
): Promise<ICookbook> {
  const cookbook = await Cookbook.findById(cookbookId);
  if (!cookbook) throw createError("Cookbook not found", 404);
  if (!cookbook.ownerId.equals(userId)) {
    throw createError("Only the owner can modify this cookbook", 403);
  }

  const candidateIds = recipeIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (candidateIds.length === 0) return cookbook;

  // Only allow recipes the user owns
  const ownedRecipes = await Recipe.find({
    _id: { $in: candidateIds },
    authorId: new Types.ObjectId(userId),
  })
    .select("_id")
    .lean();
  const ownedIds = ownedRecipes.map((r) => r._id.toString());

  const existing = new Set(cookbook.recipeIds.map((id) => id.toString()));
  const toAdd = ownedIds
    .filter((id) => !existing.has(id))
    .map((id) => new Types.ObjectId(id));
  if (toAdd.length === 0) return cookbook;

  const updated = await Cookbook.findByIdAndUpdate(
    cookbookId,
    {
      $push: { recipeIds: { $each: toAdd } },
      $inc: { recipesCount: toAdd.length },
    },
    { new: true }
  );
  if (!updated) throw createError("Cookbook not found", 404);
  return updated;
}

export async function removeRecipeFromCookbook(
  cookbookId: string,
  userId: string,
  recipeId: string
): Promise<ICookbook> {
  if (!Types.ObjectId.isValid(recipeId)) {
    throw createError("Invalid recipe ID", 400);
  }

  const cookbook = await Cookbook.findById(cookbookId);
  if (!cookbook) throw createError("Cookbook not found", 404);
  if (!cookbook.ownerId.equals(userId)) {
    throw createError("Only the owner can modify this cookbook", 403);
  }

  const target = new Types.ObjectId(recipeId);
  const wasPresent = cookbook.recipeIds.some((id) => id.equals(target));
  if (!wasPresent) return cookbook;

  const updated = await Cookbook.findByIdAndUpdate(
    cookbookId,
    {
      $pull: { recipeIds: target },
      $inc: { recipesCount: -1 },
    },
    { new: true }
  );
  if (!updated) throw createError("Cookbook not found", 404);
  return updated;
}

interface PaginatedCookbookRecipes {
  data: IRecipe[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Returns the recipes inside a cookbook the viewer can see, applying
 * optional filtering. Each recipe still passes its own visibility check
 * (private recipes inside a public cookbook are hidden from non-owners).
 */
export async function listCookbookRecipes(
  cookbookId: string,
  viewerId: string | null,
  page: number,
  limit: number,
  filters: CookbookFilters
): Promise<PaginatedCookbookRecipes> {
  const { cookbook, owner, isOwner } = await loadVisibleCookbook(
    cookbookId,
    viewerId
  );

  if (cookbook.recipeIds.length === 0) {
    return { data: [], page, limit, total: 0, totalPages: 0 };
  }

  const query: FilterQuery<IRecipe> = {
    _id: { $in: cookbook.recipeIds },
  };
  if (!isOwner) query.isPrivate = false;
  if (filters.label) query.labels = filters.label.toLowerCase();
  if (filters.dietaryTag) query.dietaryTags = filters.dietaryTag;
  if (filters.cuisineTag) query.cuisineTags = filters.cuisineTag;
  if (filters.maxCookTime != null) {
    query.totalTime = { $lte: filters.maxCookTime };
  }

  let sortOption: Record<string, 1 | -1>;
  switch (filters.sort) {
    case "oldest":
      sortOption = { createdAt: 1 };
      break;
    case "popular":
      sortOption = { likesCount: -1 };
      break;
    case "alphabetical":
      sortOption = { title: 1 };
      break;
    case "newest":
    default:
      sortOption = { createdAt: -1 };
      break;
  }

  const skip = (page - 1) * limit;
  const [recipes, total] = await Promise.all([
    Recipe.find(query)
      .sort(sortOption)
      .skip(skip)
      .limit(limit)
      .lean<IRecipe[]>(),
    Recipe.countDocuments(query),
  ]);

  // Defence-in-depth: re-check each recipe's visibility for non-owners.
  // (For shared/public accounts this is redundant with the isPrivate filter,
  // but covers private accounts where the owner's profile became invisible.)
  const visible: IRecipe[] = [];
  for (const recipe of recipes) {
    const canSee = isOwner
      ? true
      : await canViewRecipe(viewerId ?? null, recipe, owner);
    if (canSee) visible.push(recipe);
  }

  const hydrated = await hydrateListForViewer(visible, viewerId);

  return {
    data: hydrated,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * For a given recipe, returns the IDs of the cookbooks the current user has
 * placed it into. Used to surface "Already in" state in the add-to-cookbook UI.
 */
export async function listCookbooksContainingRecipe(
  ownerId: string,
  recipeId: string
): Promise<string[]> {
  if (!Types.ObjectId.isValid(recipeId)) return [];
  const cookbooks = await Cookbook.find({
    ownerId: new Types.ObjectId(ownerId),
    recipeIds: new Types.ObjectId(recipeId),
  })
    .select("_id")
    .lean();
  return cookbooks.map((c) => c._id.toString());
}
