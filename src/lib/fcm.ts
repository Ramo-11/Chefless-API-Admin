import admin from "firebase-admin";
import User from "../models/User";

interface PushData {
  [key: string]: string;
}

/**
 * Send a push notification via Firebase Cloud Messaging.
 *
 * If the token is invalid or unregistered (user uninstalled, revoked
 * permissions, etc.), the stale token is automatically removed from the
 * user document so we don't waste future attempts.
 *
 * Errors are logged but never thrown — push failures must not break the caller.
 */
export async function sendPushNotification(
  fcmToken: string,
  title: string,
  body: string,
  data?: PushData
): Promise<void> {
  console.log(
    `[FCM-DEBUG] sendPushNotification called. title="${title}", ` +
      `tokenPrefix="${fcmToken.slice(0, 12)}...", hasData=${!!data}`
  );

  if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    console.error(
      "[FCM-DEBUG] ABORTING: FIREBASE_SERVICE_ACCOUNT_KEY is NOT SET. No push will be sent."
    );
    return;
  }

  try {
    const message: admin.messaging.Message = {
      token: fcmToken,
      notification: {
        title,
        body,
      },
      data,
      android: {
        priority: "high",
        notification: {
          sound: "default",
        },
      },
      apns: {
        headers: {
          "apns-priority": "10",
        },
        payload: {
          aps: {
            alert: {
              title,
              body,
            },
            sound: "default",
            badge: 1,
            "mutable-content": 1,
          },
        },
      },
    };

    console.log(
      `[FCM-DEBUG] Sending message. Full payload: ${JSON.stringify(message, null, 2)}`
    );

    const messageId = await admin.messaging().send(message);
    console.log(
      `[FCM-DEBUG] SUCCESS — message sent. messageId="${messageId}", ` +
        `tokenPrefix="${fcmToken.slice(0, 12)}..."`
    );
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "Unknown FCM error";
    const errorCode =
      err && typeof err === "object" && "code" in err
        ? (err as { code: string }).code
        : "unknown";

    console.error(
      `[FCM-DEBUG] SEND FAILED — code="${errorCode}", message="${errorMessage}", ` +
        `tokenPrefix="${fcmToken.slice(0, 12)}..."`
    );

    // Log the full error for debugging
    if (err instanceof Error && err.stack) {
      console.error(`[FCM-DEBUG] Stack: ${err.stack}`);
    }

    // Invalid or unregistered tokens are expected when users uninstall
    // the app or revoke notification permissions. Clean them up so we
    // don't keep trying to deliver to a dead token.
    if (
      errorMessage.includes("registration-token-not-registered") ||
      errorMessage.includes("invalid-registration-token")
    ) {
      console.info(
        `[FCM-DEBUG] Token invalid — clearing from user (token prefix: ${fcmToken.slice(0, 12)}...)`
      );
      // Fire-and-forget: remove the stale token from the user document.
      User.findOneAndUpdate(
        { fcmToken },
        { $unset: { fcmToken: "" } }
      ).catch((cleanupErr: unknown) => {
        console.error(
          `[FCM-DEBUG] Failed to clear stale FCM token: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`
        );
      });
    }
  }
}
