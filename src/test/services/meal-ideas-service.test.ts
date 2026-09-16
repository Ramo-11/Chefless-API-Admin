import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import User from "../../models/User";
import Recipe from "../../models/Recipe";
import SavedRecipe from "../../models/SavedRecipe";
import ScheduleEntry from "../../models/ScheduleEntry";
import CookedPost from "../../models/CookedPost";
import RecipeRating from "../../models/RecipeRating";
import PantryItem from "../../models/PantryItem";
import Block from "../../models/Block";
import Kitchen from "../../models/Kitchen";
import { createTestRecipe, createTestUser } from "../helpers";
import { normalizeIngredientName } from "../../lib/ingredients";
import {
  getMealIdeas,
  slotMealLabel,
  slotFit,
  canonicalDietaryPreferences,
  matchesDietaryPreferences,
  ideaRankKey,
  MEAL_IDEAS_MAX_LIMIT,
} from "../../services/meal-ideas-service";

const DAY_MS = 24 * 60 * 60 * 1000;
const REF_NOW = new Date("2026-09-30T00:00:00.000Z");

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(date: Date, amount: number): Date {
  return new Date(date.getTime() + amount * DAY_MS);
}

let recipeSeq = 0;

async function makeRecipe(
  authorId: Types.ObjectId,
  overrides: Record<string, unknown> = {}
) {
  recipeSeq += 1;
  return Recipe.create({
    authorId,
    title: `Recipe ${recipeSeq}`,
    baseServings: 2,
    servings: 2,
    isPrivate: false,
    isHidden: false,
    ingredients: [{ name: "Black Pepper", quantity: 1, unit: "tsp" }],
    steps: [{ order: 1, instruction: "Cook" }],
    ...overrides,
  });
}

async function stockPantry(userId: Types.ObjectId, names: string[]) {
  await PantryItem.create(
    names.map((name) => ({
      userId,
      name,
      normalizedName: normalizeIngredientName(name),
      category: "Other",
    }))
  );
}

async function makePremium(userId: Types.ObjectId, premiumExpiresAt?: Date) {
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        isPremium: true,
        ...(premiumExpiresAt ? { premiumExpiresAt } : {}),
      },
    }
  );
}

async function setDietaryPreferences(userId: Types.ObjectId, preferences: string[]) {
  await User.updateOne({ _id: userId }, { $set: { dietaryPreferences: preferences } });
}

async function putInKitchen(userId: Types.ObjectId, kitchenId: Types.ObjectId) {
  await User.updateOne({ _id: userId }, { $set: { kitchenId } });
}

async function createKitchen(leadId: Types.ObjectId, overrides: Record<string, unknown> = {}) {
  return Kitchen.create({
    name: "Test Kitchen",
    leadId,
    inviteCode: new Types.ObjectId().toString(),
    memberCount: 1,
    ...overrides,
  });
}

