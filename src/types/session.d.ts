import "express-session";

declare module "express-session" {
  interface SessionData {
    adminId: string;
    adminEmail: string;
    adminName: string;
    adminRole: string;
    csrfToken: string;
  }
}
