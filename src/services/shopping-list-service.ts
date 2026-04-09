import { Types } from "mongoose";
import ShoppingList, { IShoppingList } from "../models/ShoppingList";
import ScheduleEntry from "../models/ScheduleEntry";
import Recipe, { IIngredient } from "../models/Recipe";
import User from "../models/User";

interface ServiceError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): ServiceError {
  const error = new Error(message) as ServiceError;
  error.statusCode = statusCode;
  return error;
}

// --- Ingredient Category Mapping ---

const INGREDIENT_CATEGORY_MAP: Record<string, string> = {
  // Meat & Poultry
  chicken: "Meat",
  beef: "Meat",
  lamb: "Meat",
  pork: "Meat",
  turkey: "Meat",
  steak: "Meat",
  sausage: "Meat",
  bacon: "Meat",
  "ground beef": "Meat",
  "ground turkey": "Meat",
  "ground chicken": "Meat",
  veal: "Meat",
  duck: "Meat",

  // Seafood
  salmon: "Seafood",
  shrimp: "Seafood",
  tuna: "Seafood",
  cod: "Seafood",
  tilapia: "Seafood",
  crab: "Seafood",
  lobster: "Seafood",
  fish: "Seafood",
  prawns: "Seafood",

  // Dairy
  milk: "Dairy",
  cheese: "Dairy",
  butter: "Dairy",
  cream: "Dairy",
  yogurt: "Dairy",
  "sour cream": "Dairy",
  "cream cheese": "Dairy",
  mozzarella: "Dairy",
  parmesan: "Dairy",
  cheddar: "Dairy",
  eggs: "Dairy",
  egg: "Dairy",
  "heavy cream": "Dairy",
  "whipping cream": "Dairy",

  // Produce
  onion: "Produce",
  onions: "Produce",
  tomato: "Produce",
  tomatoes: "Produce",
  lettuce: "Produce",
  spinach: "Produce",
  garlic: "Produce",
  ginger: "Produce",
  carrot: "Produce",
  carrots: "Produce",
  potato: "Produce",
  potatoes: "Produce",
  pepper: "Produce",
  peppers: "Produce",
  "bell pepper": "Produce",
  cucumber: "Produce",
  broccoli: "Produce",
  celery: "Produce",
  mushroom: "Produce",
  mushrooms: "Produce",
  avocado: "Produce",
  lemon: "Produce",
  lime: "Produce",
  corn: "Produce",
  zucchini: "Produce",
  cabbage: "Produce",
  kale: "Produce",
  cilantro: "Produce",
  parsley: "Produce",
  basil: "Produce",
  mint: "Produce",
  "green onion": "Produce",
  "green onions": "Produce",
  scallions: "Produce",
  jalapeño: "Produce",
  jalapeno: "Produce",
  banana: "Produce",
  apple: "Produce",
  orange: "Produce",
  berries: "Produce",
  strawberries: "Produce",
  blueberries: "Produce",

  // Pantry
  flour: "Pantry",
  sugar: "Pantry",
  oil: "Pantry",
  "olive oil": "Pantry",
  "vegetable oil": "Pantry",
  "coconut oil": "Pantry",
  salt: "Pantry",
  "black pepper": "Pantry",
  vinegar: "Pantry",
  "soy sauce": "Pantry",
  rice: "Pantry",
  pasta: "Pantry",
  noodles: "Pantry",
  "baking powder": "Pantry",
  "baking soda": "Pantry",
  vanilla: "Pantry",
  "vanilla extract": "Pantry",
  honey: "Pantry",
  "maple syrup": "Pantry",
  "tomato paste": "Pantry",
  "tomato sauce": "Pantry",
  broth: "Pantry",
  "chicken broth": "Pantry",
  "beef broth": "Pantry",
  stock: "Pantry",
  "bread crumbs": "Pantry",
  breadcrumbs: "Pantry",
  cornstarch: "Pantry",

  // Spices
  cumin: "Spices",
  paprika: "Spices",
  "chili powder": "Spices",
  oregano: "Spices",
  thyme: "Spices",
  rosemary: "Spices",
  cinnamon: "Spices",
  nutmeg: "Spices",
  turmeric: "Spices",
  cayenne: "Spices",
  "garlic powder": "Spices",
  "onion powder": "Spices",
  "bay leaf": "Spices",
  "bay leaves": "Spices",
  cloves: "Spices",
  coriander: "Spices",

  // Bakery & Bread
  bread: "Bakery",
  tortilla: "Bakery",
  tortillas: "Bakery",
  pita: "Bakery",
  buns: "Bakery",
  rolls: "Bakery",

  // Canned & Jarred
  "canned tomatoes": "Canned",
  "diced tomatoes": "Canned",
  "crushed tomatoes": "Canned",
  "canned beans": "Canned",
  "black beans": "Canned",
  "kidney beans": "Canned",
  chickpeas: "Canned",
  lentils: "Canned",
  "coconut milk": "Canned",

  // Frozen
  "frozen peas": "Frozen",
  "frozen corn": "Frozen",
  "frozen berries": "Frozen",
};

