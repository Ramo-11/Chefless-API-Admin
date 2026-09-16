import { Types } from "mongoose";
import ShoppingList, {
  IShoppingList,
  IShoppingListItem,
} from "../models/ShoppingList";
import ScheduleEntry from "../models/ScheduleEntry";
import Recipe, { IIngredient } from "../models/Recipe";
import User, { IUser } from "../models/User";
import Kitchen from "../models/Kitchen";
import { deleteImage, publicIdFromUrl } from "../lib/cloudinary";
import { categorizeIngredient, normalizeIngredientKey } from "../lib/ingredients";
import { canViewRecipe } from "./visibility-service";

interface ServiceError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): ServiceError {
  const error = new Error(message) as ServiceError;
  error.statusCode = statusCode;
  return error;
}

// --- Permission helpers ---

async function getUserWithKitchen(
  userId: string
): Promise<{ _id: Types.ObjectId; kitchenId?: Types.ObjectId }> {
  const user = await User.findById(userId).select("_id kitchenId").lean();
  if (!user) {
    throw createError("User not found", 404);
  }
  return user;
}

function effectiveOrder(item: IShoppingListItem, index: number): number {
  return typeof item.order === "number" ? item.order : index;
}

function nextOrder(items: IShoppingListItem[]): number {
  if (items.length === 0) return 0;
  const highest = items.reduce(
    (max, item, index) => Math.max(max, effectiveOrder(item, index)),
    0
  );
  return highest + 1;
}

async function assertListAccess(
  list: IShoppingList,
  userId: string
): Promise<void> {
  if (list.userId && list.userId.equals(userId)) {
    return;
  }

  if (list.kitchenId) {
    const user = await getUserWithKitchen(userId);
    if (user.kitchenId && user.kitchenId.equals(list.kitchenId)) {
      return;
    }
  }

  throw createError("You do not have access to this shopping list", 403);
}

// --- Service Functions ---

interface CreateListData {
  name?: string;
  kitchenId?: string;
  isPrivate?: boolean;
  items?: Array<{
    name: string;
    quantity?: number;
    unit?: string;
    category?: string;
  }>;
}

export async function createList(
  userId: string,
  data: CreateListData
): Promise<IShoppingList> {
  const user = await getUserWithKitchen(userId);

  const listFields: Record<string, unknown> = {
    name: data.name,
    items: (data.items ?? []).map((item, index) => ({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      category: item.category ?? categorizeIngredient(item.name),
      isChecked: false,
      addedBy: user._id,
      order: index,
    })),
    generatedFromSchedule: false,
  };

  // Explicit private list — belongs to this user only
  if (data.isPrivate) {
    listFields.userId = user._id;
  } else if (data.kitchenId) {
    // Explicit kitchen ID — verify membership
    if (!user.kitchenId || !user.kitchenId.equals(data.kitchenId)) {
      throw createError("You are not a member of this kitchen", 403);
    }
    listFields.kitchenId = new Types.ObjectId(data.kitchenId);
  } else if (user.kitchenId) {
    // User is in a kitchen, default to kitchen list
    listFields.kitchenId = user.kitchenId;
  } else {
    // Personal list
    listFields.userId = user._id;
  }

  const list = await ShoppingList.create(listFields);
  return list;
}

export type ShoppingListWithPlanChanged = IShoppingList & { planChanged: boolean };

function resolveStartOfViewerToday(offsetMinutes: number): Date {
  const shifted = new Date(Date.now() + offsetMinutes * 60000);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  );
}

function isPlanLinked(list: IShoppingList): boolean {
  return (
    list.scheduleLinkVersion === 1 &&
    Boolean(list.scheduleStartDate) &&
    Boolean(list.scheduleEndDate) &&
    Boolean(list.kitchenId || list.userId)
  );
}

function computePlanChanged(
  list: IShoppingList,
  ownerRevision: number | undefined,
  startOfViewerToday: Date
): boolean {
  const linked = isPlanLinked(list);
  const notPast = Boolean(
    list.scheduleEndDate && list.scheduleEndDate >= startOfViewerToday
  );
  const stale = (ownerRevision ?? 0) > (list.scheduleRevisionAtSync ?? 0);
  return linked && notPast && stale;
}

