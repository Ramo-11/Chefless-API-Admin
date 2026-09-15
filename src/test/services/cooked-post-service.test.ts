import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import User from "../../models/User";
import Recipe from "../../models/Recipe";
import CookedPost from "../../models/CookedPost";
import { createTestUser } from "../helpers";
import { createCookedPost } from "../../services/cooked-post-service";

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

describe("cooked-post-service unlockedCuisines denormalization", () => {
  it("seeds unlockedCuisines on a brand new account's first post", async () => {
    const chef = await createTestUser({ email: "chef1@test.com" });
    const recipe = await createRecipeWithCuisine(chef._id, ["Italian"]);

    const result = await createCookedPost({
      userId: chef._id.toString(),
      recipeId: recipe._id.toString(),
      photoUrl: "https://example.com/photo.jpg",
    });

    expect(result.newStamps).toEqual(["Italian"]);

    const updatedUser = await User.findById(chef._id).lean();
    expect(updatedUser?.unlockedCuisines).toEqual(["Italian"]);
  });

  it("does not re-flag an already-unlocked cuisine as new once denormalized", async () => {
    const chef = await createTestUser({ email: "chef2@test.com" });
    const recipeA = await createRecipeWithCuisine(chef._id, ["Italian"]);
    const recipeB = await createRecipeWithCuisine(chef._id, ["Italian"]);

    await createCookedPost({
      userId: chef._id.toString(),
      recipeId: recipeA._id.toString(),
      photoUrl: "https://example.com/photo-a.jpg",
    });

    const second = await createCookedPost({
      userId: chef._id.toString(),
      recipeId: recipeB._id.toString(),
      photoUrl: "https://example.com/photo-b.jpg",
    });

    expect(second.newStamps).toEqual([]);

    const updatedUser = await User.findById(chef._id).lean();
    expect(updatedUser?.unlockedCuisines).toEqual(["Italian"]);
  });

  it("falls back to scanning post history when unlockedCuisines is absent, then self-heals the field", async () => {
    const chef = await createTestUser({ email: "chef3@test.com" });
    const legacyRecipe = await createRecipeWithCuisine(chef._id, ["Italian"]);

    await CookedPost.create({
      userId: chef._id,
      recipeId: legacyRecipe._id,
      recipeTitle: legacyRecipe.title,
      recipeAuthorId: chef._id,
      photoUrl: "https://example.com/legacy.jpg",
      cuisineTags: ["Italian"],
    });

    const userBefore = await User.findById(chef._id).lean();
    expect(userBefore?.unlockedCuisines).toBeUndefined();

    const newRecipe = await createRecipeWithCuisine(chef._id, ["Thai"]);
    const result = await createCookedPost({
      userId: chef._id.toString(),
      recipeId: newRecipe._id.toString(),
      photoUrl: "https://example.com/new.jpg",
    });

    expect(result.newStamps).toEqual(["Thai"]);

    const userAfter = await User.findById(chef._id).lean();
    expect(userAfter?.unlockedCuisines?.sort()).toEqual(["Italian", "Thai"]);
  });
});

describe("cooked-post-service passport badges", () => {
  it("returns first_bite in newBadges on the first ever post and stores it dated to that post", async () => {
    const chef = await createTestUser({ email: "badgechef1@test.com" });
    const recipe = await createRecipeWithCuisine(chef._id, ["Lebanese"]);

    const result = await createCookedPost({
      userId: chef._id.toString(),
      recipeId: recipe._id.toString(),
      photoUrl: "https://example.com/photo.jpg",
    });

    expect(result.newBadges).toContain("first_bite");

    const updatedUser = await User.findById(chef._id).lean();
    const stored = updatedUser?.passportBadges?.find((b) => b.id === "first_bite");
    expect(stored?.earnedAt.getTime()).toBe(result.post.createdAt.getTime());
  });

  it("awards region_europe only once five distinct European cuisines are cooked, not at four", async () => {
    const chef = await createTestUser({ email: "badgechef2@test.com" });
    const europeanCuisines = ["Italian", "French", "Spanish", "Greek", "Portuguese"];
    let lastResult;
    for (const cuisine of europeanCuisines) {
      const recipe = await createRecipeWithCuisine(chef._id, [cuisine]);
      lastResult = await createCookedPost({
        userId: chef._id.toString(),
        recipeId: recipe._id.toString(),
        photoUrl: `https://example.com/${cuisine.toLowerCase()}.jpg`,
      });
      if (cuisine !== "Portuguese") {
        expect(lastResult.newBadges).not.toContain("region_europe");
      }
    }

    expect(lastResult!.newBadges).toContain("region_europe");

    const updatedUser = await User.findById(chef._id).lean();
    const stored = updatedUser?.passportBadges?.find((b) => b.id === "region_europe");
    expect(stored?.earnedAt.getTime()).toBe(lastResult!.post.createdAt.getTime());
  });

  it("does not re-award region_oceania on a fifth cuisine when it is already stored from the old four cuisine rule", async () => {
    const chef = await createTestUser({ email: "badgechef3@test.com" });
    const storedDate = new Date("2025-01-01T00:00:00.000Z");
    await User.updateOne(
      { _id: chef._id },
      {
        $set: {
          unlockedCuisines: ["Australian", "New Zealand", "Hawaiian", "Polynesian"],
          passportBadges: [{ id: "region_oceania", earnedAt: storedDate }],
        },
      }
    );
    const recipe = await createRecipeWithCuisine(chef._id, ["Fijian"]);

    const result = await createCookedPost({
      userId: chef._id.toString(),
      recipeId: recipe._id.toString(),
      photoUrl: "https://example.com/fijian.jpg",
    });

    expect(result.newBadges).not.toContain("region_oceania");

    const updatedUser = await User.findById(chef._id).lean();
    const stored = updatedUser?.passportBadges?.find((b) => b.id === "region_oceania");
    expect(stored?.earnedAt.getTime()).toBe(storedDate.getTime());
  });

  it("still resolves with the post and newBadges when the badge storage write rejects", async () => {
    const chef = await createTestUser({ email: "badgechef4@test.com" });
    const recipe = await createRecipeWithCuisine(chef._id, ["Lebanese"]);

    const original = User.updateOne.bind(User);
    const updateSpy = vi
      .spyOn(User, "updateOne")
      .mockImplementation(((...args: Parameters<typeof User.updateOne>) => {
        const [, update] = args;
        if (Array.isArray(update)) {
          return Promise.reject(new Error("simulated pipeline failure"));
        }
        return original(...args);
      }) as typeof User.updateOne);

    const result = await createCookedPost({
      userId: chef._id.toString(),
      recipeId: recipe._id.toString(),
      photoUrl: "https://example.com/photo.jpg",
    });
    updateSpy.mockRestore();

    expect(result.post).toBeDefined();
    expect(result.newBadges).toContain("first_bite");

    const updatedUser = await User.findById(chef._id).lean();
    expect(updatedUser?.passportBadges).toBeUndefined();
  });
});
