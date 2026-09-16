import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import shoppingListsRouter from "../../routes/shopping-lists";
import ShoppingList from "../../models/ShoppingList";
import ScheduleEntry from "../../models/ScheduleEntry";
import User from "../../models/User";
import { createTestRecipe, createTestUser, getAuthHeaders } from "../helpers";
import { generateFromSchedule } from "../../services/shopping-list-service";

const app = express();
app.use(express.json());
app.use("/api/shopping-lists", shoppingListsRouter);

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

function startOfViewerTodayMirror(offsetMinutes: number): Date {
  const shifted = new Date(Date.now() + offsetMinutes * 60000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

async function createActingUser() {
  return createTestUser({ firebaseUid: "test-firebase-uid" });
}

describe("GET /api/shopping-lists/:id timezoneOffsetMinutes changes only the past range rule", () => {
  it("lets a viewer far behind UTC still see planChanged true for a range that a viewer far ahead of UTC already sees as past", async () => {
    const user = await createActingUser();
    const behindStart = startOfViewerTodayMirror(-840);
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: new Date(behindStart.getTime() - 6 * 24 * 60 * 60 * 1000),
      scheduleEndDate: behindStart,
      scheduleRevisionAtSync: 0,
    });
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });

    const behindResponse = await request(app)
      .get(`/api/shopping-lists/${list._id.toString()}`)
      .query({ timezoneOffsetMinutes: "-840" })
      .set(getAuthHeaders());
    const aheadResponse = await request(app)
      .get(`/api/shopping-lists/${list._id.toString()}`)
      .query({ timezoneOffsetMinutes: "840" })
      .set(getAuthHeaders());

    expect(behindResponse.status).toBe(200);
    expect(aheadResponse.status).toBe(200);
    expect(behindResponse.body.list.planChanged).toBe(true);
    expect(aheadResponse.body.list.planChanged).toBe(false);
  });

  it("falls back to the caller's stored User.timezoneOffsetMinutes when the query parameter is absent", async () => {
    const user = await createActingUser();
    const behindStart = startOfViewerTodayMirror(-840);
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: new Date(behindStart.getTime() - 6 * 24 * 60 * 60 * 1000),
      scheduleEndDate: behindStart,
      scheduleRevisionAtSync: 0,
    });
    await User.updateOne(
      { _id: user._id },
      { $set: { timezoneOffsetMinutes: -840, scheduleRevision: 1 } }
    );

    const behindResponse = await request(app)
      .get(`/api/shopping-lists/${list._id.toString()}`)
      .set(getAuthHeaders());
    expect(behindResponse.body.list.planChanged).toBe(true);

    await User.updateOne({ _id: user._id }, { $set: { timezoneOffsetMinutes: 840 } });

    const aheadResponse = await request(app)
      .get(`/api/shopping-lists/${list._id.toString()}`)
      .set(getAuthHeaders());
    expect(aheadResponse.body.list.planChanged).toBe(false);
  });

  it("uses UTC when neither a query parameter nor a stored offset is present", async () => {
    const user = await createActingUser();
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });
    const today = daysFromToday(0);
    const todayList = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: today,
      scheduleRevisionAtSync: 0,
    });
    const yesterdayList = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-7),
      scheduleEndDate: daysFromToday(-1),
      scheduleRevisionAtSync: 0,
    });

    const todayResponse = await request(app)
      .get(`/api/shopping-lists/${todayList._id.toString()}`)
      .set(getAuthHeaders());
    const yesterdayResponse = await request(app)
      .get(`/api/shopping-lists/${yesterdayList._id.toString()}`)
      .set(getAuthHeaders());

    expect(todayResponse.body.list.planChanged).toBe(true);
    expect(yesterdayResponse.body.list.planChanged).toBe(false);
  });

  it("ignores a non numeric timezoneOffsetMinutes query value and falls back the same as if it were absent", async () => {
    const user = await createActingUser();
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(0),
      scheduleRevisionAtSync: 0,
    });

    const response = await request(app)
      .get(`/api/shopping-lists/${list._id.toString()}`)
      .query({ timezoneOffsetMinutes: "abc" })
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.list.planChanged).toBe(true);
  });

  it("ignores an out of range timezoneOffsetMinutes query value and falls back the same as if it were absent", async () => {
    const user = await createActingUser();
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(0),
      scheduleRevisionAtSync: 0,
    });

    const response = await request(app)
      .get(`/api/shopping-lists/${list._id.toString()}`)
      .query({ timezoneOffsetMinutes: "99999" })
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.list.planChanged).toBe(true);
  });
});

