/**
 * One-off migration: drop the legacy unique index on EmailContact.email.
 *
 * Why: each Google-Form submission now imports as its own EmailContact row,
 * keyed by (email, signedUpAt). The old `email_1` unique index would block
 * duplicate-email submissions and must be removed before re-importing.
 *
 * Idempotent: safe to re-run. If the legacy index is already gone, it just
 * reports that and exits.
 *
 * Usage:
 *   npx tsx src/scripts/drop-email-contact-unique-index.ts
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../lib/env";

const LEGACY_INDEX = "email_1";

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  if (!db) throw new Error("Mongo connection has no db handle");

  const collection = db.collection("emailcontacts");
  const indexes = await collection.indexes();
  const legacy = indexes.find((idx) => idx.name === LEGACY_INDEX);

  if (!legacy) {
    console.log(`No '${LEGACY_INDEX}' index found — nothing to drop.`);
  } else if (!legacy.unique) {
    console.log(
      `'${LEGACY_INDEX}' exists but is already non-unique — nothing to drop.`
    );
  } else {
    await collection.dropIndex(LEGACY_INDEX);
    console.log(`Dropped legacy unique index '${LEGACY_INDEX}'.`);
  }

  // Recreate the non-unique single-field index that the schema still declares,
  // and the new compound (email, signedUpAt) unique index.
  await collection.createIndex({ email: 1 });
  await collection.createIndex(
    { email: 1, signedUpAt: 1 },
    {
      unique: true,
      partialFilterExpression: { signedUpAt: { $exists: true } },
      name: "email_1_signedUpAt_1",
    }
  );
  console.log("Ensured email_1 (non-unique) and email_1_signedUpAt_1 indexes.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
