import crypto from "crypto";
import { Router, Request, Response } from "express";
import User from "../models/User";
import WebhookEvent from "../models/WebhookEvent";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

const router = Router();

/**
 * RevenueCat webhook event shape.
 *
 * `id` is documented in RevenueCat's spec as a unique event identifier and is
 * what we use for idempotency. In the wild, retries of the *same delivery*
 * carry the same id; replays of an in-flight event carry a new one. That
 * matches what we want — reject dupes, accept legit retries.
 */
interface RevenueCatEvent {
  id?: string;
  type: string;
  app_user_id: string;
  product_id?: string;
  expiration_at_ms?: number;
}

interface RevenueCatWebhookPayload {
  event: RevenueCatEvent;
}

function getPlanFromProductId(
  productId: string | undefined
): "monthly" | "annual" | undefined {
  if (!productId) return undefined;
  if (productId.includes("annual") || productId.includes("yearly"))
    return "annual";
  if (productId.includes("monthly")) return "monthly";
  return "monthly";
}

/** True if the error is a Mongo duplicate-key error (code 11000). */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
}

router.post("/revenuecat", async (req: Request, res: Response) => {
  // Verify webhook secret
  const authHeader = req.headers.authorization;
  if (!env.REVENUECAT_WEBHOOK_SECRET) {
    logger.error("REVENUECAT_WEBHOOK_SECRET is not configured");
    res.status(500).json({ error: "Webhook secret not configured" });
    return;
  }

  const expectedToken = `Bearer ${env.REVENUECAT_WEBHOOK_SECRET}`;
  if (
    !authHeader ||
    authHeader.length !== expectedToken.length ||
    !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expectedToken))
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const payload = req.body as RevenueCatWebhookPayload | undefined;
  const event = payload?.event;

  if (!event || !event.type || !event.app_user_id) {
    res.status(400).json({ error: "Invalid webhook payload" });
    return;
  }

  const {
    id: eventId,
    type,
    app_user_id: appUserId,
    product_id: productId,
    expiration_at_ms: expirationAtMs,
  } = event;

  // Idempotency — record the event first. If RevenueCat missing an event id
  // (unexpected), synthesize a stable hash from the payload so retries of the
  // same body still dedupe.
  const idempotencyKey =
    eventId ??
    crypto
      .createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");

  try {
    await WebhookEvent.create({
      eventId: idempotencyKey,
      provider: "revenuecat",
      payload,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      logger.info(
        { eventId: idempotencyKey, type },
        "Duplicate RevenueCat webhook, skipping"
      );
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
    logger.error(
      { err, eventId: idempotencyKey },
      "Failed to record webhook event"
    );
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  try {
    switch (type) {
      case "INITIAL_PURCHASE":
      case "RENEWAL": {
        const plan = getPlanFromProductId(productId);
        const incomingExpiry = expirationAtMs
          ? new Date(expirationAtMs)
          : undefined;

        // Load existing premiumExpiresAt to guard against out-of-order delivery
        // rolling back a longer subscription window.
        const existing = await User.findOne({ firebaseUid: appUserId })
          .select("premiumExpiresAt")
          .lean();

        if (!existing) {
          logger.warn(
            { appUserId, type },
            "RevenueCat event for unknown user; ignoring"
          );
          break;
        }

        const set: Record<string, unknown> = { isPremium: true };
        if (plan) set.premiumPlan = plan;

        // Only advance premiumExpiresAt forward in time. A delayed RENEWAL
        // carrying an older expiry than what's already stored must not shrink
        // the user's window.
        if (incomingExpiry) {
          const currentExpiry = existing.premiumExpiresAt
            ? new Date(existing.premiumExpiresAt)
            : undefined;
          if (!currentExpiry || incomingExpiry.getTime() > currentExpiry.getTime()) {
            set.premiumExpiresAt = incomingExpiry;
          } else {
            logger.info(
              {
                appUserId,
                currentExpiry: currentExpiry.toISOString(),
                incomingExpiry: incomingExpiry.toISOString(),
              },
              "Ignoring stale RevenueCat expiry (would roll back)"
            );
          }
        }

        await User.updateOne(
          { firebaseUid: appUserId },
          {
            $set: set,
            $unset: { premiumGrantedBy: 1, premiumGrantedAt: 1 },
          }
        );
        break;
      }

      case "CANCELLATION":
      case "EXPIRATION": {
        await User.updateOne(
          { firebaseUid: appUserId },
          {
            $set: { isPremium: false },
            $unset: {
              premiumPlan: 1,
              premiumExpiresAt: 1,
              premiumGrantedBy: 1,
              premiumGrantedAt: 1,
            },
          }
        );
        break;
      }

      default:
        // Acknowledge unknown event types without processing.
        logger.info({ type }, "Ignoring unhandled RevenueCat event type");
        break;
    }

    res.status(200).json({ received: true });
  } catch (err: unknown) {
    logger.error(
      { err, eventId: idempotencyKey, type },
      "Error processing RevenueCat event"
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
