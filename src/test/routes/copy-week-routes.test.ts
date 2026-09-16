import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import schedulesRouter from "../../routes/schedules";
import { errorHandler } from "../../middleware/errorHandler";
import ScheduleEntry from "../../models/ScheduleEntry";
import User from "../../models/User";
import { createTestUser, getAuthHeaders } from "../helpers";

const app = express();
app.use(express.json());
app.use("/api/schedule", schedulesRouter);
app.use(errorHandler);

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

async function makePremium(userId: Types.ObjectId) {
  await User.updateOne({ _id: userId }, { $set: { isPremium: true } });
}

describe("POST /api/schedule/copy-week validation", () => {
  it("rejects a request missing sourceStart", async () => {
    const response = await request(app)
      .post("/api/schedule/copy-week")
      .set(getAuthHeaders())
      .send({ targetStart: dateStr(daysFromToday(7)) });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation failed");
  });

  it("rejects a badly formatted date", async () => {
    const response = await request(app)
      .post("/api/schedule/copy-week")
      .set(getAuthHeaders())
      .send({
        sourceStart: "09-20-2026",
        targetStart: dateStr(daysFromToday(7)),
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation failed");
    expect(response.body.details[0].issues).toContainEqual({
      path: "sourceStart",
      message: "Date must be in YYYY-MM-DD format",
    });
  });

  it("rejects an impossible calendar date with a proper validation failure instead of a crash", async () => {
    const response = await request(app)
      .post("/api/schedule/copy-week")
      .set(getAuthHeaders())
      .send({ sourceStart: "2026-02-31", targetStart: "2026-03-10" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Validation failed",
      details: [
        {
          location: "body",
          issues: [
            { path: "sourceStart", message: "Date must be a real calendar date" },
          ],
        },
      ],
    });
    expect(await ScheduleEntry.countDocuments({})).toBe(0);
  });

  it("accepts a real leap day as sourceStart", async () => {
    await createActingUser();

    const response = await request(app)
      .post("/api/schedule/copy-week")
      .set(getAuthHeaders())
      .send({ sourceStart: "2024-02-29", targetStart: "2024-03-10", dryRun: true });

    expect(response.status).toBe(200);
    expect(response.body.sourceCount).toBe(0);
    expect(response.body.created).toEqual([]);
  });

  it("rejects a timezoneOffsetMinutes outside the allowed range", async () => {
    const response = await request(app)
      .post("/api/schedule/copy-week")
      .set(getAuthHeaders())
      .send({
        sourceStart: dateStr(daysFromToday(0)),
        targetStart: dateStr(daysFromToday(7)),
        timezoneOffsetMinutes: 1000,
      });

    expect(response.status).toBe(400);
  });
});

describe("existing schedule date validation stays additive", () => {
  it("GET /api/schedule also rejects an impossible calendar date on start", async () => {
    await createActingUser();

    const response = await request(app)
      .get("/api/schedule")
      .query({ start: "2026-02-31", end: "2026-03-05" })
      .set(getAuthHeaders());

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Validation failed");
    expect(response.body.details[0].issues[0]).toEqual({
      path: "start",
      message: "Date must be a real calendar date",
    });
  });
});

describe("POST /api/schedule/copy-week defaults", () => {
  it("defaults skipFilledSlots to true when it is omitted", async () => {
    const user = await createActingUser();
    await makePremium(user._id);
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Source meal",
      status: "confirmed",
    });
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(7),
      mealSlot: "dinner",
      freeformText: "Already there",
      status: "confirmed",
    });

    const response = await request(app)
      .post("/api/schedule/copy-week")
      .set(getAuthHeaders())
      .send({
        sourceStart: dateStr(daysFromToday(0)),
        targetStart: dateStr(daysFromToday(7)),
        dryRun: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.skipped.filledSlots).toBe(1);
    expect(response.body.created).toHaveLength(0);
  });

  it("defaults dryRun to false when it is omitted", async () => {
    const user = await createActingUser();
    await makePremium(user._id);
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Source meal",
      status: "confirmed",
    });
    const countBefore = await ScheduleEntry.countDocuments({});

    const response = await request(app)
      .post("/api/schedule/copy-week")
      .set(getAuthHeaders())
      .send({
        sourceStart: dateStr(daysFromToday(0)),
        targetStart: dateStr(daysFromToday(7)),
        skipFilledSlots: true,
      });

    expect(response.status).toBe(200);
    expect(await ScheduleEntry.countDocuments({})).toBe(countBefore + 1);
  });
});

