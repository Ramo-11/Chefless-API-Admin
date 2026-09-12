import { describe, expect, it, beforeEach } from "vitest";
import express, { Express } from "express";
import request from "supertest";
import { Types } from "mongoose";
import Recipe from "../../models/Recipe";
import Block from "../../models/Block";
import { createTestUser, getAuthHeaders } from "../helpers";
import searchRouter from "../../routes/search";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/search", searchRouter);
  return app;
}

interface RecipeOverrides {
  authorId: Types.ObjectId;
  title?: string;
  cuisineTags?: string[];
  dietaryTags?: string[];
  labels?: string[];
  tags?: string[];
  difficulty?: "easy" | "medium" | "hard";
  prepTime?: number;
  cookTime?: number;
  totalTime?: number;
  avgRating?: number;
  ratingCount?: number;
  likesCount?: number;
  forksCount?: number;
  isPrivate?: boolean;
  isHidden?: boolean;
  createdAt?: Date;
}

async function makeRecipe(overrides: RecipeOverrides) {
  const recipe = await Recipe.create({
    authorId: overrides.authorId,
    title: overrides.title ?? "Recipe",
    baseServings: 4,
    isPrivate: overrides.isPrivate ?? false,
    isHidden: overrides.isHidden ?? false,
    cuisineTags: overrides.cuisineTags ?? [],
    dietaryTags: overrides.dietaryTags ?? [],
    labels: overrides.labels ?? [],
    tags: overrides.tags ?? [],
    difficulty: overrides.difficulty,
    prepTime: overrides.prepTime,
    cookTime: overrides.cookTime,
    totalTime: overrides.totalTime,
    avgRating: overrides.avgRating ?? 0,
    ratingCount: overrides.ratingCount ?? 0,
    likesCount: overrides.likesCount ?? 0,
    forksCount: overrides.forksCount ?? 0,
    ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
    steps: [{ order: 1, instruction: "Mix ingredients" }],
  });
  if (overrides.createdAt) {
    await Recipe.collection.updateOne(
      { _id: recipe._id },
      { $set: { createdAt: overrides.createdAt } }
    );
  }
  return recipe;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe("GET /api/search filters", () => {
  let app: Express;
  let viewer: Awaited<ReturnType<typeof createTestUser>>;
  let author: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    app = buildApp();
    viewer = await createTestUser({ firebaseUid: "test-firebase-uid" });
    author = await createTestUser({ email: "author@test.com" });
  });

  it("rejects a request with no query and no filters", async () => {
    const res = await request(app).get("/api/search").set(getAuthHeaders());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SEARCH_EMPTY_QUERY");
  });

  it("rejects type=users with no query even when filters are present", async () => {
    const res = await request(app)
      .get("/api/search")
      .query({ type: "users", cuisines: "Italian" })
      .set(getAuthHeaders());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SEARCH_EMPTY_QUERY");
  });

  it("rejects type=kitchens with no query", async () => {
    const res = await request(app)
      .get("/api/search")
      .query({ type: "kitchens" })
      .set(getAuthHeaders());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SEARCH_EMPTY_QUERY");
  });

  it("q only keeps the existing relevance ranking and response envelope", async () => {
    await makeRecipe({ authorId: author._id, title: "Chicken Curry", likesCount: 1 });
    await makeRecipe({ authorId: author._id, title: "Spicy Chicken Wings", likesCount: 50 });
    await makeRecipe({ authorId: author._id, title: "Beef Stew" });

    const res = await request(app)
      .get("/api/search")
      .query({ q: "chicken" })
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
    const titles = res.body.recipes.map((r: { title: string }) => r.title);
    expect(titles).toEqual(["Chicken Curry", "Spicy Chicken Wings"]);
    expect(res.body.totals.recipes).toBe(2);
    expect(res.body).toHaveProperty("users");
    expect(res.body).toHaveProperty("kitchens");
    expect(res.body.totals).toHaveProperty("users");
    expect(res.body.totals).toHaveProperty("kitchens");
  });

  it("filters recipes by cuisine alone in browse mode", async () => {
    await makeRecipe({ authorId: author._id, title: "Pasta", cuisineTags: ["Italian"] });
    await makeRecipe({ authorId: author._id, title: "Tacos", cuisineTags: ["Mexican"] });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian" })
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.recipes).toHaveLength(1);
    expect(res.body.recipes[0].title).toBe("Pasta");
    expect(res.body.totals.recipes).toBe(1);
  });

  it("filters recipes by diet alone in browse mode", async () => {
    await makeRecipe({ authorId: author._id, title: "Vegan Bowl", dietaryTags: ["Vegan"] });
    await makeRecipe({ authorId: author._id, title: "Steak", dietaryTags: [] });

    const res = await request(app)
      .get("/api/search")
      .query({ diets: "Vegan" })
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Vegan Bowl"]);
  });

  it("filters recipes by difficulty alone in browse mode", async () => {
    await makeRecipe({ authorId: author._id, title: "Easy Toast", difficulty: "easy" });
    await makeRecipe({ authorId: author._id, title: "Hard Souffle", difficulty: "hard" });

    const res = await request(app)
      .get("/api/search")
      .query({ difficulty: "easy" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Easy Toast"]);
  });

  it("filters recipes by maxTotalTime alone in browse mode", async () => {
    await makeRecipe({ authorId: author._id, title: "Quick Salad", totalTime: 10 });
    await makeRecipe({ authorId: author._id, title: "Slow Roast", totalTime: 180 });

    const res = await request(app)
      .get("/api/search")
      .query({ maxTotalTime: 30 })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Quick Salad"]);
  });

  it("filters recipes by minRating alone in browse mode", async () => {
    await makeRecipe({ authorId: author._id, title: "Loved Dish", avgRating: 4.5, ratingCount: 10 });
    await makeRecipe({ authorId: author._id, title: "Unrated Dish", avgRating: 4.9, ratingCount: 0 });

    const res = await request(app)
      .get("/api/search")
      .query({ minRating: 4 })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Loved Dish"]);
  });

  it("excludes ratingCount: 0 recipes even when avgRating qualifies", async () => {
    await makeRecipe({ authorId: author._id, title: "Zero Ratings", avgRating: 5, ratingCount: 0 });

    const res = await request(app)
      .get("/api/search")
      .query({ minRating: 1 })
      .set(getAuthHeaders());

    expect(res.body.recipes).toHaveLength(0);
    expect(res.body.totals.recipes).toBe(0);
  });

  it("combines cuisines, diets, difficulty, maxTotalTime and minRating together", async () => {
    await makeRecipe({
      authorId: author._id,
      title: "Match",
      cuisineTags: ["Italian"],
      dietaryTags: ["Vegan"],
      difficulty: "easy",
      totalTime: 20,
      avgRating: 4.8,
      ratingCount: 5,
    });
    await makeRecipe({
      authorId: author._id,
      title: "Wrong Cuisine",
      cuisineTags: ["Mexican"],
      dietaryTags: ["Vegan"],
      difficulty: "easy",
      totalTime: 20,
      avgRating: 4.8,
      ratingCount: 5,
    });
    await makeRecipe({
      authorId: author._id,
      title: "Too Slow",
      cuisineTags: ["Italian"],
      dietaryTags: ["Vegan"],
      difficulty: "easy",
      totalTime: 90,
      avgRating: 4.8,
      ratingCount: 5,
    });

    const res = await request(app)
      .get("/api/search")
      .query({
        cuisines: "Italian",
        diets: "Vegan",
        difficulty: "easy",
        maxTotalTime: 30,
        minRating: 4,
      })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Match"]);
  });

  it("ANDs diets together (must have every listed diet)", async () => {
    await makeRecipe({ authorId: author._id, title: "Both", dietaryTags: ["Vegan", "Gluten-Free"] });
    await makeRecipe({ authorId: author._id, title: "Only Vegan", dietaryTags: ["Vegan"] });

    const res = await request(app)
      .get("/api/search")
      .query({ diets: "Vegan,Gluten-Free" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Both"]);
  });

  it("ORs cuisines together (matches any listed cuisine)", async () => {
    await makeRecipe({ authorId: author._id, title: "Italian Dish", cuisineTags: ["Italian"] });
    await makeRecipe({ authorId: author._id, title: "Mexican Dish", cuisineTags: ["Mexican"] });
    await makeRecipe({ authorId: author._id, title: "Japanese Dish", cuisineTags: ["Japanese"] });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian,Mexican" })
      .set(getAuthHeaders());

    const titles = res.body.recipes.map((r: { title: string }) => r.title).sort();
    expect(titles).toEqual(["Italian Dish", "Mexican Dish"]);
  });

  it("matches cuisines and diets case-insensitively", async () => {
    await makeRecipe({
      authorId: author._id,
      title: "Cased",
      cuisineTags: ["Italian"],
      dietaryTags: ["Vegan"],
    });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "italian", diets: "VEGAN" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Cased"]);
  });

  it("filters recipes by labels alone in browse mode, matching the labels array", async () => {
    await makeRecipe({ authorId: author._id, title: "Quick Meal", labels: ["breakfast"] });
    await makeRecipe({ authorId: author._id, title: "Slow Meal", labels: ["dinner"] });

    const res = await request(app)
      .get("/api/search")
      .query({ labels: "breakfast" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Quick Meal"]);
  });

  it("filters recipes by labels alone, also matching the tags array", async () => {
    await makeRecipe({ authorId: author._id, title: "Tagged", tags: ["breakfast"] });
    await makeRecipe({ authorId: author._id, title: "Untagged", tags: ["dinner"] });

    const res = await request(app)
      .get("/api/search")
      .query({ labels: "breakfast" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Tagged"]);
  });

  it("matches labels case-insensitively", async () => {
    await makeRecipe({ authorId: author._id, title: "Cased Label", labels: ["Breakfast"] });

    const res = await request(app)
      .get("/api/search")
      .query({ labels: "BREAKFAST" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Cased Label"]);
  });

  it("ORs labels together (matches any listed label, across either field)", async () => {
    await makeRecipe({ authorId: author._id, title: "Breakfast Dish", labels: ["breakfast"] });
    await makeRecipe({ authorId: author._id, title: "Dinner Dish", tags: ["dinner"] });
    await makeRecipe({ authorId: author._id, title: "Snack Dish", labels: ["snack"] });

    const res = await request(app)
      .get("/api/search")
      .query({ labels: "breakfast,dinner" })
      .set(getAuthHeaders());

    const titles = res.body.recipes.map((r: { title: string }) => r.title).sort();
    expect(titles).toEqual(["Breakfast Dish", "Dinner Dish"]);
  });

  it("combines labels with diets and cuisines", async () => {
    await makeRecipe({
      authorId: author._id,
      title: "Match",
      labels: ["breakfast"],
      dietaryTags: ["Vegan"],
      cuisineTags: ["Italian"],
    });
    await makeRecipe({
      authorId: author._id,
      title: "Wrong Label",
      labels: ["dinner"],
      dietaryTags: ["Vegan"],
      cuisineTags: ["Italian"],
    });

    const res = await request(app)
      .get("/api/search")
      .query({ labels: "breakfast", diets: "Vegan", cuisines: "Italian" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Match"]);
  });

  it("accepts a browse-mode request with only labels set", async () => {
    await makeRecipe({ authorId: author._id, title: "Breakfast Dish", labels: ["breakfast"] });

    const res = await request(app)
      .get("/api/search")
      .query({ labels: "breakfast" })
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Breakfast Dish"]);
  });

  it("matches a text query against a recipe whose only hit is a tag", async () => {
    await makeRecipe({ authorId: author._id, title: "Weeknight Bowl", tags: ["mealprep"] });
    await makeRecipe({ authorId: author._id, title: "Other Dish" });

    const res = await request(app)
      .get("/api/search")
      .query({ q: "mealprep" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Weeknight Bowl"]);
  });

  it("computes effective total time from prepTime + cookTime when totalTime is unset", async () => {
    await makeRecipe({ authorId: author._id, title: "Within Budget", prepTime: 10, cookTime: 15 });
    await makeRecipe({ authorId: author._id, title: "Over Budget", prepTime: 10, cookTime: 30 });
    await makeRecipe({ authorId: author._id, title: "Prep Only", prepTime: 20 });

    const res = await request(app)
      .get("/api/search")
      .query({ maxTotalTime: 25 })
      .set(getAuthHeaders());

    const titles = res.body.recipes.map((r: { title: string }) => r.title).sort();
    expect(titles).toEqual(["Prep Only", "Within Budget"]);
  });

  it("excludes recipes with no time information at all when maxTotalTime is active", async () => {
    await makeRecipe({ authorId: author._id, title: "No Time Info" });
    await makeRecipe({ authorId: author._id, title: "Has Time", totalTime: 15 });

    const res = await request(app)
      .get("/api/search")
      .query({ maxTotalTime: 60 })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Has Time"]);
  });

  it("sorts by newest descending", async () => {
    const oldest = await makeRecipe({
      authorId: author._id,
      title: "Oldest",
      cuisineTags: ["Italian"],
      createdAt: daysAgo(10),
    });
    const newest = await makeRecipe({
      authorId: author._id,
      title: "Newest",
      cuisineTags: ["Italian"],
      createdAt: daysAgo(1),
    });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian", sort: "newest" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { _id: string }) => r._id)).toEqual([
      newest._id.toString(),
      oldest._id.toString(),
    ]);
  });

  it("sorts by popular descending", async () => {
    await makeRecipe({ authorId: author._id, title: "Less Liked", cuisineTags: ["Italian"], likesCount: 2 });
    await makeRecipe({ authorId: author._id, title: "More Liked", cuisineTags: ["Italian"], likesCount: 20 });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian", sort: "popular" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["More Liked", "Less Liked"]);
  });

  it("sorts by rating descending", async () => {
    await makeRecipe({
      authorId: author._id,
      title: "Lower Rated",
      cuisineTags: ["Italian"],
      avgRating: 3.5,
      ratingCount: 5,
    });
    await makeRecipe({
      authorId: author._id,
      title: "Higher Rated",
      cuisineTags: ["Italian"],
      avgRating: 4.9,
      ratingCount: 5,
    });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian", sort: "rating" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Higher Rated", "Lower Rated"]);
  });

  it("sorts by quickest ascending, with no-time recipes last", async () => {
    await makeRecipe({ authorId: author._id, title: "Slow", cuisineTags: ["Italian"], totalTime: 60 });
    await makeRecipe({ authorId: author._id, title: "Fast", cuisineTags: ["Italian"], totalTime: 10 });
    await makeRecipe({ authorId: author._id, title: "Unknown Time", cuisineTags: ["Italian"] });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian", sort: "quickest" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual([
      "Fast",
      "Slow",
      "Unknown Time",
    ]);
  });

  it("falls back relevance to popular in browse mode when no query is given", async () => {
    await makeRecipe({ authorId: author._id, title: "Less Liked", cuisineTags: ["Italian"], likesCount: 2 });
    await makeRecipe({ authorId: author._id, title: "More Liked", cuisineTags: ["Italian"], likesCount: 20 });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["More Liked", "Less Liked"]);
  });

  it("returns recipes only in browse mode, with users and kitchens empty regardless of type", async () => {
    await makeRecipe({ authorId: author._id, title: "Pasta", cuisineTags: ["Italian"] });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian", type: "all" })
      .set(getAuthHeaders());

    expect(res.body.recipes).toHaveLength(1);
    expect(res.body.users).toEqual([]);
    expect(res.body.kitchens).toEqual([]);
    expect(res.body.totals.users).toBe(0);
    expect(res.body.totals.kitchens).toBe(0);
  });

  it("reports totals matching the filtered result count across every page", async () => {
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(
        await makeRecipe({
          authorId: author._id,
          title: `Italian Dish ${i}`,
          cuisineTags: ["Italian"],
          createdAt: daysAgo(i),
        })
      );
    }

    const seenIds = new Set<string>();
    for (let page = 1; page <= 3; page += 1) {
      const res = await request(app)
        .get("/api/search")
        .query({ cuisines: "Italian", sort: "newest", page, limit: 2 })
        .set(getAuthHeaders());

      expect(res.body.totals.recipes).toBe(5);
      for (const r of res.body.recipes as Array<{ _id: string }>) {
        expect(seenIds.has(r._id)).toBe(false);
        seenIds.add(r._id);
      }
    }

    expect(seenIds.size).toBe(5);
    expect([...seenIds].sort()).toEqual(created.map((r) => r._id.toString()).sort());
  });

  it("clamps totals.recipes at 1000 instead of scanning the full matched set", async () => {
    const docs = Array.from({ length: 1001 }, (_, i) => ({
      authorId: author._id,
      title: `Cap Test ${i}`,
      baseServings: 4,
      isPrivate: false,
      isHidden: false,
      cuisineTags: ["ZCapCuisine"],
      dietaryTags: [],
      ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
      steps: [{ order: 1, instruction: "Mix ingredients" }],
    }));
    await Recipe.insertMany(docs);

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "ZCapCuisine", limit: 20, page: 1 })
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.recipes).toHaveLength(20);
    expect(res.body.totals.recipes).toBe(1000);
  });

  it("never returns a private recipe to a non-owner under any filter", async () => {
    await makeRecipe({
      authorId: author._id,
      title: "Private Italian",
      cuisineTags: ["Italian"],
      isPrivate: true,
    });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian" })
      .set(getAuthHeaders());

    expect(res.body.recipes).toHaveLength(0);
    expect(res.body.totals.recipes).toBe(0);
  });

  it("never returns a hidden recipe under any filter", async () => {
    await makeRecipe({
      authorId: author._id,
      title: "Hidden Italian",
      cuisineTags: ["Italian"],
      isHidden: true,
    });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian" })
      .set(getAuthHeaders());

    expect(res.body.recipes).toHaveLength(0);
  });

  it("never returns a blocked author's recipes under any filter", async () => {
    await Block.create({ blockerId: viewer._id, blockedId: author._id });
    await makeRecipe({ authorId: author._id, title: "Blocked Author Dish", cuisineTags: ["Italian"] });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian" })
      .set(getAuthHeaders());

    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual([]);
  });

  it("accepts a cuisines list of exactly 20 entries", async () => {
    const cuisines = Array.from({ length: 20 }, (_, i) => `Cuisine${i}`).join(",");
    const res = await request(app)
      .get("/api/search")
      .query({ cuisines })
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
  });

  it("rejects a cuisines list longer than 20 entries", async () => {
    const cuisines = Array.from({ length: 21 }, (_, i) => `Cuisine${i}`).join(",");
    const res = await request(app)
      .get("/api/search")
      .query({ cuisines })
      .set(getAuthHeaders());

    expect(res.status).toBe(400);
  });

  it("rejects an invalid difficulty value", async () => {
    const res = await request(app)
      .get("/api/search")
      .query({ difficulty: "expert" })
      .set(getAuthHeaders());

    expect(res.status).toBe(400);
  });

  it("rejects maxTotalTime of 0", async () => {
    const res = await request(app)
      .get("/api/search")
      .query({ maxTotalTime: 0 })
      .set(getAuthHeaders());

    expect(res.status).toBe(400);
  });

  it("rejects maxTotalTime of 99999", async () => {
    const res = await request(app)
      .get("/api/search")
      .query({ maxTotalTime: 99999 })
      .set(getAuthHeaders());

    expect(res.status).toBe(400);
  });
});

describe("GET /api/search/filters", () => {
  it("lists the values the server accepts", async () => {
    const app = buildApp();
    await createTestUser({ firebaseUid: "test-firebase-uid" });

    const res = await request(app).get("/api/search/filters").set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.cuisines)).toBe(true);
    expect(res.body.cuisines).toContain("Italian");
    expect(res.body.diets).toEqual([
      "Halal",
      "Vegetarian",
      "Vegan",
      "Pescatarian",
      "Gluten-Free",
      "Dairy-Free",
      "Nut-Free",
      "Egg-Free",
      "Soy-Free",
      "Shellfish-Free",
      "Low Sugar",
      "Low Sodium",
      "Low Carb",
      "High Protein",
      "Keto",
      "Paleo",
      "Low FODMAP",
      "Kosher",
    ]);
    expect(res.body.labels).toEqual([
      "breakfast",
      "lunch",
      "dinner",
      "snack",
      "dessert",
      "drink",
    ]);
    expect(res.body.difficulties).toEqual(["easy", "medium", "hard"]);
    expect(res.body.sorts).toEqual(["relevance", "newest", "popular", "rating", "quickest"]);
  });
});