async function getOwnerScheduleRevision(scope: {
  kitchenId?: Types.ObjectId;
  userId?: Types.ObjectId;
}): Promise<number> {
  if (scope.kitchenId) {
    const kitchen = await Kitchen.findById(scope.kitchenId)
      .select("_id scheduleRevision")
      .lean();
    return kitchen?.scheduleRevision ?? 0;
  }
  if (scope.userId) {
    const owner = await User.findById(scope.userId)
      .select("_id scheduleRevision")
      .lean();
    return owner?.scheduleRevision ?? 0;
  }
  return 0;
}

async function resolveOwnerRevisions(
  lists: IShoppingList[]
): Promise<Map<string, number>> {
  const userIds = new Set<string>();
  const kitchenIds = new Set<string>();

  for (const list of lists) {
    if (!isPlanLinked(list)) continue;
    if (list.kitchenId) {
      kitchenIds.add(list.kitchenId.toString());
    } else if (list.userId) {
      userIds.add(list.userId.toString());
    }
  }

  const revisions = new Map<string, number>();

  if (userIds.size > 0) {
    const owners = await User.find({ _id: { $in: Array.from(userIds) } })
      .select("_id scheduleRevision")
      .lean();
    for (const owner of owners) {
      revisions.set(owner._id.toString(), owner.scheduleRevision ?? 0);
    }
  }

  if (kitchenIds.size > 0) {
    const owners = await Kitchen.find({ _id: { $in: Array.from(kitchenIds) } })
      .select("_id scheduleRevision")
      .lean();
    for (const owner of owners) {
      revisions.set(owner._id.toString(), owner.scheduleRevision ?? 0);
    }
  }

  return revisions;
}

async function attachPlanChanged(
  lists: IShoppingList[],
  viewerOffsetMinutes?: number
): Promise<ShoppingListWithPlanChanged[]> {
  const startOfViewerToday = resolveStartOfViewerToday(viewerOffsetMinutes ?? 0);
  const revisions = await resolveOwnerRevisions(lists);

  return lists.map((list) => {
    const ownerId = list.kitchenId?.toString() ?? list.userId?.toString();
    const ownerRevision = ownerId ? revisions.get(ownerId) : undefined;
    return {
      ...list,
      planChanged: computePlanChanged(list, ownerRevision, startOfViewerToday),
    } as ShoppingListWithPlanChanged;
  });
}

export async function getLists(
  userId: string,
  viewerOffsetMinutes?: number
): Promise<ShoppingListWithPlanChanged[]> {
  const user = await getUserWithKitchen(userId);

  const conditions: Record<string, unknown>[] = [
    { userId: user._id },
  ];

  if (user.kitchenId) {
    conditions.push({ kitchenId: user.kitchenId });
  }

  const lists = await ShoppingList.find({ $or: conditions })
    .sort({ updatedAt: -1 })
    .lean<IShoppingList[]>();

  return attachPlanChanged(lists, viewerOffsetMinutes);
}

export async function getList(
  listId: string,
  userId: string,
  viewerOffsetMinutes?: number
): Promise<ShoppingListWithPlanChanged> {
  const list = await ShoppingList.findById(listId).lean<IShoppingList>();
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list as IShoppingList, userId);

  const [withPlanChanged] = await attachPlanChanged([list], viewerOffsetMinutes);
  return withPlanChanged;
}

interface UpdateListData {
  name?: string;
  isPrivate?: boolean;
}

