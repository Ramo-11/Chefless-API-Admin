import crypto from "crypto";
import { Router, Request, Response } from "express";
import User from "../models/User";
import { env } from "../lib/env";

const router = Router();

interface RevenueCatEvent {
  type: string;
  app_user_id: string;
  product_id?: string;
  expiration_at_ms?: number;
}

interface RevenueCatWebhookPayload {
  event: RevenueCatEvent;
}

function getPlanFromProductId(productId: string | undefined): "monthly" | "annual" | undefined {
  if (!productId) return undefined;
  if (productId.includes("annual") || productId.includes("yearly")) return "annual";
  if (productId.includes("monthly")) return "monthly";
  return "monthly";
}

router.post("/revenuecat", async (req: Request, res: Response) => {
  // Verify webhook secret
  const authHeader = req.headers.authorization;
  if (!env.REVENUECAT_WEBHOOK_SECRET) {
    console.error("[Webhook] REVENUECAT_WEBHOOK_SECRET is not configured");
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

  const payload = req.body as RevenueCatWebhookPayload;
  const event = payload?.event;

  if (!event || !event.type || !event.app_user_id) {
    res.status(400).json({ error: "Invalid webhook payload" });
    return;
  }

  const { type, app_user_id: appUserId, product_id: productId, expiration_at_ms: expirationAtMs } = event;

  try {
    switch (type) {
      case "INITIAL_PURCHASE":
      case "RENEWAL": {
        const plan = getPlanFromProductId(productId);
        const premiumExpiresAt = expirationAtMs ? new Date(expirationAtMs) : undefined;

        const updateFields: Record<string, unknown> = {
          isPremium: true,
        };
        if (plan) {
          updateFields.premiumPlan = plan;
        }
        if (premiumExpiresAt) {
          updateFields.premiumExpiresAt = premiumExpiresAt;
        }

        await User.updateOne(
          { firebaseUid: appUserId },
          { $set: updateFields }
        );
        break;
      }

      case "CANCELLATION":
      case "EXPIRATION": {
        await User.updateOne(
          { firebaseUid: appUserId },
          {
            $set: { isPremium: false },
            $unset: { premiumPlan: 1, premiumExpiresAt: 1 },
          }
        );
        break;
      }

      default:
        // Acknowledge unknown event types without processing
        break;
    }

    res.status(200).json({ received: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Webhook] Error processing RevenueCat event: ${msg}`);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
