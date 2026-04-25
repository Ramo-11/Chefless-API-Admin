/**
 * Create the Apple Reviewer test account in production.
 *
 * Creates a Firebase Auth user (email/password) and a matching Mongo User
 * document. Empty profile, onboarding not completed. Premium is granted
 * separately via the admin dashboard after this runs.
 *
 * Usage (from chefless-api/):
 *   NODE_ENV=production npm run create-apple-review-user
 *
 * Reads MONGODB_URI / FIREBASE_PROJECT_ID / FIREBASE_SERVICE_ACCOUNT_KEY
 * from .env. Refuses to run unless NODE_ENV=production so the reviewer
 * account always lands in the prod database.
 *
 * Idempotent: re-running rotates the Firebase password and leaves the
 * Mongo doc untouched.
 */
import "dotenv/config";
import mongoose from "mongoose";
import admin from "firebase-admin";
import User, { DEFAULT_NOTIFICATION_PREFERENCES } from "../models/User";

const REVIEWER_EMAIL = "apple-review@chefless.org";
const REVIEWER_PASSWORD = "Chefless2026!";
const FULL_NAME = "Apple Review";

async function run() {
  if (process.env.NODE_ENV !== "production") {
    throw new Error(
      "Refusing to run: set NODE_ENV=production. The reviewer account must live in the prod database."
    );
  }

  const uri = process.env.MONGODB_URI;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!uri) throw new Error("MONGODB_URI required");
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID required");
  if (!serviceAccountKey) throw new Error("FIREBASE_SERVICE_ACCOUNT_KEY required");

  const email = REVIEWER_EMAIL;
  const password = REVIEWER_PASSWORD;

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId,
      credential: admin.credential.cert(
        JSON.parse(serviceAccountKey) as admin.ServiceAccount
      ),
    });
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  // 1. Firebase Auth — create or rotate password
  let firebaseUid: string;
  try {
    const existing = await admin.auth().getUserByEmail(email);
    firebaseUid = existing.uid;
    await admin.auth().updateUser(firebaseUid, {
      password,
      emailVerified: true,
      disabled: false,
    });
    console.log(`Firebase user already existed; password rotated. uid=${firebaseUid}`);
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "auth/user-not-found"
    ) {
      const created = await admin.auth().createUser({
        email,
        password,
        displayName: FULL_NAME,
        emailVerified: true,
      });
      firebaseUid = created.uid;
      console.log(`Firebase user created. uid=${firebaseUid}`);
    } else {
      throw err;
    }
  }

  // 2. Mongo user doc — create only if missing
  const existingDoc = await User.findOne({
    $or: [{ firebaseUid }, { email }],
  });

  if (existingDoc) {
    console.log(
      `Mongo user already exists (id=${existingDoc._id.toString()}); leaving as-is.`
    );
  } else {
    const doc = await User.create({
      firebaseUid,
      email,
      fullName: FULL_NAME,
      isPublic: true,
      onboardingComplete: false,
      notificationPreferences: { ...DEFAULT_NOTIFICATION_PREFERENCES },
    });
    console.log(`Mongo user created. id=${doc._id.toString()}`);
  }

  console.log("\nReviewer credentials:");
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log("\nNext: promote to Premium via admin dashboard.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
