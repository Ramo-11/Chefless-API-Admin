import { Request, Response } from "express";
import User from "../../models/User";
import Recipe from "../../models/Recipe";
import Kitchen from "../../models/Kitchen";
import ScheduleEntry from "../../models/ScheduleEntry";
import Report from "../../models/Report";
import { logger } from "../../lib/logger";

interface DailyCount {
  date: string;
  count: number;
}

interface WeeklyCount {
  week: string;
  count: number;
}

interface TagCount {
  tag: string;
  count: number;
}

interface TopUser {
  _id: string;
  fullName: string;
  email: string;
  recipesCount: number;
  followersCount: number;
  followingCount: number;
}

interface TopRecipe {
  _id: string;
  title: string;
  authorName: string;
  likesCount: number;
  forksCount: number;
}

interface KitchenSizeBucket {
  range: string;
  count: number;
}

interface ActiveKitchen {
  kitchenId: string;
  kitchenName: string;
  entryCount: number;
}

interface StatusCount {
  status: string;
  count: number;
}

interface ReasonCount {
  reason: string;
  count: number;
}

function getDaysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function getWeeksAgo(weeks: number): Date {
  return new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);
}

/** Fill gaps in daily counts so charts have continuous data */
function fillDailyCounts(
  rawCounts: Array<{ _id: string; count: number }>,
  days: number
): DailyCount[] {
  const map = new Map<string, number>();
  for (const r of rawCounts) {
    map.set(r._id, r.count);
  }

  const result: DailyCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, count: map.get(key) ?? 0 });
  }
  return result;
}

/** Fill gaps in weekly counts */
function fillWeeklyCounts(
  rawCounts: Array<{ _id: { year: number; week: number }; count: number }>,
  weeks: number
): WeeklyCount[] {
  // Build a lookup from "YYYY-WW" to count
  const map = new Map<string, number>();
  for (const r of rawCounts) {
    const key = `${r._id.year}-W${String(r._id.week).padStart(2, "0")}`;
    map.set(key, r.count);
  }

  // Walk backwards from current week
  const result: WeeklyCount[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000);
    const year = d.getFullYear();
    // ISO week number
    const startOfYear = new Date(year, 0, 1);
    const dayOfYear = Math.floor(
      (d.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000)
    );
    const weekNum = Math.ceil((dayOfYear + startOfYear.getDay() + 1) / 7);
    const key = `${year}-W${String(weekNum).padStart(2, "0")}`;
    if (!result.some((r) => r.week === key)) {
      result.push({ week: key, count: map.get(key) ?? 0 });
    }
  }
  return result;
}

