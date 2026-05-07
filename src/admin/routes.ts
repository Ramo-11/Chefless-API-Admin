import { Router } from "express";
import expressLayouts from "express-ejs-layouts";
import { requireAdminSession, requireSuperAdmin } from "../middleware/adminSession";
import { authLimiter } from "../middleware/rateLimit";
import { csrfProtection } from "../middleware/csrf";
import { loginPage, loginPost, logout } from "./auth";
import { dashboardPage } from "./controllers/dashboard";
import { analyticsPage } from "./controllers/analytics";
import {
  usersPage,
  userDetail,
  userDeleteImpact,
  deleteUser,
  banUser,
  unbanUser,
  updateUser,
  grantPremium,
  revokePremium,
} from "./controllers/users";
import {
  recipesPage,
  toggleHideRecipe,
  toggleFeatureRecipe,
  deleteRecipe,
  recipeDetail,
  updateRecipe,
} from "./controllers/recipes";
import {
  reportsPage,
  reviewReport,
  dismissReport,
} from "./controllers/reports";
import { labelsPage, createLabel, updateLabel, deleteLabel } from "./controllers/labels";
import {
  seasonalPage,
  createTag,
  toggleTag,
  deleteTag,
  tagRecipe,
  untagRecipe,
} from "./controllers/seasonal";
import {
  kitchensPage,
  kitchenDetail,
  kitchenSuggestions,
  updateKitchen,
  removeKitchenMember,
  transferKitchenLead,
  deleteKitchen,
  removeKitchenPhoto,
} from "./controllers/kitchens";
import {
  adminsPage,
  createAdmin,
  updateAdmin,
  toggleAdminActive,
  resetAdminPassword,
} from "./controllers/admins";
import {
  feedbackPage,
  feedbackDetail,
  updateFeedbackStatus,
  updateFeedbackNote,
  deleteFeedback,
} from "./controllers/feedback";
import { moderatedPostsPage } from "./controllers/moderated-posts";
import {
  appConfigPage,
  updateAppConfig,
  addWrappedTestUser,
  removeWrappedTestUser,
} from "./controllers/app-config";
import {
  seedDataPage,
  seedUsersList,
  seedRecipesList,
  deleteSeedUser,
  deleteSeedRecipe,
  deleteSeedCuisine,
  deleteAllSeed,
} from "./controllers/seed-data";

const router = Router();

// ── Auth (public, no layout) ───────────────────────────────────────
router.get("/login", loginPage);
router.post("/login", authLimiter, csrfProtection, loginPost);
router.post("/logout", csrfProtection, logout);

// ── All routes below require admin session ──────────────────────────
router.use(requireAdminSession);

// ── JSON API routes (no layout) ────────────────────────────────────
router.get("/api/users/:id", userDetail);
router.get("/api/users/:id/delete-impact", userDeleteImpact);
router.post("/api/users/:id/ban", csrfProtection, banUser);
router.post("/api/users/:id/unban", csrfProtection, unbanUser);
router.put("/api/users/:id", csrfProtection, updateUser);
router.delete("/api/users/:id", csrfProtection, deleteUser);
router.post("/api/users/:id/grant-premium", csrfProtection, grantPremium);
router.post("/api/users/:id/revoke-premium", csrfProtection, revokePremium);
router.get("/api/recipes/:id", recipeDetail);
router.post("/api/recipes/:id/toggle-hide", csrfProtection, toggleHideRecipe);
router.post("/api/recipes/:id/toggle-feature", csrfProtection, toggleFeatureRecipe);
router.put("/api/recipes/:id", csrfProtection, updateRecipe);
router.delete("/api/recipes/:id", csrfProtection, deleteRecipe);
router.post("/api/reports/:id/review", csrfProtection, reviewReport);
router.post("/api/reports/:id/dismiss", csrfProtection, dismissReport);
router.post("/api/labels", csrfProtection, createLabel);
router.put("/api/labels/:id", csrfProtection, updateLabel);
router.delete("/api/labels/:id", csrfProtection, deleteLabel);
router.post("/api/seasonal/tags", csrfProtection, createTag);
router.post("/api/seasonal/tags/:id/toggle", csrfProtection, toggleTag);
router.delete("/api/seasonal/tags/:id", csrfProtection, deleteTag);
router.post("/api/seasonal/tag-recipe", csrfProtection, tagRecipe);
router.post("/api/seasonal/untag-recipe", csrfProtection, untagRecipe);
router.get("/api/kitchens/:id", kitchenDetail);
router.get("/api/kitchens/:id/suggestions", kitchenSuggestions);
router.put("/api/kitchens/:id", csrfProtection, updateKitchen);
router.post("/api/kitchens/:id/remove-member", csrfProtection, removeKitchenMember);
router.post("/api/kitchens/:id/transfer-lead", csrfProtection, transferKitchenLead);
router.delete("/api/kitchens/:id/photo", csrfProtection, removeKitchenPhoto);
router.delete("/api/kitchens/:id", csrfProtection, deleteKitchen);

// ── Feedback mutation routes (form POSTs, redirect responses) ──────
router.post("/feedback/:id/status", csrfProtection, updateFeedbackStatus);
router.post("/feedback/:id/note", csrfProtection, updateFeedbackNote);
router.post("/feedback/:id/delete", csrfProtection, deleteFeedback);

// ── Admin management API routes (super admin only) ─────────────────
router.post("/api/admins", requireSuperAdmin, csrfProtection, createAdmin);
router.put("/api/admins/:id", requireSuperAdmin, csrfProtection, updateAdmin);
router.post("/api/admins/:id/toggle-active", requireSuperAdmin, csrfProtection, toggleAdminActive);
router.post("/api/admins/:id/reset-password", requireSuperAdmin, csrfProtection, resetAdminPassword);

// ── Seed data (synthetic discovery accounts) ──────────────────────
router.get("/api/seed-data/users", seedUsersList);
router.get("/api/seed-data/recipes", seedRecipesList);
router.delete("/api/seed-data/users/:id", csrfProtection, deleteSeedUser);
router.delete("/api/seed-data/recipes/:id", csrfProtection, deleteSeedRecipe);
router.delete(
  "/api/seed-data/cuisines/:cuisine",
  csrfProtection,
  deleteSeedCuisine
);
router.delete("/api/seed-data/all", csrfProtection, deleteAllSeed);

// ── App config (runtime feature flags) ─────────────────────────────
router.post("/api/app-config", csrfProtection, updateAppConfig);
router.post(
  "/api/app-config/wrapped-test-users",
  csrfProtection,
  addWrappedTestUser
);
router.delete(
  "/api/app-config/wrapped-test-users/:id",
  csrfProtection,
  removeWrappedTestUser
);

// ── Page routes (with layout) ──────────────────────────────────────
router.use(expressLayouts);
router.get("/", dashboardPage);
router.get("/analytics", analyticsPage);
router.get("/users", usersPage);
router.get("/recipes", recipesPage);
router.get("/moderated-posts", moderatedPostsPage);
router.get("/reports", reportsPage);
router.get("/labels", labelsPage);
router.get("/seasonal", seasonalPage);
router.get("/kitchens", kitchensPage);
router.get("/feedback", feedbackPage);
router.get("/feedback/:id", feedbackDetail);
router.get("/admins", requireSuperAdmin, adminsPage);
router.get("/app-config", appConfigPage);
router.get("/seed-data", seedDataPage);

export default router;
