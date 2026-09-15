import { Types } from "mongoose";
import CookedPost from "../models/CookedPost";
import User from "../models/User";
import {
  ALL_BADGES,
  BadgeDefinition,
  badgeProgress,
  canonicalCuisine,
  CUISINE_REGIONS,
  earnedBadgeIds,
} from "../lib/cuisines";
import {
  badgeEarnedDates,
  CURRENT_BADGE_REQUIREMENTS,
  EarnedPassportBadge,
  firstCookedByCuisine,
  knownPersistedBadges,
  recordPassportBadges,
} from "../lib/passport-badges";

interface AppError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): AppError {
  const error = new Error(message) as AppError;
  error.statusCode = statusCode;
  return error;
}

export interface CuisineStamp {
  cuisine: string;
  count: number;
  firstCookedAt: Date;
  lastCookedAt: Date;
  /** A few recent photo URLs (up to 3) for rendering the stamp preview. */
  samplePhotos: string[];
  /** Region id the cuisine belongs to, or null for unmapped cuisines. */
  regionId: string | null;
}

export interface RegionProgress {
  id: string;
  name: string;
  emoji: string;
  total: number;
  unlocked: number;
  /** Canonical cuisines in this region, in display order. */
  cuisines: string[];
  /** Subset of `cuisines` the user has unlocked. */
  unlockedCuisines: string[];
}

export interface PassportBadge {
  id: string;
  title: string;
  subtitle: string;
  emoji: string;
  tier: string;
  /** True once the user has earned this badge. */
  earned: boolean;
  earnedAt?: string;
  threshold?: number;
  /** Current progress value toward this badge (unique cuisines cooked). */
  progress?: number;
  /** Populated for regional badges; undefined for global ones. */
  regionId?: string;
}

export interface PassportSummary {
  userId: string;
  displayName: string;
  profilePicture: string | null;
  totalPosts: number;
  uniqueCuisines: number;
  totalCuisines: number;
  stamps: CuisineStamp[];
  regions: RegionProgress[];
  badges: PassportBadge[];
  /** Most-recent single post — useful for the passport hero tile. */
  latestPhotoUrl: string | null;
  /** UTC timestamp of the first-ever cooked post. Null for new users. */
  startedAt: Date | null;
}

/**
 * Build a user's passport summary: unlocked cuisines with sample photos,
 * per-region progress, earned badges, and aggregate counts.
 */
export async function getPassportSummary(
  userId: string
): Promise<PassportSummary> {
  const userOid = new Types.ObjectId(userId);

  const [user, totalPosts, aggregate, latestPost] = await Promise.all([
    User.findById(userId).select("fullName profilePicture passportBadges").lean(),
    CookedPost.countDocuments({ userId: userOid }),
    CookedPost.aggregate<{
      _id: string;
      count: number;
      firstCookedAt: Date;
      lastCookedAt: Date;
      samplePhotos: string[];
    }>([
      { $match: { userId: userOid } },
      { $sort: { _id: -1 } },
      { $unwind: "$cuisineTags" },
      {
        $group: {
          _id: "$cuisineTags",
          count: { $sum: 1 },
          firstCookedAt: { $min: "$createdAt" },
          lastCookedAt: { $max: "$createdAt" },
          samplePhotos: { $push: "$photoUrl" },
        },
      },
    ]),
    CookedPost.findOne({ userId: userOid })
      .sort({ _id: -1 })
      .select("photoUrl createdAt")
      .lean(),
  ]);

  if (!user) throw createError("User not found", 404);

  const unlocked = new Set<string>();
  const stamps: CuisineStamp[] = [];
  for (const row of aggregate) {
    const canonical = canonicalCuisine(row._id) ?? row._id;
    unlocked.add(canonical);

    const region = CUISINE_REGIONS.find((r) =>
      r.cuisines.includes(canonical)
    );

    stamps.push({
      cuisine: canonical,
      count: row.count,
      firstCookedAt: row.firstCookedAt,
      lastCookedAt: row.lastCookedAt,
      samplePhotos: row.samplePhotos.slice(0, 3),
      regionId: region?.id ?? null,
    });
  }

  // Sort stamps by most-recent first for better UX — users see their newest
  // unlocks at the top of the passport.
  stamps.sort((a, b) => b.lastCookedAt.getTime() - a.lastCookedAt.getTime());

  const regions: RegionProgress[] = CUISINE_REGIONS.map((region) => {
    const unlockedCuisines = region.cuisines.filter((c) => unlocked.has(c));
    return {
      id: region.id,
      name: region.name,
      emoji: region.emoji,
      total: region.cuisines.length,
      unlocked: unlockedCuisines.length,
      cuisines: [...region.cuisines],
      unlockedCuisines,
    };
  });

  const totalCuisines = CUISINE_REGIONS.reduce(
    (sum, r) => sum + r.cuisines.length,
    0
  );

  const firstCooked = firstCookedByCuisine(
    aggregate.map((row) => ({ tag: row._id, firstCookedAt: row.firstCookedAt }))
  );
  const persisted = knownPersistedBadges(user.passportBadges);
  const liveDates = badgeEarnedDates(CURRENT_BADGE_REQUIREMENTS, firstCooked);
  const live = earnedBadgeIds(unlocked);

  const missing: EarnedPassportBadge[] = [];
  for (const id of live) {
    if (!persisted.has(id)) {
      missing.push({ id, earnedAt: liveDates.get(id) ?? new Date() });
    }
  }

  if (missing.length > 0) {
    try {
      await recordPassportBadges(userOid, missing);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`recordPassportBadges self heal failed: ${msg}`);
    }
    for (const badge of missing) {
      persisted.set(badge.id, badge.earnedAt);
    }
  }

  const badges: PassportBadge[] = ALL_BADGES.map((b: BadgeDefinition) => ({
    id: b.id,
    title: b.title,
    subtitle: b.subtitle,
    emoji: b.emoji,
    tier: b.tier,
    earned: persisted.has(b.id),
    earnedAt: persisted.get(b.id)?.toISOString(),
    threshold: b.threshold,
    progress: badgeProgress(b, unlocked),
    regionId: b.regionId,
  }));

  return {
    userId,
    displayName: user.fullName,
    profilePicture: user.profilePicture ?? null,
    totalPosts,
    uniqueCuisines: unlocked.size,
    totalCuisines,
    stamps,
    regions,
    badges,
    latestPhotoUrl: latestPost?.photoUrl ?? null,
    startedAt:
      stamps.length > 0
        ? stamps.reduce<Date | null>(
            (earliest, s) =>
              !earliest || s.firstCookedAt < earliest
                ? s.firstCookedAt
                : earliest,
            null
          )
        : null,
  };
}
