import "dotenv/config";
import mongoose, { Model } from "mongoose";
import { env } from "../lib/env";

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  console.log("Connected (read only)");

  const models = mongoose.modelNames().map((n) => mongoose.model(n) as Model<unknown>);
  let missing = 0;

  for (const model of models) {
    const name = model.collection.collectionName;
    const actual = await model.collection.indexes().catch(() => []);
    const actualKeys = actual.map((i) => JSON.stringify(i.key));
    const wanted = model.schema.indexes();
    const gaps = wanted
      .map(([key]) => JSON.stringify(key))
      .filter((k) => !actualKeys.includes(k));
    if (gaps.length > 0) {
      missing += gaps.length;
      console.log(`${name}: MISSING ${gaps.join(" | ")}`);
    }
  }

  console.log(missing === 0 ? "All schema indexes present." : `${missing} missing.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