describe("POST /api/schedule/copy-week auth and lookup", () => {
  it("rejects a request with no authorization header", async () => {
    const response = await request(app)
      .post("/api/schedule/copy-week")
      .send({
        sourceStart: dateStr(daysFromToday(0)),
        targetStart: dateStr(daysFromToday(7)),
      });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "Missing or invalid authorization header",
    });
  });

  it("answers 404 when the acting user does not exist", async () => {
    const response = await request(app)
      .post("/api/schedule/copy-week")
      .set(getAuthHeaders())
      .send({
        sourceStart: dateStr(daysFromToday(0)),
        targetStart: dateStr(daysFromToday(7)),
      });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "User not found" });
  });

  it("answers 403 with the premium required code when a free account's copy would land on a locked day", async () => {
    const user = await createActingUser();
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(-14),
      mealSlot: "dinner",
      freeformText: "Source meal",
      status: "confirmed",
    });

    const response = await request(app)
      .post("/api/schedule/copy-week")
      .set(getAuthHeaders())
      .send({
        sourceStart: dateStr(daysFromToday(-14)),
        targetStart: dateStr(daysFromToday(7)),
      });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("PREMIUM_REQUIRED");
  });
});

describe("POST /api/schedule/batch-delete validation", () => {
  it("rejects an empty ids array", async () => {
    const response = await request(app)
      .post("/api/schedule/batch-delete")
      .set(getAuthHeaders())
      .send({ ids: [] });

    expect(response.status).toBe(400);
  });

  it("accepts as many ids as a single copy can create, so undo can always reverse one", async () => {
    await createActingUser();
    const ids = Array.from({ length: 500 }, () => new Types.ObjectId().toString());

    const response = await request(app)
      .post("/api/schedule/batch-delete")
      .set(getAuthHeaders())
      .send({ ids });

    expect(response.status).toBe(200);
    expect(response.body.deleted).toBe(0);
  });

  it("rejects a list longer than a single copy could ever create", async () => {
    const ids = Array.from({ length: 501 }, () => new Types.ObjectId().toString());

    const response = await request(app)
      .post("/api/schedule/batch-delete")
      .set(getAuthHeaders())
      .send({ ids });

    expect(response.status).toBe(400);
  });

  it("rejects an invalid object id in the list", async () => {
    const response = await request(app)
      .post("/api/schedule/batch-delete")
      .set(getAuthHeaders())
      .send({ ids: ["not-an-object-id"] });

    expect(response.status).toBe(400);
  });
});

describe("POST /api/schedule/batch-delete", () => {
  it("deletes the listed entries and returns the count", async () => {
    const user = await createActingUser();
    const entry = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Meal to remove",
      status: "confirmed",
    });

    const response = await request(app)
      .post("/api/schedule/batch-delete")
      .set(getAuthHeaders())
      .send({ ids: [entry._id.toString()] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 1 });
    expect(await ScheduleEntry.findById(entry._id).lean()).toBeNull();
  });
});

describe("backward compatibility with the 1.2 schedule contract after a copy", () => {
  it("GET /api/schedule still returns the exact fields a 1.2 app reads, using a request with none of the new optional fields", async () => {
    const user = await createActingUser();
    await makePremium(user._id);
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Source meal",
      status: "confirmed",
    });

    const copyResponse = await request(app)
      .post("/api/schedule/copy-week")
      .set(getAuthHeaders())
      .send({
        sourceStart: dateStr(daysFromToday(0)),
        targetStart: dateStr(daysFromToday(7)),
      });
    expect(copyResponse.status).toBe(200);
    expect(copyResponse.body.created).toHaveLength(1);

    const response = await request(app)
      .get("/api/schedule")
      .query({
        start: dateStr(daysFromToday(7)),
        end: dateStr(daysFromToday(13)),
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
});
