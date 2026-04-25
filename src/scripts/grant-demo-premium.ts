/**
 * Grant premium to the video-demo user so Month/Year schedule views unlock.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://.../chefless_dev" \
 *   LEAD_EMAIL="demo-xxx@chefless.test" \
 *   node --import tsx src/scripts/grant-demo-premium.ts
 */
import mongoose from "mongoose";
import User from "../models/User";

async function run() {
  const uri = process.env.MONGODB_URI;
  const email = process.env.LEAD_EMAIL;
  const name = process.env.LEAD_NAME;
  if (!uri) throw new Error("MONGODB_URI required");
  if (!email && !name) throw new Error("LEAD_EMAIL or LEAD_NAME required");
  if (!uri.includes("chefless_dev")) {
    throw new Error("Refusing to run: MONGODB_URI must target chefless_dev");
  }

  await mongoose.connect(uri);
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);
  const filter = email ? { email: email.toLowerCase() } : { fullName: name };
  const r = await User.updateOne(filter, {
    $set: {
      isPremium: true,
      premiumPlan: "admin",
      premiumExpiresAt: expires,
    },
  });
  console.log("matched:", r.matchedCount, "modified:", r.modifiedCount);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