export async function updateList(
  listId: string,
  userId: string,
  updates: UpdateListData
): Promise<IShoppingList> {
  const list = await ShoppingList.findById(listId);
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list, userId);

  const setFields: Record<string, unknown> = {};
  const unsetFields: Record<string, 1> = {};

  if (updates.name !== undefined) {
    setFields.name = updates.name;
  }

  if (updates.isPrivate !== undefined) {
    const user = await getUserWithKitchen(userId);
    if (updates.isPrivate) {
      // Make personal — set userId, remove kitchenId
      setFields.userId = user._id;
      setFields.generatedFromSchedule = false;
      unsetFields.kitchenId = 1;
      unsetFields.scheduleLinkVersion = 1;
      unsetFields.scheduleStartDate = 1;
      unsetFields.scheduleEndDate = 1;
      unsetFields.excludedScheduleSourceKeys = 1;
    } else {
      // Make shared — set kitchenId, remove userId
      if (!user.kitchenId) {
        throw createError(
          "You must be in a kitchen to make a list shared",
          400
        );
      }
      setFields.kitchenId = user.kitchenId;
      unsetFields.userId = 1;
    }
  }

  const updateQuery: Record<string, unknown> = {};
  if (Object.keys(setFields).length > 0) {
    updateQuery.$set = setFields;
  }
  if (Object.keys(unsetFields).length > 0) {
    updateQuery.$unset = unsetFields;
  }

  if (Object.keys(updateQuery).length === 0) {
    return list;
  }

  const updated = await ShoppingList.findByIdAndUpdate(
    listId,
    updateQuery,
    { new: true, runValidators: true }
  );

  if (!updated) {
    throw createError("Shopping list not found", 404);
  }

  return updated;
}

export async function deleteList(
  listId: string,
  userId: string
): Promise<void> {
  const list = await ShoppingList.findById(listId);
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list, userId);

  await ShoppingList.findByIdAndDelete(listId);
}

interface AddItemData {
  name: string;
  quantity?: number;
  unit?: string;
  recipeId?: string;
  category?: string;
  notes?: string;
  imageUrl?: string;
}

export async function addItem(
  listId: string,
  userId: string,
  item: AddItemData
): Promise<IShoppingList> {
  const list = await ShoppingList.findById(listId);
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list, userId);

  const MAX_ITEMS = 500;
  if (list.items.length >= MAX_ITEMS) {
    throw createError(`Shopping lists are limited to ${MAX_ITEMS} items.`, 400);
  }

  const newItem = {
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    recipeId: item.recipeId ? new Types.ObjectId(item.recipeId) : undefined,
    isChecked: false,
    addedBy: new Types.ObjectId(userId),
    category: item.category ?? categorizeIngredient(item.name),
    notes: item.notes,
    imageUrl: item.imageUrl,
    order: nextOrder(list.items),
  };

  const updated = await ShoppingList.findByIdAndUpdate(
    listId,
    { $push: { items: newItem } },
    { new: true, runValidators: true }
  );

  if (!updated) {
    throw createError("Shopping list not found", 404);
  }

  return updated;
}

export async function addItems(
  listId: string,
  userId: string,
  items: AddItemData[]
): Promise<IShoppingList> {
  const list = await ShoppingList.findById(listId);
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list, userId);

  const MAX_ITEMS = 500;
  if (list.items.length + items.length > MAX_ITEMS) {
    throw createError(`Shopping lists are limited to ${MAX_ITEMS} items.`, 400);
  }

  const existingByKey = new Map<string, number>();
  list.items.forEach((item, index) => {
    existingByKey.set(itemMergeKey(item.name, item.unit), index);
  });

  const additions: Record<string, unknown>[] = [];
  const increments: Record<string, number> = {};
  let order = nextOrder(list.items);

  for (const item of items) {
    const key = itemMergeKey(item.name, item.unit);
    const existingIndex = existingByKey.get(key);

    if (
      existingIndex !== undefined &&
      typeof item.quantity === "number" &&
      typeof list.items[existingIndex].quantity === "number"
    ) {
      const path = `items.${existingIndex}.quantity`;
      increments[path] = (increments[path] ?? 0) + item.quantity;
      continue;
    }

    additions.push({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      recipeId: item.recipeId ? new Types.ObjectId(item.recipeId) : undefined,
      isChecked: false,
      addedBy: new Types.ObjectId(userId),
      category: item.category ?? categorizeIngredient(item.name),
      notes: item.notes,
      imageUrl: item.imageUrl,
      order: order++,
    });
    existingByKey.set(key, list.items.length + additions.length - 1);
  }

  const update: Record<string, unknown> = {};
  if (additions.length > 0) update.$push = { items: { $each: additions } };
  if (Object.keys(increments).length > 0) update.$inc = increments;

  if (Object.keys(update).length === 0) return list.toObject() as IShoppingList;

  const updated = await ShoppingList.findByIdAndUpdate(listId, update, {
    new: true,
    runValidators: true,
  });

  if (!updated) {
    throw createError("Shopping list not found", 404);
  }

  return updated;
}

