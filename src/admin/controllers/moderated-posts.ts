import { Request, Response } from "express";
import CookedPost from "../../models/CookedPost";
import User from "../../models/User";
import { logger } from "../../lib/logger";

/**
 * Admin feed of recipe-owner moderation actions on "I Cooked It" posts. Every
 * row captures who uploaded, who removed, when, the original photo, caption,
 * and the reason the owner supplied. Pure read view — mutations happen in the
 * mobile app through the recipe-owner flow.
 */
export async function moderatedPostsPage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = 20;
    const skip = (page - 1) * limit;

    const query = { removedAt: { $ne: null } };

    const [rows, total] = await Promise.all([
      CookedPost.find(query)
        .sort({ removedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CookedPost.countDocuments(query),
    ]);

    // Hydrate uploader + owner names in one round-trip.
    const userIds = new Set<string>();
    for (const r of rows) {
      if (r.userId) userIds.add(r.userId.toString());
      if (r.removedBy) userIds.add(r.removedBy.toString());
    }
    const users = await User.find({
      _id: { $in: Array.from(userIds) },
    })
      .select("fullName email profilePicture")
      .lean();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    const posts = rows.map((r) => ({
      id: r._id.toString(),
      recipeId: r.recipeId ? r.recipeId.toString() : null,
      recipeTitle: r.recipeTitle,
      photoUrl: r.photoUrl,
      caption: r.caption ?? "",
      createdAt: r.createdAt,
      removedAt: r.removedAt,
      removalReason: r.removalReason ?? "",
      uploader: r.userId ? userMap.get(r.userId.toString()) ?? null : null,
      owner: r.removedBy
        ? userMap.get(r.removedBy.toString()) ?? null
        : null,
    }));

    const totalPages = Math.ceil(total / limit);

    res.render("moderated-posts", {
      page: "moderated-posts",
      posts,
      pagination: { current: page, total: totalPages, totalItems: total },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load moderated posts page");
    res.status(500).send("Internal server error");
  }
}
