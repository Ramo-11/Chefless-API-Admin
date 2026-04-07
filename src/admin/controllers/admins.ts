import { Request, Response } from "express";
import AdminUser from "../../models/AdminUser";
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

export async function adminsPage(req: Request, res: Response): Promise<void> {
  try {
    const admins = await AdminUser.find()
      .sort({ createdAt: -1 })
      .select("name email role isActive lastLoginAt createdAt")
      .lean();

    res.render("admins", {
      page: "admins",
      pageTitle: "Admin Users",
      admins,
    });
  } catch (error) {
    console.error("Failed to load admins page:", error);
    res.status(500).send("Internal server error");
  }
}

export async function createAdmin(req: Request, res: Response): Promise<void> {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      res.status(400).json({ error: "All fields are required" });
      return;
    }

    if (role !== "admin" && role !== "super_admin") {
      res.status(400).json({ error: "Role must be admin or super_admin" });
      return;
    }

    if (typeof password !== "string" || password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) ||
        !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      res.status(400).json({
        error: "Password must include uppercase, lowercase, number, and special character",
      });
      return;
    }

    const existing = await AdminUser.findOne({ email: email.toLowerCase() });
    if (existing) {
      res.status(400).json({ error: "An admin with this email already exists" });
      return;
    }

    const admin = await AdminUser.create({
      name,
      email: email.toLowerCase(),
      password,
      role,
      isActive: true,
    });

    await audit(req, "create_admin", "admin_user", admin._id.toString(), {
      name,
      email: email.toLowerCase(),
      role,
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Failed to create admin:", error);
    res.status(500).json({ error: "Failed to create admin" });
  }
}

export async function updateAdmin(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id as string;
    const { name, role } = req.body;

    if (id === req.session.adminId && role) {
      res.status(400).json({ error: "You cannot change your own role" });
      return;
    }

    if (role && role !== "admin" && role !== "super_admin") {
      res.status(400).json({ error: "Role must be admin or super_admin" });
      return;
    }

    const $set: Record<string, unknown> = {};
    if (name !== undefined) $set.name = name;
    if (role !== undefined) $set.role = role;

    if (Object.keys($set).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    const admin = await AdminUser.findByIdAndUpdate(
      id,
      { $set },
      { new: true }
    );

    if (!admin) {
      res.status(404).json({ error: "Admin not found" });
      return;
    }

    await audit(req, "update_admin", "admin_user", id, $set);

    res.json({ success: true });
  } catch (error) {
    console.error("Failed to update admin:", error);
    res.status(500).json({ error: "Failed to update admin" });
  }
}

export async function toggleAdminActive(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const id = req.params.id as string;

    if (id === req.session.adminId) {
      res.status(400).json({ error: "You cannot deactivate yourself" });
      return;
    }

    const admin = await AdminUser.findById(id);
    if (!admin) {
      res.status(404).json({ error: "Admin not found" });
      return;
    }

    admin.isActive = !admin.isActive;
    await admin.save();

    await audit(req, "toggle_admin_active", "admin_user", id, {
      isActive: admin.isActive,
    });

    res.json({ success: true, isActive: admin.isActive });
  } catch (error) {
    console.error("Failed to toggle admin active:", error);
    res.status(500).json({ error: "Failed to toggle admin status" });
  }
}

export async function resetAdminPassword(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const id = req.params.id as string;
    const { newPassword } = req.body;

    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) ||
        !/\d/.test(newPassword) || !/[^A-Za-z0-9]/.test(newPassword)) {
      res.status(400).json({
        error: "Password must include uppercase, lowercase, number, and special character",
      });
      return;
    }

    const admin = await AdminUser.findById(id);
    if (!admin) {
      res.status(404).json({ error: "Admin not found" });
      return;
    }

    admin.password = newPassword;
    await admin.save();

    await audit(req, "reset_admin_password", "admin_user", id);

    res.json({ success: true });
  } catch (error) {
    console.error("Failed to reset admin password:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
}
