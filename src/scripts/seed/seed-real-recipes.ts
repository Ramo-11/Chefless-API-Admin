/**
 * End-to-end seed pipeline. Pulls real recipes from TheMealDB + curated JSON
 * (subagent-generated, real named dishes only), looks up real Wikipedia/
 * Commons photos for the curated ones, generates fake-but-plausible seed
 * users per cuisine, and inserts everything into MongoDB.
 *
 * Hard guardrails:
 *  - Refuses to run unless MONGODB_URI points at a *_dev database.
 *  - Every doc gets `isSeed: true` so the admin Seed Data tab can wipe them.
 *  - Recipes without an image are dropped (logged to data/_seed-report.json).
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://...chefless_dev" \
 *     tsx src/scripts/seed/seed-real-recipes.ts
 *
 * To wipe everything created by this script:
 *   tsx src/scripts/seed/seed-real-recipes.ts cleanup
 */
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import User from "../../models/User";
import Recipe from "../../models/Recipe";
import { CUISINE_QUOTAS, recipesPerAccount } from "./cuisine-plan";
import type { CuisineQuota } from "./cuisine-plan";
import { ingestArea, type NormalizedRecipe } from "./themealdb";
import { findDishImage } from "./wikimedia";
import { buildSeedUser } from "./seed-users";
import type { CuratedCuisineData, CuratedRecipe } from "./curated-types";

const DATA_DIR = path.join(__dirname, "data");
const REPORT_PATH = path.join(DATA_DIR, "_seed-report.json");

interface SeedReport {
  generatedAt: string;
  totals: { users: number; recipes: number; dropped: number };
  perCuisine: Array<{
    cuisine: string;
    users: number;
    recipes: number;
    droppedNoImage: string[];
    fromMealdb: number;
    fromCurated: number;
  }>;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/(^_|_$)/g, "");
}

