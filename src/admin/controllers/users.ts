import { Request, Response } from "express";
import User from "../../models/User";
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
          "fullName email profilePicture isPremium isBanned isAdmin recipesCount followersCount followingCount createdAt lastActiveAt isPublic"
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
    console.error("Failed to load users page:", error);
    res.status(500).send("Internal server error");
  }
}

export async function userDetail(req: Request, res: Response): Promise<void> {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ user });
  } catch (error) {
    console.error("Failed to get user detail:", error);
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
    console.error("Failed to ban user:", error);
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
    console.error("Failed to unban user:", error);
    res.status(500).json({ error: "Failed to unban user" });
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
    console.error("Failed to update user:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
}
