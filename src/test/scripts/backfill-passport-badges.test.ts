import { describe, expect, it, beforeEach } from "vitest";
import { Types } from "mongoose";
import User from "../../models/User";
import CookedPost from "../../models/CookedPost";
import { createTestUser } from "../helpers";
import {
  backfillPassportBadges,
  parseBackfillArgs,
} from "../../scripts/backfill-passport-badges";
import { LEGACY_CUISINE_REGIONS } from "../../lib/legacy-cuisine-regions";

function day(n: number): Date {
  return new Date(Date.UTC(2026, 2, n, 12));
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

describe("parseBackfillArgs", () => {
  it("defaults to a real run with no user scope for empty args", () => {
    expect(parseBackfillArgs([])).toEqual({ dryRun: false, userId: undefined });
  });

  it("sets dryRun true for the dry run flag", () => {
    expect(parseBackfillArgs(["--dry-run"])).toEqual({ dryRun: true, userId: undefined });
  });

  it("accepts a valid twenty four character hex user id", () => {
    const id = new Types.ObjectId().toString();
    expect(parseBackfillArgs([`--user-id=${id}`])).toEqual({ dryRun: false, userId: id });
  });

  it("throws for a user id that is not a valid object id", () => {
    expect(() => parseBackfillArgs(["--user-id=not-an-id"])).toThrow();
  });

  it("throws for an argument it does not recognize", () => {
    expect(() => parseBackfillArgs(["--bogus"])).toThrow();
  });
});

describe("backfillPassportBadges", () => {
  let userA: Awaited<ReturnType<typeof createTestUser>>;
  let userB: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    userA = await createTestUser({ email: "backfilla@test.com" });
    userB = await createTestUser({ email: "backfillb@test.com" });

    await cookCuisine(userA._id, "Australian", day(1));
    await cookCuisine(userA._id, "New Zealand", day(2));
    await cookCuisine(userA._id, "Hawaiian", day(3));
    await cookCuisine(userA._id, "Polynesian", day(4));
    await cookCuisine(userA._id, "Italian", day(5));
    await cookCuisine(userA._id, "French", day(6));
    await cookCuisine(userA._id, "Spanish", day(7));
    await cookCuisine(userA._id, "Greek", day(8));
    const portuguese = await cookCuisine(userA._id, "Portuguese", day(9));
    await cookCuisine(userA._id, "German", day(10));
    await CookedPost.updateOne({ _id: portuguese._id }, { $set: { removedAt: new Date() } });

    await cookCuisine(userB._id, "Japanese", day(20));
  });

  it("plans without writing on a dry run, reporting the four badges user A would earn", async () => {
    const result = await backfillPassportBadges({ dryRun: true, userId: userA._id.toString() });

    expect(result.scannedUsers).toBe(1);
    expect(result.usersChanged).toBe(1);
    expect(result.badgesAdded).toBe(4);
    expect(result.datesCorrected).toBe(0);

    const stored = await User.findById(userA._id).lean();
    expect(stored?.passportBadges).toBeUndefined();
  });

  it("stores first_bite, region_oceania, and region_europe on their true historical dates and logs one line for A", async () => {
    const lines: string[] = [];
    const result = await backfillPassportBadges({
      dryRun: false,
      userId: userA._id.toString(),
      log: (line) => lines.push(line),
    });

    expect(result.usersChanged).toBe(1);
    expect(result.badgesAdded).toBe(4);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(userA._id.toString());

    const stored = await User.findById(userA._id).lean();
    const byId = new Map(stored?.passportBadges?.map((b) => [b.id, b.earnedAt]));
    expect(byId.get("first_bite")?.getTime()).toBe(day(1).getTime());
    expect(byId.get("region_oceania")?.getTime()).toBe(day(4).getTime());
    expect(byId.get("region_europe")?.getTime()).toBe(day(9).getTime());
  });

  it("makes no further changes on a second real run for the same user", async () => {
    await backfillPassportBadges({ dryRun: false, userId: userA._id.toString() });
    const firstStored = await User.findById(userA._id).lean();

    const second = await backfillPassportBadges({ dryRun: false, userId: userA._id.toString() });

    expect(second.usersChanged).toBe(0);
    expect(second.badgesAdded).toBe(0);
    expect(second.datesCorrected).toBe(0);

    const secondStored = await User.findById(userA._id).lean();
    expect(secondStored?.passportBadges).toEqual(firstStored?.passportBadges);
  });

  it("corrects a stored badge dated later than its true history and never removes a badge history does not support", async () => {
    const chef = await createTestUser({ email: "backfillcorrect@test.com" });
    await cookCuisine(chef._id, "Lebanese", day(5));
    await User.updateOne(
      { _id: chef._id },
      {
        $set: {
          passportBadges: [
            { id: "first_bite", earnedAt: day(20) },
            { id: "explorer", earnedAt: day(1) },
          ],
        },
      }
    );

    const result = await backfillPassportBadges({ dryRun: false, userId: chef._id.toString() });

    expect(result.datesCorrected).toBe(1);
    expect(result.badgesAdded).toBe(0);

    const stored = await User.findById(chef._id).lean();
    const byId = new Map(stored?.passportBadges?.map((b) => [b.id, b.earnedAt]));
    expect(byId.get("first_bite")?.getTime()).toBe(day(5).getTime());
    expect(byId.get("explorer")?.getTime()).toBe(day(1).getTime());
  });

  it("leaves user B alone when the user id option scopes the run to user A", async () => {
    await backfillPassportBadges({ dryRun: false, userId: userA._id.toString() });

    const storedB = await User.findById(userB._id).lean();
    expect(storedB?.passportBadges).toBeUndefined();
  });

  it("counts a post whose user no longer exists as missingUsers without throwing", async () => {
    const ghostId = new Types.ObjectId();
    await CookedPost.create({
      userId: ghostId,
      recipeId: null,
      recipeTitle: "Test Recipe",
      recipeAuthorId: ghostId,
      photoUrl: "https://example.com/ghost.jpg",
      cuisineTags: ["Thai"],
      createdAt: day(1),
    });

    const result = await backfillPassportBadges({ dryRun: false });

    expect(result.missingUsers).toBe(1);
    expect(result.scannedUsers).toBe(3);
  });

  it("awards the legacy planet_eater badge for all 77 pre 1.3 cuisines even though today's catalogue is larger", async () => {
    const chef = await createTestUser({ email: "backfillplanet@test.com" });
    const legacyCuisines = LEGACY_CUISINE_REGIONS.flatMap((region) => region.cuisines);
    expect(legacyCuisines).toHaveLength(77);

    await Promise.all(
      legacyCuisines.map((cuisine, i) => cookCuisine(chef._id, cuisine, day(i + 1)))
    );

    const result = await backfillPassportBadges({ dryRun: false, userId: chef._id.toString() });

    expect(result.badgesAdded).toBeGreaterThan(0);
    const stored = await User.findById(chef._id).lean();
    const planetEater = stored?.passportBadges?.find((b) => b.id === "planet_eater");
    expect(planetEater).toBeDefined();
    expect(planetEater?.earnedAt.getTime()).toBe(day(77).getTime());
  });
});
