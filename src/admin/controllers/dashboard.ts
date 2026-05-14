import { Request, Response } from "express";
import User from "../../models/User";
import Recipe from "../../models/Recipe";
import Kitchen from "../../models/Kitchen";
import Report from "../../models/Report";
import ClientError from "../../models/ClientError";
import { logger } from "../../lib/logger";

export async function dashboardPage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Synthetic seed accounts and their recipes never count toward real
    // platform metrics. They remain visible under the Seed Data tab.
    const notSeed = { isSeed: { $ne: true } };

    const [
      totalUsers,
      newUsersWeek,
      newUsersMonth,
      totalRecipes,
      totalKitchens,
      pendingReports,
      premiumUsers,
      recentUsers,
      bannedUsers,
      openCrashes,
      crashesWeek,
    ] = await Promise.all([
      User.countDocuments(notSeed),
      User.countDocuments({ ...notSeed, createdAt: { $gte: weekAgo } }),
      User.countDocuments({ ...notSeed, createdAt: { $gte: monthAgo } }),
      Recipe.countDocuments(notSeed),
      Kitchen.countDocuments(),
      Report.countDocuments({ status: "pending" }),
      User.countDocuments({ ...notSeed, isPremium: true }),
      User.find(notSeed)
        .sort({ createdAt: -1 })
        .limit(10)
        .select("fullName email isPremium createdAt profilePicture")
        .lean(),
      User.countDocuments({ ...notSeed, isBanned: true }),
      ClientError.countDocuments({ status: "new" }),
      ClientError.countDocuments({ lastSeenAt: { $gte: weekAgo } }),
    ]);

    res.render("dashboard", {
      page: "dashboard",
      stats: {
        totalUsers,
        newUsersWeek,
        newUsersMonth,
        totalRecipes,
        totalKitchens,
        pendingReports,
        premiumUsers,
        bannedUsers,
        openCrashes,
        crashesWeek,
      },
      recentUsers,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load dashboard");
    res.status(500).send("Internal server error");
  }
}