describe("slotMealLabel", () => {
  it("recognizes a known meal label", () => {
    expect(slotMealLabel("dinner")).toBe("dinner");
  });

  it("normalizes mixed case and surrounding whitespace", () => {
    expect(slotMealLabel("  DiNNer  ")).toBe("dinner");
  });

  it("returns null for a custom slot name", () => {
    expect(slotMealLabel("Iftar")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(slotMealLabel("")).toBeNull();
  });

  it("returns null when no slot is given", () => {
    expect(slotMealLabel(undefined)).toBeNull();
  });
});

describe("slotFit", () => {
  it("returns zero for an explicit label match", () => {
    expect(slotFit({ labels: ["dinner"], tags: [] }, "dinner")).toBe(0);
  });

  it("returns zero for a match found in tags", () => {
    expect(slotFit({ labels: [], tags: ["dinner"] }, "dinner")).toBe(0);
  });

  it("matches case insensitively", () => {
    expect(slotFit({ labels: ["Dinner"], tags: [] }, "dinner")).toBe(0);
  });

  it("gives an unlabeled recipe a fit of one", () => {
    expect(slotFit({ labels: [], tags: [] }, "dinner")).toBe(1);
  });

  it("gives a recipe labeled only for another meal a null fit", () => {
    expect(slotFit({ labels: ["breakfast"], tags: [] }, "dinner")).toBeNull();
  });

  it("gives every recipe a fit of zero for an unknown slot", () => {
    expect(slotFit({ labels: ["breakfast"], tags: [] }, null)).toBe(0);
  });
});

describe("canonicalDietaryPreferences", () => {
  it("canonicalizes case", () => {
    expect(canonicalDietaryPreferences(["halal"])).toEqual(["Halal"]);
  });

  it("drops unknown values such as None", () => {
    expect(canonicalDietaryPreferences(["None"])).toEqual([]);
  });

  it("dedupes preferences that canonicalize to the same value", () => {
    expect(canonicalDietaryPreferences(["Halal", "halal", "HALAL"])).toEqual(["Halal"]);
  });
});

describe("matchesDietaryPreferences", () => {
  it("requires every preference to be present", () => {
    expect(matchesDietaryPreferences(["Halal", "Vegan"], ["Halal", "Vegan"])).toBe(true);
    expect(matchesDietaryPreferences(["Halal"], ["Halal", "Vegan"])).toBe(false);
  });

  it("matches case insensitively", () => {
    expect(matchesDietaryPreferences(["halal"], ["Halal"])).toBe(true);
  });

  it("returns true when there are no preferences to satisfy", () => {
    expect(matchesDietaryPreferences([], [])).toBe(true);
    expect(matchesDietaryPreferences(null, [])).toBe(true);
  });
});

describe("ideaRankKey", () => {
  it("is stable for the same inputs", () => {
    expect(ideaRankKey("user1", "2026-09-16", "recipe1")).toBe(
      ideaRankKey("user1", "2026-09-16", "recipe1")
    );
  });

  it("changes when the date changes", () => {
    expect(ideaRankKey("user1", "2026-09-16", "recipe1")).not.toBe(
      ideaRankKey("user1", "2026-09-17", "recipe1")
    );
  });

  it("changes when the recipe changes", () => {
    expect(ideaRankKey("user1", "2026-09-16", "recipe1")).not.toBe(
      ideaRankKey("user1", "2026-09-16", "recipe2")
    );
  });

  it("matches a manually computed sha256 hex digest of the colon joined input", () => {
    const expected = createHash("sha256")
      .update("user1:2026-09-16:recipe1")
      .digest("hex");
    expect(ideaRankKey("user1", "2026-09-16", "recipe1")).toBe(expected);
  });
});

describe("tier order and reasons", () => {
  it("gives a Premium user with a stocked pantry a pantry idea first, followed by saved and popular ideas", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    await stockPantry(user._id, ["Rice", "Chicken", "Onion"]);

    const pantryAuthor = await createTestUser();
    const pantryRecipe = await makeRecipe(pantryAuthor._id, {
      title: "Pantry Match",
      ingredients: [
        { name: "Rice", quantity: 1, unit: "cup" },
        { name: "Chicken", quantity: 1, unit: "lb" },
      ],
    });

    const savedAuthor = await createTestUser();
    const savedRecipe = await makeRecipe(savedAuthor._id, { title: "Saved Idea" });
    await SavedRecipe.create({ userId: user._id, recipeId: savedRecipe._id });

    const popularAuthor = await createTestUser();
    const popularRecipe = await makeRecipe(popularAuthor._id, { title: "Popular Idea" });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas).toHaveLength(3);
    expect(result.ideas[0].recipe._id).toBe(pantryRecipe._id.toString());
    expect(result.ideas[0].reason).toEqual({
      kind: "pantry",
      haveCount: 2,
      totalCount: 2,
      missingIngredients: [],
    });
    expect(result.ideas[1].recipe._id).toBe(savedRecipe._id.toString());
    expect(result.ideas[1].reason).toEqual({ kind: "saved" });
    expect(result.ideas[2].recipe._id).toBe(popularRecipe._id.toString());
    expect(result.ideas[2].reason).toEqual({ kind: "popular" });
  });
});

