import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import shoppingListsRouter from "../../routes/shopping-lists";
import ScheduleEntry from "../../models/ScheduleEntry";
import { createTestRecipe, createTestUser, getAuthHeaders } from "../helpers";

const app = express();
app.use(express.json());
app.use("/api/shopping-lists", shoppingListsRouter);

describe("POST /api/shopping-lists/generate with unitless ingredients", () => {
  it("answers 201 with blank units instead of a 400 validation failure when a planned recipe lists eggs with no unit, for the exact body a 1.2 app sends", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createTestRecipe({ authorId: user._id });
    recipe.set("ingredients", [
      { name: "Eggs", quantity: 2, unit: "" },
      { name: "Flour", quantity: 200, unit: "g" },
    ]);
    await recipe.save();
    await ScheduleEntry.create({
      userId: user._id,
      date: new Date("2026-08-02T00:00:00.000Z"),
      mealSlot: "breakfast",
      recipeId: recipe._id,
      status: "confirmed",
    });

    const response = await request(app)
      .post("/api/shopping-lists/generate")
      .set(getAuthHeaders())
      .send({ startDate: "2026-08-01T00:00:00.000", endDate: "2026-08-07T23:59:59.999" });

    expect(response.status).toBe(201);
    const eggs = response.body.list.items.find((item: { name: string }) => item.name === "Eggs");
    expect(eggs.unit).toBe("");
    expect(eggs.quantity).toBe(2);
  });
});
