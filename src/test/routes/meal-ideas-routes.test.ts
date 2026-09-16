import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import schedulesRouter from "../../routes/schedules";
import Recipe from "../../models/Recipe";
import User from "../../models/User";
import PantryItem from "../../models/PantryItem";
import Kitchen from "../../models/Kitchen";
import { normalizeIngredientName } from "../../lib/ingredients";
import { createTestRecipe, createTestUser, getAuthHeaders } from "../helpers";

const app = express();
app.use(express.json());
app.use("/api/schedule", schedulesRouter);

const RECIPE_KEYS = [
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
].sort();

const ENTRY_KEYS = [
  "_id",
  "userId",
  "date",
  "mealSlot",
  "recipeId",
  "recipeTitle",
  "recipeAuthorId",
  "recipeAuthorName",
  "servings",
  "status",
  "confirmedBy",
  "rsvps",
  "cookedAt",
  "createdAt",
  "updatedAt",
];

function stripTime(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function daysFromToday(offset: number): Date {
  const d = stripTime(new Date());
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

function dateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function createActingUser(overrides: Record<string, unknown> = {}) {
  return createTestUser({ firebaseUid: "test-firebase-uid", ...overrides });
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

describe("GET /api/schedule/ideas", () => {
  it("returns 200 with ideas for a user who has saved recipes, matching the documented recipe fields", async () => {
    const user = await createActingUser();
    await createTestRecipe({ authorId: user._id });

    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-09-16", slot: "dinner" })
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.ideas.length).toBeGreaterThan(0);
    const idea = response.body.ideas[0];
    expect(Object.keys(idea.recipe).sort()).toEqual(RECIPE_KEYS);
  });
});

describe("GET /api/schedule/ideas limit", () => {
  it("returns at most three ideas when limit is omitted", async () => {
    const user = await createActingUser();
    for (let i = 0; i < 4; i += 1) {
      await createTestRecipe({ authorId: user._id, title: `Limit Omitted ${i}` });
    }

    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-09-16" })
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.ideas.length).toBeLessThanOrEqual(3);
    expect(response.body.ideas).toHaveLength(3);
  });

  it("returns exactly one idea when limit is one", async () => {
    const user = await createActingUser();
    await createTestRecipe({ authorId: user._id, title: "Limit One A" });
    await createTestRecipe({ authorId: user._id, title: "Limit One B" });

    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-09-16", limit: "1" })
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.ideas).toHaveLength(1);
  });
});

describe("GET /api/schedule/ideas validation", () => {
  it("rejects a request missing date", async () => {
    await createActingUser();

    const response = await request(app)
      .get("/api/schedule/ideas")
      .set(getAuthHeaders());

    expect(response.status).toBe(400);
  });

  it("rejects an impossible calendar date", async () => {
    await createActingUser();

    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-02-31" })
      .set(getAuthHeaders());

    expect(response.status).toBe(400);
  });

  it("rejects a badly formatted date", async () => {
    await createActingUser();

    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "16-09-2026" })
      .set(getAuthHeaders());

    expect(response.status).toBe(400);
  });

  it("rejects a limit of zero", async () => {
    await createActingUser();

    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-09-16", limit: "0" })
      .set(getAuthHeaders());

    expect(response.status).toBe(400);
  });

  it("rejects a limit of four", async () => {
    await createActingUser();

    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-09-16", limit: "4" })
      .set(getAuthHeaders());

    expect(response.status).toBe(400);
  });

  it("rejects a non numeric limit", async () => {
    await createActingUser();

    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-09-16", limit: "abc" })
      .set(getAuthHeaders());

    expect(response.status).toBe(400);
  });

  it("rejects an empty slot", async () => {
    await createActingUser();

    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-09-16", slot: "" })
      .set(getAuthHeaders());

    expect(response.status).toBe(400);
  });

  it("rejects a slot fifty one characters long", async () => {
    await createActingUser();

    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-09-16", slot: "a".repeat(51) })
      .set(getAuthHeaders());

    expect(response.status).toBe(400);
  });
});

describe("GET /api/schedule/ideas authentication and lookup", () => {
  it("rejects a request with no authorization header", async () => {
    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-09-16" });

    expect(response.status).toBe(401);
  });

  it("returns 404 when the Firebase user has no Chefless account", async () => {
    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-09-16" })
      .set(getAuthHeaders());

    expect(response.status).toBe(404);
  });
});

