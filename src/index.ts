import path from "path";
import express from "express";
import cors from "cors";
import session from "express-session";
import MongoStore from "connect-mongo";
import { env } from "./lib/env";
import { connectDatabase } from "./lib/db";
import { defaultLimiter } from "./middleware/rateLimit";
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

// ── Core middleware ─────────────────────────────────────────────────
app.use(cors({
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Authorization", "Content-Type"],
}));
app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(defaultLimiter);

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
      maxAge: 24 * 60 * 60 * 1000,
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
app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);
// Upload routes need a higher body limit for base64 image data
app.use("/api/users", express.json({ limit: "10mb" }), usersRouter);
app.use("/api/recipes", express.json({ limit: "10mb" }), recipesRouter);
app.use("/api/kitchens", kitchensRouter);
app.use("/api/schedule", scheduleRouter);
app.use("/api/shopping-lists", shoppingListsRouter);
app.use("/api/search", searchRouter);
app.use("/api/feed", feedRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/labels", labelsRouter);
app.use("/api/reports", reportsRouter);

// ── Error handler (must be last) ────────────────────────────────────
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`Chefless API running on port ${env.PORT}`);
  connectDatabase().catch((error) => {
    console.error("MongoDB connection failed:", error);
  });
});

export default app;