describe("premium and pantry gating", () => {
  it("gives a Premium user with only two pantry items no pantry idea", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    await stockPantry(user._id, ["Rice", "Chicken"]);
    await makeRecipe(user._id, {
      title: "Two Item Match",
      ingredients: [
        { name: "Rice", quantity: 1, unit: "cup" },
        { name: "Chicken", quantity: 1, unit: "lb" },
      ],
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.reason.kind === "pantry")).toBe(false);
  });

  it("never offers a pantry idea to a free user even with a fully stocked pantry, and the response never mentions pantry data", async () => {
    const user = await createTestUser();
    await stockPantry(user._id, ["Rice", "Chicken", "Onion"]);
    await makeRecipe(user._id, {
      title: "Free User Match",
      ingredients: [
        { name: "Rice", quantity: 1, unit: "cup" },
        { name: "Chicken", quantity: 1, unit: "lb" },
      ],
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("pantry");
    expect(serialized).not.toContain("haveCount");
  });

  it("treats a Premium user whose premiumExpiresAt already passed as a free user", async () => {
    const user = await createTestUser();
    await makePremium(user._id, new Date(Date.now() - DAY_MS));
    await stockPantry(user._id, ["Rice", "Chicken", "Onion"]);
    await makeRecipe(user._id, {
      title: "Expired Premium Match",
      ingredients: [
        { name: "Rice", quantity: 1, unit: "cup" },
        { name: "Chicken", quantity: 1, unit: "lb" },
      ],
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.reason.kind === "pantry")).toBe(false);
  });
});

describe("pantry match strength", () => {
  it("does not offer a pantry idea when the person has fewer ingredients than are missing", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    await stockPantry(user._id, ["Rice", "Onion", "Garlic"]);
    await makeRecipe(user._id, {
      title: "Mostly Missing",
      ingredients: [
        { name: "Rice", quantity: 1, unit: "cup" },
        { name: "Lobster", quantity: 1, unit: "lb" },
        { name: "Truffle", quantity: 1, unit: "oz" },
      ],
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.reason.kind === "pantry")).toBe(false);
  });
});