async function loadCuratedFile(
  cuisine: string
): Promise<CuratedCuisineData | null> {
  const filePath = path.join(DATA_DIR, `${slugify(cuisine)}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as CuratedCuisineData;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

async function attachImageToCurated(
  recipe: CuratedRecipe,
  failures: string[]
): Promise<NormalizedRecipe | null> {
  const url = await findDishImage(recipe.title);
  if (!url) {
    failures.push(recipe.title);
    return null;
  }
  return {
    externalId: `curated:${slugify(recipe.title)}`,
    title: recipe.title,
    description: recipe.description,
    photos: [url],
    ingredients: recipe.ingredients,
    steps: recipe.steps.map((instruction, i) => ({
      order: i + 1,
      instruction,
    })),
    cuisineTags: [],
    tags: recipe.tags,
    difficulty: recipe.difficulty,
    servings: recipe.servings,
    baseServings: recipe.servings,
    source: "curated",
    cuisine: "",
  };
}

async function buildRecipePoolForCuisine(
  quota: CuisineQuota,
  curated: CuratedCuisineData | null,
  failures: string[]
): Promise<{ pool: NormalizedRecipe[]; mealdbCount: number; curatedCount: number }> {
  const pool: NormalizedRecipe[] = [];
  let mealdbCount = 0;
  let curatedCount = 0;

  if (quota.mealdbArea) {
    try {
      const fetched = await ingestArea(quota.mealdbArea, quota.cuisine);
      pool.push(...fetched);
      mealdbCount = fetched.length;
    } catch (err) {
      console.error(`  TheMealDB fetch failed for ${quota.cuisine}:`, err);
    }
  }

  if (curated) {
    for (const r of curated.recipes) {
      const normalized = await attachImageToCurated(r, failures);
      if (normalized) {
        normalized.cuisine = quota.cuisine;
        normalized.cuisineTags = [quota.cuisine];
        pool.push(normalized);
        curatedCount += 1;
      }
    }
  }

  return { pool, mealdbCount, curatedCount };
}

async function seedCuisine(
  quota: CuisineQuota,
  report: SeedReport
): Promise<void> {
  console.log(`\n→ ${quota.cuisine} (${quota.tier}) — target ${quota.recipes} recipes / ${quota.accounts} users`);

  const curated = await loadCuratedFile(quota.cuisine);

  // Curated file is required for cuisines TheMealDB can't fill — names come
  // from there. If it's missing we still proceed using TheMealDB data only,
  // but we need a name pool: fall back to a generic English-sounding pool.
  const namePool: CuratedCuisineData =
    curated ??
    {
      cuisine: quota.cuisine,
      names: {
        first: ["Alex", "Sam", "Jordan", "Taylor", "Casey", "Riley", "Morgan", "Quinn"],
        last: ["Cook", "Baker", "Hart", "Kim", "Ali", "Lee", "Patel", "Garcia"],
      },
      recipes: [],
    };

  const failures: string[] = [];
  const { pool, mealdbCount, curatedCount } = await buildRecipePoolForCuisine(
    quota,
    curated,
    failures
  );

  if (pool.length === 0) {
    console.warn(`  no recipes available for ${quota.cuisine} — skipping`);
    report.perCuisine.push({
      cuisine: quota.cuisine,
      users: 0,
      recipes: 0,
      droppedNoImage: failures,
      fromMealdb: mealdbCount,
      fromCurated: curatedCount,
    });
    return;
  }

  // Trim or expand to match the quota. We want EXACTLY quota.recipes recipes
  // when possible; if we have fewer, take what we have.
  const targetCount = Math.min(quota.recipes, pool.length);
  // Shuffle deterministically so re-runs are stable.
  const shuffled = [...pool].sort((a, b) =>
    a.externalId.localeCompare(b.externalId)
  );
  const selected = shuffled.slice(0, targetCount);

  // Create seed users — primary source decides their seedSource label.
  const userSource: "themealdb" | "curated" =
    curated && curated.recipes.length > 0 ? "curated" : "themealdb";
  const userSpecs = Array.from({ length: quota.accounts }, (_, i) =>
    buildSeedUser(namePool, i, userSource)
  );

  const userDocs = await Promise.all(
    userSpecs.map(async (spec) => {
      const existing = await User.findOne({ firebaseUid: spec.firebaseUid });
      if (existing) return existing;
      return User.create(spec);
    })
  );

  // Distribute recipes across users.
  const perUser = recipesPerAccount(selected.length, userDocs.length);
  let cursor = 0;
  let inserted = 0;

  for (let i = 0; i < userDocs.length; i += 1) {
    const slice = selected.slice(cursor, cursor + perUser[i]);
    cursor += perUser[i];
    if (slice.length === 0) continue;

    const author = userDocs[i];
    const docs = slice.map((r) => ({
      authorId: author._id,
      title: r.title,
      description: r.description,
      photos: r.photos,
      ingredients: r.ingredients,
      steps: r.steps,
      cuisineTags: r.cuisineTags.length > 0 ? r.cuisineTags : [quota.cuisine],
      tags: r.tags,
      difficulty: r.difficulty,
      servings: r.servings,
      baseServings: r.baseServings,
      isPrivate: false,
      isHidden: false,
      isSeed: true,
      seedSource: r.source,
      seedCuisine: quota.cuisine,
      seedExternalId: r.externalId,
    }));

    // Skip already-inserted recipes (same authorId + seedExternalId).
    const existingIds = await Recipe.find({
      authorId: author._id,
      seedExternalId: { $in: docs.map((d) => d.seedExternalId) },
    })
      .select("seedExternalId")
      .lean();
    const have = new Set(existingIds.map((d) => d.seedExternalId));
    const fresh = docs.filter((d) => !have.has(d.seedExternalId));
    if (fresh.length === 0) continue;

    const created = await Recipe.insertMany(fresh);
    inserted += created.length;

    // Update the user's recipesCount + originalRecipesCount.
    await User.updateOne(
      { _id: author._id },
      {
        $inc: {
          recipesCount: created.length,
          originalRecipesCount: created.length,
        },
      }
    );
  }

  console.log(
    `  ✓ ${quota.cuisine}: ${userDocs.length} users, ${inserted} recipes (mealdb=${mealdbCount}, curated=${curatedCount}, dropped=${failures.length})`
  );

  report.perCuisine.push({
    cuisine: quota.cuisine,
    users: userDocs.length,
    recipes: inserted,
    droppedNoImage: failures,
    fromMealdb: mealdbCount,
    fromCurated: curatedCount,
  });
  report.totals.users += userDocs.length;
  report.totals.recipes += inserted;
  report.totals.dropped += failures.length;
}

async function cleanup(): Promise<void> {
  console.log("Wiping all seed data...");
  const recipeResult = await Recipe.deleteMany({ isSeed: true });
  console.log(`  removed ${recipeResult.deletedCount} seed recipes`);
  const userResult = await User.deleteMany({ isSeed: true });
  console.log(`  removed ${userResult.deletedCount} seed users`);
}

async function run(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI env var required");

  const args = process.argv.slice(2);
  const allowProd = args.includes("--allow-prod");
  const isCleanup = args.includes("cleanup");
  const isDevUri = /_dev(\b|\?|\/)/.test(uri);

  if (!isDevUri && !allowProd) {
    throw new Error(
      `Refusing to run: MONGODB_URI must point at a *_dev database. Pass --allow-prod to run against ${uri.replace(/:[^@]+@/, ":***@")}.`
    );
  }

  if (!isDevUri && allowProd) {
    const masked = uri.replace(/:[^@]+@/, ":***@");
    console.warn("⚠️  PRODUCTION DATABASE TARGETED");
    console.warn(`URI: ${masked}`);
    console.warn(
      "Inserting/cleaning seed data on a non-dev database. Ctrl+C now to abort."
    );
    console.warn("Continuing in 8 seconds...");
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }

  await mongoose.connect(uri);
  console.log("connected to", mongoose.connection.db?.databaseName);

  if (isCleanup) {
    await cleanup();
    await mongoose.disconnect();
    return;
  }

  const report: SeedReport = {
    generatedAt: new Date().toISOString(),
    totals: { users: 0, recipes: 0, dropped: 0 },
    perCuisine: [],
  };

  for (const quota of CUISINE_QUOTAS) {
    try {
      await seedCuisine(quota, report);
    } catch (err) {
      console.error(`  ✗ ${quota.cuisine} failed:`, err);
    }
  }

  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(
    `\n✅ Done. Users=${report.totals.users}, recipes=${report.totals.recipes}, dropped=${report.totals.dropped}`
  );
  console.log(`Report: ${REPORT_PATH}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
