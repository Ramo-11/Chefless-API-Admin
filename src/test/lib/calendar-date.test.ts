import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import shoppingListsRouter from "../../routes/shopping-lists";
import ScheduleEntry from "../../models/ScheduleEntry";
import { createTestRecipe, createTestUser, getAuthHeaders } from "../helpers";
import { utcCalendarDay } from "../../lib/calendar-date";

describe("utcCalendarDay accepted strings", () => {
  it("reads a bare YYYY-MM-DD date string as UTC midnight of that day", () => {
    expect(utcCalendarDay("2026-09-15")?.getTime()).toBe(Date.UTC(2026, 8, 15));
  });

  it("reads a zoneless local ISO string, what a 1.2 app sends, as UTC midnight of its date part", () => {
    expect(utcCalendarDay("2026-09-15T00:00:00.000")?.getTime()).toBe(Date.UTC(2026, 8, 15));
  });

  it("reads a UTC ISO string carrying a time of day as UTC midnight of its date part, ignoring the time", () => {
    expect(utcCalendarDay("2026-09-15T18:30:00.000Z")?.getTime()).toBe(Date.UTC(2026, 8, 15));
  });

  it("reads an ISO string carrying a negative zone offset as UTC midnight of its own date part, not the date the offset would shift it to", () => {
    expect(utcCalendarDay("2026-09-15T23:00:00.000-05:00")?.getTime()).toBe(Date.UTC(2026, 8, 15));
  });

  it("reads an ISO string carrying a positive zone offset as UTC midnight of its own date part, not the date the offset would shift it to", () => {
    expect(utcCalendarDay("2026-09-15T01:00:00.000+09:00")?.getTime()).toBe(Date.UTC(2026, 8, 15));
  });
});

describe("utcCalendarDay accepted epoch milliseconds and Date instances", () => {
  it("reads epoch milliseconds as the UTC calendar day they fall on", () => {
    const ms = Date.UTC(2026, 8, 15, 18, 30, 0);
    expect(utcCalendarDay(ms)?.getTime()).toBe(Date.UTC(2026, 8, 15));
  });

  it("reads a Date instance as its own UTC calendar day", () => {
    const date = new Date(Date.UTC(2026, 8, 15, 18, 30, 0));
    expect(utcCalendarDay(date)?.getTime()).toBe(Date.UTC(2026, 8, 15));
  });
});

describe("utcCalendarDay rejections", () => {
  it("returns null for February 31st, which JavaScript silently rolls over into March, by catching the round trip mismatch rather than trusting the rolled over date", () => {
    expect(utcCalendarDay("2026-02-31")).toBeNull();
  });

  it("returns null for a month of 13", () => {
    expect(utcCalendarDay("2026-13-01")).toBeNull();
  });

  it("returns null for a day of 00", () => {
    expect(utcCalendarDay("2026-01-00")).toBeNull();
  });

  it("returns null for a slash formatted date", () => {
    expect(utcCalendarDay("15/09/2026")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(utcCalendarDay("")).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(utcCalendarDay(NaN)).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(utcCalendarDay(Infinity)).toBeNull();
  });

  it("returns null for an invalid Date instance", () => {
    expect(utcCalendarDay(new Date("not a date"))).toBeNull();
  });
});

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

interface GeneratedItemShape {
  name: unknown;
  quantity: unknown;
  unit: unknown;
}

describe("POST /api/shopping-lists/generate is independent of the server's own timezone", () => {
  let originalTz: string | undefined;

  beforeEach(() => {
    originalTz = process.env.TZ;
  });

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  const zones = ["America/Los_Angeles", "Asia/Tokyo", "UTC"];

  it("finds a meal scheduled today and generates the identical list under a zone behind UTC, a zone ahead of UTC, and UTC itself when the request sends a plain YYYY-MM-DD date", async () => {
    const today = daysFromToday(0);
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createTestRecipe({ authorId: user._id });
    const results: GeneratedItemShape[][] = [];

    for (const zone of zones) {
      process.env.TZ = zone;
      const entry = await ScheduleEntry.create({
        userId: user._id,
        date: today,
        mealSlot: "dinner",
        recipeId: recipe._id,
        servings: 4,
        status: "confirmed",
      });

      const response = await request(app)
        .post("/api/shopping-lists/generate")
        .set(getAuthHeaders())
        .send({ startDate: dateStr(today), endDate: dateStr(today), scope: "personal" });

      expect(response.status).toBe(201);
      expect(response.body.list.items).toHaveLength(1);
      expect(response.body.list.scheduleStartDate).toBe(today.toISOString());
      expect(response.body.list.scheduleEndDate).toBe(today.toISOString());
      results.push(
        response.body.list.items.map((item: GeneratedItemShape) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
        }))
      );

      await ScheduleEntry.deleteOne({ _id: entry._id });
    }

    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });

  it("finds a meal scheduled today and generates the identical list under the same three zones when the request sends the legacy zoneless local ISO string a 1.2 app sends", async () => {
    const today = daysFromToday(0);
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createTestRecipe({ authorId: user._id });
    const results: GeneratedItemShape[][] = [];

    for (const zone of zones) {
      process.env.TZ = zone;
      const entry = await ScheduleEntry.create({
        userId: user._id,
        date: today,
        mealSlot: "dinner",
        recipeId: recipe._id,
        servings: 4,
        status: "confirmed",
      });

      const response = await request(app)
        .post("/api/shopping-lists/generate")
        .set(getAuthHeaders())
        .send({
          startDate: `${dateStr(today)}T00:00:00.000`,
          endDate: `${dateStr(today)}T00:00:00.000`,
          scope: "personal",
        });

      expect(response.status).toBe(201);
      expect(response.body.list.items).toHaveLength(1);
      expect(response.body.list.scheduleStartDate).toBe(today.toISOString());
      expect(response.body.list.scheduleEndDate).toBe(today.toISOString());
      results.push(
        response.body.list.items.map((item: GeneratedItemShape) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
        }))
      );

      await ScheduleEntry.deleteOne({ _id: entry._id });
    }

    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
  });

  it("rejects a malformed generate date with HTTP 400 regardless of the server's zone", async () => {
    process.env.TZ = "Asia/Tokyo";
    await createTestUser({ firebaseUid: "test-firebase-uid" });

    const response = await request(app)
      .post("/api/shopping-lists/generate")
      .set(getAuthHeaders())
      .send({
        startDate: "15/09/2026",
        endDate: dateStr(daysFromToday(1)),
        scope: "personal",
      });

    expect(response.status).toBe(400);
  });
});