describe("pantry tier recency exclusions", () => {
  it("excludes a pantry match whose schedule entry shows it cooked three days ago", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    await stockPantry(user._id, ["Rice", "Chicken", "Onion"]);
    const recipe = await makeRecipe(user._id, {
      title: "Cooked Via Schedule",
      ingredients: [
        { name: "Rice", quantity: 1, unit: "cup" },
        { name: "Chicken", quantity: 1, unit: "lb" },
      ],
    });
    await ScheduleEntry.create({
      userId: user._id,
      date: parseDate("2026-08-01"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
      cookedAt: addDays(REF_NOW, -3),
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
      now: REF_NOW,
    });

    expect(result.ideas.some((idea) => idea.reason.kind === "pantry")).toBe(false);
  });

  it("excludes a pantry match with a cooked post from three days ago", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    await stockPantry(user._id, ["Rice", "Chicken", "Onion"]);
    const recipe = await makeRecipe(user._id, {
      title: "Cooked Via Post",
      ingredients: [
        { name: "Rice", quantity: 1, unit: "cup" },
        { name: "Chicken", quantity: 1, unit: "lb" },
      ],
    });
    await CookedPost.create({
      userId: user._id,
      recipeId: recipe._id,
      recipeTitle: recipe.title,
      photoUrl: "https://example.com/photo.jpg",
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
      now: new Date(Date.now() + 3 * DAY_MS),
    });

    expect(result.ideas.some((idea) => idea.reason.kind === "pantry")).toBe(false);
  });

  it("excludes a pantry match with a rating cooked three days ago", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    await stockPantry(user._id, ["Rice", "Chicken", "Onion"]);
    const recipe = await makeRecipe(user._id, {
      title: "Cooked Via Rating",
      ingredients: [
        { name: "Rice", quantity: 1, unit: "cup" },
        { name: "Chicken", quantity: 1, unit: "lb" },
      ],
    });
    await RecipeRating.create({
      recipeId: recipe._id,
      userId: user._id,
      stars: 5,
      cookedAt: addDays(REF_NOW, -3),
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
      now: REF_NOW,
    });

    expect(result.ideas.some((idea) => idea.reason.kind === "pantry")).toBe(false);
  });

  it("still offers a pantry match cooked ten days ago while the same recency would exclude it from the saved tier", async () => {
    const pantryUser = await createTestUser();
    await makePremium(pantryUser._id);
    await stockPantry(pantryUser._id, ["Rice", "Chicken", "Onion"]);
    const pantryRecipe = await makeRecipe(pantryUser._id, {
      title: "Ten Days Pantry",
      ingredients: [
        { name: "Rice", quantity: 1, unit: "cup" },
        { name: "Chicken", quantity: 1, unit: "lb" },
      ],
    });
    await RecipeRating.create({
      recipeId: pantryRecipe._id,
      userId: pantryUser._id,
      stars: 5,
      cookedAt: addDays(REF_NOW, -10),
    });

    const pantryResult = await getMealIdeas(pantryUser._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
      now: REF_NOW,
    });
    const pantryIdea = pantryResult.ideas.find(
      (idea) => idea.recipe._id === pantryRecipe._id.toString()
    );
    expect(pantryIdea?.reason.kind).toBe("pantry");

    const savedUser = await createTestUser();
    const savedRecipe = await makeRecipe(savedUser._id, { title: "Ten Days Saved" });
    await RecipeRating.create({
      recipeId: savedRecipe._id,
      userId: savedUser._id,
      stars: 5,
      cookedAt: addDays(REF_NOW, -10),
    });

    const savedResult = await getMealIdeas(savedUser._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
      now: REF_NOW,
    });
    expect(
      savedResult.ideas.some((idea) => idea.recipe._id === savedRecipe._id.toString())
    ).toBe(false);
  });
});

describe("saved tier", () => {
  it("offers both the person's own recipe and a recipe they saved, each with kind saved", async () => {
    const user = await createTestUser();
    const ownRecipe = await makeRecipe(user._id, { title: "My Own Recipe" });
    const otherAuthor = await createTestUser();
    const savedRecipe = await makeRecipe(otherAuthor._id, { title: "A Recipe I Saved" });
    await SavedRecipe.create({ userId: user._id, recipeId: savedRecipe._id });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    const ids = result.ideas.map((idea) => idea.recipe._id);
    expect(ids).toContain(ownRecipe._id.toString());
    expect(ids).toContain(savedRecipe._id.toString());
    for (const idea of result.ideas) {
      expect(idea.reason).toEqual({ kind: "saved" });
    }
  });

  it("excludes a saved tier recipe cooked ten days ago but includes one cooked fifteen days ago", async () => {
    const user = await createTestUser();
    const recentRecipe = await makeRecipe(user._id, { title: "Cooked Recently" });
    const olderRecipe = await makeRecipe(user._id, { title: "Cooked A While Ago" });

    await RecipeRating.create({
      recipeId: recentRecipe._id,
      userId: user._id,
      stars: 4,
      cookedAt: addDays(REF_NOW, -10),
    });
    await RecipeRating.create({
      recipeId: olderRecipe._id,
      userId: user._id,
      stars: 4,
      cookedAt: addDays(REF_NOW, -15),
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
      now: REF_NOW,
    });

    const ids = result.ideas.map((idea) => idea.recipe._id);
    expect(ids).not.toContain(recentRecipe._id.toString());
    expect(ids).toContain(olderRecipe._id.toString());
  });

  it("drops a saved recipe from the ideas once it becomes private", async () => {
    const user = await createTestUser();
    const author = await createTestUser();
    const recipe = await makeRecipe(author._id, { title: "Now Private", isPrivate: true });
    await SavedRecipe.create({ userId: user._id, recipeId: recipe._id });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(false);
  });

  it("never offers a hidden saved recipe", async () => {
    const user = await createTestUser();
    const author = await createTestUser();
    const recipe = await makeRecipe(author._id, { title: "Hidden Save", isHidden: true });
    await SavedRecipe.create({ userId: user._id, recipeId: recipe._id });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(false);
  });

  it("never offers a saved recipe authored by someone the person has blocked", async () => {
    const user = await createTestUser();
    const author = await createTestUser();
    const recipe = await makeRecipe(author._id, { title: "Blocked Author Save" });
    await SavedRecipe.create({ userId: user._id, recipeId: recipe._id });
    await Block.create({ blockerId: user._id, blockedId: author._id });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(false);
  });
});

