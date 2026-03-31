import { Request, Response } from "express";
import Recipe from "../../models/Recipe";
import Report from "../../models/Report";
import AuditLog from "../../models/AuditLog";

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
    console.error("Audit log failed:", err instanceof Error ? err.message : err);
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
      query.title = { $regex: search, $options: "i" };
    }

    if (filter === "reported") query.reportsCount = { $gt: 0 };
    if (filter === "hidden") query.isHidden = true;

    const skip = (page - 1) * limit;

    const [recipes, total] = await Promise.all([
      Recipe.find(query)
        .sort(filter === "reported" ? { reportsCount: -1 } : { createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("authorId", "fullName email")
        .select(
          "title authorId photos reportsCount isHidden isPrivate likesCount forksCount createdAt"
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
    console.error("Failed to load recipes page:", error);
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
    console.error("Failed to toggle recipe visibility:", error);
    res.status(500).json({ error: "Failed to update recipe" });
  }
}

export async function deleteRecipe(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const recipe = await Recipe.findByIdAndDelete(req.params.id);
    if (!recipe) {
      res.status(404).json({ error: "Recipe not found" });
      return;
    }

    // Clean up orphaned reports for this recipe
    await Report.deleteMany({
      targetType: "recipe",
      targetId: recipe._id,
    });

    await audit(req, "delete_recipe", "recipe", req.params.id as string, { title: recipe.title });
    res.json({ success: true });
  } catch (error) {
    console.error("Failed to delete recipe:", error);
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
    console.error("Failed to get recipe detail:", error);
    res.status(500).json({ error: "Failed to load recipe" });
  }
}
