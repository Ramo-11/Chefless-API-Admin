import "dotenv/config";
import mongoose, { Model } from "mongoose";
import { env } from "../lib/env";
import AdminUser from "../models/AdminUser";
import AiUsageEvent from "../models/AiUsageEvent";
import AppConfig from "../models/AppConfig";
import AuditLog from "../models/AuditLog";
import Block from "../models/Block";
import ClientError from "../models/ClientError";
import Comment from "../models/Comment";
import Cookbook from "../models/Cookbook";
import CookedPost from "../models/CookedPost";
import EmailCampaign from "../models/EmailCampaign";
import EmailContact from "../models/EmailContact";
import Feedback from "../models/Feedback";
import Follow from "../models/Follow";
import IgnoredErrorFingerprint from "../models/IgnoredErrorFingerprint";
import Kitchen from "../models/Kitchen";
import KitchenInvite from "../models/KitchenInvite";
import Like from "../models/Like";
import Notification from "../models/Notification";
import PantryItem from "../models/PantryItem";
import Recipe from "../models/Recipe";
import RecipeRating from "../models/RecipeRating";
import RecipeShare from "../models/RecipeShare";
import Report from "../models/Report";
import SavedRecipe from "../models/SavedRecipe";
import ScheduleEntry from "../models/ScheduleEntry";
import SeasonalTag from "../models/SeasonalTag";
import ShoppingList from "../models/ShoppingList";
import SystemLabel from "../models/SystemLabel";
import Transaction from "../models/Transaction";
import User from "../models/User";
import WebhookEvent from "../models/WebhookEvent";

const MODELS = [
  AdminUser,
  AiUsageEvent,
  AppConfig,
  AuditLog,
  Block,
  ClientError,
  Comment,
  Cookbook,
  CookedPost,
  EmailCampaign,
  EmailContact,
  Feedback,
  Follow,
  IgnoredErrorFingerprint,
  Kitchen,
  KitchenInvite,
  Like,
  Notification,
  PantryItem,
  Recipe,
  RecipeRating,
  RecipeShare,
  Report,
  SavedRecipe,
  ScheduleEntry,
  SeasonalTag,
  ShoppingList,
  SystemLabel,
  Transaction,
  User,
  WebhookEvent,
] as unknown as Array<Model<unknown>>;

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => bk[i] === k && String(a[k]) === String(b[k]));
}

function sameOptions(
  existing: Record<string, unknown>,
  wanted: Record<string, unknown>
): boolean {
  const uniqueMatches = Boolean(existing.unique) === Boolean(wanted.unique);
  const existingPartial = JSON.stringify(existing.partialFilterExpression ?? null);
  const wantedPartial = JSON.stringify(wanted.partialFilterExpression ?? null);
  const sparseMatches = Boolean(existing.sparse) === Boolean(wanted.sparse);
  const ttlMatches =
    (existing.expireAfterSeconds ?? null) === (wanted.expireAfterSeconds ?? null);
  return (
    uniqueMatches &&
    existingPartial === wantedPartial &&
    sparseMatches &&
    ttlMatches
  );
}

async function dropConflictingIndexes(model: Model<unknown>): Promise<string[]> {
  const existing = await model.collection.indexes();
  const wanted = model.schema.indexes();
  const dropped: string[] = [];

  for (const [wantedKey, wantedOptions] of wanted) {
    const options = (wantedOptions ?? {}) as Record<string, unknown>;
    for (const idx of existing) {
      if (!idx.name || idx.name === "_id_") continue;
      if (!sameKey(idx.key as Record<string, unknown>, wantedKey)) continue;
      if (sameOptions(idx as Record<string, unknown>, options)) continue;
      await model.collection.dropIndex(idx.name);
      dropped.push(idx.name);
    }
  }

  return dropped;
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  console.log("Connected to MongoDB");

  let created = 0;
  let failed = 0;

  for (const model of MODELS) {
    const name = model.collection.collectionName;
    const before = new Set(
      (await model.collection.indexes().catch(() => [])).map((idx) => idx.name)
    );

    try {
      await model.createIndexes();
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code !== 86) {
        failed++;
        console.error(`${name}: index creation failed:`, err);
        continue;
      }
      try {
        const dropped = await dropConflictingIndexes(model);
        if (dropped.length > 0) {
          console.log(
            `${name}: replacing ${dropped.join(", ")} (same name, different definition)`
          );
        }
        await model.createIndexes();
      } catch (retryErr) {
        failed++;
        const retryCode = (retryErr as { code?: number }).code;
        if (retryCode === 11000) {
          console.error(
            `${name}: cannot apply a unique index because the collection already contains duplicates. Remove the duplicate rows, then rerun this script.`
          );
          console.error(retryErr);
        } else {
          console.error(`${name}: index creation failed:`, retryErr);
        }
        continue;
      }
    }

    const after = await model.collection.indexes();
    const added = after
      .map((idx) => idx.name)
      .filter((idxName) => idxName !== undefined && !before.has(idxName));

    if (added.length === 0) {
      console.log(`${name}: already up to date.`);
    } else {
      created += added.length;
      console.log(`${name}: created ${added.join(", ")}`);
    }
  }

  console.log(`Done. ${created} index(es) created, ${failed} model(s) failed.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