describe("planned exclusion", () => {
  it("excludes a recipe planned six days before or six days after the requested date on a personal plan", async () => {
    const user = await createTestUser();
    const date = parseDate("2026-09-16");
    const before = await makeRecipe(user._id, { title: "Planned Six Before" });
    const after = await makeRecipe(user._id, { title: "Planned Six After" });
    await ScheduleEntry.create({
      userId: user._id,
      date: addDays(date, -6),
      mealSlot: "dinner",
      recipeId: before._id,
      status: "confirmed",
    });
    await ScheduleEntry.create({
      userId: user._id,
      date: addDays(date, 6),
      mealSlot: "dinner",
      recipeId: after._id,
      status: "confirmed",
    });

    const result = await getMealIdeas(user._id.toString(), { date, limit: 3 });

    const ids = result.ideas.map((idea) => idea.recipe._id);
    expect(ids).not.toContain(before._id.toString());
    expect(ids).not.toContain(after._id.toString());
  });

  it("does not exclude a recipe planned seven days before or seven days after the requested date", async () => {
    const user = await createTestUser();
    const date = parseDate("2026-09-16");
    const before = await makeRecipe(user._id, { title: "Planned Seven Before" });
    const after = await makeRecipe(user._id, { title: "Planned Seven After" });
    await ScheduleEntry.create({
      userId: user._id,
      date: addDays(date, -7),
      mealSlot: "dinner",
      recipeId: before._id,
      status: "confirmed",
    });
    await ScheduleEntry.create({
      userId: user._id,
      date: addDays(date, 7),
      mealSlot: "dinner",
      recipeId: after._id,
      status: "confirmed",
    });

    const result = await getMealIdeas(user._id.toString(), { date, limit: 3 });

    const ids = result.ideas.map((idea) => idea.recipe._id);
    expect(ids).toContain(before._id.toString());
    expect(ids).toContain(after._id.toString());
  });

  it("counts a pending kitchen suggestion as planned", async () => {
    const lead = await createTestUser();
    const kitchen = await createKitchen(lead._id);
    await putInKitchen(lead._id, kitchen._id);
    const date = parseDate("2026-09-16");
    const recipe = await makeRecipe(lead._id, { title: "Suggested Meal" });
    await ScheduleEntry.create({
      kitchenId: kitchen._id,
      userId: lead._id,
      date,
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "suggested",
      suggestedBy: lead._id,
    });

    const result = await getMealIdeas(lead._id.toString(), { date, limit: 3 });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(false);
  });

  it("does not let another person's personal plan exclude a recipe", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const date = parseDate("2026-09-16");
    const recipe = await makeRecipe(user._id, { title: "Only Mine" });
    await ScheduleEntry.create({
      userId: other._id,
      date,
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });

    const result = await getMealIdeas(user._id.toString(), { date, limit: 3 });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(true);
  });
});

