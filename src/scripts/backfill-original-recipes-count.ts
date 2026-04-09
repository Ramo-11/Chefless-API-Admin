/**
 * One-time / maintenance: set User.originalRecipesCount from Recipe data.
 * Run: npx tsx src/scripts/backfill-original-recipes-count.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User";
import Recipe from "../models/Recipe";
import { env } from "../lib/env";

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  const users = await User.find().select("_id").lean();
  let n = 0;
  for (const u of users) {
    const count = await Recipe.countDocuments({
      authorId: u._id,
      $or: [{ forkedFrom: { $exists: false } }, { forkedFrom: null }],
    });
    await User.updateOne({ _id: u._id }, { $set: { originalRecipesCount: count } });
    n += 1;
  }
  console.log(`Updated originalRecipesCount for ${n} users.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
