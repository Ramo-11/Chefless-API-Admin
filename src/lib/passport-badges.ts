import { Types } from "mongoose";
import User from "../models/User";
import {
  canonicalCuisine,
  CUISINE_REGIONS,
  GLOBAL_BADGES,
  KNOWN_BADGE_IDS,
  regionalBadgeThreshold,
} from "./cuisines";
import { LEGACY_CUISINE_REGIONS } from "./legacy-cuisine-regions";

export interface EarnedPassportBadge {
  id: string;
  earnedAt: Date;
}

export interface BadgeRequirement {
  id: string;
  threshold: number;
  cuisines: ReadonlySet<string> | null;
}

export interface CuisineFirstCook {
  tag: string;
  firstCookedAt: Date;
}

export const CURRENT_BADGE_REQUIREMENTS: readonly BadgeRequirement[] = [
  ...GLOBAL_BADGES.flatMap((badge) =>
    badge.threshold === undefined
      ? []
      : [{ id: badge.id, threshold: badge.threshold, cuisines: null }]
  ),
  ...CUISINE_REGIONS.map((region) => ({
    id: `region_${region.id}`,
    threshold: regionalBadgeThreshold(region),
    cuisines: new Set(region.cuisines),
  })),
];

const LEGACY_KNOWN_CUISINES = LEGACY_CUISINE_REGIONS.flatMap(
  (region) => region.cuisines
);

export const LEGACY_BADGE_REQUIREMENTS: readonly BadgeRequirement[] = [
  {
    id: "planet_eater",
    threshold: LEGACY_KNOWN_CUISINES.length,
    cuisines: new Set(LEGACY_KNOWN_CUISINES),
  },
  ...LEGACY_CUISINE_REGIONS.map((region) => ({
    id: `region_${region.id}`,
    threshold: region.cuisines.length,
    cuisines: new Set(region.cuisines),
  })),
];

export function cuisineKey(tag: string): string {
  return canonicalCuisine(tag) ?? tag;
}

export function firstCookedByCuisine(
  rows: Iterable<CuisineFirstCook>
): Map<string, Date> {
  const result = new Map<string, Date>();
  for (const row of rows) {
    const key = cuisineKey(row.tag);
    if (!key) continue;
    const existing = result.get(key);
    if (!existing || row.firstCookedAt < existing) {
      result.set(key, row.firstCookedAt);
    }
  }
  return result;
}

export function badgeEarnedDates(
  requirements: readonly BadgeRequirement[],
  firstCooked: ReadonlyMap<string, Date>
): Map<string, Date> {
  const result = new Map<string, Date>();
  for (const requirement of requirements) {
    if (requirement.threshold <= 0) continue;
    const dates: Date[] = [];
    for (const [cuisine, date] of firstCooked) {
      if (!requirement.cuisines || requirement.cuisines.has(cuisine)) {
        dates.push(date);
      }
    }
    if (dates.length < requirement.threshold) continue;
    dates.sort((a, b) => a.getTime() - b.getTime());
    result.set(requirement.id, dates[requirement.threshold - 1]);
  }
  return result;
}

export function earliestBadgeDates(
  ...sources: ReadonlyMap<string, Date>[]
): Map<string, Date> {
  const result = new Map<string, Date>();
  for (const source of sources) {
    for (const [id, date] of source) {
      const existing = result.get(id);
      if (!existing || date < existing) result.set(id, date);
    }
  }
  return result;
}

export function historicalBadgeDates(
  firstCooked: ReadonlyMap<string, Date>
): Map<string, Date> {
  return earliestBadgeDates(
    badgeEarnedDates(CURRENT_BADGE_REQUIREMENTS, firstCooked),
    badgeEarnedDates(LEGACY_BADGE_REQUIREMENTS, firstCooked)
  );
}

export function knownPersistedBadges(
  persisted: readonly EarnedPassportBadge[] | null | undefined
): Map<string, Date> {
  const result = new Map<string, Date>();
  for (const badge of persisted ?? []) {
    if (!badge || typeof badge.id !== "string") continue;
    if (!KNOWN_BADGE_IDS.has(badge.id)) continue;
    const earnedAt = new Date(badge.earnedAt);
    if (Number.isNaN(earnedAt.getTime())) continue;
    const existing = result.get(badge.id);
    if (!existing || earnedAt < existing) result.set(badge.id, earnedAt);
  }
  return result;
}

export interface BadgeChangePlan {
  added: EarnedPassportBadge[];
  corrected: EarnedPassportBadge[];
}

export function planBadgeChanges(
  persisted: readonly EarnedPassportBadge[] | null | undefined,
  computed: ReadonlyMap<string, Date>
): BadgeChangePlan {
  const current = knownPersistedBadges(persisted);
  const added: EarnedPassportBadge[] = [];
  const corrected: EarnedPassportBadge[] = [];
  for (const [id, earnedAt] of computed) {
    if (!KNOWN_BADGE_IDS.has(id)) continue;
    const existing = current.get(id);
    if (!existing) {
      added.push({ id, earnedAt });
    } else if (earnedAt < existing) {
      corrected.push({ id, earnedAt });
    }
  }
  return { added, corrected };
}

export async function recordPassportBadges(
  userId: Types.ObjectId | string,
  badges: readonly EarnedPassportBadge[]
): Promise<boolean> {
  const incoming = [...knownPersistedBadges(badges)].map(([id, earnedAt]) => ({
    id,
    earnedAt,
  }));
  if (incoming.length === 0) return false;

  const result = await User.updateOne(
    { _id: new Types.ObjectId(userId) },
    [
      {
        $set: {
          passportBadges: {
            $let: {
              vars: {
                existing: { $ifNull: ["$passportBadges", []] },
                incoming: { $literal: incoming },
              },
              in: {
                $concatArrays: [
                  {
                    $map: {
                      input: "$$existing",
                      as: "p",
                      in: {
                        id: "$$p.id",
                        earnedAt: {
                          $min: [
                            "$$p.earnedAt",
                            {
                              $let: {
                                vars: {
                                  match: {
                                    $arrayElemAt: [
                                      {
                                        $filter: {
                                          input: "$$incoming",
                                          as: "i",
                                          cond: { $eq: ["$$i.id", "$$p.id"] },
                                        },
                                      },
                                      0,
                                    ],
                                  },
                                },
                                in: "$$match.earnedAt",
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                  {
                    $filter: {
                      input: "$$incoming",
                      as: "i",
                      cond: {
                        $not: [{ $in: ["$$i.id", "$$existing.id"] }],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ],
    { timestamps: false }
  );
  return result.modifiedCount > 0;
}