describe("slot behavior", () => {
  it("never offers a breakfast only recipe for the dinner slot", async () => {
    const user = await createTestUser();
    await makeRecipe(user._id, { title: "Breakfast Only", labels: ["breakfast"] });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      slot: "dinner",
      limit: 3,
    });

    expect(result.ideas).toHaveLength(0);
  });

  it("prefers a recipe labeled for the requested slot over an unlabeled one when only one idea is requested", async () => {
    const user = await createTestUser();
    await makeRecipe(user._id, { title: "No Label" });
    const dinnerLabeled = await makeRecipe(user._id, {
      title: "Dinner Labeled",
      labels: ["dinner"],
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      slot: "dinner",
      limit: 1,
    });

    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0].recipe._id).toBe(dinnerLabeled._id.toString());
  });

  it("treats a Dinner value inside tags the same as a label", async () => {
    const user = await createTestUser();
    const recipe = await makeRecipe(user._id, { title: "Dinner In Tags", tags: ["Dinner"] });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      slot: "dinner",
      limit: 1,
    });

    expect(result.ideas[0]?.recipe._id).toBe(recipe._id.toString());
  });

  it("offers a breakfast only recipe under a custom slot name", async () => {
    const user = await createTestUser();
    const recipe = await makeRecipe(user._id, {
      title: "Breakfast For Iftar",
      labels: ["breakfast"],
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      slot: "Iftar",
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(true);
  });
});

describe("dietary preferences", () => {
  it("excludes a saved recipe missing the required dietary tag", async () => {
    const user = await createTestUser();
    await setDietaryPreferences(user._id, ["Halal"]);
    const author = await createTestUser();
    const recipe = await makeRecipe(author._id, { title: "No Diet Tag" });
    await SavedRecipe.create({ userId: user._id, recipeId: recipe._id });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(false);
  });

  it("includes a saved recipe tagged halal in lowercase", async () => {
    const user = await createTestUser();
    await setDietaryPreferences(user._id, ["Halal"]);
    const author = await createTestUser();
    const recipe = await makeRecipe(author._id, {
      title: "Lowercase Halal",
      dietaryTags: ["halal"],
    });
    await SavedRecipe.create({ userId: user._id, recipeId: recipe._id });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(true);
  });

  it("includes the person's own untagged recipe regardless of their dietary preference", async () => {
    const user = await createTestUser();
    await setDietaryPreferences(user._id, ["Halal"]);
    const recipe = await makeRecipe(user._id, { title: "My Untagged Recipe" });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(true);
  });

  it("excludes a for you recipe missing the required dietary tag", async () => {
    const user = await createTestUser();
    await setDietaryPreferences(user._id, ["Halal"]);
    const author = await createTestUser();
    const recipe = await makeRecipe(author._id, { title: "Popular No Diet Tag" });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(false);
  });

  it("filters nothing when the stored preference is the legacy value None", async () => {
    const user = await createTestUser();
    await setDietaryPreferences(user._id, ["None"]);
    const author = await createTestUser();
    const recipe = await makeRecipe(author._id, { title: "Any Diet Recipe" });
    await SavedRecipe.create({ userId: user._id, recipeId: recipe._id });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(true);
  });
});

describe("popular tier", () => {
  it("fills remaining slots with a public recipe from another author when the recipe book cannot", async () => {
    const user = await createTestUser();
    const author = await createTestUser();
    const recipe = await makeRecipe(author._id, { title: "Discoverable Recipe" });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    const idea = result.ideas.find((i) => i.recipe._id === recipe._id.toString());
    expect(idea?.reason).toEqual({ kind: "popular" });
  });

  it("does not offer a recipe from a private account the viewer does not follow", async () => {
    const user = await createTestUser();
    const privateAuthor = await createTestUser({ isPublic: false });
    const recipe = await makeRecipe(privateAuthor._id, { title: "Private Account Recipe" });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(false);
  });

  it("does not offer a recipe from a blocked author", async () => {
    const user = await createTestUser();
    const blockedAuthor = await createTestUser();
    const recipe = await makeRecipe(blockedAuthor._id, { title: "Blocked Popular Recipe" });
    await Block.create({ blockerId: user._id, blockedId: blockedAuthor._id });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(false);
  });
});

