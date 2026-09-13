import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import schedulesRouter from "../../routes/schedules";
import shoppingListsRouter from "../../routes/shopping-lists";
import ScheduleEntry from "../../models/ScheduleEntry";
import ShoppingList from "../../models/ShoppingList";
import User from "../../models/User";
import { createTestRecipe, createTestUser, getAuthHeaders } from "../helpers";

const app = express();
app.use(express.json());
app.use("/api/schedule", schedulesRouter);
app.use("/api/shopping-lists", shoppingListsRouter);

describe("planning and shopping route contracts", () => {
  it("validates planned servings and persists an accepted value", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await User.updateOne({ _id: user._id }, { $set: { isPremium: true } });
    const recipe = await createTestRecipe({ authorId: user._id });
    const invalid = await request(app)
      .post("/api/schedule")
      .set(getAuthHeaders())
      .send({
        date: "2026-09-12",
        mealSlot: "dinner",
        recipeId: recipe._id.toString(),
        servings: 0,
      });
    expect(invalid.status).toBe(400);

    const accepted = await request(app)
      .post("/api/schedule")
      .set(getAuthHeaders())
      .send({
        date: "2026-09-12",
        mealSlot: "dinner",
        recipeId: recipe._id.toString(),
        servings: 6,
      });
    expect(accepted.status).toBe(201);
    const stored = await ScheduleEntry.findById(accepted.body.entry._id).lean();
    expect(stored?.servings).toBe(6);
  });

  it("requires a nonnegative integer revision before refresh", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await User.updateOne({ _id: user._id }, { $set: { isPremium: true } });
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: false,
    });
    const response = await request(app)
      .post(`/api/shopping-lists/${list._id.toString()}/refresh`)
      .set(getAuthHeaders())
      .send({ revision: -1 });
    expect(response.status).toBe(400);
  });

  it("allows free accounts to refresh a linked personal list", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: false,
      scheduleLinkVersion: 1,
      scheduleStartDate: new Date("2026-09-01T00:00:00.000Z"),
      scheduleEndDate: new Date("2026-09-07T23:59:59.000Z"),
    });
    const response = await request(app)
      .post(`/api/shopping-lists/${list._id.toString()}/refresh`)
      .set(getAuthHeaders())
      .send({ revision: 0 });
    expect(response.status).toBe(200);
  });
});
