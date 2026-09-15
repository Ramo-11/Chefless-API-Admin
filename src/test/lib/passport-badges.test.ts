import { describe, expect, it } from "vitest";
import User from "../../models/User";
import { createTestUser } from "../helpers";
import {
  ALL_KNOWN_CUISINES,
  badgeProgress,
  CUISINE_REGIONS,
  earnedBadgeIds,
  REGIONAL_BADGES,
  regionalBadgeThreshold,
} from "../../lib/cuisines";
import { LEGACY_CUISINE_REGIONS } from "../../lib/legacy-cuisine-regions";
import {
  badgeEarnedDates,
  CURRENT_BADGE_REQUIREMENTS,
  firstCookedByCuisine,
  historicalBadgeDates,
  knownPersistedBadges,
  LEGACY_BADGE_REQUIREMENTS,
  planBadgeChanges,
  recordPassportBadges,
} from "../../lib/passport-badges";

function day(n: number): Date {
  return new Date(Date.UTC(2026, 3, n, 12));
}

function cooked(entries: Array<[string, number]>): Map<string, Date> {
  return firstCookedByCuisine(
    entries.map(([tag, n]) => ({ tag, firstCookedAt: day(n) }))
  );
}

describe("regional badge rule", () => {
  it("sets every regional badge threshold to five, or the region size when smaller", () => {
    for (const badge of REGIONAL_BADGES) {
      const region = CUISINE_REGIONS.find((r) => r.id === badge.regionId);
      expect(region).toBeDefined();
      expect(badge.threshold).toBe(Math.min(5, region!.cuisines.length));
    }
  });

  it("earns a region badge at five different cuisines from that region, not at the full list", () => {
    const europe = CUISINE_REGIONS.find((r) => r.id === "europe")!;
    const four = new Set(europe.cuisines.slice(0, 4));
    const five = new Set(europe.cuisines.slice(0, 5));

    expect(earnedBadgeIds(four).has("region_europe")).toBe(false);
    expect(earnedBadgeIds(five).has("region_europe")).toBe(true);
  });

  it("requires every cuisine when a region has exactly five", () => {
    const centralAsia = CUISINE_REGIONS.find((r) => r.id === "central_asia")!;
    expect(regionalBadgeThreshold(centralAsia)).toBe(centralAsia.cuisines.length);
    expect(
      earnedBadgeIds(new Set(centralAsia.cuisines.slice(0, 4))).has("region_central_asia")
    ).toBe(false);
    expect(earnedBadgeIds(new Set(centralAsia.cuisines)).has("region_central_asia")).toBe(true);
  });

  it("does not count cuisines from other regions toward a region badge", () => {
    const asia = CUISINE_REGIONS.find((r) => r.id === "east_se_asia")!;
    const mixed = new Set([...asia.cuisines.slice(0, 4), "Italian", "French"]);
    expect(earnedBadgeIds(mixed).has("region_east_se_asia")).toBe(false);
  });

  it("reports regional progress as cuisines cooked in that region capped at the threshold", () => {
    const europeBadge = REGIONAL_BADGES.find((b) => b.id === "region_europe")!;
    expect(badgeProgress(europeBadge, new Set(["Italian", "French", "Thai"]))).toBe(2);
    expect(
      badgeProgress(
        europeBadge,
        new Set(["Italian", "French", "Spanish", "Greek", "German", "Polish", "Irish"])
      )
    ).toBe(5);
  });

  it("writes regional subtitles as the rule in plain words without dashes", () => {
    for (const badge of REGIONAL_BADGES) {
      expect(badge.subtitle).toMatch(/^Cook (5 different cuisines|every cuisine) from this region\.$/);
      expect(badge.subtitle).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("legacy region definitions", () => {
  it("keeps the seven pre 1.3 regions whose badge ids still exist today", () => {
    expect(LEGACY_CUISINE_REGIONS).toHaveLength(7);
    for (const region of LEGACY_CUISINE_REGIONS) {
      expect(REGIONAL_BADGES.some((b) => b.id === `region_${region.id}`)).toBe(true);
    }
  });

  it("uses only cuisine names that are still canonical today so posts match", () => {
    for (const region of LEGACY_CUISINE_REGIONS) {
      for (const cuisine of region.cuisines) {
        expect(ALL_KNOWN_CUISINES.has(cuisine)).toBe(true);
      }
    }
  });

  it("requires all 77 legacy cuisines for the legacy planet eater badge", () => {
    const planet = LEGACY_BADGE_REQUIREMENTS.find((r) => r.id === "planet_eater")!;
    expect(planet.threshold).toBe(77);
  });
});

describe("badge earned dates", () => {
  it("dates a badge at the first cook of the cuisine that completed the set", () => {
    const dates = badgeEarnedDates(
      CURRENT_BADGE_REQUIREMENTS,
      cooked([
        ["Italian", 1],
        ["French", 3],
        ["Spanish", 2],
        ["Greek", 9],
        ["German", 5],
        ["Polish", 7],
      ])
    );

    expect(dates.get("first_bite")).toEqual(day(1));
    expect(dates.get("region_europe")).toEqual(day(7));
    expect(dates.has("explorer")).toBe(false);
  });

  it("uses the earliest cook when the same cuisine was cooked under different casing", () => {
    const map = firstCookedByCuisine([
      { tag: "italian", firstCookedAt: day(4) },
      { tag: "Italian", firstCookedAt: day(2) },
    ]);
    expect(map.get("Italian")).toEqual(day(2));
    expect(map.size).toBe(1);
  });

  it("awards an old complete region under the legacy rule even when today's rule is not met", () => {
    const dates = historicalBadgeDates(
      cooked([
        ["Australian", 1],
        ["New Zealand", 2],
        ["Hawaiian", 6],
        ["Polynesian", 4],
      ])
    );
    expect(dates.get("region_oceania")).toEqual(day(6));
  });

  it("takes the earlier date when both the legacy and the current rule earned the same badge", () => {
    const legacyEurope = LEGACY_CUISINE_REGIONS.find((r) => r.id === "europe")!;
    const entries: Array<[string, number]> = legacyEurope.cuisines.map((c, i) => [c, i + 1]);
    const dates = historicalBadgeDates(cooked(entries));
    expect(dates.get("region_europe")).toEqual(day(5));
  });
});

describe("persisted badge helpers", () => {
  it("ignores unknown badge ids and invalid dates instead of throwing", () => {
    const map = knownPersistedBadges([
      { id: "region_atlantis", earnedAt: day(1) },
      { id: "first_bite", earnedAt: new Date("not a date") },
      { id: "explorer", earnedAt: day(3) },
    ]);
    expect([...map.keys()]).toEqual(["explorer"]);
  });

  it("plans additions for new badges and corrections only for earlier dates", () => {
    const plan = planBadgeChanges(
      [
        { id: "first_bite", earnedAt: day(5) },
        { id: "explorer", earnedAt: day(2) },
      ],
      new Map([
        ["first_bite", day(1)],
        ["explorer", day(9)],
        ["region_europe", day(4)],
      ])
    );
    expect(plan.added).toEqual([{ id: "region_europe", earnedAt: day(4) }]);
    expect(plan.corrected).toEqual([{ id: "first_bite", earnedAt: day(1) }]);
  });
});

describe("recordPassportBadges", () => {
  it("creates the list on a user who never had one", async () => {
    const user = await createTestUser();
    const changed = await recordPassportBadges(user._id, [{ id: "first_bite", earnedAt: day(1) }]);

    expect(changed).toBe(true);
    const stored = await User.findById(user._id).lean();
    expect(stored?.passportBadges).toEqual([{ id: "first_bite", earnedAt: day(1) }]);
  });

  it("never removes a badge that is already stored", async () => {
    const user = await createTestUser();
    await recordPassportBadges(user._id, [{ id: "region_oceania", earnedAt: day(2) }]);
    await recordPassportBadges(user._id, [{ id: "first_bite", earnedAt: day(3) }]);

    const stored = await User.findById(user._id).lean();
    expect(stored?.passportBadges?.map((b) => b.id).sort()).toEqual(["first_bite", "region_oceania"]);
  });

  it("keeps the earliest date and reports no change when nothing new arrives", async () => {
    const user = await createTestUser();
    await recordPassportBadges(user._id, [{ id: "first_bite", earnedAt: day(5) }]);

    expect(await recordPassportBadges(user._id, [{ id: "first_bite", earnedAt: day(8) }])).toBe(false);
    expect(await recordPassportBadges(user._id, [{ id: "first_bite", earnedAt: day(2) }])).toBe(true);

    const stored = await User.findById(user._id).lean();
    expect(stored?.passportBadges).toEqual([{ id: "first_bite", earnedAt: day(2) }]);
  });

  it("persists a badge once when two requests award it at the same time", async () => {
    const user = await createTestUser();
    await Promise.all([
      recordPassportBadges(user._id, [{ id: "region_europe", earnedAt: day(3) }]),
      recordPassportBadges(user._id, [{ id: "region_europe", earnedAt: day(3) }]),
      recordPassportBadges(user._id.toString(), [{ id: "region_europe", earnedAt: day(4) }]),
    ]);

    const stored = await User.findById(user._id).lean();
    expect(stored?.passportBadges).toEqual([{ id: "region_europe", earnedAt: day(3) }]);
  });

  it("drops unknown ids and duplicate ids before writing", async () => {
    const user = await createTestUser();
    const changed = await recordPassportBadges(user._id, [
      { id: "region_atlantis", earnedAt: day(1) },
      { id: "explorer", earnedAt: day(6) },
      { id: "explorer", earnedAt: day(4) },
    ]);

    expect(changed).toBe(true);
    const stored = await User.findById(user._id).lean();
    expect(stored?.passportBadges).toEqual([{ id: "explorer", earnedAt: day(4) }]);
  });

  it("does not write at all when every id is unknown", async () => {
    const user = await createTestUser();
    expect(await recordPassportBadges(user._id, [{ id: "region_atlantis", earnedAt: day(1) }])).toBe(false);
    const stored = await User.findById(user._id).lean();
    expect(stored?.passportBadges).toBeUndefined();
  });
});