function itemMergeKey(name: string, unit?: string | null): string {
  return `${normalizeIngredientKey(name)}|${normalizeIngredientKey(unit ?? "")}`;
}

export async function removeItem(
  listId: string,
  userId: string,
  itemId: string
): Promise<IShoppingList> {
  const list = await ShoppingList.findById(listId);
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list, userId);

  // Delete the item's image from Cloudinary if it has one
  const item = list.items.find((i) => i._id.equals(itemId));
  if (item?.imageUrl) {
    const publicId = publicIdFromUrl(item.imageUrl);
    if (publicId) {
      deleteImage(publicId).catch(() => {});
    }
  }

  const updated = await ShoppingList.findByIdAndUpdate(
    listId,
    {
      $pull: { items: { _id: new Types.ObjectId(itemId) } },
      ...(item?.scheduleSource?.key
        ? { $addToSet: { excludedScheduleSourceKeys: item.scheduleSource.key } }
        : {}),
    },
    { new: true }
  );

  if (!updated) {
    throw createError("Shopping list not found", 404);
  }

  return updated;
}

interface UpdateItemData {
  name?: string;
  quantity?: number | null;
  unit?: string | null;
  category?: string | null;
  notes?: string | null;
  imageUrl?: string | null;
}

export async function updateItem(
  listId: string,
  userId: string,
  itemId: string,
  updates: UpdateItemData
): Promise<IShoppingList> {
  const list = await ShoppingList.findById(listId);
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list, userId);

  const item = list.items.find((i) => i._id.equals(itemId));
  if (!item) {
    throw createError("Item not found in this shopping list", 404);
  }

  const setFields: Record<string, unknown> = {};
  const unsetFields: Record<string, 1> = {};

  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      unsetFields[`items.$.${key}`] = 1;
    } else if (value !== undefined) {
      setFields[`items.$.${key}`] = value;
    }
  }

  const updateQuery: Record<string, unknown> = {};
  if (Object.keys(setFields).length > 0) {
    updateQuery.$set = setFields;
  }
  if (Object.keys(unsetFields).length > 0) {
    updateQuery.$unset = unsetFields;
  }

  if (Object.keys(updateQuery).length === 0) {
    return list;
  }

  const updated = await ShoppingList.findOneAndUpdate(
    { _id: listId, "items._id": new Types.ObjectId(itemId) },
    updateQuery,
    { new: true }
  );

  if (!updated) {
    throw createError("Shopping list not found", 404);
  }

  return updated;
}

export async function clearCompleted(
  listId: string,
  userId: string
): Promise<IShoppingList> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const list = await ShoppingList.findById(listId);
    if (!list) throw createError("Shopping list not found", 404);
    await assertListAccess(list, userId);
    const excludedKeys = list.items
      .filter((item) => item.isChecked && item.scheduleSource)
      .map((item) => item.scheduleSource!.key);
    const updated = await ShoppingList.findOneAndUpdate(
      { _id: listId, revision: list.revision },
      {
        $pull: { items: { isChecked: true } },
        ...(excludedKeys.length > 0
          ? { $addToSet: { excludedScheduleSourceKeys: { $each: excludedKeys } } }
          : {}),
      },
      { new: true }
    );
    if (updated) return updated;
  }
  throw createError("This shopping list changed. Reload it and try again", 409);
}

export async function toggleItem(
  listId: string,
  userId: string,
  itemId: string
): Promise<IShoppingList> {
  const list = await ShoppingList.findById(listId);
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list, userId);

  const item = list.items.find((i) => i._id.equals(itemId));
  if (!item) {
    throw createError("Item not found in this shopping list", 404);
  }

  const updated = await ShoppingList.findOneAndUpdate(
    { _id: listId, "items._id": new Types.ObjectId(itemId) },
    { $set: { "items.$.isChecked": !item.isChecked } },
    { new: true }
  );

  if (!updated) {
    throw createError("Shopping list not found", 404);
  }

  return updated;
}

