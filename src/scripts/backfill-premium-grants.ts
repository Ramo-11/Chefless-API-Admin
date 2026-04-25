/**
 * Backfill premiumPlan + premiumGrantedBy + premiumGrantedAt on every
 * existing premium user.
 *
 * Premise: at this point in time, no production user has paid through
 * RevenueCat yet — every current premium account was granted by the same
 * admin (omarh5877@gmail.com). This rewrites those rows so the admin
 * dashboard shows the granter explicitly instead of "unknown admin".
 *
 * Usage (from chefless-api/):
 *   NODE_ENV=production npm run backfill-premium-grants
 *
 * Idempotent: safe to re-run. Only sets premiumGrantedAt when missing so
 * the original grant date is preserved on subsequent runs.
 */
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User";
import AdminUser from "../models/AdminUser";

const GRANTER_EMAIL = "omarh5877@gmail.com";

async function run() {
  if (process.env.NODE_ENV !== "production") {
    throw new Error(
      "Refusing to run: set NODE_ENV=production. This backfill targets the prod database."
    );
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI required");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const granter = await AdminUser.findOne({ email: GRANTER_EMAIL.toLowerCase() })
    .select("_id email name")
    .lean();
  if (!granter) {
    throw new Error(
      `AdminUser not found for ${GRANTER_EMAIL}. Run npm run seed:admin first.`
    );
  }
  console.log(`Granter: ${granter.name} <${granter.email}> (id=${granter._id.toString()})`);

  const now = new Date();

  const premiumCount = await User.countDocuments({ isPremium: true });
  console.log(`Found ${premiumCount} premium users.`);

  // 1. Ensure plan + granter on every premium user.
  const planAndGranter = await User.updateMany(
    { isPremium: true },
    {
      $set: {
        premiumPlan: "admin",
        premiumGrantedBy: granter._id,
      },
    }
  );

  // 2. Backfill premiumGrantedAt only where missing (preserve real grant time).
  const grantedAt = await User.updateMany(
    {
      isPremium: true,
      $or: [
        { premiumGrantedAt: { $exists: false } },
        { premiumGrantedAt: null },
      ],
    },
    { $set: { premiumGrantedAt: now } }
  );

  console.log(
    `Plan/granter — matched ${planAndGranter.matchedCount}, modified ${planAndGranter.modifiedCount}`
  );
  console.log(
    `Granted-at  — matched ${grantedAt.matchedCount}, modified ${grantedAt.modifiedCount}`
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
