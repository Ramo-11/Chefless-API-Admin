import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import Recipe from "../models/Recipe";
import { env } from "../lib/env";
import { canonicalDiet } from "../lib/diets";
import { slugify } from "./seed/slugify";
import type { CuratedCuisineData } from "./seed/curated-types";

const DATA_DIR = path.join(__dirname, "seed", "data");
const BATCH_SIZE = 500;

export function buildDietaryTagsMap(files: CuratedCuisineData[]): {
  map: Map<string, string[]>;
  skippedUnknownTag: number;
} {
  const map = new Map<string, string[]>();
  let skippedUnknownTag = 0;

  for (const file of files) {
    for (const recipe of file.recipes) {
      const raw = recipe.dietaryTags ?? [];
      if (raw.length === 0) continue;

      const canonical = Array.from(
        new Set(
          raw
            .map((tag) => canonicalDiet(tag))
            .filter((tag): tag is string => tag !== null)
        )
      );

      if (canonical.length === 0) {
        skippedUnknownTag += 1;
        continue;
      }

      map.set(`curated:${slugify(recipe.title)}`, canonical);
    }
  }

  return { map, skippedUnknownTag };
}

async function loadCuratedFiles(): Promise<CuratedCuisineData[]> {
  const entries = await fs.readdir(DATA_DIR);
  const files: CuratedCuisineData[] = [];

  for (const entry of entries) {
    if (entry.startsWith("_") || !entry.endsWith(".json")) continue;
    const raw = await fs.readFile(path.join(DATA_DIR, entry), "utf8");
    files.push(JSON.parse(raw) as CuratedCuisineData);
  }

  return files;
}

async function main(): Promise<void> {
  const isDryRun = process.argv.slice(2).includes("--dry-run");

  const files = await loadCuratedFiles();
  const { map, skippedUnknownTag } = buildDietaryTagsMap(files);
  console.log(
    `Loaded ${map.size} curated recipe(s) with a recognized dietary tag (skipped ${skippedUnknownTag} with no recognized tag).`
  );

  await mongoose.connect(env.MONGODB_URI);
  console.log("Connected to MongoDB");

  const cursor = Recipe.find({
    seedExternalId: { $in: [...map.keys()] },
    $or: [{ dietaryTags: { $exists: false } }, { dietaryTags: { $size: 0 } }],
  })
    .select("_id seedExternalId")
    .lean()
    .cursor();

  let matched = 0;
  let updated = 0;
  let batch: mongoose.AnyBulkWriteOperation[] = [];

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    if (isDryRun) {
      batch = [];
      return;
    }
    const result = await Recipe.bulkWrite(batch, { ordered: false });
    updated += result.modifiedCount ?? 0;
    batch = [];
  }

  for await (const doc of cursor) {
    const dietaryTags = map.get(doc.seedExternalId as string);
    if (!dietaryTags) continue;
    matched += 1;

    batch.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { dietaryTags } },
      },
    });

    if (batch.length >= BATCH_SIZE) {
      await flush();
    }
  }

  await flush();

  console.log(
    `Done. Matched ${matched}, updated ${updated}, skipped-unknown-tag ${skippedUnknownTag}.${
      isDryRun ? " (dry run, no writes made)" : ""
    }`
  );
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
