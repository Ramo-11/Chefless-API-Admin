import { Request, Response } from "express";
import Recipe from "../../models/Recipe";
import AuditLog from "../../models/AuditLog";
import { cascadeRecipeDeletion } from "../../services/recipe-service";
import { logger } from "../../lib/logger";

/** Escape user input for use inside a MongoDB `$regex` expression. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

export async function recipesPage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = 20;
    const filter = (req.query.filter as string) || "reported";
    const search = (req.query.search as string) || "";

    const query: Record<string, unknown> = {};

    if (search) {
      query.title = { $regex: escapeRegex(search), $options: "i" };
    }

    if (filter === "reported") query.reportsCount = { $gt: 0 };
    if (filter === "hidden") query.isHidden = true;
    if (filter === "featured") query.isFeatured = true;

    const skip = (page - 1) * limit;

    const [recipes, total] = await Promise.all([
      Recipe.find(query)
        .sort(filter === "reported" ? { reportsCount: -1 } : { createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("authorId", "fullName email")
        .select(
          "title authorId photos reportsCount isHidden isPrivate isFeatured featuredAt likesCount forksCount createdAt"
        )
        .lean(),
      Recipe.countDocuments(query),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.render("recipes", {
      page: "recipes",
      recipes,
      pagination: { current: page, total: totalPages, totalItems: total },
      filter,
      search,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load recipes page");
    res.status(500).send("Internal server error");
  }
}

export async function toggleHideRecipe(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) {
      res.status(404).json({ error: "Recipe not found" });
      return;
    }
    recipe.isHidden = !recipe.isHidden;
    await recipe.save();
    await audit(req, recipe.isHidden ? "hide_recipe" : "unhide_recipe", "recipe", req.params.id as string);
    res.json({ success: true, isHidden: recipe.isHidden });
  } catch (error) {
    logger.error({ err: error }, "Failed to toggle recipe visibility");
    res.status(500).json({ error: "Failed to update recipe" });
  }
}

export async function toggleFeatureRecipe(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) {
      res.status(404).json({ error: "Recipe not found" });
      return;
    }

    if (recipe.isFeatured) {
      recipe.isFeatured = false;
      recipe.featuredAt = undefined;
      await recipe.save();
      await audit(
        req,
        "unfeature_recipe",
        "recipe",
        req.params.id as string,
        { title: recipe.title }
      );
      res.json({ success: true, isFeatured: false });
      return;
    }

    // Reject if the recipe is not visible to end users.
    if (recipe.isPrivate || recipe.isHidden) {
      res.status(400).json({
        error:
          "Cannot feature a private or hidden recipe. Make it public and visible first.",
      });
      return;
    }

    // Enforce the single-featured-recipe invariant app-wide.
    await Recipe.updateMany(
      { isFeatured: true },
      { $set: { isFeatured: false }, $unset: { featuredAt: 1 } }
    );

    recipe.isFeatured = true;
    recipe.featuredAt = new Date();
    await recipe.save();

    await audit(req, "feature_recipe", "recipe", req.params.id as string, {
      title: recipe.title,
    });
    res.json({ success: true, isFeatured: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to toggle recipe feature");
    res.status(500).json({ error: "Failed to update recipe" });
  }
}

export async function deleteRecipe(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const recipe = await Recipe.findById(req.params.id);
    if (!recipe) {
      res.status(404).json({ error: "Recipe not found" });
      return;
    }

    // Full cleanup: engagement rows, remix pointers, cooked posts, schedule
    // entries, cookbooks, shopping lists, notifications, reports, denormalized
    // counters and Cloudinary images. Shared with the author-facing delete.
    await cascadeRecipeDeletion(recipe);
    await Recipe.findByIdAndDelete(recipe._id);

    await audit(req, "delete_recipe", "recipe", req.params.id as string, { title: recipe.title });
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to delete recipe");
    res.status(500).json({ error: "Failed to delete recipe" });
  }
}

export async function recipeDetail(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const recipe = await Recipe.findById(req.params.id)
      .populate("authorId", "fullName email profilePicture")
      .lean();
    if (!recipe) {
      res.status(404).json({ error: "Recipe not found" });
      return;
    }
    res.json({ recipe });
  } catch (error) {
    logger.error({ err: error }, "Failed to get recipe detail");
    res.status(500).json({ error: "Failed to load recipe" });
  }
}

export async function updateRecipe(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const allowedFields = [
      "title",
      "description",
      "dietaryTags",
      "cuisineTags",
      "prepTime",
      "cookTime",
      "servings",
      "calories",
      "costEstimate",
      "isPrivate",
    ] as const;

    const sanitized: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        sanitized[field] = req.body[field];
      }
    }

    const recipe = await Recipe.findByIdAndUpdate(
      req.params.id,
      { $set: sanitized },
      { new: true, runValidators: true }
    );

    if (!recipe) {
      res.status(404).json({ error: "Recipe not found" });
      return;
    }

    await audit(req, "update_recipe", "recipe", req.params.id as string, sanitized);
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to update recipe");
    res.status(500).json({ error: "Failed to update recipe" });
  }
}
