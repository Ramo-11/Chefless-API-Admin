import { Request, Response, NextFunction } from "express";
import { generateCsrfToken } from "./csrf";
import Report from "../models/Report";

/**
 * Protects admin panel pages. Checks for a valid admin session.
 * Redirects to /admin/login if not authenticated.
 */
export async function requireAdminSession(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.session.adminId || !req.session.adminEmail) {
    res.redirect("/admin/login");
    return;
  }

  // Make admin info available to all admin views
  res.locals.adminName = req.session.adminName;
  res.locals.adminEmail = req.session.adminEmail;
  res.locals.adminRole = req.session.adminRole;

  // CSRF token for all admin views (forms and JS fetch calls)
  res.locals.csrfToken = generateCsrfToken(req);

  // Pending report count for the nav badge
  try {
    res.locals.pendingCount = await Report.countDocuments({ status: "pending" });
  } catch {
    res.locals.pendingCount = 0;
  }

  next();
}
