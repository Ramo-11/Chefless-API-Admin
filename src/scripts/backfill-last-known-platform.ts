/**
 * Backfill `lastKnownPlatform` on existing users from data we already have.
 *
 * Why: `lastKnownPlatform` is captured from the Flutter client on FCM-token
 * registration, but only for app launches that happen after the field shipped.
 * Until everyone re-opens the app, the admin Users table shows "Unknown" for
 * historical accounts. We can do better by harvesting platform from records
 * already attributed to each user.
 *
 * Sources (most authoritative first):
 *   1. ClientError.platform / userId (lastSeenAt is the newest signal)
 *   2. Feedback.platform / userId (createdAt)
 *
 * Both collections store `ios | android | web` per record. We pick the most
 * recent record per user and copy its platform onto User.lastKnownPlatform —
 * but only when the field is currently unset, so a real FCM registration
 * (which is more authoritative — the user literally opened the app on that
 * device) is never overwritten.
 *
 * Idempotent: safe to re-run. Users who already have lastKnownPlatform set
 * are skipped. Users with no signal in either collection stay unknown.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-last-known-platform.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User";
import ClientError from "../models/ClientError";
import Feedback from "../models/Feedback";
import { env } from "../lib/env";

type Platform = "ios" | "android" | "web";

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  console.log("Connected to MongoDB");

  const users = await User.find({
    lastKnownPlatform: { $exists: false },
  })
    .select("_id")
    .lean();
  console.log(`Found ${users.length} users with no platform recorded.`);

  let processed = 0;
  let updated = 0;
  let stillUnknown = 0;
  const tally: Record<Platform, number> = { ios: 0, android: 0, web: 0 };

  for (const u of users) {
    const platform = await resolvePlatform(u._id);
    if (platform) {
      await User.updateOne(
        { _id: u._id },
        { $set: { lastKnownPlatform: platform } }
      );
      updated += 1;
      tally[platform] += 1;
    } else {
      stillUnknown += 1;
    }

    processed += 1;
    if (processed % 100 === 0) {
      console.log(`  ...${processed}/${users.length}`);
    }
  }

  console.log("");
  console.log(`Done. Processed ${processed} users.`);
  console.log(`  Backfilled: ${updated}`);
  console.log(`    ios:     ${tally.ios}`);
  console.log(`    android: ${tally.android}`);
  console.log(`    web:     ${tally.web}`);
  console.log(`  Still unknown (no error/feedback signal): ${stillUnknown}`);

  await mongoose.disconnect();
}

async function resolvePlatform(
  userId: mongoose.Types.ObjectId
): Promise<Platform | null> {
  const latestError = await ClientError.findOne({ userId })
    .sort({ lastSeenAt: -1 })
    .select("platform lastSeenAt")
    .lean();

  const latestFeedback = await Feedback.findOne({
    userId,
    platform: { $in: ["ios", "android", "web"] },
  })
    .sort({ createdAt: -1 })
    .select("platform createdAt")
    .lean();

  const errorAt = latestError?.lastSeenAt?.getTime() ?? 0;
  const feedbackAt = latestFeedback?.createdAt?.getTime() ?? 0;

  if (errorAt === 0 && feedbackAt === 0) return null;

  const winner = errorAt >= feedbackAt ? latestError : latestFeedback;
  const platform = winner?.platform;
  if (platform === "ios" || platform === "android" || platform === "web") {
    return platform;
  }
  return null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
