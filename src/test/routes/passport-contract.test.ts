import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import passportRouter from "../../routes/passport";
import cookedPostsRouter from "../../routes/cooked-posts";
import CookedPost from "../../models/CookedPost";
import Recipe from "../../models/Recipe";
import { createTestUser, getAuthHeaders } from "../helpers";

const app = express();
app.use(express.json());
app.use("/api/passport", passportRouter);
app.use("/api/cooked-posts", cookedPostsRouter);

const OLD_BADGE_KEYS = [
  "id",
  "title",
  "subtitle",
  "emoji",
  "tier",
  "earned",
  "threshold",
  "progress",
  "regionId",
];
const ALLOWED_BADGE_KEYS = [...OLD_BADGE_KEYS, "earnedAt"];

const SUMMARY_KEYS = [
  "userId",
  "displayName",
  "profilePicture",
  "totalPosts",
  "uniqueCuisines",
  "totalCuisines",
  "stamps",
  "regions",
  "badges",
  "latestPhotoUrl",
  "startedAt",
];

const REGION_KEYS = ["id", "name", "emoji", "total", "unlocked", "cuisines", "unlockedCuisines"];

function expectPassportSummaryShape(body: Record<string, unknown>) {
  expect(Object.keys(body).sort()).toEqual([...SUMMARY_KEYS].sort());
  expect(typeof body.userId).toBe("string");
  expect(typeof body.displayName).toBe("string");
  expect(body.profilePicture === null || typeof body.profilePicture === "string").toBe(true);
  expect(Number.isInteger(body.totalPosts)).toBe(true);
  expect(Number.isInteger(body.uniqueCuisines)).toBe(true);
  expect(Number.isInteger(body.totalCuisines)).toBe(true);
  expect(Array.isArray(body.stamps)).toBe(true);
  expect(Array.isArray(body.regions)).toBe(true);
  expect(Array.isArray(body.badges)).toBe(true);
  expect(body.latestPhotoUrl === null || typeof body.latestPhotoUrl === "string").toBe(true);
  expect(body.startedAt === null || typeof body.startedAt === "string").toBe(true);

  for (const region of body.regions as Record<string, unknown>[]) {
    expect(Object.keys(region).sort()).toEqual([...REGION_KEYS].sort());
    expect(typeof region.id).toBe("string");
    expect(typeof region.name).toBe("string");
    expect(typeof region.emoji).toBe("string");
    expect(Number.isInteger(region.total)).toBe(true);
    expect(Number.isInteger(region.unlocked)).toBe(true);
    expect(Array.isArray(region.cuisines)).toBe(true);
    expect(Array.isArray(region.unlockedCuisines)).toBe(true);
  }

  for (const badge of body.badges as Record<string, unknown>[]) {
    for (const key of Object.keys(badge)) {
      expect(ALLOWED_BADGE_KEYS).toContain(key);
    }
    expect(typeof badge.id).toBe("string");
    expect(typeof badge.title).toBe("string");
    expect(typeof badge.subtitle).toBe("string");
    expect(typeof badge.emoji).toBe("string");
    expect(typeof badge.tier).toBe("string");
    expect(typeof badge.earned).toBe("boolean");
    if ("threshold" in badge) expect(Number.isInteger(badge.threshold)).toBe(true);
    if ("progress" in badge) expect(Number.isInteger(badge.progress)).toBe(true);
    if ("regionId" in badge) expect(typeof badge.regionId).toBe("string");
    if (badge.earned) {
      expect(typeof badge.earnedAt).toBe("string");
      expect(new Date(badge.earnedAt as string).toISOString()).toBe(badge.earnedAt);
    } else {
      expect(badge).not.toHaveProperty("earnedAt");
    }
  }
}

