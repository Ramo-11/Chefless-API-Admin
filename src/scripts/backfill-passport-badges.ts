import "dotenv/config";
import mongoose, { PipelineStage, Types } from "mongoose";
import User from "../models/User";
import CookedPost from "../models/CookedPost";
import { env } from "../lib/env";
import {
  firstCookedByCuisine,
  historicalBadgeDates,
  planBadgeChanges,
  recordPassportBadges,
} from "../lib/passport-badges";

const USER_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

interface UserCuisineGroup {
  _id: Types.ObjectId;
  cuisines: { tag: string; firstCookedAt: Date }[];
}

export interface BackfillPassportBadgesOptions {
  dryRun: boolean;
  userId?: string;
  log?: (line: string) => void;
}

export interface BackfillPassportBadgesResult {
  scannedUsers: number;
  missingUsers: number;
  usersChanged: number;
  badgesAdded: number;
  datesCorrected: number;
}

export function parseBackfillArgs(
  argv: readonly string[]
): { dryRun: boolean; userId?: string } {
  let dryRun = false;
  let userId: string | undefined;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--user-id=")) {
      const value = arg.slice("--user-id=".length);
      if (!USER_ID_PATTERN.test(value)) {
        throw new Error(
          `Invalid --user-id: "${value}" is not a 24 character hex ObjectId.`
        );
      }
      userId = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { dryRun, userId };
}

export async function backfillPassportBadges(
  options: BackfillPassportBadgesOptions
): Promise<BackfillPassportBadgesResult> {
  const log = options.log ?? console.log;

  const pipeline: PipelineStage[] = [];
  if (options.userId) {
    pipeline.push({ $match: { userId: new Types.ObjectId(options.userId) } });
  }
  pipeline.push(
    { $unwind: "$cuisineTags" },
    {
      $group: {
        _id: { userId: "$userId", tag: "$cuisineTags" },
        firstCookedAt: { $min: "$createdAt" },
      },
    },
    {
      $group: {
        _id: "$_id.userId",
        cuisines: {
          $push: { tag: "$_id.tag", firstCookedAt: "$firstCookedAt" },
        },
      },
    },
    { $sort: { _id: 1 } }
  );

  const cursor = CookedPost.aggregate(pipeline)
    .allowDiskUse(true)
    .cursor<UserCuisineGroup>();

  const result: BackfillPassportBadgesResult = {
    scannedUsers: 0,
    missingUsers: 0,
    usersChanged: 0,
    badgesAdded: 0,
    datesCorrected: 0,
  };

  for await (const group of cursor) {
    result.scannedUsers += 1;

    const user = await User.findById(group._id)
      .select("passportBadges")
      .lean();
    if (!user) {
      result.missingUsers += 1;
      continue;
    }

    const computed = historicalBadgeDates(
      firstCookedByCuisine(group.cuisines)
    );
    const plan = planBadgeChanges(user.passportBadges, computed);
    if (plan.added.length === 0 && plan.corrected.length === 0) continue;

    const parts = [
      ...plan.added.map(
        (badge) => `add ${badge.id} (${badge.earnedAt.toISOString()})`
      ),
      ...plan.corrected.map(
        (badge) => `correct ${badge.id} (${badge.earnedAt.toISOString()})`
      ),
    ];
    log(`${group._id.toString()}: ${parts.join(", ")}`);

    if (options.dryRun) {
      result.usersChanged += 1;
    } else {
      const changed = await recordPassportBadges(group._id, [
        ...plan.added,
        ...plan.corrected,
      ]);
      if (changed) result.usersChanged += 1;
    }

    result.badgesAdded += plan.added.length;
    result.datesCorrected += plan.corrected.length;
  }

  return result;
}

async function main(): Promise<void> {
  const { dryRun, userId } = parseBackfillArgs(process.argv.slice(2));

  await mongoose.connect(env.MONGODB_URI);
  console.log("Connected to MongoDB");

  const result = await backfillPassportBadges({ dryRun, userId });

  console.log(
    `Done. Scanned ${result.scannedUsers} user(s), missing ${result.missingUsers}, changed ${result.usersChanged}, badges added ${result.badgesAdded}, dates corrected ${result.datesCorrected}.${
      dryRun ? " (dry run, no writes made)" : ""
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