export async function reorderItems(
  listId: string,
  userId: string,
  itemIds: string[]
): Promise<IShoppingList> {
  const list = await ShoppingList.findById(listId);
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list, userId);

  const currentIds = list.items.map((item) => item._id.toString());
  const requestedIds = new Set(itemIds);

  const isPermutation =
    itemIds.length === currentIds.length &&
    requestedIds.size === itemIds.length &&
    currentIds.every((id) => requestedIds.has(id));

  if (!isPermutation) {
    throw createError(
      "The new order must include every item in this list exactly once",
      400
    );
  }

  const positionById = new Map(itemIds.map((id, index) => [id, index]));

  for (const item of list.items) {
    const position = positionById.get(item._id.toString());
    if (position !== undefined) {
      item.order = position;
    }
  }

  list.revision += 1;
  await list.save();

  return list;
}

export async function duplicateList(
  listId: string,
  userId: string,
  name?: string
): Promise<IShoppingList> {
  const list = await ShoppingList.findById(listId).lean<IShoppingList>();
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list as IShoppingList, userId);

  const user = await getUserWithKitchen(userId);

  // Duplicate items — reset checked state and assign to current user
  const duplicatedItems = list.items.map((item, index) => ({
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    recipeId: item.recipeId,
    isChecked: false,
    addedBy: user._id,
    category: item.category,
    notes: item.notes,
    imageUrl: item.imageUrl,
    order: effectiveOrder(item, index),
  }));

  const listFields: Record<string, unknown> = {
    name: name ?? `${list.name ?? "Untitled"} (copy)`,
    items: duplicatedItems,
    generatedFromSchedule: false,
  };

  // Inherit visibility from original list
  if (list.kitchenId) {
    listFields.kitchenId = list.kitchenId;
  } else {
    listFields.userId = user._id;
  }

  const newList = await ShoppingList.create(listFields);
  return newList;
}

export async function uncheckAll(
  listId: string,
  userId: string
): Promise<IShoppingList> {
  const list = await ShoppingList.findById(listId);
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list, userId);

  const updated = await ShoppingList.findByIdAndUpdate(
    listId,
    { $set: { "items.$[].isChecked": false } },
    { new: true }
  );

  if (!updated) {
    throw createError("Shopping list not found", 404);
  }

  return updated;
}

interface GenerateData {
  kitchenId?: string;
  scope?: "kitchen" | "personal";
  startDate: Date;
  endDate: Date;
  name?: string;
}

interface CombinedIngredient {
  name: string;
  quantity: number;
  unit: string;
  recipeIds: Types.ObjectId[];
  category: string;
  key: string;
  contributions: Array<{
    scheduleEntryId: Types.ObjectId;
    recipeId: Types.ObjectId;
    quantity: number;
  }>;
}

export interface GeneratedShoppingList {
  list: ShoppingListWithPlanChanged;
  meta: {
    /** Number of scheduled recipes that were omitted because they weren't viewable by the whole kitchen. */
    skippedPrivateCount: number;
    added?: number;
    removed?: number;
    updated?: number;
  };
}