describe("GET /api/schedule/ideas free tier", () => {
  it("never mentions pantry in a free user's response even with a stocked pantry", async () => {
    const user = await createActingUser();
    await stockPantry(user._id, ["Rice", "Chicken", "Onion"]);
    await Recipe.create({
      authorId: user._id,
      title: "Free Tier Match",
      baseServings: 2,
      ingredients: [
        { name: "Rice", quantity: 1, unit: "cup" },
        { name: "Chicken", quantity: 1, unit: "lb" },
      ],
      steps: [{ order: 1, instruction: "Cook" }],
    });

    const response = await request(app)
      .get("/api/schedule/ideas")
      .query({ date: "2026-09-16" })
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("pantry");
  });
});

describe("POST /api/schedule backward compatibility for Plan it", () => {
  it("accepts the exact 1.2 app body and returns a confirmed entry with servings from the recipe", async () => {
    const user = await createActingUser();
    const recipe = await Recipe.create({
      authorId: user._id,
      title: "1.2 Compat Recipe",
      baseServings: 4,
      servings: 4,
      ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
      steps: [{ order: 1, instruction: "Cook" }],
    });

    const response = await request(app)
      .post("/api/schedule")
      .set(getAuthHeaders())
      .send({
        date: dateStr(daysFromToday(0)),
        mealSlot: "dinner",
        recipeId: recipe._id.toString(),
      });

    expect(response.status).toBe(201);
    for (const key of ENTRY_KEYS) {
      expect(response.body.entry).toHaveProperty(key);
    }
    expect(response.body.entry.status).toBe("confirmed");
    expect(response.body.entry.servings).toBe(4);
  });

  it("accepts the Plan it body with timezoneOffsetMinutes and returns the same key set", async () => {
    const user = await createActingUser();
    const recipe = await Recipe.create({
      authorId: user._id,
      title: "Plan It Compat Recipe",
      baseServings: 3,
      servings: 3,
      ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
      steps: [{ order: 1, instruction: "Cook" }],
    });

    const response = await request(app)
      .post("/api/schedule")
      .set(getAuthHeaders())
      .send({
        date: dateStr(daysFromToday(0)),
        mealSlot: "dinner",
        recipeId: recipe._id.toString(),
        timezoneOffsetMinutes: -240,
      });

    expect(response.status).toBe(201);
    for (const key of ENTRY_KEYS) {
      expect(response.body.entry).toHaveProperty(key);
    }
    expect(response.body.entry.status).toBe("confirmed");
    expect(response.body.entry.servings).toBe(3);
  });

  it("returns a suggested entry for a kitchen member without edit rights using the same 1.2 body", async () => {
    const lead = await createTestUser();
    const member = await createActingUser();
    const kitchen = await Kitchen.create({
      name: "Compat Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
      scheduleAddPolicy: "lead_only",
    });
    await User.updateOne({ _id: lead._id }, { $set: { kitchenId: kitchen._id } });
    await User.updateOne({ _id: member._id }, { $set: { kitchenId: kitchen._id } });
    const recipe = await Recipe.create({
      authorId: member._id,
      title: "Kitchen Compat Recipe",
      baseServings: 2,
      servings: 2,
      isPrivate: false,
      ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
      steps: [{ order: 1, instruction: "Cook" }],
    });

    const response = await request(app)
      .post("/api/schedule")
      .set(getAuthHeaders())
      .send({
        date: dateStr(daysFromToday(0)),
        mealSlot: "dinner",
        recipeId: recipe._id.toString(),
      });

    expect(response.status).toBe(201);
    expect(response.body.entry.status).toBe("suggested");
  });
});

describe("GET /api/schedule/ideas after planning", () => {
  it("no longer offers a recipe once it has been planned for the requested date", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id, title: "Soon To Be Planned" });
    const otherRecipe = await createTestRecipe({ authorId: user._id, title: "Still Available" });
    const date = dateStr(daysFromToday(0));

    const before = await request(app)
      .get("/api/schedule/ideas")
      .query({ date })
      .set(getAuthHeaders());
    expect(
      before.body.ideas.map((idea: { recipe: { _id: string } }) => idea.recipe._id)
    ).toContain(recipe._id.toString());

    const planResponse = await request(app)
      .post("/api/schedule")
      .set(getAuthHeaders())
      .send({ date, mealSlot: "dinner", recipeId: recipe._id.toString() });
    expect(planResponse.status).toBe(201);

    const after = await request(app)
      .get("/api/schedule/ideas")
      .query({ date })
      .set(getAuthHeaders());

    const afterIds = after.body.ideas.map(
      (idea: { recipe: { _id: string } }) => idea.recipe._id
    );
    expect(afterIds).not.toContain(recipe._id.toString());
    expect(afterIds).toContain(otherRecipe._id.toString());
  });
});
