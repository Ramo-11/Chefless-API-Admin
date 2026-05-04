/**
 * Backfill `savedRecipesCount` and `remixesCount` on every existing user.
 *
 * Why: the v2 free-tier model gates on `originalRecipesCount + savedRecipesCount`
 * and on `remixesCount`. Existing users have neither counter populated, so the
 * gate would let them save unlimited recipes (incorrectly) or block them
 * arbitrarily on remix.
 *
 * What it does:
 *   - For every user, set savedRecipesCount = COUNT(SavedRecipe where userId = user)
 *   - For every user, set remixesCount = COUNT(Recipe where authorId = user AND forkedFrom is set)
 *
 * Idempotent: safe to re-run. Always overwrites counters with truth from the
 * source collections.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-recipe-counters.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/User";
import Recipe from "../models/Recipe";
import SavedRecipe from "../models/SavedRecipe";
import { env } from "../lib/env";

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  console.log("Connected to MongoDB");

  const users = await User.find().select("_id").lean();
  console.log(`Found ${users.length} users to process.`);

  let processed = 0;
  let drifted = 0;
  for (const u of users) {
    const [savedCount, remixCount] = await Promise.all([
      SavedRecipe.countDocuments({ userId: u._id }),
      Recipe.countDocuments({
        authorId: u._id,
        forkedFrom: { $exists: true, $ne: null },
      }),
    ]);

    const result = await User.updateOne(
      { _id: u._id },
      {
        $set: {
          savedRecipesCount: savedCount,
          remixesCount: remixCount,
        },
      }
    );

    if (result.modifiedCount > 0) drifted += 1;
    processed += 1;

    if (processed % 100 === 0) {
      console.log(`  …${processed}/${users.length}`);
    }
  }

  console.log(
    `Done. Processed ${processed} users. ${drifted} had drifting counters that were corrected.`
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
