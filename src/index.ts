import path from "path";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import MongoStore from "connect-mongo";
import { env } from "./lib/env";
import { connectDatabase } from "./lib/db";
import {
  apiReadLimiter,
  apiWriteLimiter,
  strictLimiter,
  authLimiter,
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
import aiRouter from "./routes/ai";
import promoCodesRouter from "./routes/promo-codes";
import adminRouter from "./admin/routes";
import pagesRouter from "./routes/pages";

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

// ── Core middleware ─────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : undefined,
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Authorization", "Content-Type"],
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
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    },
  })
);

// ── Public pages (privacy, terms) ───────────────────────────────────
app.use("/", pagesRouter);

// ── Admin panel (served at /admin) ──────────────────────────────────
app.use("/admin", adminRouter);

// ── Webhook routes (no auth — they verify their own secrets) ────────
app.use("/api/webhooks", webhooksRouter);

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
app.use("/api/kitchens", jsonDefault, ...apiLimiters, kitchensRouter);
app.use("/api/schedule", jsonDefault, ...apiLimiters, scheduleRouter);
app.use("/api/shopping-lists", jsonDefault, ...apiLimiters, shoppingListsRouter);
app.use("/api/search", jsonDefault, ...apiLimiters, searchRouter);
app.use("/api/feed", jsonDefault, ...apiLimiters, feedRouter);
app.use("/api/notifications", jsonDefault, ...apiLimiters, notificationsRouter);
app.use("/api/labels", jsonDefault, ...apiLimiters, labelsRouter);
app.use("/api/reports", jsonDefault, strictLimiter, reportsRouter);
app.use("/api/ai", jsonDefault, strictLimiter, aiRouter);
app.use("/api/promo-codes", jsonDefault, ...apiLimiters, promoCodesRouter);

// ── Error handler (must be last) ────────────────────────────────────
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`Chefless API running on port ${env.PORT}`);
  connectDatabase().catch((error) => {
    console.error("MongoDB connection failed:", error);
  });
});

export default app;