describe("kitchen plan private recipes", () => {
  it("never offers a kitchen member's own private recipe while a shared one is offered", async () => {
    const member = await createTestUser();
    const kitchen = await createKitchen(member._id, { name: "Private Test Kitchen" });
    await putInKitchen(member._id, kitchen._id);
    const privateRecipe = await makeRecipe(member._id, {
      title: "Kitchen Private",
      isPrivate: true,
    });
    const sharedRecipe = await makeRecipe(member._id, {
      title: "Kitchen Shared",
      isPrivate: false,
    });

    const result = await getMealIdeas(member._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    const ids = result.ideas.map((idea) => idea.recipe._id);
    expect(ids).not.toContain(privateRecipe._id.toString());
    expect(ids).toContain(sharedRecipe._id.toString());
  });

  it("offers the same private recipe on a personal plan", async () => {
    const user = await createTestUser();
    const privateRecipe = await makeRecipe(user._id, {
      title: "Personal Private",
      isPrivate: true,
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    const ids = result.ideas.map((idea) => idea.recipe._id);
    expect(ids).toContain(privateRecipe._id.toString());
  });
});

describe("determinism", () => {
  it("returns identical recipe ids in identical order across two calls for the same date", async () => {
    const user = await createTestUser();
    for (let i = 0; i < 5; i += 1) {
      await makeRecipe(user._id, { title: `Deterministic Recipe ${i}` });
    }
    const date = parseDate("2026-09-16");

    const first = await getMealIdeas(user._id.toString(), { date, limit: 3 });
    const second = await getMealIdeas(user._id.toString(), { date, limit: 3 });

    expect(second.ideas.map((idea) => idea.recipe._id)).toEqual(
      first.ideas.map((idea) => idea.recipe._id)
    );
  });

  it("produces a different order on at least two of seven consecutive dates", async () => {
    const user = await createTestUser();
    for (let i = 0; i < 8; i += 1) {
      await makeRecipe(user._id, { title: `Rotating Recipe ${i}` });
    }
    const baseDate = parseDate("2026-09-16");

    const orders: string[][] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const result = await getMealIdeas(user._id.toString(), {
        date: addDays(baseDate, offset),
        limit: 3,
      });
      orders.push(result.ideas.map((idea) => idea.recipe._id));
    }

    const distinctOrders = new Set(orders.map((order) => order.join(",")));
    expect(distinctOrders.size).toBeGreaterThan(1);
  });
});

describe("limit and uniqueness", () => {
  it("returns exactly one idea when limit is one", async () => {
    const user = await createTestUser();
    await makeRecipe(user._id, { title: "Limit Recipe A" });
    await makeRecipe(user._id, { title: "Limit Recipe B" });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 1,
    });

    expect(result.ideas).toHaveLength(1);
  });

  it("never returns more than three ideas at the maximum limit", async () => {
    const user = await createTestUser();
    for (let i = 0; i < 5; i += 1) {
      await makeRecipe(user._id, { title: `Cap Recipe ${i}` });
    }

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: MEAL_IDEAS_MAX_LIMIT,
    });

    expect(result.ideas).toHaveLength(3);
  });

  it("shows a recipe that matches both the pantry and the saved recipe book only once, with the pantry reason", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    await stockPantry(user._id, ["Rice", "Chicken", "Onion"]);
    const recipe = await makeRecipe(user._id, {
      title: "Double Duty Recipe",
      ingredients: [
        { name: "Rice", quantity: 1, unit: "cup" },
        { name: "Chicken", quantity: 1, unit: "lb" },
      ],
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    const matches = result.ideas.filter((idea) => idea.recipe._id === recipe._id.toString());
    expect(matches).toHaveLength(1);
    expect(matches[0].reason.kind).toBe("pantry");
  });
});

