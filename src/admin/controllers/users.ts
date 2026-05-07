import { Request, Response } from "express";
import User from "../../models/User";
import AuditLog from "../../models/AuditLog";
import { logger } from "../../lib/logger";
import { getDeleteImpact, deleteAccount } from "../../services/user-service";

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

export async function usersPage(req: Request, res: Response): Promise<void> {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = 20;
    const search = (req.query.search as string) || "";
    const filter = (req.query.filter as string) || "all";

    const query: Record<string, unknown> = {};

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.$or = [
        { fullName: { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } },
      ];
    }

    if (filter === "premium") query.isPremium = true;
    if (filter === "banned") query.isBanned = true;
    if (filter === "admin") query.isAdmin = true;

    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      User.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          "fullName email profilePicture isPremium premiumPlan isBanned isAdmin recipesCount followersCount followingCount createdAt lastActiveAt isPublic"
        )
        .lean(),
      User.countDocuments(query),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.render("users", {
      page: "users",
      users,
      pagination: { current: page, total: totalPages, totalItems: total },
      search,
      filter,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to load users page");
    res.status(500).send("Internal server error");
  }
}

export async function userDetail(req: Request, res: Response): Promise<void> {
  try {
    const user = await User.findById(req.params.id)
      .populate<{
        premiumGrantedBy: { _id: unknown; name: string; email: string } | null;
      }>("premiumGrantedBy", "name email")
      .lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Roll up AI counters into a single struct so the admin UI doesn't have
    // to repeat day-key math. `usedToday` is the stored counter only if it
    // still belongs to *today's* local day in the user's zone — otherwise
    // zero, matching how the quota check behaves at runtime.
    const offset = user.timezoneOffsetMinutes;
    const todayKey =
      offset != null && Number.isFinite(offset)
        ? new Date(Date.now() + offset * 60_000).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);
    const usedToday =
      user.aiRecipeHelperUsageDay === todayKey
        ? user.aiRecipeHelperUsageCount ?? 0
        : 0;

    const ai = {
      usedToday,
      limit: 20,
      dayKey: user.aiRecipeHelperUsageDay ?? null,
      totalMessagesSent: user.aiTotalMessagesSent ?? 0,
      generateCount: user.aiGenerateCount ?? 0,
      substitutionsCount: user.aiSubstitutionsCount ?? 0,
      formatCount: user.aiFormatCount ?? 0,
      lastUsedAt: user.aiLastUsedAt ?? null,
      timezoneOffsetMinutes: user.timezoneOffsetMinutes ?? null,
    };

    res.json({ user, ai });
  } catch (error) {
    logger.error({ err: error }, "Failed to get user detail");
    res.status(500).json({ error: "Failed to load user" });
  }
}

export async function banUser(req: Request, res: Response): Promise<void> {
  try {
    const { reason } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        isBanned: true,
        banReason: reason || "Violation of terms of service",
        bannedAt: new Date(),
      },
      { new: true }
    );

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await audit(req, "ban_user", "user", req.params.id as string, { reason });
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to ban user");
    res.status(500).json({ error: "Failed to ban user" });
  }
}

export async function unbanUser(req: Request, res: Response): Promise<void> {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        isBanned: false,
        $unset: { banReason: 1, bannedAt: 1 },
      },
      { new: true }
    );

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await audit(req, "unban_user", "user", req.params.id as string);
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to unban user");
    res.status(500).json({ error: "Failed to unban user" });
  }
}

export async function grantPremium(req: Request, res: Response): Promise<void> {
  try {
    const { durationDays } = req.body;
    const adminId = req.session.adminId;

    const baseSet: Record<string, unknown> = {
      isPremium: true,
      premiumPlan: "admin",
      premiumGrantedAt: new Date(),
    };
    if (adminId) baseSet.premiumGrantedBy = adminId;

    const hasDuration = durationDays && Number(durationDays) > 0;
    let expires: Date | undefined;
    if (hasDuration) {
      expires = new Date();
      expires.setDate(expires.getDate() + Number(durationDays));
      baseSet.premiumExpiresAt = expires;
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      hasDuration
        ? { $set: baseSet }
        : { $set: baseSet, $unset: { premiumExpiresAt: 1 } },
      { new: true }
    );

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await audit(req, "grant_premium", "user", req.params.id as string, {
      plan: "admin",
      durationDays: durationDays ? Number(durationDays) : "indefinite",
    });
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to grant premium");
    res.status(500).json({ error: "Failed to grant premium" });
  }
}

export async function revokePremium(req: Request, res: Response): Promise<void> {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        $set: { isPremium: false },
        $unset: {
          premiumPlan: 1,
          premiumExpiresAt: 1,
          premiumGrantedBy: 1,
          premiumGrantedAt: 1,
        },
      },
      { new: true }
    );

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await audit(req, "revoke_premium", "user", req.params.id as string);
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to revoke premium");
    res.status(500).json({ error: "Failed to revoke premium" });
  }
}

export async function userDeleteImpact(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const impact = await getDeleteImpact(req.params.id as string);
    if (!impact) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(impact);
  } catch (error) {
    logger.error({ err: error }, "Failed to compute delete impact");
    res.status(500).json({ error: "Failed to compute delete impact" });
  }
}

export async function deleteUser(req: Request, res: Response): Promise<void> {
  try {
    const targetId = req.params.id as string;

    // Snapshot for the audit log BEFORE the cascade runs and the user vanishes.
    const impact = await getDeleteImpact(targetId);
    if (!impact) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Refuse to delete an admin via this surface — admin lifecycle goes
    // through /admin/admins routes (which are super-admin gated).
    const target = await User.findById(targetId).select("isAdmin").lean();
    if (target?.isAdmin) {
      res.status(403).json({
        error: "Cannot delete an admin account from this screen.",
      });
      return;
    }

    await deleteAccount(targetId);

    await audit(req, "delete_user", "user", targetId, {
      email: impact.user.email,
      fullName: impact.user.fullName,
      recipesDeleted: impact.recipes.count,
      cookedPostsDeleted: impact.cookedPosts.count,
      kitchensAffected: impact.kitchens.length,
      cloudinaryImagesDeleted: impact.cloudinary.totalImages,
      cloudinaryBytesDeleted: impact.cloudinary.totalBytes,
    });

    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to delete user");
    res.status(500).json({ error: "Failed to delete user" });
  }
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  try {
    const allowedFields = [
      "fullName",
      "email",
      "bio",
      "phone",
      "profilePicture",
      "signature",
      "isPublic",
      "dietaryPreferences",
      "cuisinePreferences",
      "onboardingComplete",
    ] as const;

    const sanitized: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        sanitized[field] = req.body[field];
      }
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: sanitized },
      { new: true, runValidators: true }
    );

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await audit(req, "update_user", "user", req.params.id as string, sanitized);
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, "Failed to update user");
    res.status(500).json({ error: "Failed to update user" });
  }
}