function categorizeIngredient(name: string): string {
  const lower = name.toLowerCase().trim();

  // Direct match
  if (INGREDIENT_CATEGORY_MAP[lower]) {
    return INGREDIENT_CATEGORY_MAP[lower];
  }

  // Partial match — check if the ingredient name contains a known keyword
  for (const [keyword, category] of Object.entries(INGREDIENT_CATEGORY_MAP)) {
    if (lower.includes(keyword) || keyword.includes(lower)) {
      return category;
    }
  }

  return "Other";
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
    items: (data.items ?? []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      category: item.category ?? categorizeIngredient(item.name),
      isChecked: false,
      addedBy: user._id,
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

export async function getLists(userId: string): Promise<IShoppingList[]> {
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

  return lists;
}

export async function getList(
  listId: string,
  userId: string
): Promise<IShoppingList> {
  const list = await ShoppingList.findById(listId).lean<IShoppingList>();
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list as IShoppingList, userId);
  return list;
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
      unsetFields.kitchenId = 1;
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

  const updated = await ShoppingList.findByIdAndUpdate(
    listId,
    { $pull: { items: { _id: new Types.ObjectId(itemId) } } },
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
  const list = await ShoppingList.findById(listId);
  if (!list) {
    throw createError("Shopping list not found", 404);
  }

  await assertListAccess(list, userId);

  const updated = await ShoppingList.findByIdAndUpdate(
    listId,
    { $pull: { items: { isChecked: true } } },
    { new: true }
  );

  if (!updated) {
    throw createError("Shopping list not found", 404);
  }

  return updated;
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
  const duplicatedItems = list.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    recipeId: item.recipeId,
    isChecked: false,
    addedBy: user._id,
    category: item.category,
    notes: item.notes,
    imageUrl: item.imageUrl,
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
}

export async function generateFromSchedule(
  userId: string,
  data: GenerateData
): Promise<IShoppingList> {
  const user = await getUserWithKitchen(userId);

  let kitchenId: Types.ObjectId;

  if (data.kitchenId) {
    if (!user.kitchenId || !user.kitchenId.equals(data.kitchenId)) {
      throw createError("You are not a member of this kitchen", 403);
    }
    kitchenId = new Types.ObjectId(data.kitchenId);
  } else if (user.kitchenId) {
    kitchenId = user.kitchenId;
  } else {
    throw createError(
      "You need to be in a kitchen to generate a shopping list from a schedule",
      400
    );
  }

  // 1. Fetch schedule entries with recipes for the date range
  const entries = await ScheduleEntry.find({
    kitchenId,
    date: { $gte: data.startDate, $lte: data.endDate },
    recipeId: { $exists: true, $ne: null },
  }).lean();

  if (entries.length === 0) {
    throw createError(
      "No scheduled recipes found in this date range",
      400
    );
  }

  // 2. Collect unique recipe IDs
  const recipeIds = [
    ...new Set(entries.map((e) => e.recipeId!.toString())),
  ].map((id) => new Types.ObjectId(id));

  // 3. Fetch all recipes with their ingredients
  const recipes = await Recipe.find({ _id: { $in: recipeIds } })
    .select("_id ingredients")
    .lean();

  const recipeMap = new Map(
    recipes.map((r) => [r._id.toString(), r])
  );

  // 4. Count how many times each recipe appears in the schedule
  const recipeCounts = new Map<string, number>();
  for (const entry of entries) {
    const rid = entry.recipeId!.toString();
    recipeCounts.set(rid, (recipeCounts.get(rid) ?? 0) + 1);
  }

  // 5. Combine ingredients: group by normalized name + unit
  const combinedMap = new Map<string, CombinedIngredient>();

  for (const [recipeIdStr, count] of recipeCounts.entries()) {
    const recipe = recipeMap.get(recipeIdStr);
    if (!recipe) continue;

    const recipeObjectId = new Types.ObjectId(recipeIdStr);

    for (const ingredient of recipe.ingredients) {
      const normalizedName = ingredient.name.toLowerCase().trim();
      const normalizedUnit = ingredient.unit.toLowerCase().trim();
      const key = `${normalizedName}|${normalizedUnit}`;

      const existing = combinedMap.get(key);
      if (existing) {
        existing.quantity += ingredient.quantity * count;
        if (!existing.recipeIds.some((id) => id.equals(recipeObjectId))) {
          existing.recipeIds.push(recipeObjectId);
        }
      } else {
        combinedMap.set(key, {
          name: ingredient.name.trim(),
          quantity: ingredient.quantity * count,
          unit: ingredient.unit.trim(),
          recipeIds: [recipeObjectId],
          category: categorizeIngredient(ingredient.name),
        });
      }
    }
  }

  // 6. Build items array
  const items = Array.from(combinedMap.values()).map((combined) => ({
    name: combined.name,
    quantity: combined.quantity,
    unit: combined.unit,
    recipeId: combined.recipeIds[0],
    isChecked: false,
    addedBy: user._id,
    category: combined.category,
  }));

  // 7. Create the shopping list
  const listName =
    data.name ??
    `Week of ${data.startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  const list = await ShoppingList.create({
    kitchenId,
    name: listName,
    items,
    generatedFromSchedule: true,
    scheduleStartDate: data.startDate,
    scheduleEndDate: data.endDate,
  });

  return list;
}