async function createRecipeWithCuisine(authorId: Types.ObjectId, cuisineTags: string[]) {
  return Recipe.create({
    authorId,
    title: "Test Recipe",
    baseServings: 4,
    cuisineTags,
    ingredients: [{ name: "Salt", quantity: 1, unit: "tsp" }],
    steps: [{ order: 1, instruction: "Cook it." }],
  });
}

describe("GET /api/passport/me", () => {
  it("returns the 1.2 top level and nested shape with earnedAt only on earned badges", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await CookedPost.create({
      userId: user._id,
      recipeId: null,
      recipeTitle: "Test Recipe",
      recipeAuthorId: user._id,
      photoUrl: "https://example.com/photo.jpg",
      cuisineTags: ["Lebanese"],
    });

    const response = await request(app).get("/api/passport/me").set(getAuthHeaders());

    expect(response.status).toBe(200);
    expectPassportSummaryShape(response.body);
    expect(response.body.totalPosts).toBe(1);
    expect(typeof response.body.latestPhotoUrl).toBe("string");
    expect(typeof response.body.startedAt).toBe("string");
    expect(response.body.profilePicture).toBeNull();
  });
});

describe("GET /api/passport/:id", () => {
  it("returns the same shape for another public user's passport", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    const other = await createTestUser({ isPublic: true });
    await CookedPost.create({
      userId: other._id,
      recipeId: null,
      recipeTitle: "Test Recipe",
      recipeAuthorId: other._id,
      photoUrl: "https://example.com/other.jpg",
      cuisineTags: ["Turkish"],
    });

    const response = await request(app)
      .get(`/api/passport/${other._id.toString()}`)
      .set(getAuthHeaders());

    expect(response.status).toBe(200);
    expectPassportSummaryShape(response.body);
    expect(response.body.userId).toBe(other._id.toString());
  });
});

describe("GET /api/passport/metadata", () => {
  it("returns the region and badge catalogue with the old keys, threshold now included on regional badges", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });

    const response = await request(app).get("/api/passport/metadata").set(getAuthHeaders());

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(["badges", "regions"]);
    expect(Array.isArray(response.body.regions)).toBe(true);
    expect(Array.isArray(response.body.badges)).toBe(true);

    for (const region of response.body.regions) {
      expect(Object.keys(region).sort()).toEqual(["cuisines", "emoji", "id", "name"].sort());
    }

    const METADATA_BADGE_KEYS = ["id", "title", "subtitle", "emoji", "tier", "threshold", "regionId"];
    let sawRegionalThreshold = false;
    for (const badge of response.body.badges) {
      for (const key of Object.keys(badge)) {
        expect(METADATA_BADGE_KEYS).toContain(key);
      }
      expect(typeof badge.id).toBe("string");
      expect(typeof badge.title).toBe("string");
      expect(typeof badge.subtitle).toBe("string");
      expect(typeof badge.emoji).toBe("string");
      expect(typeof badge.tier).toBe("string");
      if ("threshold" in badge) {
        expect(Number.isInteger(badge.threshold)).toBe(true);
        if ("regionId" in badge) sawRegionalThreshold = true;
      }
      if ("regionId" in badge) expect(typeof badge.regionId).toBe("string");
    }
    expect(sawRegionalThreshold).toBe(true);
  });
});

describe("POST /api/cooked-posts", () => {
  it("accepts the 1.2 request body and returns the old response keys with newBadges as strings", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeWithCuisine(user._id, ["Lebanese"]);

    const response = await request(app)
      .post("/api/cooked-posts")
      .set(getAuthHeaders())
      .send({
        recipeId: recipe._id.toString(),
        photoUrl: "https://example.com/photo.jpg",
      });

    expect(response.status).toBe(201);
    expect(Object.keys(response.body).sort()).toEqual(
      ["newBadges", "newRegions", "newStamps", "post"].sort()
    );
    expect(Array.isArray(response.body.newBadges)).toBe(true);
    for (const id of response.body.newBadges) {
      expect(typeof id).toBe("string");
    }
    expect(response.body.newBadges).toContain("first_bite");
  });
});