describe("empty results", () => {
  it("returns an empty ideas array for a user with no recipes, no pantry, and an empty catalogue", async () => {
    const user = await createTestUser();

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result).toEqual({ ideas: [] });
  });

  it("returns an empty result when nobody's recipes carry the person's dietary preference", async () => {
    const user = await createTestUser();
    await setDietaryPreferences(user._id, ["Vegan"]);
    const author = await createTestUser();
    await makeRecipe(author._id, { title: "Not Vegan At All" });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result).toEqual({ ideas: [] });
  });
});

describe("payload shape", () => {
  it("returns exactly the documented recipe fields with the right types", async () => {
    const user = await createTestUser({ fullName: "Pat Baker" });
    const recipe = await createTestRecipe({ authorId: user._id });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas).toHaveLength(1);
    const idea = result.ideas[0];
    expect(Object.keys(idea.recipe).sort()).toEqual(
      [
        "_id",
        "authorId",
        "authorName",
        "authorPhoto",
        "avgRating",
        "baseServings",
        "cookTime",
        "createdAt",
        "cuisineTags",
        "difficulty",
        "dietaryTags",
        "forksCount",
        "isPrivate",
        "labels",
        "likesCount",
        "photos",
        "prepTime",
        "ratingCount",
        "servings",
        "tags",
        "title",
        "totalTime",
        "updatedAt",
      ].sort()
    );
    expect(typeof idea.recipe._id).toBe("string");
    expect(typeof idea.recipe.authorId).toBe("string");
    expect(idea.recipe._id).toBe(recipe._id.toString());
    expect(idea.recipe.difficulty).toBeNull();
    expect(idea.recipe.prepTime).toBeNull();
    expect(idea.recipe.cookTime).toBeNull();
    expect(idea.recipe.totalTime).toBeNull();
    expect(idea.recipe.servings).toBeNull();
    expect(idea.recipe.authorName).toBe(user.fullName);
    expect(Object.keys(idea.reason)).toEqual(["kind"]);
  });

  it("sends times and servings as whole numbers so an app that reads integers never drops the idea", async () => {
    const user = await createTestUser({ fullName: "Pat Baker" });
    await makeRecipe(user._id, {
      prepTime: 12.4,
      cookTime: 20.6,
      totalTime: 33.5,
      servings: 3.2,
      baseServings: 2.7,
    });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas).toHaveLength(1);
    const { recipe } = result.ideas[0];
    expect(recipe.prepTime).toBe(12);
    expect(recipe.cookTime).toBe(21);
    expect(recipe.totalTime).toBe(34);
    expect(recipe.servings).toBe(3);
    expect(recipe.baseServings).toBe(3);
    for (const value of [
      recipe.prepTime,
      recipe.cookTime,
      recipe.totalTime,
      recipe.servings,
      recipe.baseServings,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe("hidden and banned author exclusions", () => {
  it("never offers the person's own hidden recipe", async () => {
    const user = await createTestUser();
    const recipe = await makeRecipe(user._id, { title: "My Hidden Recipe", isHidden: true });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(false);
  });

  it("never offers a saved recipe authored by a banned user", async () => {
    const user = await createTestUser();
    const bannedAuthor = await createTestUser({ isBanned: true });
    const recipe = await makeRecipe(bannedAuthor._id, { title: "Banned Author Recipe" });
    await SavedRecipe.create({ userId: user._id, recipeId: recipe._id });

    const result = await getMealIdeas(user._id.toString(), {
      date: parseDate("2026-09-16"),
      limit: 3,
    });

    expect(result.ideas.some((idea) => idea.recipe._id === recipe._id.toString())).toBe(false);
  });
});

describe("unknown user", () => {
  it("rejects with a 404 status code for an unknown user id", async () => {
    const unknownId = new Types.ObjectId().toString();

    await expect(
      getMealIdeas(unknownId, { date: parseDate("2026-09-16"), limit: 3 })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
