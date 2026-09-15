import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import User from "../../models/User";
import CookedPost from "../../models/CookedPost";
import { createTestUser } from "../helpers";
import { getPassportSummary } from "../../services/passport-service";
import { deleteCookedPost } from "../../services/cooked-post-service";
import { CUISINE_REGIONS } from "../../lib/cuisines";

function day(n: number): Date {
  return new Date(Date.UTC(2026, 5, n, 12));
}

async function cookCuisine(userId: Types.ObjectId, cuisine: string, createdAt: Date) {
  return CookedPost.create({
    userId,
    recipeId: null,
    recipeTitle: "Test Recipe",
    recipeAuthorId: userId,
    photoUrl: `https://example.com/${cuisine.toLowerCase().replace(/\s+/g, "-")}.jpg`,
    cuisineTags: [cuisine],
    createdAt,
  });
}

describe("getPassportSummary", () => {
  it("returns every badge unearned with no earnedAt key and writes nothing for a user with no cooked posts", async () => {
    const user = await createTestUser();

    const summary = await getPassportSummary(user._id.toString());

    expect(summary.regions.every((region) => region.unlocked === 0)).toBe(true);
    expect(summary.badges.every((badge) => badge.earned === false)).toBe(true);
    const serializedBadges = JSON.parse(JSON.stringify(summary.badges));
    for (const badge of serializedBadges) {
      expect(badge).not.toHaveProperty("earnedAt");
    }

    const stored = await User.findById(user._id).lean();
    expect(stored?.passportBadges).toBeUndefined();
  });

  it("caps regional progress at the regional threshold and global progress at total unique cuisines cooked", async () => {
    const chef = await createTestUser();
    let cursor = 1;
    let uniqueCount = 0;
    for (const region of CUISINE_REGIONS) {
      const sample = region.cuisines.slice(0, 3);
      for (const cuisine of sample) {
        await cookCuisine(chef._id, cuisine, day(cursor));
        cursor += 1;
        uniqueCount += 1;
      }
    }

    const summary = await getPassportSummary(chef._id.toString());

    for (const badge of summary.badges) {
      if (badge.regionId) {
        const region = CUISINE_REGIONS.find((r) => r.id === badge.regionId)!;
        const cooked = Math.min(3, region.cuisines.length);
        const expectedThreshold = Math.min(5, region.cuisines.length);
        expect(badge.threshold).toBe(expectedThreshold);
        expect(badge.progress).toBe(Math.min(cooked, expectedThreshold));
      } else {
        expect(badge.progress).toBe(Math.min(uniqueCount, badge.threshold!));
      }
    }
  });

  it("self heals first_bite and region_europe for posts that predate the badges feature, dating each to the post that completed it", async () => {
    const chef = await createTestUser();
    const firstPost = await cookCuisine(chef._id, "Italian", day(1));
    expect(firstPost.createdAt.getTime()).toBe(day(1).getTime());
    await cookCuisine(chef._id, "French", day(2));
    await cookCuisine(chef._id, "Spanish", day(3));
    await cookCuisine(chef._id, "Greek", day(4));
    await cookCuisine(chef._id, "Portuguese", day(5));

    const summary = await getPassportSummary(chef._id.toString());

    const firstBite = summary.badges.find((b) => b.id === "first_bite")!;
    const regionEurope = summary.badges.find((b) => b.id === "region_europe")!;
    expect(firstBite.earned).toBe(true);
    expect(firstBite.earnedAt).toBe(day(1).toISOString());
    expect(regionEurope.earned).toBe(true);
    expect(regionEurope.earnedAt).toBe(day(5).toISOString());

    const stored = await User.findById(chef._id).lean();
    expect(stored?.passportBadges?.map((b) => b.id).sort()).toEqual(["first_bite", "region_europe"]);
    const storedFirstBite = stored?.passportBadges?.find((b) => b.id === "first_bite");
    const storedRegionEurope = stored?.passportBadges?.find((b) => b.id === "region_europe");
    expect(storedFirstBite?.earnedAt.getTime()).toBe(day(1).getTime());
    expect(storedRegionEurope?.earnedAt.getTime()).toBe(day(5).getTime());
  });

  it("does not issue a badge write pipeline on a second call and returns the same earned dates", async () => {
    const chef = await createTestUser();
    await cookCuisine(chef._id, "Lebanese", day(1));

    const first = await getPassportSummary(chef._id.toString());
    const updateSpy = vi.spyOn(User, "updateOne");

    const second = await getPassportSummary(chef._id.toString());

    const pipelineCalls = updateSpy.mock.calls.filter(([, update]) => Array.isArray(update));
    expect(pipelineCalls).toHaveLength(0);
    updateSpy.mockRestore();

    const firstEarnedDates = first.badges.filter((b) => b.earned).map((b) => [b.id, b.earnedAt]);
    const secondEarnedDates = second.badges.filter((b) => b.earned).map((b) => [b.id, b.earnedAt]);
    expect(secondEarnedDates).toEqual(firstEarnedDates);
  });

  it("keeps a stored region badge earned at its old date when the region grows past the live count", async () => {
    const chef = await createTestUser();
    const storedDate = day(1);
    await User.updateOne(
      { _id: chef._id },
      { $set: { passportBadges: [{ id: "region_oceania", earnedAt: storedDate }] } }
    );
    await cookCuisine(chef._id, "Australian", day(2));
    await cookCuisine(chef._id, "New Zealand", day(3));
    await cookCuisine(chef._id, "Hawaiian", day(4));
    await cookCuisine(chef._id, "Polynesian", day(5));

    const summary = await getPassportSummary(chef._id.toString());

    const badge = summary.badges.find((b) => b.id === "region_oceania")!;
    expect(badge.earned).toBe(true);
    expect(badge.earnedAt).toBe(storedDate.toISOString());
    expect(badge.threshold).toBe(5);
    expect(badge.progress).toBe(4);

    const region = summary.regions.find((r) => r.id === "oceania")!;
    expect(region.unlocked).toBe(4);
    expect(region.total).toBe(8);
  });

  it("keeps a persisted badge earned after every post behind it is soft removed and then hard deleted", async () => {
    const chef = await createTestUser();
    const first = await cookCuisine(chef._id, "Lebanese", day(1));
    const second = await cookCuisine(chef._id, "Turkish", day(2));

    await getPassportSummary(chef._id.toString());
    const beforeDelete = await User.findById(chef._id).lean();
    expect(beforeDelete?.passportBadges?.some((b) => b.id === "first_bite")).toBe(true);

    await CookedPost.updateOne({ _id: first._id }, { $set: { removedAt: new Date() } });
    await CookedPost.updateOne({ _id: second._id }, { $set: { removedAt: new Date() } });
    await deleteCookedPost(first._id.toString(), chef._id.toString());
    await deleteCookedPost(second._id.toString(), chef._id.toString());

    const remaining = await CookedPost.countDocuments({ userId: chef._id });
    expect(remaining).toBe(0);

    const summary = await getPassportSummary(chef._id.toString());
    const firstBite = summary.badges.find((b) => b.id === "first_bite")!;
    expect(firstBite.earned).toBe(true);
    expect(firstBite.earnedAt).toBe(day(1).toISOString());
  });

  it("ignores an unknown persisted badge id without error and never returns it", async () => {
    const chef = await createTestUser();
    await User.updateOne(
      { _id: chef._id },
      { $set: { passportBadges: [{ id: "region_atlantis", earnedAt: day(1) }] } }
    );

    const summary = await getPassportSummary(chef._id.toString());

    expect(summary.badges.some((b) => b.id === "region_atlantis")).toBe(false);
    expect(summary.badges.every((b) => b.earned === false)).toBe(true);
  });

  it("still resolves the summary with the badge earned when the self heal write rejects", async () => {
    const chef = await createTestUser();
    await cookCuisine(chef._id, "Lebanese", day(1));

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

    const summary = await getPassportSummary(chef._id.toString());
    updateSpy.mockRestore();

    const firstBite = summary.badges.find((b) => b.id === "first_bite")!;
    expect(firstBite.earned).toBe(true);
    expect(firstBite.earnedAt).toBe(day(1).toISOString());

    const stored = await User.findById(chef._id).lean();
    expect(stored?.passportBadges).toBeUndefined();
  });

  it("returns the union of stored and live badges when called for a different user's id", async () => {
    const other = await createTestUser();
    const storedDate = day(1);
    await User.updateOne(
      { _id: other._id },
      { $set: { passportBadges: [{ id: "region_oceania", earnedAt: storedDate }] } }
    );
    await cookCuisine(other._id, "Lebanese", day(2));

    const summary = await getPassportSummary(other._id.toString());

    const oceania = summary.badges.find((b) => b.id === "region_oceania")!;
    const firstBite = summary.badges.find((b) => b.id === "first_bite")!;
    expect(oceania.earned).toBe(true);
    expect(oceania.earnedAt).toBe(storedDate.toISOString());
    expect(firstBite.earned).toBe(true);
    expect(firstBite.earnedAt).toBe(day(2).toISOString());
  });
});
