import User, { IUser } from "../models/User";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

/**
 * Server-side RevenueCat integration.
 *
 * The RevenueCat webhook (`routes/webhooks.ts`) is the push path for
 * entitlement changes, but a delayed or dropped webhook would leave a paying
 * user locked out. This service is the deterministic pull path: the app calls
 * `POST /api/users/me/sync-subscription` right after a purchase / restore, and
 * we reconcile the user's stored premium state against RevenueCat's servers.
 *
 * IMPORTANT: RevenueCat's `app_user_id` for this product is the Firebase UID.
 * Both the webhook lookup and this service key on `firebaseUid`. The mobile
 * app MUST configure the RevenueCat SDK with `appUserID = firebaseUid` to
 * match — see `chefless-app/lib/providers/subscription_provider.dart`.
 */

const REVENUECAT_API_BASE = "https://api.revenuecat.com/v1";

/** Entitlement identifier configured in the RevenueCat dashboard. */
const PREMIUM_ENTITLEMENT_ID = "Chefless Pro";

interface RevenueCatEntitlement {
  /** ISO timestamp, or `null` for a non-expiring entitlement. */
  expires_date: string | null;
  product_identifier?: string;
  purchase_date?: string;
}

interface RevenueCatSubscriberResponse {
  subscriber?: {
    entitlements?: Record<string, RevenueCatEntitlement>;
  };
}

export interface PremiumStatus {
  isActive: boolean;
  plan?: "monthly" | "annual";
  expiresAt?: Date;
}

function planFromProductId(
  productId: string | undefined
): "monthly" | "annual" | undefined {
  if (!productId) return undefined;
  const id = productId.toLowerCase();
  if (id.includes("annual") || id.includes("yearly")) return "annual";
  if (id.includes("monthly")) return "monthly";
  return "monthly";
}

/** True when server-side RevenueCat verification is available. */
export function isRevenueCatVerificationConfigured(): boolean {
  return Boolean(env.REVENUECAT_API_KEY);
}

/**
 * Queries RevenueCat's REST API for the given app user's premium entitlement.
 *
 * Returns `{ isActive: false }` for an app user RevenueCat has never seen
 * (HTTP 404) — that is a definitive "no entitlements", not an error. Throws on
 * genuine failures (auth, network, 5xx) so callers can retry rather than
 * mistakenly downgrading a user.
 */
export async function fetchPremiumStatus(
  appUserId: string
): Promise<PremiumStatus> {
  if (!env.REVENUECAT_API_KEY) {
    throw new Error("REVENUECAT_API_KEY is not configured");
  }

  const res = await fetch(
    `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(appUserId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.REVENUECAT_API_KEY}`,
        Accept: "application/json",
      },
    }
  );

  // 404 => RevenueCat has no record of this app user id. Legitimate "not
  // premium", not a failure.
  if (res.status === 404) {
    return { isActive: false };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `RevenueCat subscriber lookup failed (${res.status}): ${body.slice(0, 200)}`
    );
  }

  const data = (await res.json()) as RevenueCatSubscriberResponse;
  const entitlement = data.subscriber?.entitlements?.[PREMIUM_ENTITLEMENT_ID];

  if (!entitlement) {
    return { isActive: false };
  }

  // `expires_date: null` means a non-expiring entitlement. Otherwise it is
  // active only while the expiry is in the future.
  const expiresAt = entitlement.expires_date
    ? new Date(entitlement.expires_date)
    : undefined;
  const isActive = !expiresAt || expiresAt.getTime() > Date.now();

  return {
    isActive,
    plan: planFromProductId(entitlement.product_identifier),
    expiresAt,
  };
}

/**
 * Forces the user's stored premium state to match RevenueCat's servers.
 *
 * Deterministic backstop to the webhook: the app calls this immediately after
 * a purchase / restore so premium unlocks even if the webhook is delayed or
 * dropped. Returns the up-to-date user document, or `null` if no user exists
 * for `firebaseUid`.
 *
 * Behaviour:
 * - No secret key configured -> returns the current DB record unchanged (the
 *   correctly-keyed webhook remains the update path in this mode).
 * - RevenueCat lookup fails -> returns the current DB record unchanged so a
 *   transient error never downgrades a paying user; the caller can retry.
 * - Admin-granted premium (`premiumPlan === "admin"`) is never downgraded
 *   here — those grants are managed exclusively from the admin panel.
 */
export async function syncUserPremiumFromRevenueCat(
  firebaseUid: string
): Promise<IUser | null> {
  const user = await User.findOne({ firebaseUid });
  if (!user) return null;

  if (!isRevenueCatVerificationConfigured()) {
    return user;
  }

  let status: PremiumStatus;
  try {
    status = await fetchPremiumStatus(firebaseUid);
  } catch (err) {
    logger.error({ err, firebaseUid }, "RevenueCat sync lookup failed");
    return user;
  }

  if (status.isActive) {
    user.isPremium = true;
    if (status.plan) user.premiumPlan = status.plan;
    user.premiumExpiresAt = status.expiresAt;
    // A real entitlement supersedes any prior admin grant bookkeeping.
    user.premiumGrantedBy = undefined;
    user.premiumGrantedAt = undefined;
    await user.save();
    logger.info({ firebaseUid, plan: status.plan }, "Premium synced: active");
    return user;
  }

  // RevenueCat reports no active entitlement. Never touch admin grants.
  if (user.premiumPlan === "admin") {
    return user;
  }

  if (user.isPremium || user.premiumPlan || user.premiumExpiresAt) {
    user.isPremium = false;
    user.premiumPlan = undefined;
    user.premiumExpiresAt = undefined;
    await user.save();
    logger.info({ firebaseUid }, "Premium synced: inactive");
  }
  return user;
}