describe("backward compatibility with the 1.2 shopping list contract", () => {
  it("GET /api/shopping-lists with no query string at all still returns the old list shape for every entry", async () => {
    const user = await createActingUser();
    await ShoppingList.create({
      userId: user._id,
      name: "Old style",
      items: [{ name: "Milk", isChecked: false }],
      generatedFromSchedule: false,
    });

    const response = await request(app).get("/api/shopping-lists").set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(response.body.lists).toHaveLength(1);
    const list = response.body.lists[0];
    for (const key of [
      "_id",
      "items",
      "generatedFromSchedule",
      "revision",
      "createdAt",
      "updatedAt",
    ]) {
      expect(list).toHaveProperty(key);
    }
  });

  it("GET /api/shopping-lists/:id still returns the old list shape with every original field", async () => {
    const user = await createActingUser();
    const created = await ShoppingList.create({
      userId: user._id,
      name: "Old style",
      items: [{ name: "Milk", isChecked: false }],
      generatedFromSchedule: false,
    });

    const response = await request(app)
      .get(`/api/shopping-lists/${created._id.toString()}`)
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    const list = response.body.list;
    for (const key of [
      "_id",
      "items",
      "generatedFromSchedule",
      "revision",
      "createdAt",
      "updatedAt",
    ]) {
      expect(list).toHaveProperty(key);
    }
    expect(typeof list.planChanged).toBe("boolean");
  });

  it("POST /api/shopping-lists/:id/refresh called with a body of only revision still returns the old response shape with meta.skippedPrivateCount as a number", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const range = { startDate: daysFromToday(-1), endDate: daysFromToday(5) };
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), range);

    const response = await request(app)
      .post(`/api/shopping-lists/${generated.list._id.toString()}/refresh`)
      .set(getAuthHeaders())
      .send({ revision: generated.list.revision });

    expect(response.status).toBe(200);
    expect(typeof response.body.meta.skippedPrivateCount).toBe("number");
    const list = response.body.list;
    for (const key of [
      "_id",
      "items",
      "generatedFromSchedule",
      "scheduleStartDate",
      "scheduleEndDate",
      "scheduleLinkVersion",
      "revision",
      "createdAt",
      "updatedAt",
    ]) {
      expect(list).toHaveProperty(key);
    }
  });

  it("POST /api/shopping-lists/generate with the 1.2 body of zoneless local ISO strings and scope still returns 201 with the old response shape", async () => {
    const user = await createActingUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });

    const response = await request(app)
      .post("/api/shopping-lists/generate")
      .set(getAuthHeaders())
      .send({
        startDate: `${dateStr(daysFromToday(-1))}T00:00:00.000`,
        endDate: `${dateStr(daysFromToday(5))}T00:00:00.000`,
        scope: "personal",
      });

    expect(response.status).toBe(201);
    const list = response.body.list;
    for (const key of [
      "_id",
      "items",
      "generatedFromSchedule",
      "scheduleStartDate",
      "scheduleEndDate",
      "scheduleLinkVersion",
      "revision",
      "createdAt",
      "updatedAt",
    ]) {
      expect(list).toHaveProperty(key);
    }
    expect(typeof response.body.meta.skippedPrivateCount).toBe("number");
  });
});
