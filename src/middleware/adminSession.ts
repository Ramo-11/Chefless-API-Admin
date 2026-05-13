import { Request, Response, NextFunction } from "express";
import { generateCsrfToken } from "./csrf";
import Report from "../models/Report";
import ClientError from "../models/ClientError";

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
    const [pendingReports, openCrashes] = await Promise.all([
      Report.countDocuments({ status: "pending" }),
      ClientError.countDocuments({ status: "new" }),
    ]);
    res.locals.pendingCount = pendingReports;
    res.locals.openCrashesCount = openCrashes;
  } catch {
    res.locals.pendingCount = 0;
    res.locals.openCrashesCount = 0;
  }

  next();
}

/**
 * Requires the admin to have the super_admin role.
 * Must be used AFTER requireAdminSession.
 */
export function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.session.adminRole !== "super_admin") {
    if (req.path.startsWith("/api/")) {
      res.status(403).json({ error: "Forbidden: super admin access required" });
    } else {
      res.status(403).send("Forbidden");
    }
    return;
  }
  next();
}
