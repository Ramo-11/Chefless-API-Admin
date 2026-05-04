import path from "path";
import crypto from "crypto";
import express from "express";
import cors, { CorsOptions } from "cors";
import helmet from "helmet";
import session from "express-session";
import MongoStore from "connect-mongo";
import { env } from "./lib/env";
import { connectDatabase } from "./lib/db";
import { logger } from "./lib/logger";
import {
  apiReadLimiter,
  apiWriteLimiter,
  strictLimiter,
  authLimiter,
  webhookLimiter,
} from "./middleware/rateLimit";
import { errorHandler } from "./middleware/errorHandler";
import healthRouter from "./routes/health";
import authRouter from "./routes/auth";
import usersRouter from "./routes/users";
import recipesRouter from "./routes/recipes";
import cookbooksRouter from "./routes/cookbooks";
import kitchensRouter from "./routes/kitchens";
import scheduleRouter from "./routes/schedules";
import shoppingListsRouter from "./routes/shopping-lists";
import searchRouter from "./routes/search";
import feedRouter from "./routes/feed";
import notificationsRouter from "./routes/notifications";
import webhooksRouter from "./routes/webhooks";
import labelsRouter from "./routes/labels";
import reportsRouter from "./routes/reports";
import feedbackRouter from "./routes/feedback";
import aiRouter from "./routes/ai";
import adminRouter from "./admin/routes";
import pagesRouter from "./routes/pages";
import blocksRouter from "./routes/blocks";
import cookPromptsRouter from "./routes/cook-prompts";
import cookedPostsRouter from "./routes/cooked-posts";
import passportRouter from "./routes/passport";
import remixTreeRouter from "./routes/remix-tree";
import wrappedRouter from "./routes/wrapped";
import appConfigRouter from "./routes/app-config";

const app = express();

// ── Trust proxy (Render runs behind a reverse proxy) ────────────────
app.set("trust proxy", 1);

// ── View engine (EJS for admin panel) ───────────────────────────────
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ── Static files ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Security headers ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // CSP managed separately for admin EJS views
}));

// ── CORS ────────────────────────────────────────────────────────────
// In production, require an explicit allowlist. If ALLOWED_ORIGINS is empty,
// refuse all browser origins (passing `origin: false` to cors). Server-to-
// server and mobile clients don't send an Origin header and remain unaffected.
// In development, allow any origin for local tooling.
const isProd = env.NODE_ENV === "production";
const corsOriginOption: CorsOptions["origin"] = isProd
  ? env.ALLOWED_ORIGINS.length > 0
    ? env.ALLOWED_ORIGINS
    : false
  : true;

app.use(cors({
  origin: corsOriginOption,
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Authorization", "Content-Type", "X-CSRF-Token"],
  credentials: true,
}));

app.use(express.urlencoded({ extended: true }));

// ── Request ID for tracing ─────────────────────────────────────────
app.use((req, _res, next) => {
  req.requestId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
  next();
});

// JSON body parsers — applied per-route so upload routes can have a higher limit.
// Must NOT use a global express.json() or its limit would block larger uploads
// before the route-specific parser runs.
const jsonDefault = express.json({ limit: "1mb" });
const jsonUpload = express.json({ limit: "15mb" });

// ── Session middleware (admin panel only, but applied globally) ──────
app.use(
  session({
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: env.MONGODB_URI,
      collectionName: "admin_sessions",
      ttl: 24 * 60 * 60, // 1 day
    }),
    cookie: {
      maxAge: 4 * 60 * 60 * 1000, // 4 hours for admin sessions
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
    },
  })
);

// ── Public pages (privacy, terms) ───────────────────────────────────
app.use("/", pagesRouter);

// ── Admin panel (served at /admin) ──────────────────────────────────
app.use("/admin", adminRouter);

// ── Webhook routes (no auth — they verify their own secrets) ────────
// RevenueCat webhooks are authorized by a shared Bearer token (see
// routes/webhooks.ts) and carry JSON bodies. We verify the *token*, not a
// signature over the raw body, so parsing JSON here is safe. If the provider
// is ever swapped for one that signs raw bytes, this mount must move to
// express.raw and the verifier will need access to the raw buffer.
app.use(
  "/api/webhooks",
  webhookLimiter,
  express.json({ limit: "1mb" }),
  webhooksRouter
);

// ── API routes ──────────────────────────────────────────────────────
// Rate limit strategy:
//   - apiReadLimiter:  per-user, generous (only counts GET/HEAD)
//   - apiWriteLimiter: per-user, moderate (only counts POST/PATCH/DELETE)
//   - Both applied to authed API routes; together they form one cohesive limit
//     without one method type starving the other.
const apiLimiters = [apiReadLimiter, apiWriteLimiter];

app.use("/api/health", jsonDefault, healthRouter);
app.use("/api/auth", jsonDefault, authLimiter, authRouter);
// Upload routes need a higher body limit for base64 image data
app.use("/api/users", jsonUpload, ...apiLimiters, usersRouter);
app.use("/api/recipes", jsonUpload, ...apiLimiters, recipesRouter);
app.use("/api/cookbooks", jsonUpload, ...apiLimiters, cookbooksRouter);
// Kitchens routes accept base64 photo uploads on /me/photo — needs larger
// JSON limit than the default 1MB to handle the base64 overhead on a 1600px
// JPEG at ~88% quality.
app.use("/api/kitchens", jsonUpload, ...apiLimiters, kitchensRouter);
app.use("/api/schedule", jsonDefault, ...apiLimiters, scheduleRouter);
app.use("/api/shopping-lists", jsonDefault, ...apiLimiters, shoppingListsRouter);
app.use("/api/search", jsonDefault, ...apiLimiters, searchRouter);
app.use("/api/feed", jsonDefault, ...apiLimiters, feedRouter);
app.use("/api/notifications", jsonDefault, ...apiLimiters, notificationsRouter);
app.use("/api/labels", jsonDefault, ...apiLimiters, labelsRouter);
app.use("/api/reports", jsonDefault, strictLimiter, reportsRouter);
app.use("/api/feedback", jsonDefault, strictLimiter, feedbackRouter);
app.use("/api/ai", jsonDefault, strictLimiter, aiRouter);
app.use("/api/blocks", jsonDefault, ...apiLimiters, blocksRouter);
app.use("/api/cook-prompts", jsonDefault, ...apiLimiters, cookPromptsRouter);
// Cooked-posts endpoints accept base64 photos, so use the larger body limit.
app.use("/api/cooked-posts", jsonUpload, ...apiLimiters, cookedPostsRouter);
app.use("/api/passport", jsonDefault, ...apiLimiters, passportRouter);
app.use("/api/remix-tree", jsonDefault, ...apiLimiters, remixTreeRouter);
app.use("/api/wrapped", jsonDefault, ...apiLimiters, wrappedRouter);
app.use("/api/app-config", jsonDefault, ...apiLimiters, appConfigRouter);

// ── Error handler (must be last) ────────────────────────────────────
app.use(errorHandler);

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "Chefless API listening");
  connectDatabase().catch((error) => {
    logger.error({ err: error }, "MongoDB connection failed");
  });
});

export default app;