async function buildScheduleItems(
  scope: { kitchenId?: Types.ObjectId; userId?: Types.ObjectId },
  startDate: Date,
  endDate: Date,
  userId: Types.ObjectId,
  allowEmpty = false
): Promise<{ items: Array<Record<string, unknown>>; skippedPrivateCount: number }> {
  const entries = await ScheduleEntry.find({
    ...(scope.kitchenId
      ? { kitchenId: scope.kitchenId }
      : { userId: scope.userId, kitchenId: { $exists: false } }),
    date: { $gte: startDate, $lte: endDate },
    recipeId: { $exists: true, $ne: null },
    leftoverOfEntryId: { $exists: false },
  })
    .sort({ _id: 1 })
    .lean();

  if (entries.length === 0) {
    if (allowEmpty) return { items: [], skippedPrivateCount: 0 };
    throw createError("No scheduled recipes found in this date range", 400);
  }

  const recipeIds = [...new Set(entries.map((entry) => entry.recipeId!.toString()))].map(
    (id) => new Types.ObjectId(id)
  );
  const recipes = await Recipe.find({ _id: { $in: recipeIds } })
    .select("_id ingredients servings authorId isPrivate isHidden")
    .lean();
  const authorIds = [...new Set(recipes.map((recipe) => recipe.authorId.toString()))].map(
    (id) => new Types.ObjectId(id)
  );
  const authors = await User.find({ _id: { $in: authorIds } })
    .select("_id isPublic isBanned kitchenId")
    .lean();
  const authorMap = new Map(authors.map((author) => [author._id.toString(), author]));
  const viewableRecipes = scope.kitchenId
    ? recipes.filter((recipe) => {
        const author = authorMap.get(recipe.authorId.toString());
        if (!author || recipe.isPrivate || recipe.isHidden || author.isBanned) return false;
        return Boolean(author.isPublic) || author.kitchenId?.toString() === scope.kitchenId?.toString();
      })
    : (
        await Promise.all(
          recipes.map(async (recipe) => {
            const author = authorMap.get(recipe.authorId.toString());
            if (!author || recipe.isHidden || author.isBanned) return null;
            return (await canViewRecipe(userId, recipe, author as unknown as IUser))
              ? recipe
              : null;
          })
        )
      ).filter((recipe) => recipe !== null) as typeof recipes;
  const recipeMap = new Map(viewableRecipes.map((recipe) => [recipe._id.toString(), recipe]));
  const combinedMap = new Map<string, CombinedIngredient>();

  for (const entry of entries) {
    const recipe = recipeMap.get(entry.recipeId!.toString());
    if (!recipe) continue;
    const ratio = (entry.servings ?? recipe.servings ?? 1) / (recipe.servings ?? 1);
    for (const ingredient of recipe.ingredients) {
      const key = `${normalizeIngredientKey(ingredient.name)}|${normalizeIngredientKey(ingredient.unit)}`;
      const quantity = ingredient.quantity * ratio;
      const existing = combinedMap.get(key);
      if (existing) {
        existing.quantity += quantity;
        existing.contributions.push({ scheduleEntryId: entry._id, recipeId: recipe._id, quantity });
        if (!existing.recipeIds.some((id) => id.equals(recipe._id))) existing.recipeIds.push(recipe._id);
      } else {
        combinedMap.set(key, {
          key,
          name: ingredient.name.trim(),
          quantity,
          unit: ingredient.unit.trim(),
          recipeIds: [recipe._id],
          category: categorizeIngredient(ingredient.name),
          contributions: [{ scheduleEntryId: entry._id, recipeId: recipe._id, quantity }],
        });
      }
    }
  }

  const items = Array.from(combinedMap.values()).map((combined, index) => ({
    name: combined.name,
    quantity: combined.quantity,
    unit: combined.unit,
    recipeId: combined.recipeIds[0],
    isChecked: false,
    addedBy: userId,
    category: combined.category,
    order: index,
    scheduleSource: {
      key: combined.key,
      name: combined.name,
      quantity: combined.quantity,
      unit: combined.unit,
      category: combined.category,
      contributions: combined.contributions,
    },
  }));

  return { items, skippedPrivateCount: recipes.length - viewableRecipes.length };
}

