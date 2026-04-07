import path from "path";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import MongoStore from "connect-mongo";
import { env } from "./lib/env";
import { connectDatabase } from "./lib/db";
import { defaultLimiter, strictLimiter } from "./middleware/rateLimit";
import { errorHandler } from "./middleware/errorHandler";
import healthRouter from "./routes/health";
import authRouter from "./routes/auth";
import usersRouter from "./routes/users";
import recipesRouter from "./routes/recipes";
import kitchensRouter from "./routes/kitchens";
import scheduleRouter from "./routes/schedules";
import shoppingListsRouter from "./routes/shopping-lists";
import searchRouter from "./routes/search";
import feedRouter from "./routes/feed";
import notificationsRouter from "./routes/notifications";
import webhooksRouter from "./routes/webhooks";
import labelsRouter from "./routes/labels";
import reportsRouter from "./routes/reports";
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
app.use(defaultLimiter);

// ── Request ID for tracing ─────────────────────────────────────────
app.use((req, _res, next) => {
  req.requestId = (req.headers["x-request-id"] as string) || crypto.randomUUID();
  next();
});

// JSON body parsers — applied per-route so upload routes can have a higher limit.
// Must NOT use a global express.json() or its limit would block larger uploads
// before the route-specific parser runs.
const jsonDefault = express.json({ limit: "1mb" });
const jsonUpload = express.json({ limit: "10mb" });

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
      secure: true,
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
app.use("/api/health", jsonDefault, healthRouter);
app.use("/api/auth", jsonDefault, strictLimiter, authRouter);
// Upload routes need a higher body limit for base64 image data
app.use("/api/users", jsonUpload, usersRouter);
app.use("/api/recipes", jsonUpload, recipesRouter);
app.use("/api/kitchens", jsonDefault, kitchensRouter);
app.use("/api/schedule", jsonDefault, scheduleRouter);
app.use("/api/shopping-lists", jsonDefault, shoppingListsRouter);
app.use("/api/search", jsonDefault, searchRouter);
app.use("/api/feed", jsonDefault, feedRouter);
app.use("/api/notifications", jsonDefault, notificationsRouter);
app.use("/api/labels", jsonDefault, labelsRouter);
app.use("/api/reports", jsonDefault, strictLimiter, reportsRouter);

// ── Error handler (must be last) ────────────────────────────────────
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`Chefless API running on port ${env.PORT}`);
  connectDatabase().catch((error) => {
    console.error("MongoDB connection failed:", error);
  });
});

export default app;
