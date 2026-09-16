import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import schedulesRouter from "../../routes/schedules";
import ScheduleEntry from "../../models/ScheduleEntry";
import { createTestRecipe, createTestUser, getAuthHeaders } from "../helpers";

const app = express();
app.use(express.json());
app.use("/api/schedule", schedulesRouter);

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

async function createActingUser() {
  return createTestUser({ firebaseUid: "test-firebase-uid" });
}

describe("POST /api/schedule/:id/leftovers", () => {
  it("returns 201 with the leftover and the raised source", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });

    const response = await request(app)
      .post(`/api/schedule/${source._id.toString()}/leftovers`)
      .set(getAuthHeaders())
      .send({
        date: dateStr(daysFromToday(1)),
        mealSlot: "lunch",
        cookExtra: false,
      });

    expect(response.status).toBe(201);
    expect(response.body.leftover.leftoverOfEntryId).toBe(
      source._id.toString()
    );
    expect(response.body.source._id).toBe(source._id.toString());
  });

  it("rejects a badly formatted date", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });

    const response = await request(app)
      .post(`/api/schedule/${source._id.toString()}/leftovers`)
      .set(getAuthHeaders())
      .send({ date: "09-20-2026", mealSlot: "lunch", cookExtra: false });

    expect(response.status).toBe(400);
  });

  it("rejects a request that is missing cookExtra", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });

    const response = await request(app)
      .post(`/api/schedule/${source._id.toString()}/leftovers`)
      .set(getAuthHeaders())
      .send({ date: dateStr(daysFromToday(1)), mealSlot: "lunch" });

    expect(response.status).toBe(400);
  });

  it("rejects extraServings of zero", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });

    const response = await request(app)
      .post(`/api/schedule/${source._id.toString()}/leftovers`)
      .set(getAuthHeaders())
      .send({
        date: dateStr(daysFromToday(1)),
        mealSlot: "lunch",
        cookExtra: true,
        extraServings: 0,
      });

    expect(response.status).toBe(400);
  });

  it("rejects extraServings of 101", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });

    const response = await request(app)
      .post(`/api/schedule/${source._id.toString()}/leftovers`)
      .set(getAuthHeaders())
      .send({
        date: dateStr(daysFromToday(1)),
        mealSlot: "lunch",
        cookExtra: true,
        extraServings: 101,
      });

    expect(response.status).toBe(400);
  });

  it("rejects a malformed schedule entry id", async () => {
    const response = await request(app)
      .post("/api/schedule/not-an-object-id/leftovers")
      .set(getAuthHeaders())
      .send({
        date: dateStr(daysFromToday(1)),
        mealSlot: "lunch",
        cookExtra: false,
      });

    expect(response.status).toBe(400);
  });

  it("surfaces the free tier window refusal with its 403 status code", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });

    const response = await request(app)
      .post(`/api/schedule/${source._id.toString()}/leftovers`)
      .set(getAuthHeaders())
      .send({
        date: dateStr(daysFromToday(5)),
        mealSlot: "lunch",
        cookExtra: false,
      });

    expect(response.status).toBe(403);
  });

  it("surfaces a permission refusal with its 403 status code", async () => {
    const owner = await createTestUser();
    await createActingUser();
    const recipe = await createTestRecipe({ authorId: owner._id });
    const source = await ScheduleEntry.create({
      userId: owner._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });

    const response = await request(app)
      .post(`/api/schedule/${source._id.toString()}/leftovers`)
      .set(getAuthHeaders())
      .send({
        date: dateStr(daysFromToday(1)),
        mealSlot: "lunch",
        cookExtra: false,
      });

    expect(response.status).toBe(403);
  });
});

describe("backward compatibility with the 1.2 schedule contract", () => {
  it("GET /api/schedule for a plan with no leftovers returns exactly the response shape a 1.2 app expects", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });

    const response = await request(app)
      .get("/api/schedule")
      .query({
        start: dateStr(daysFromToday(-1)),
        end: dateStr(daysFromToday(1)),
      })
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.entries).toHaveLength(1);
    const entry = response.body.entries[0];
    for (const key of [
      "_id",
      "date",
      "mealSlot",
      "status",
      "rsvps",
      "createdAt",
      "updatedAt",
    ]) {
      expect(entry).toHaveProperty(key);
    }
    expect(entry).not.toHaveProperty("leftoverOfEntryId");
    expect(entry).not.toHaveProperty("leftoverOfDate");
    expect(entry).not.toHaveProperty("leftoverCount");
  });

  it("DELETE /api/schedule/:id called the old way with no query string still returns success and deletes exactly one entry, leaving leftovers in place", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });
    const leftover = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(1),
      mealSlot: "lunch",
      recipeId: recipe._id,
      status: "confirmed",
      leftoverOfEntryId: source._id,
    });

    const response = await request(app)
      .delete(`/api/schedule/${source._id.toString()}`)
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(await ScheduleEntry.findById(source._id).lean()).toBeNull();
    expect(await ScheduleEntry.findById(leftover._id).lean()).not.toBeNull();
  });

  it("POST /api/schedule the old add route is unaffected by the leftovers change", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id });

    const response = await request(app)
      .post("/api/schedule")
      .set(getAuthHeaders())
      .send({
        date: dateStr(daysFromToday(0)),
        mealSlot: "dinner",
        recipeId: recipe._id.toString(),
        servings: 4,
      });

    expect(response.status).toBe(201);
    expect(response.body.entry.recipeId).toBe(recipe._id.toString());
    expect(response.body.entry.mealSlot).toBe("dinner");
    expect(response.body.entry).not.toHaveProperty("leftoverOfEntryId");
  });
});
