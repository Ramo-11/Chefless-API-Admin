/**
 * Mark the video-demo user's onboarding complete so the sim can fast-forward
 * past the 4-step onboarding wizard and land on the kitchen home.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://.../chefless_dev" \
 *   LEAD_EMAIL="demo-xxx@chefless.test" \
 *   node --import tsx src/scripts/complete-demo-onboarding.ts
 */
import mongoose from "mongoose";
import User from "../models/User";

async function run() {
  const uri = process.env.MONGODB_URI;
  const email = process.env.LEAD_EMAIL;
  if (!uri) throw new Error("MONGODB_URI required");
  if (!email) throw new Error("LEAD_EMAIL required");
  if (!uri.includes("chefless_dev")) {
    throw new Error("Refusing to run: MONGODB_URI must target chefless_dev");
  }

  await mongoose.connect(uri);
  const r = await User.updateOne(
    { email: email.toLowerCase() },
    {
      $set: {
        onboardingComplete: true,
        fullName: "Omar Henderson",
        cuisinePreferences: ["middle_eastern", "indian", "mediterranean"],
      },
    },
  );
  console.log("matched:", r.matchedCount, "modified:", r.modifiedCount);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
