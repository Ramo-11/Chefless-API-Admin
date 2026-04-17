import rateLimit from "express-rate-limit";
import type { Request } from "express";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Decode the Firebase ID token (signature NOT verified — that's done by
 * `requireAuth`). Used solely as a stable per-user bucket key for rate limits.
 * Forging a token only buys access to your *own* bucket — never another user's.
 */
function userKeyFromBearer(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    ) as { user_id?: string; sub?: string };
    const uid = payload.user_id ?? payload.sub;
    return uid ? `u:${uid}` : null;
  } catch {
    return null;
  }
}

/** Per-user when authenticated, per-IP otherwise. IPv6-safe. */
function userOrIpKey(req: Request): string {
  return userKeyFromBearer(req) ?? `ip:${req.ip ?? "unknown"}`;
}

const baseOptions = {
  windowMs: 15 * 60 * 1000,
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
};

/**
 * Reads — generous because list/feed/detail endpoints are paginated and a
 * single browsing session can fire 30+ GETs. 600/15min ≈ 40/min sustained.
 */
export const apiReadLimiter = rateLimit({
  ...baseOptions,
  limit: isDev ? 5000 : 600,
  message: { error: "Too many requests, please slow down and try again." },
  skip: (req) => req.method !== "GET" && req.method !== "HEAD",
});

/**
 * Writes — moderate. POST/PATCH/DELETE on owned resources. 150/15min ≈ 10/min
 * sustained (much higher than realistic human rate).
 */
export const apiWriteLimiter = rateLimit({
  ...baseOptions,
  limit: isDev ? 1500 : 150,
  message: { error: "Too many writes, please slow down and try again." },
  skip: (req) =>
    req.method === "GET" ||
    req.method === "HEAD" ||
    req.method === "OPTIONS",
});

/** Strict — for AI/reports (expensive ops). Per-user. */
export const strictLimiter = rateLimit({
  ...baseOptions,
  limit: isDev ? 200 : 30,
  message: { error: "Too many requests, please try again later." },
});

/**
 * Auth — per-IP (no user yet). Tighter to slow credential stuffing.
 * Excludes token-refresh and other safe auth reads if any.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isDev ? 100 : 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${req.ip ?? "unknown"}`,
  message: {
    error: "Too many authentication attempts, please try again later.",
  },
});