export async function generateFromSchedule(
  userId: string,
  data: GenerateData
): Promise<GeneratedShoppingList> {
  const user = await getUserWithKitchen(userId);

  let scope: { kitchenId?: Types.ObjectId; userId?: Types.ObjectId };

  if (data.scope === "personal") {
    scope = { userId: user._id, kitchenId: undefined };
  } else if (data.kitchenId) {
    if (!user.kitchenId || !user.kitchenId.equals(data.kitchenId)) {
      throw createError("You are not a member of this kitchen", 403);
    }
    scope = { kitchenId: new Types.ObjectId(data.kitchenId) };
  } else if (user.kitchenId) {
    scope = { kitchenId: user.kitchenId };
  } else {
    scope = { userId: user._id, kitchenId: undefined };
  }

  const ownerRevision = await getOwnerScheduleRevision(scope);

  const { items, skippedPrivateCount } = await buildScheduleItems(
    scope,
    data.startDate,
    data.endDate,
    user._id
  );

  // 7. Create the shopping list
  const listName =
    data.name ??
    `Week of ${data.startDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;

  const list = await ShoppingList.create({
    ...(scope.kitchenId ? { kitchenId: scope.kitchenId } : { userId: user._id }),
    name: listName,
    items,
    generatedFromSchedule: true,
    scheduleStartDate: data.startDate,
    scheduleEndDate: data.endDate,
    scheduleLinkVersion: 1,
    revision: 0,
    excludedScheduleSourceKeys: [],
    scheduleRevisionAtSync: ownerRevision,
    scheduleSyncedAt: new Date(),
  });

  const plainList = list.toObject() as IShoppingList;

  return {
    list: {
      ...plainList,
      planChanged: computePlanChanged(plainList, ownerRevision, resolveStartOfViewerToday(0)),
    } as ShoppingListWithPlanChanged,
    meta: { skippedPrivateCount },
  };
}

export async function refreshFromSchedule(
  listId: string,
  userId: string,
  revision: number
): Promise<GeneratedShoppingList> {
  const list = await ShoppingList.findById(listId);
  if (!list) throw createError("Shopping list not found", 404);
  await assertListAccess(list, userId);
  if (
    list.scheduleLinkVersion !== 1 ||
    (!list.kitchenId && !list.userId) ||
    !list.scheduleStartDate ||
    !list.scheduleEndDate
  ) {
    throw createError("This older shopping list cannot be updated from the plan", 409);
  }
  if (list.revision !== revision) {
    throw createError("This shopping list changed. Reload it and try again", 409);
  }

  const scope = list.kitchenId
    ? { kitchenId: list.kitchenId }
    : { userId: list.userId!, kitchenId: undefined };
  const ownerRevision = await getOwnerScheduleRevision(scope);

  const generated = await buildScheduleItems(
    scope,
    list.scheduleStartDate,
    list.scheduleEndDate,
    new Types.ObjectId(userId),
    true
  );
  const desired = new Map(
    generated.items.map((item) => [
      (item.scheduleSource as { key: string }).key,
      item,
    ])
  );
  const excluded = new Set(list.excludedScheduleSourceKeys ?? []);
  const nextItems: Array<Record<string, unknown>> = [];
  let addedCount = 0;
  let removedCount = 0;
  let updatedCount = 0;

  for (const item of list.items) {
    const source = item.scheduleSource;
    if (!source) {
      nextItems.push(
        (item as unknown as { toObject(): Record<string, unknown> }).toObject()
      );
      continue;
    }
    const changed =
      item.name !== source.name ||
      item.quantity !== source.quantity ||
      (item.unit ?? "") !== source.unit ||
      item.category !== source.category;
    if (changed) {
      const detached = (
        item as unknown as { toObject(): Record<string, unknown> }
      ).toObject();
      delete detached.scheduleSource;
      nextItems.push(detached);
      excluded.add(source.key);
      continue;
    }
    const replacement = desired.get(source.key);
    desired.delete(source.key);
    if (!replacement) {
      removedCount += 1;
      continue;
    }
    const replacementSnapshot = replacement as {
      name: string;
      quantity: number;
      unit: string;
      category: string;
    };
    if (
      replacementSnapshot.name !== source.name ||
      replacementSnapshot.quantity !== source.quantity ||
      (replacementSnapshot.unit ?? "") !== source.unit ||
      replacementSnapshot.category !== source.category
    ) {
      updatedCount += 1;
    }
    nextItems.push({
      ...replacement,
      _id: item._id,
      isChecked: item.isChecked,
      notes: item.notes,
      imageUrl: item.imageUrl,
      order: item.order,
    });
  }

  for (const [key, item] of desired) {
    if (!excluded.has(key)) {
      nextItems.push(item);
      addedCount += 1;
    }
  }

  const updated = await ShoppingList.findOneAndUpdate(
    { _id: list._id, revision },
    {
      $set: {
        items: nextItems,
        excludedScheduleSourceKeys: Array.from(excluded),
        scheduleRevisionAtSync: ownerRevision,
        scheduleSyncedAt: new Date(),
      },
      $inc: { revision: 1 },
    },
    { new: true, runValidators: true }
  );
  if (!updated) throw createError("This shopping list changed. Reload it and try again", 409);

  const plainUpdated = updated.toObject() as IShoppingList;

  return {
    list: {
      ...plainUpdated,
      planChanged: computePlanChanged(plainUpdated, ownerRevision, resolveStartOfViewerToday(0)),
    } as ShoppingListWithPlanChanged,
    meta: {
      skippedPrivateCount: generated.skippedPrivateCount,
      added: addedCount,
      removed: removedCount,
      updated: updatedCount,
    },
  };
}
