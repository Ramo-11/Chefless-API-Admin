import { Request, Response, NextFunction } from "express";
import admin from "firebase-admin";
import User from "../models/User";

// Initialize Firebase Admin only once.
// Service account credentials are required for FCM push delivery.
// Auth token verification (verifyIdToken) works with just projectId,
// but admin.messaging().send() needs authenticated credentials.
if (!admin.apps.length) {
  const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountKey) {
    console.warn(
      "[FCM-DEBUG] Firebase Admin initialized WITHOUT FIREBASE_SERVICE_ACCOUNT_KEY. " +
        "Auth verification may still work, but FCM push notifications are DISABLED."
    );
  } else {
    try {
      const parsed = JSON.parse(serviceAccountKey) as Record<string, unknown>;
      console.log(
        `[FCM-DEBUG] Firebase Admin initializing WITH service account. ` +
          `project_id=${parsed.project_id}, client_email=${parsed.client_email}`
      );
    } catch (e) {
      console.error(
        `[FCM-DEBUG] FIREBASE_SERVICE_ACCOUNT_KEY is set but INVALID JSON: ${e instanceof Error ? e.message : e}`
      );
    }
  }
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID,
    ...(serviceAccountKey && {
      credential: admin.credential.cert(
        JSON.parse(serviceAccountKey) as admin.ServiceAccount
      ),
    }),
  });
  console.log(
    `[FCM-DEBUG] Firebase Admin initialized. App name: ${admin.app().name}, ` +
      `projectId: ${process.env.FIREBASE_PROJECT_ID}`
  );
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
    };

    // Check if user is banned
    const user = await User.findOne({ firebaseUid: decodedToken.uid })
      .select("isBanned")
      .lean();

    if (user?.isBanned) {
      res.status(403).json({
        error: "Your account has been suspended. Contact support for assistance.",
      });
      return;
    }

    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