export async function analyticsPage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const now = new Date();
    const sevenDaysAgo = getDaysAgo(7);
    const thirtyDaysAgo = getDaysAgo(30);
    const weekAgo = sevenDaysAgo;
    const monthAgo = thirtyDaysAgo;
    const twelveWeeksAgo = getWeeksAgo(12);

    const [
      // ── User Engagement ──
      totalUsers,
      activeUsers7d,
      activeUsers30d,
      signupsDaily,
      onboardingCompleted,
      onboardingIncomplete,
      topActiveUsers,

      // ── Recipe Activity ──
      totalRecipes,
      recipesThisWeek,
      recipesThisMonth,
      recipesDaily,
      topLikedRecipes,
      topRemixedRecipes,
      dietaryTagDistribution,
      recipesWithPhotos,
      recipesWithoutPhotos,

      // ── Social & Engagement ──
      totalLikesAgg,
      totalForksAgg,
      totalFollowsAgg,
      avgFollowersAgg,
      avgLikesAgg,
      mostFollowedUsers,

      // ── Kitchen Activity ──
      totalKitchens,
      avgMembersAgg,
      kitchenSizeDistribution,
      mostActiveKitchens,

      // ── Schedule Usage ──
      totalScheduleEntries,
      scheduleEntriesWeek,
      scheduleEntriesMonth,
      mealSlotDistribution,
      recipeBasedEntries,
      freeformEntries,
      scheduleWeekly,

      // ── Premium Funnel ──
      premiumUsers,
      premiumMonthly,
      premiumAnnual,

      // ── Content Moderation ──
      reportsByStatus,
      reportsByReason,
      bannedUsers,
      hiddenRecipes,
    ] = await Promise.all([
      // ── User Engagement ──
      User.countDocuments(),
      User.countDocuments({ lastActiveAt: { $gte: sevenDaysAgo } }),
      User.countDocuments({ lastActiveAt: { $gte: thirtyDaysAgo } }),
      User.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: thirtyDaysAgo } } },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      User.countDocuments({ onboardingComplete: true }),
      User.countDocuments({ onboardingComplete: false }),
      User.find()
        .sort({ recipesCount: -1, followingCount: -1 })
        .limit(10)
        .select("fullName email recipesCount followersCount followingCount")
        .lean<TopUser[]>(),

      // ── Recipe Activity ──
      Recipe.countDocuments(),
      Recipe.countDocuments({ createdAt: { $gte: weekAgo } }),
      Recipe.countDocuments({ createdAt: { $gte: monthAgo } }),
      Recipe.aggregate<{ _id: string; count: number }>([
        { $match: { createdAt: { $gte: thirtyDaysAgo } } },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Recipe.aggregate<TopRecipe>([
        { $match: { likesCount: { $gt: 0 } } },
        { $sort: { likesCount: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: "users",
            localField: "authorId",
            foreignField: "_id",
            as: "author",
            pipeline: [{ $project: { fullName: 1 } }],
          },
        },
        {
          $project: {
            title: 1,
            likesCount: 1,
            forksCount: 1,
            authorName: {
              $ifNull: [
                { $arrayElemAt: ["$author.fullName", 0] },
                "Unknown",
              ],
            },
          },
        },
      ]),
      Recipe.aggregate<TopRecipe>([
        { $match: { forksCount: { $gt: 0 } } },
        { $sort: { forksCount: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: "users",
            localField: "authorId",
            foreignField: "_id",
            as: "author",
            pipeline: [{ $project: { fullName: 1 } }],
          },
        },
        {
          $project: {
            title: 1,
            likesCount: 1,
            forksCount: 1,
            authorName: {
              $ifNull: [
                { $arrayElemAt: ["$author.fullName", 0] },
                "Unknown",
              ],
            },
          },
        },
      ]),
      Recipe.aggregate<TagCount>([
        { $unwind: "$dietaryTags" },
        { $group: { _id: "$dietaryTags", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
        { $project: { _id: 0, tag: "$_id", count: 1 } },
      ]),
      Recipe.countDocuments({
        photos: { $exists: true, $not: { $size: 0 } },
      }),
      Recipe.countDocuments({
        $or: [{ photos: { $exists: false } }, { photos: { $size: 0 } }],
      }),

      // ── Social & Engagement ──
      Recipe.aggregate<{ total: number }>([
        { $group: { _id: null, total: { $sum: "$likesCount" } } },
      ]),
      Recipe.aggregate<{ total: number }>([
        { $group: { _id: null, total: { $sum: "$forksCount" } } },
      ]),
      User.aggregate<{ total: number }>([
        { $group: { _id: null, total: { $sum: "$followersCount" } } },
      ]),
      User.aggregate<{ avg: number }>([
        { $group: { _id: null, avg: { $avg: "$followersCount" } } },
      ]),
      Recipe.aggregate<{ avg: number }>([
        { $group: { _id: null, avg: { $avg: "$likesCount" } } },
      ]),
      User.find()
        .sort({ followersCount: -1 })
        .limit(10)
        .select("fullName email followersCount recipesCount")
        .lean<TopUser[]>(),

      // ── Kitchen Activity ──
      Kitchen.countDocuments(),
      Kitchen.aggregate<{ avg: number }>([
        { $group: { _id: null, avg: { $avg: "$memberCount" } } },
      ]),
      Kitchen.aggregate<{ _id: string; count: number }>([
        {
          $bucket: {
            groupBy: "$memberCount",
            boundaries: [0, 2, 4, 6, 10, 50],
            default: "50+",
            output: { count: { $sum: 1 } },
          },
        },
      ]),
      ScheduleEntry.aggregate<{
        _id: string;
        entryCount: number;
        kitchenInfo: Array<{ name: string }>;
      }>([
        { $match: { kitchenId: { $exists: true, $ne: null } } },
        { $group: { _id: "$kitchenId", entryCount: { $sum: 1 } } },
        { $sort: { entryCount: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: "kitchens",
            localField: "_id",
            foreignField: "_id",
            as: "kitchenInfo",
            pipeline: [{ $project: { name: 1 } }],
          },
        },
      ]),

      // ── Schedule Usage ──
      ScheduleEntry.countDocuments(),
      ScheduleEntry.countDocuments({ createdAt: { $gte: weekAgo } }),
      ScheduleEntry.countDocuments({ createdAt: { $gte: monthAgo } }),
      ScheduleEntry.aggregate<{ _id: string; count: number }>([
        { $group: { _id: "$mealSlot", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      ScheduleEntry.countDocuments({
        recipeId: { $exists: true, $ne: null },
      }),
      ScheduleEntry.countDocuments({
        freeformText: { $exists: true, $nin: [null, ""] },
        $or: [
          { recipeId: { $exists: false } },
          { recipeId: null },
        ],
      }),
      ScheduleEntry.aggregate<{
        _id: { year: number; week: number };
        count: number;
      }>([
        { $match: { createdAt: { $gte: twelveWeeksAgo } } },
        {
          $group: {
            _id: {
              year: { $isoWeekYear: "$createdAt" },
              week: { $isoWeek: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.week": 1 } },
      ]),

      // ── Premium Funnel ──
      User.countDocuments({ isPremium: true }),
      User.countDocuments({ isPremium: true, premiumPlan: "monthly" }),
      User.countDocuments({ isPremium: true, premiumPlan: "annual" }),

      // ── Content Moderation ──
      Report.aggregate<StatusCount>([
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $project: { _id: 0, status: "$_id", count: 1 } },
      ]),
      Report.aggregate<ReasonCount>([
        { $group: { _id: "$reason", count: { $sum: 1 } } },
        { $project: { _id: 0, reason: "$_id", count: 1 } },
      ]),
      User.countDocuments({ isBanned: true }),
      Recipe.countDocuments({ isHidden: true }),
    ]);

    // ── Derived values ──
    const retention7d =
      totalUsers > 0
        ? Math.round((activeUsers7d / totalUsers) * 100)
        : 0;
    const retention30d =
      totalUsers > 0
        ? Math.round((activeUsers30d / totalUsers) * 100)
        : 0;
    const avgRecipesPerUser =
      totalUsers > 0
        ? Math.round((totalRecipes / totalUsers) * 10) / 10
        : 0;
    const freeUsers = totalUsers - premiumUsers;
    const premiumRate =
      totalUsers > 0
        ? Math.round((premiumUsers / totalUsers) * 100 * 10) / 10
        : 0;

    const totalLikes = totalLikesAgg[0]?.total ?? 0;
    const totalForks = totalForksAgg[0]?.total ?? 0;
    const totalFollows = totalFollowsAgg[0]?.total ?? 0;
    const avgFollowers =
      Math.round((avgFollowersAgg[0]?.avg ?? 0) * 10) / 10;
    const avgLikes =
      Math.round((avgLikesAgg[0]?.avg ?? 0) * 10) / 10;
    const avgMembers =
      Math.round((avgMembersAgg[0]?.avg ?? 0) * 10) / 10;

    // Format kitchen size distribution
    const sizeLabels: Record<string, string> = {
      "0": "1 member",
      "2": "2-3 members",
      "4": "4-5 members",
      "6": "6-9 members",
      "10": "10-49 members",
      "50+": "50+ members",
    };
    const kitchenSizes: KitchenSizeBucket[] = kitchenSizeDistribution.map(
      (b: { _id: string; count: number }) => ({
        range: sizeLabels[String(b._id)] ?? `${b._id}`,
        count: b.count,
      })
    );

    // Format active kitchens
    const activeKitchens: ActiveKitchen[] = mostActiveKitchens.map(
      (k: {
        _id: string;
        entryCount: number;
        kitchenInfo: Array<{ name: string }>;
      }) => ({
        kitchenId: String(k._id),
        kitchenName: k.kitchenInfo[0]?.name ?? "Unknown",
        entryCount: k.entryCount,
      })
    );

    // Fill chart data
    const signupsChartData = fillDailyCounts(signupsDaily, 30);
    const recipesChartData = fillDailyCounts(recipesDaily, 30);
    const scheduleChartData = fillWeeklyCounts(scheduleWeekly, 12);

    res.render("analytics", {
      page: "analytics",

      // KPI stats
      totalUsers,
      activeUsers30d,
      retention7d,
      retention30d,
      totalRecipes,
      recipesThisWeek,
      recipesThisMonth,
      avgRecipesPerUser,
      premiumUsers,
      freeUsers,
      premiumRate,
      totalKitchens,

      // User engagement
      onboardingCompleted,
      onboardingIncomplete,
      topActiveUsers,

      // Charts
      signupsChartData,
      recipesChartData,
      dietaryTagDistribution,
      scheduleChartData,

      // Social
      totalLikes,
      totalForks,
      totalFollows,
      avgFollowers,
      avgLikes,
      mostFollowedUsers,

      // Kitchen
      avgMembers,
      kitchenSizes,
      activeKitchens,

      // Schedule
      totalScheduleEntries,
      scheduleEntriesWeek,
      scheduleEntriesMonth,
      mealSlotDistribution,
      recipeBasedEntries,
      freeformEntries,

      // Premium
      premiumMonthly,
      premiumAnnual,

      // Moderation
      reportsByStatus,
      reportsByReason,
      bannedUsers,
      hiddenRecipes,

      // Tables
      topLikedRecipes,
      topRemixedRecipes,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load analytics");
    res.status(500).send("Internal server error");
  }
}
