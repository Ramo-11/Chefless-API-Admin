import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import usersRouter from "../../routes/users";
import SavedRecipe from "../../models/SavedRecipe";
import Recipe from "../../models/Recipe";
import ScheduleEntry from "../../models/ScheduleEntry";
import User from "../../models/User";
import { createTestUser, createTestRecipe, getAuthHeaders } from "../helpers";

const app = express();
app.use(express.json());
app.use("/api/users", usersRouter);

describe("GET /api/users/me/first-steps", () => {
  it("returns all flags false for a fresh user, with createdAt", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });

    const response = await request(app)
      .get("/api/users/me/first-steps")
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      savedRecipe: false,
      importedRecipe: false,
      plannedMeal: false,
      kitchen: false,
      createdAt: user.createdAt.toISOString(),
    });
  });

  it("flips savedRecipe true once a recipe is saved", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createTestRecipe({ authorId: user._id });
    await SavedRecipe.create({ userId: user._id, recipeId: recipe._id });

    const response = await request(app)
      .get("/api/users/me/first-steps")
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.savedRecipe).toBe(true);
  });

  it("flips importedRecipe true once an imported recipe exists", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await Recipe.create({
      authorId: user._id,
      title: "Imported Recipe",
      baseServings: 4,
      ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
      steps: [{ order: 1, instruction: "Mix ingredients" }],
      source: {
        type: "website",
        url: "https://example.com/recipe",
        importedVia: "structured",
      },
    });

    const response = await request(app)
      .get("/api/users/me/first-steps")
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.importedRecipe).toBe(true);
  });

  it("leaves importedRecipe false for a recipe without a source", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await createTestRecipe({ authorId: user._id });

    const response = await request(app)
      .get("/api/users/me/first-steps")
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.importedRecipe).toBe(false);
  });

  it("flips plannedMeal true once a schedule entry exists", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await ScheduleEntry.create({
      userId: user._id,
      date: new Date("2026-09-12"),
      mealSlot: "dinner",
      freeformText: "Leftovers",
    });

    const response = await request(app)
      .get("/api/users/me/first-steps")
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.plannedMeal).toBe(true);
  });

  it("flips kitchen true once the user has a kitchenId", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await User.updateOne(
      { _id: user._id },
      { $set: { kitchenId: new Types.ObjectId() } }
    );

    const response = await request(app)
      .get("/api/users/me/first-steps")
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.kitchen).toBe(true);
  });

  it("returns 401 without an Authorization header", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });

    const response = await request(app).get("/api/users/me/first-steps");

    expect(response.status).toBe(401);
  });
});
