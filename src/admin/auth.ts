import { Request, Response } from "express";
import AdminUser from "../models/AdminUser";
import { generateCsrfToken } from "../middleware/csrf";

export async function loginPage(req: Request, res: Response): Promise<void> {
  if (req.session.adminId) {
    res.redirect("/admin");
    return;
  }
  res.render("login", { error: null, csrfToken: generateCsrfToken(req) });
}

export async function loginPost(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;

  if (!email || !password) {
    res.render("login", { error: "Email and password are required", csrfToken: generateCsrfToken(req) });
    return;
  }

  const admin = await AdminUser.findOne({ email: email.toLowerCase(), isActive: true });

  if (!admin || !(await admin.comparePassword(password))) {
    res.render("login", { error: "Invalid email or password", csrfToken: generateCsrfToken(req) });
    return;
  }

  // Update last login
  admin.lastLoginAt = new Date();
  await admin.save();

  // Set session
  req.session.adminId = admin._id.toString();
  req.session.adminEmail = admin.email;
  req.session.adminName = admin.name;
  req.session.adminRole = admin.role;

  res.redirect("/admin");
}

export function logout(req: Request, res: Response): void {
  req.session.destroy(() => {
    res.redirect("/admin/login");
  });
}
