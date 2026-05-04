/**
 * Admin Seed Data tab — view + delete synthetic accounts/recipes created by
 * the seed pipeline. Backed by the `isSeed: true` flag on User and Recipe.
 *
 * Delete actions reuse the existing `deleteAccount` cascade so nothing leaks
 * (kitchens, follows, likes, saves, etc.).
 */
import { Request, Response } from "express";
import User from "../../models/User";
import Recipe from "../../models/Recipe";
import AuditLog from "../../models/AuditLog";
import { logger } from "../../lib/logger";
import { deleteAccount } from "../../services/user-service";

async function audit(
  req: Request,
  action: string,
  targetType: string,
  targetId?: string,
  details?: Record<string, unknown>
): Promise<void> {
  AuditLog.create({
    adminId: req.session.adminId ?? "unknown",
    adminEmail: req.session.adminEmail ?? "unknown",
    action,
    targetType,
    targetId,
    details,
    ipAddress: req.ip,
  }).catch((err: unknown) => {
    logger.error({ err }, "Audit log failed");
  });
}

/** GET /admin/seed-data — overview table grouped by cuisine. */
export async function seedDataPage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const cuisineFilter = (req.query.cuisine as string) || "";

    const userMatch: Record<string, unknown> = { isSeed: true };
    const recipeMatch: Record<string, unknown> = { isSeed: true };
    if (cuisineFilter) {
      userMatch.seedCuisine = cuisineFilter;
      recipeMatch.seedCuisine = cuisineFilter;
    }

    const [byCuisine, totals, allCuisines] = await Promise.all([
      User.aggregate<{
        _id: string;
        users: number;
        recipes: number;
        sources: string[];
      }>([
        { $match: { isSeed: true } },
        {
          $group: {
            _id: "$seedCuisine",
            users: { $sum: 1 },
            sources: { $addToSet: "$seedSource" },
            userIds: { $push: "$_id" },
          },
        },
        {
          $lookup: {
            from: "recipes",
            let: { ids: "$userIds" },
            pipeline: [
              {
                $match: {
                  $expr: { $in: ["$authorId", "$$ids"] },
                  isSeed: true,
                },
              },
              { $count: "n" },
            ],
            as: "recipeAgg",
          },
        },
        {
          $project: {
            users: 1,
            sources: 1,
            recipes: { $ifNull: [{ $arrayElemAt: ["$recipeAgg.n", 0] }, 0] },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Promise.all([
        User.countDocuments({ isSeed: true }),
        Recipe.countDocuments({ isSeed: true }),
      ]),
      User.distinct("seedCuisine", { isSeed: true }),
    ]);

    res.render("seed-data", {
      page: "seed-data",
      pageTitle: "Seed Data",
      groups: byCuisine,
      totals: { users: totals[0], recipes: totals[1] },
      allCuisines: (allCuisines as string[]).filter(Boolean).sort(),
      cuisineFilter,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load seed data page");
    res.status(500).send("Internal server error");
  }
}

/** GET /admin/seed-data/users?cuisine=Lebanese — paginated user list. */
export async function seedUsersList(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const page = parseInt((req.query.page as string) ?? "1", 10) || 1;
    const limit = 20;
    const cuisine = (req.query.cuisine as string) || "";

    const filter: Record<string, unknown> = { isSeed: true };
    if (cuisine) filter.seedCuisine = cuisine;

    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ seedCuisine: 1, fullName: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select(
          "fullName email profilePicture seedCuisine seedSource recipesCount followersCount createdAt"
        )
        .lean(),
      User.countDocuments(filter),
    ]);

    res.json({
      users,
      pagination: {
        current: page,
        total: Math.ceil(total / limit),
        totalItems: total,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load seed users");
    res.status(500).json({ error: "Failed to load seed users" });
  }
}

/** GET /admin/seed-data/recipes?cuisine=Lebanese */
export async function seedRecipesList(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const page = parseInt((req.query.page as string) ?? "1", 10) || 1;
    const limit = 20;
    const cuisine = (req.query.cuisine as string) || "";

    const filter: Record<string, unknown> = { isSeed: true };
    if (cuisine) filter.seedCuisine = cuisine;

    const [recipes, total] = await Promise.all([
      Recipe.find(filter)
        .sort({ seedCuisine: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("authorId", "fullName email")
        .select(
          "title photos seedCuisine seedSource cuisineTags likesCount createdAt"
        )
        .lean(),
      Recipe.countDocuments(filter),
    ]);

    res.json({
      recipes,
      pagination: {
        current: page,
        total: Math.ceil(total / limit),
        totalItems: total,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load seed recipes");
    res.status(500).json({ error: "Failed to load seed recipes" });
  }
}

/** DELETE /admin/seed-data/users/:id — full cascade via deleteAccount. */
export async function deleteSeedUser(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const user = await User.findById(req.params.id).select("isSeed").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (!user.isSeed) {
      res.status(400).json({ error: "Refusing — user is not a seed account" });
      return;
    }

    await deleteAccount(String(req.params.id));
    await audit(req, "delete_seed_user", "user", req.params.id as string);
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to delete seed user");
    res.status(500).json({ error: "Failed to delete seed user" });
  }
}

/** DELETE /admin/seed-data/recipes/:id — single seed recipe. */
export async function deleteSeedRecipe(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const recipe = await Recipe.findById(req.params.id)
      .select("isSeed authorId")
      .lean();
    if (!recipe) {
      res.status(404).json({ error: "Recipe not found" });
      return;
    }
    if (!recipe.isSeed) {
      res
        .status(400)
        .json({ error: "Refusing — recipe is not a seed entry" });
      return;
    }

    await Recipe.deleteOne({ _id: recipe._id });
    await User.updateOne(
      { _id: recipe.authorId },
      { $inc: { recipesCount: -1, originalRecipesCount: -1 } }
    );
    await audit(req, "delete_seed_recipe", "recipe", req.params.id as string);
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to delete seed recipe");
    res.status(500).json({ error: "Failed to delete seed recipe" });
  }
}

/** DELETE /admin/seed-data/cuisines/:cuisine — wipe a whole cuisine bucket. */
export async function deleteSeedCuisine(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const cuisine = String(req.params.cuisine ?? "").trim();
    if (!cuisine) {
      res.status(400).json({ error: "Cuisine required" });
      return;
    }

    const users = await User.find({ isSeed: true, seedCuisine: cuisine })
      .select("_id")
      .lean();

    let deletedUsers = 0;
    for (const u of users) {
      try {
        await deleteAccount(String(u._id));
        deletedUsers += 1;
      } catch (err) {
        logger.error({ err, userId: u._id }, "Cascade delete failed for seed user");
      }
    }

    // Catch any orphan recipes that may have lost their author somehow.
    const orphan = await Recipe.deleteMany({
      isSeed: true,
      seedCuisine: cuisine,
    });

    await audit(req, "delete_seed_cuisine", "cuisine", cuisine, {
      users: deletedUsers,
      orphanRecipesRemoved: orphan.deletedCount,
    });

    res.json({
      success: true,
      deletedUsers,
      orphanRecipesRemoved: orphan.deletedCount,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to wipe seed cuisine");
    res.status(500).json({ error: "Failed to wipe seed cuisine" });
  }
}

/** DELETE /admin/seed-data/all — nuclear option. */
export async function deleteAllSeed(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const confirm = String(req.body?.confirm ?? "");
    if (confirm !== "DELETE ALL SEED") {
      res
        .status(400)
        .json({ error: "Confirm phrase missing or incorrect." });
      return;
    }

    const users = await User.find({ isSeed: true }).select("_id").lean();
    let deletedUsers = 0;
    for (const u of users) {
      try {
        await deleteAccount(String(u._id));
        deletedUsers += 1;
      } catch (err) {
        logger.error({ err, userId: u._id }, "Cascade delete failed for seed user");
      }
    }

    const orphan = await Recipe.deleteMany({ isSeed: true });

    await audit(req, "delete_all_seed", "seed", undefined, {
      users: deletedUsers,
      orphanRecipesRemoved: orphan.deletedCount,
    });

    res.json({
      success: true,
      deletedUsers,
      orphanRecipesRemoved: orphan.deletedCount,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to wipe all seed data");
    res.status(500).json({ error: "Failed to wipe all seed data" });
  }
}
