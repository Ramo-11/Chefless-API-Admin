import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import ScheduleEntry, { IScheduleEntry } from "../../models/ScheduleEntry";
import User from "../../models/User";
import schedulesRouter from "../../routes/schedules";
import { createTestUser, getAuthHeaders } from "../helpers";
import { addEntry, redactLockedEntriesForFree } from "../../services/schedule-service";

const FREE_TIER_MESSAGE =
  "Free tier users can plan within 2 days before and 2 days after today. Upgrade to premium for full calendar scheduling.";

const app = express();
app.use(express.json());
app.use("/api/schedule", schedulesRouter);

async function setOffset(userId: Types.ObjectId, minutes: number) {
  await User.updateOne({ _id: userId }, { $set: { timezoneOffsetMinutes: minutes } });
}

async function clearOffset(userId: Types.ObjectId) {
  await User.updateOne({ _id: userId }, { $unset: { timezoneOffsetMinutes: "" } });
}

function dateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("free tier window across time zones", () => {
  it("a zone behind UTC follows the local calendar day, refusing a date the old UTC maths accepted and accepting the date the person can actually plan", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 2, 0, 0)));
    const user = await createTestUser();
    await setOffset(user._id, -240);

    await expect(
      addEntry(user._id.toString(), null, {
        date: new Date(Date.UTC(2026, 8, 18)),
        mealSlot: "dinner",
      })
    ).rejects.toMatchObject({ statusCode: 403, message: FREE_TIER_MESSAGE });

    const accepted = await addEntry(user._id.toString(), null, {
      date: new Date(Date.UTC(2026, 8, 13)),
      mealSlot: "lunch",
    });
    expect(accepted.date.getTime()).toBe(Date.UTC(2026, 8, 13));

    await clearOffset(user._id);
    const acceptedUnderOldMaths = await addEntry(user._id.toString(), null, {
      date: new Date(Date.UTC(2026, 8, 18)),
      mealSlot: "breakfast",
    });
    expect(acceptedUnderOldMaths.date.getTime()).toBe(Date.UTC(2026, 8, 18));
  });

  it("a zone ahead of UTC follows the local calendar day in the other direction", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 15, 20, 0, 0)));
    const user = await createTestUser();
    await setOffset(user._id, 540);

    const accepted = await addEntry(user._id.toString(), null, {
      date: new Date(Date.UTC(2026, 8, 18)),
      mealSlot: "dinner",
    });
    expect(accepted.date.getTime()).toBe(Date.UTC(2026, 8, 18));

    await expect(
      addEntry(user._id.toString(), null, {
        date: new Date(Date.UTC(2026, 8, 13)),
        mealSlot: "lunch",
      })
    ).rejects.toMatchObject({ statusCode: 403, message: FREE_TIER_MESSAGE });
  });

  it("falls back to UTC and behaves exactly as before when no offset has ever been stored", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 12, 0, 0)));
    const user = await createTestUser();

    const boundaryFuture = await addEntry(user._id.toString(), null, {
      date: new Date(Date.UTC(2026, 8, 18)),
      mealSlot: "dinner",
    });
    expect(boundaryFuture.date.getTime()).toBe(Date.UTC(2026, 8, 18));

    const boundaryPast = await addEntry(user._id.toString(), null, {
      date: new Date(Date.UTC(2026, 8, 14)),
      mealSlot: "lunch",
    });
    expect(boundaryPast.date.getTime()).toBe(Date.UTC(2026, 8, 14));

    await expect(
      addEntry(user._id.toString(), null, {
        date: new Date(Date.UTC(2026, 8, 19)),
        mealSlot: "breakfast",
      })
    ).rejects.toMatchObject({ statusCode: 403, message: FREE_TIER_MESSAGE });

    await expect(
      addEntry(user._id.toString(), null, {
        date: new Date(Date.UTC(2026, 8, 13)),
        mealSlot: "snack",
      })
    ).rejects.toMatchObject({ statusCode: 403, message: FREE_TIER_MESSAGE });
  });
});

describe("redaction of locked future meals across time zones", () => {
  it("follows the same calendar day as the window instead of the plain UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 16, 2, 0, 0)));
    const user = await createTestUser();
    const onBoundary = await ScheduleEntry.create({
      userId: user._id,
      date: new Date(Date.UTC(2026, 8, 17)),
      mealSlot: "dinner",
      recipeTitle: "Visible Meal",
      status: "confirmed",
    });
    const beyondLocalWindow = await ScheduleEntry.create({
      userId: user._id,
      date: new Date(Date.UTC(2026, 8, 18)),
      mealSlot: "dinner",
      recipeTitle: "Hidden Meal",
      status: "confirmed",
    });

    const onBoundaryLean = (await ScheduleEntry.findById(
      onBoundary._id
    ).lean()) as IScheduleEntry;
    const beyondLocalWindowLean = (await ScheduleEntry.findById(
      beyondLocalWindow._id
    ).lean()) as IScheduleEntry;

    redactLockedEntriesForFree([onBoundaryLean], false, -240);
    redactLockedEntriesForFree([beyondLocalWindowLean], false, -240);

    expect(onBoundaryLean.locked).toBeUndefined();
    expect(onBoundaryLean.recipeTitle).toBe("Visible Meal");
    expect(beyondLocalWindowLean.locked).toBe(true);
    expect(beyondLocalWindowLean.recipeTitle).toBeUndefined();

    const beyondLocalWindowUnderOldMaths = (await ScheduleEntry.findById(
      beyondLocalWindow._id
    ).lean()) as IScheduleEntry;
    redactLockedEntriesForFree([beyondLocalWindowUnderOldMaths], false, undefined);
    expect(beyondLocalWindowUnderOldMaths.locked).toBeUndefined();
    expect(beyondLocalWindowUnderOldMaths.recipeTitle).toBe("Hidden Meal");
  });
});

describe("schedule routes capture a fresh time zone offset", () => {
  it("stores a freshly sent offset on the user", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const today = dateStr(new Date());

    const response = await request(app)
      .get("/api/schedule")
      .query({ start: today, end: today, timezoneOffsetMinutes: -300 })
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    const stored = await User.findById(user._id).lean();
    expect(stored?.timezoneOffsetMinutes).toBe(-300);
  });

  it("does not write to the database when the sent offset already matches what is stored, and attempts no write at all when none is sent", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const today = dateStr(new Date());
    await request(app)
      .get("/api/schedule")
      .query({ start: today, end: today, timezoneOffsetMinutes: -300 })
      .set(getAuthHeaders());
    const updatedAtAfterFirstCapture = (await User.findById(user._id).lean())
      ?.updatedAt;

    const spy = vi.spyOn(User, "updateOne");

    await request(app)
      .get("/api/schedule")
      .query({ start: today, end: today, timezoneOffsetMinutes: -300 })
      .set(getAuthHeaders());

    expect(spy).toHaveBeenCalledTimes(1);
    const updatedAtAfterRepeatedOffset = (await User.findById(user._id).lean())
      ?.updatedAt;
    expect(updatedAtAfterRepeatedOffset?.getTime()).toBe(
      updatedAtAfterFirstCapture?.getTime()
    );

    await request(app)
      .get("/api/schedule")
      .query({ start: today, end: today })
      .set(getAuthHeaders());

    expect(spy).toHaveBeenCalledTimes(1);

    const stored = await User.findById(user._id).lean();
    expect(stored?.timezoneOffsetMinutes).toBe(-300);

    spy.mockRestore();
  });
});
