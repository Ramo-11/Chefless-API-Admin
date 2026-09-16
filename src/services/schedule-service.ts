import { Types } from "mongoose";
import ScheduleEntry, {
  IScheduleEntry,
  RsvpStatus,
} from "../models/ScheduleEntry";
import Kitchen, { IKitchen } from "../models/Kitchen";
import Recipe from "../models/Recipe";
import User, { IUser } from "../models/User";
import {
  notifyScheduleSuggestion,
  notifyScheduleImportSuggestions,
  notifySuggestionApproved,
  notifySuggestionDeniedWithData,
} from "./notification-service";
import { hasActivePremium } from "../lib/premium";
import { canViewRecipe } from "./visibility-service";

interface ServiceError extends Error {
  statusCode: number;
  code?: string;
}

function createError(
  message: string,
  statusCode: number,
  code?: string
): ServiceError {
  const error = new Error(message) as ServiceError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function stripTime(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** UTC Monday 00:00 for the week containing `d` (week starts Monday). */
function utcMondayOf(d: Date): Date {
  const x = stripTime(d);
  const dow = x.getUTCDay();
  const delta = dow === 0 ? -6 : 1 - dow;
  const m = new Date(x);
  m.setUTCDate(m.getUTCDate() + delta);
  return stripTime(m);
}

function localCalendarToday(offsetMinutes?: number): Date {
  if (offsetMinutes == null) {
    return stripTime(new Date());
  }
  return stripTime(new Date(Date.now() + offsetMinutes * 60000));
}

/**
 * Free-tier schedulable window: a rolling 5-day band of [today - 2, today + 2],
 * inclusive, computed on the person's own calendar day when we know their
 * offset and falling back to UTC when we have never recorded one. Two days
 * behind lets users still log/edit recent meals; two days ahead covers the
 * imminent planning horizon. Anything outside this band requires premium.
 */
function freeTierScheduleWindow(offsetMinutes?: number): {
  min: Date;
  max: Date;
} {
  const today = localCalendarToday(offsetMinutes);
  const min = new Date(today);
  min.setUTCDate(min.getUTCDate() - 2);
  const max = new Date(today);
  max.setUTCDate(max.getUTCDate() + 2);
  return { min, max };
}

function isBeyondFreeTierScheduleLimit(
  date: Date,
  offsetMinutes?: number
): boolean {
  const { min, max } = freeTierScheduleWindow(offsetMinutes);
  const d = stripTime(date);
  return d > max || d < min;
}

const FREE_TIER_SCHEDULE_LIMIT_MESSAGE =
  "Free tier users can plan within 2 days before and 2 days after today. Upgrade to premium for full calendar scheduling.";

/**
 * Withholds meal content from a free user for entries that fall on a
 * premium-locked *future* day (more than 2 days ahead). The free user still
 * learns that a meal exists on that day (so the schedule and suggestion inbox
 * can show a "locked" teaser) but never receives the recipe title, photo,
 * freeform note, timing, or who suggested it. Past-locked days are left intact
 * so users can still view, rate, and tidy recent history.
 *
 * Mutates the lean entries in place — they are request-scoped response objects.
 */
export function redactLockedEntriesForFree(
  entries: IScheduleEntry[],
  isPremium: boolean,
  offsetMinutes?: number
): IScheduleEntry[] {
  if (isPremium) {
    return entries;
  }
  const { max } = freeTierScheduleWindow(offsetMinutes);
  for (const entry of entries) {
    if (stripTime(entry.date) <= max) {
      continue;
    }
    entry.recipeId = undefined;
    entry.recipeTitle = undefined;
    entry.recipePhoto = undefined;
    entry.recipeAuthorId = undefined;
    entry.recipeAuthorName = undefined;
    entry.freeformText = undefined;
    entry.scheduledTime = undefined;
    entry.prepTime = undefined;
    entry.suggestedBy = undefined;
    entry.confirmedBy = undefined;
    entry.cookedAt = undefined;
    entry.locked = true;
    entry.leftoverOfEntryId = undefined;
    entry.leftoverOfDate = undefined;
    entry.leftoverCount = undefined;
  }
  return entries;
}

interface AddEntryData {
  date: Date;
  mealSlot: string;
  recipeId?: string;
  freeformText?: string;
  scheduledTime?: string;
  prepTime?: number;
  servings?: number;
}

function hasScheduleEditPermission(
  userId: string,
  kitchen: { leadId: Types.ObjectId; membersWithScheduleEdit: Types.ObjectId[] }
): boolean {
  return (
    kitchen.leadId.equals(userId) ||
    kitchen.membersWithScheduleEdit.some((id) => id.equals(userId))
  );
}

function hasApprovalPermission(
  userId: string,
  kitchen: { leadId: Types.ObjectId; membersWithApprovalPower: Types.ObjectId[] }
): boolean {
  return (
    kitchen.leadId.equals(userId) ||
    kitchen.membersWithApprovalPower.some((id) => id.equals(userId))
  );
}

export async function bumpScheduleRevision(
  userId: string,
  kitchenId?: Types.ObjectId | string | null
): Promise<void> {
  try {
    if (kitchenId) {
      await Kitchen.updateOne(
        { _id: kitchenId },
        { $inc: { scheduleRevision: 1 } }
      );
      return;
    }
    await User.updateOne({ _id: userId }, { $inc: { scheduleRevision: 1 } });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`Failed to bump the schedule revision: ${msg}`);
  }
}

export async function addEntry(
  userId: string,
  kitchenId: string | null,
  data: AddEntryData
): Promise<IScheduleEntry> {
  const user = await User.findById(userId)
    .select("kitchenId isPremium premiumExpiresAt timezoneOffsetMinutes")
    .lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  const entryDate = stripTime(data.date);

  if (
    !hasActivePremium(user) &&
    isBeyondFreeTierScheduleLimit(entryDate, user.timezoneOffsetMinutes)
  ) {
    throw createError(
      FREE_TIER_SCHEDULE_LIMIT_MESSAGE,
      403
    );
  }

  // Personal entry (no kitchen)
  if (!kitchenId) {
    const entryFields: Record<string, unknown> = {
      userId: new Types.ObjectId(userId),
      date: entryDate,
      mealSlot: data.mealSlot,
      status: "confirmed",
      confirmedBy: new Types.ObjectId(userId),
    };

    if (data.freeformText) {
      entryFields.freeformText = data.freeformText;
    }

    if (data.scheduledTime) {
      entryFields.scheduledTime = data.scheduledTime;
    }

    if (data.prepTime != null) {
      entryFields.prepTime = data.prepTime;
    }

    if (data.recipeId) {
      await populateRecipeFields(entryFields, data.recipeId, userId, false);
    }

    if (data.servings != null) {
      entryFields.servings = data.servings;
    }

    return ScheduleEntry.create(entryFields);
  }

  // Kitchen entry
  if (!user.kitchenId || !user.kitchenId.equals(kitchenId)) {
    throw createError("You are not a member of this kitchen", 403);
  }

  const kitchen = await Kitchen.findById(kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  const canEdit = hasScheduleEditPermission(userId, kitchen);
  const status =
    kitchen.scheduleAddPolicy === "all" || canEdit ? "confirmed" : "suggested";

  // If the kitchen lead has disabled member suggestions, non-editor members
  // cannot queue up proposals. Editors and the lead bypass this because their
  // entries are confirmed outright (above), not suggested.
  if (status === "suggested" && kitchen.allowMemberSuggestions === false) {
    throw createError(
      "The kitchen lead has turned off member suggestions.",
      403
    );
  }

  const entryFields: Record<string, unknown> = {
    kitchenId: new Types.ObjectId(kitchenId),
    userId: new Types.ObjectId(userId),
    date: entryDate,
    mealSlot: data.mealSlot,
    status,
    suggestedBy: new Types.ObjectId(userId),
  };

  if (status === "confirmed") {
    entryFields.confirmedBy = new Types.ObjectId(userId);
  }

  if (data.freeformText) {
    entryFields.freeformText = data.freeformText;
  }

  if (data.scheduledTime) {
    entryFields.scheduledTime = data.scheduledTime;
  }

  if (data.prepTime != null) {
    entryFields.prepTime = data.prepTime;
  }

  if (data.recipeId) {
    await populateRecipeFields(entryFields, data.recipeId, userId, true);
  }

  if (data.servings != null) {
    entryFields.servings = data.servings;
  }

  const entry = await ScheduleEntry.create(entryFields);

  // Fire-and-forget notification for suggestions
  if (status === "suggested") {
    notifyScheduleSuggestion(
      userId,
      kitchenId,
      entry._id.toString()
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send schedule_suggestion notification: ${msg}`);
    });
  }

  return entry;
}

/**
 * Populates recipe-related fields on the entry fields object.
 * Requires the acting user so we can enforce recipe visibility — scheduling a
 * recipe a user cannot see would leak the title/photo across privacy boundaries.
 */
async function populateRecipeFields(
  entryFields: Record<string, unknown>,
  recipeId: string,
  actingUserId: string,
  requireShared: boolean
): Promise<void> {
  const recipe = await Recipe.findById(recipeId)
    .select("title photos authorId prepTime servings isPrivate isHidden")
    .lean();
  if (!recipe) {
    throw createError("Recipe not found", 404);
  }

  const author = await User.findById(recipe.authorId)
    .select("fullName isPublic kitchenId isBanned")
    .lean();
  if (!author) {
    throw createError("Recipe author not found", 404);
  }

  // Hidden (admin-moderated) or banned-author recipes are off limits for scheduling
  if (recipe.isHidden || author.isBanned) {
    throw createError("You cannot schedule this recipe", 403);
  }

  if (requireShared && recipe.isPrivate) {
    throw createError(
      "Private recipes cannot be added to a Kitchen plan. Share the recipe first.",
      400
    );
  }

  const canView = await canViewRecipe(
    new Types.ObjectId(actingUserId),
    recipe,
    author as unknown as IUser
  );
  if (!canView) {
    throw createError(
      "You do not have permission to schedule this recipe",
      403
    );
  }

  entryFields.recipeId = new Types.ObjectId(recipeId);
  entryFields.recipeTitle = recipe.title;
  entryFields.recipePhoto = recipe.photos.length > 0 ? recipe.photos[0] : undefined;
  entryFields.recipeAuthorId = recipe.authorId;
  entryFields.recipeAuthorName = author.fullName;
  if (recipe.prepTime != null) {
    entryFields.prepTime = recipe.prepTime;
  }
  entryFields.servings = recipe.servings ?? 1;
}

export async function planLeftovers(
  userId: string,
  sourceEntryId: string,
  data: { date: Date; mealSlot: string; cookExtra: boolean; extraServings?: number }
): Promise<{ leftover: IScheduleEntry; source: IScheduleEntry }> {
  const source = await ScheduleEntry.findById(sourceEntryId);
  if (!source) {
    throw createError("Schedule entry not found", 404);
  }

  if (source.leftoverOfEntryId) {
    throw createError("Leftovers cannot have their own leftovers.", 400);
  }

  if (!source.recipeId) {
    throw createError("Only meals with a recipe can have leftovers.", 400);
  }

  if (source.status !== "confirmed") {
    throw createError(
      "This meal is waiting for approval. Plan leftovers once it is approved.",
      400
    );
  }

  const user = await User.findById(userId)
    .select("kitchenId isPremium premiumExpiresAt timezoneOffsetMinutes")
    .lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  let status: "confirmed" | "suggested";
  let canEdit: boolean;

  if (source.kitchenId) {
    if (!user.kitchenId || !user.kitchenId.equals(source.kitchenId)) {
      throw createError("You are not a member of this kitchen", 403);
    }

    const kitchen = await Kitchen.findById(source.kitchenId);
    if (!kitchen) {
      throw createError("Kitchen not found", 404);
    }

    canEdit = hasScheduleEditPermission(userId, kitchen);
    status =
      kitchen.scheduleAddPolicy === "all" || canEdit ? "confirmed" : "suggested";

    if (status === "suggested" && kitchen.allowMemberSuggestions === false) {
      throw createError(
        "The kitchen lead has turned off member suggestions.",
        403
      );
    }
  } else {
    if (!source.userId.equals(userId)) {
      throw createError("You do not own this schedule entry", 403);
    }
    status = "confirmed";
    canEdit = true;
  }

  const entryDate = stripTime(data.date);

  if (
    !hasActivePremium(user) &&
    isBeyondFreeTierScheduleLimit(entryDate, user.timezoneOffsetMinutes)
  ) {
    throw createError(FREE_TIER_SCHEDULE_LIMIT_MESSAGE, 403);
  }

  if (data.cookExtra && !canEdit) {
    throw createError(
      "Only the kitchen lead or editors can change how much is cooked.",
      403
    );
  }

  if (entryDate < stripTime(source.date)) {
    throw createError(
      "Leftovers go on the same day as the meal or a later day.",
      400
    );
  }

  const entryFields: Record<string, unknown> = {
    userId: new Types.ObjectId(userId),
    date: entryDate,
    mealSlot: data.mealSlot,
    status,
  };

  if (source.kitchenId) {
    entryFields.kitchenId = source.kitchenId;
    entryFields.suggestedBy = new Types.ObjectId(userId);
  }

  if (status === "confirmed") {
    entryFields.confirmedBy = new Types.ObjectId(userId);
  }

  await populateRecipeFields(
    entryFields,
    source.recipeId.toString(),
    userId,
    Boolean(source.kitchenId)
  );

  const sourceServings = source.servings ?? 1;
  const requestedExtra = data.cookExtra
    ? Math.min(Math.max(data.extraServings ?? sourceServings, 1), 100)
    : 0;
  const extra = Math.max(0, Math.min(requestedExtra, 100 - sourceServings));
  entryFields.servings = extra > 0 ? extra : sourceServings;
  entryFields.leftoverOfEntryId = source._id;

  const leftover = await ScheduleEntry.create(entryFields);

  let updatedSource: IScheduleEntry | null = null;

  if (extra > 0) {
    try {
      updatedSource = await ScheduleEntry.findOneAndUpdate(
        { _id: source._id },
        [
          {
            $set: {
              servings: {
                $min: [100, { $add: [{ $ifNull: ["$servings", 1] }, extra] }],
              },
            },
          },
        ],
        { new: true }
      );
    } catch {
      await ScheduleEntry.findByIdAndDelete(leftover._id);
      throw createError(
        "Could not plan the leftovers. Please try again.",
        500
      );
    }

    if (!updatedSource) {
      await ScheduleEntry.findByIdAndDelete(leftover._id);
      throw createError(
        "Could not plan the leftovers. Please try again.",
        500
      );
    }
  }

  if (status === "suggested") {
    notifyScheduleSuggestion(
      userId,
      source.kitchenId!.toString(),
      leftover._id.toString()
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send schedule_suggestion notification: ${msg}`);
    });
  }

  return { leftover, source: updatedSource ?? source };
}

export async function getEntries(
  query: { kitchenId?: string; userId?: string },
  startDate: Date,
  endDate: Date
): Promise<IScheduleEntry[]> {
  const start = stripTime(startDate);
  const end = stripTime(endDate);

  const filter: Record<string, unknown> = {
    date: { $gte: start, $lte: end },
  };

  if (query.kitchenId) {
    filter.kitchenId = new Types.ObjectId(query.kitchenId);
  } else if (query.userId) {
    filter.userId = new Types.ObjectId(query.userId);
    filter.kitchenId = { $exists: false };
  } else {
    throw createError("Either kitchenId or userId must be provided", 400);
  }

  const entries = await ScheduleEntry.find(filter)
    .sort({ date: 1, mealSlot: 1 })
    .lean<IScheduleEntry[]>();

  if (entries.length === 0) {
    return entries;
  }

  const fetchedIds = entries.map((entry) => entry._id);

  const counts = await ScheduleEntry.aggregate<{
    _id: Types.ObjectId;
    count: number;
  }>([
    { $match: { leftoverOfEntryId: { $in: fetchedIds } } },
    { $group: { _id: "$leftoverOfEntryId", count: { $sum: 1 } } },
  ]);

  if (counts.length > 0) {
    const countsById = new Map(
      counts.map((c) => [c._id.toString(), c.count])
    );
    for (const entry of entries) {
      const count = countsById.get(entry._id.toString());
      if (count && count > 0) {
        entry.leftoverCount = count;
      }
    }
  }

  const leftoverEntries = entries.filter((entry) => entry.leftoverOfEntryId);

  if (leftoverEntries.length > 0) {
    const fetchedById = new Map(
      entries.map((entry) => [entry._id.toString(), entry])
    );
    const sourceIds = [
      ...new Set(
        leftoverEntries.map((entry) => entry.leftoverOfEntryId!.toString())
      ),
    ];
    const missingIds = sourceIds.filter((id) => !fetchedById.has(id));

    const fetchedSources =
      missingIds.length > 0
        ? await ScheduleEntry.find({ _id: { $in: missingIds } })
            .select("date")
            .lean<Pick<IScheduleEntry, "_id" | "date">[]>()
        : [];

    const datesById = new Map<string, Date>();
    for (const id of sourceIds) {
      const local = fetchedById.get(id);
      if (local) {
        datesById.set(id, local.date);
      }
    }
    for (const fetchedSource of fetchedSources) {
      datesById.set(fetchedSource._id.toString(), fetchedSource.date);
    }

    for (const entry of leftoverEntries) {
      const date = datesById.get(entry.leftoverOfEntryId!.toString());
      if (date) {
        entry.leftoverOfDate = date;
      }
    }
  }

  return entries;
}

export async function updateEntry(
  userId: string,
  entryId: string,
  updates: {
    date?: Date;
    mealSlot?: string;
    recipeId?: string;
    freeformText?: string;
    scheduledTime?: string | null;
    prepTime?: number | null;
    servings?: number;
  }
): Promise<IScheduleEntry> {
  const entry = await ScheduleEntry.findById(entryId);
  if (!entry) {
    throw createError("Schedule entry not found", 404);
  }

  const user = await User.findById(userId)
    .select("kitchenId isPremium premiumExpiresAt timezoneOffsetMinutes")
    .lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  // Personal entry (no kitchenId on entry) — verify ownership
  if (!entry.kitchenId) {
    if (!entry.userId.equals(userId)) {
      throw createError("You do not own this schedule entry", 403);
    }
  } else {
    // Kitchen entry — existing permission logic
    if (!user.kitchenId || !user.kitchenId.equals(entry.kitchenId)) {
      throw createError("You are not a member of this kitchen", 403);
    }

    const kitchen = await Kitchen.findById(entry.kitchenId);
    if (!kitchen) {
      throw createError("Kitchen not found", 404);
    }

    const canEdit = hasScheduleEditPermission(userId, kitchen);

    // Confirmed entries: only lead/editors can update
    if (entry.status === "confirmed" && !canEdit) {
      throw createError("Only the kitchen lead or editors can update confirmed entries", 403);
    }

    // Suggested entries: only the original suggester can update
    if (entry.status === "suggested") {
      if (!entry.suggestedBy?.equals(userId) && !canEdit) {
        throw createError("You can only update your own suggestions", 403);
      }
    }
  }

  const updateFields: Record<string, unknown> = {};

  if (updates.date !== undefined) {
    const newDate = stripTime(updates.date);
    if (
      !hasActivePremium(user) &&
      isBeyondFreeTierScheduleLimit(newDate, user.timezoneOffsetMinutes)
    ) {
      throw createError(
        FREE_TIER_SCHEDULE_LIMIT_MESSAGE,
        403
      );
    }
    updateFields.date = newDate;
  }

  if (updates.mealSlot !== undefined) {
    updateFields.mealSlot = updates.mealSlot;
  }

  if (updates.freeformText !== undefined) {
    updateFields.freeformText = updates.freeformText;
  }

  if (updates.scheduledTime !== undefined) {
    updateFields.scheduledTime = updates.scheduledTime;
  }

  if (updates.prepTime !== undefined) {
    updateFields.prepTime = updates.prepTime;
  }

  if (updates.recipeId !== undefined) {
    await populateRecipeFields(
      updateFields,
      updates.recipeId,
      userId,
      Boolean(entry.kitchenId)
    );
  }

  if (updates.servings !== undefined) {
    updateFields.servings = updates.servings;
  }

  const updated = await ScheduleEntry.findByIdAndUpdate(
    entryId,
    { $set: updateFields },
    { new: true, runValidators: true }
  );

  if (!updated) {
    throw createError("Schedule entry not found", 404);
  }

  if (updates.recipeId !== undefined && !entry.leftoverOfEntryId) {
    const snapshotKeys = [
      "recipeId",
      "recipeTitle",
      "recipePhoto",
      "recipeAuthorId",
      "recipeAuthorName",
      "prepTime",
    ] as const;

    const setFields: Record<string, unknown> = {};

    for (const key of snapshotKeys) {
      const value = updateFields[key];
      if (value !== undefined) {
        setFields[key] = value;
      }
    }

    if (Object.keys(setFields).length > 0) {
      await ScheduleEntry.updateMany(
        { leftoverOfEntryId: entry._id },
        { $set: setFields }
      );
    }
  }

  return updated;
}

export async function deleteEntry(
  userId: string,
  entryId: string,
  options?: { withLeftovers?: boolean }
): Promise<{ removedLeftovers: number }> {
  const entry = await ScheduleEntry.findById(entryId);
  if (!entry) {
    throw createError("Schedule entry not found", 404);
  }

  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  // Personal entry — verify ownership
  if (!entry.kitchenId) {
    if (!entry.userId.equals(userId)) {
      throw createError("You do not own this schedule entry", 403);
    }
  } else {
    // Kitchen entry — existing permission logic
    if (!user.kitchenId || !user.kitchenId.equals(entry.kitchenId)) {
      throw createError("You are not a member of this kitchen", 403);
    }

    const kitchen = await Kitchen.findById(entry.kitchenId);
    if (!kitchen) {
      throw createError("Kitchen not found", 404);
    }

    const canEdit = hasScheduleEditPermission(userId, kitchen);

    if (entry.status === "confirmed" && !canEdit) {
      throw createError("Only the kitchen lead or editors can delete confirmed entries", 403);
    }

    if (entry.status === "suggested" && !entry.suggestedBy?.equals(userId) && !canEdit) {
      throw createError("You can only delete your own suggestions", 403);
    }
  }

  await ScheduleEntry.findByIdAndDelete(entryId);

  let removedLeftovers = 0;
  if (options?.withLeftovers) {
    const result = await ScheduleEntry.deleteMany({
      leftoverOfEntryId: entry._id,
    });
    removedLeftovers = result.deletedCount ?? 0;
  }

  return { removedLeftovers };
}

export async function getSuggestions(
  userId: string,
  kitchenId: string
): Promise<IScheduleEntry[]> {
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  if (!user.kitchenId || !user.kitchenId.equals(kitchenId)) {
    throw createError("You are not a member of this kitchen", 403);
  }

  const kitchen = await Kitchen.findById(kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!hasApprovalPermission(userId, kitchen)) {
    throw createError("You do not have permission to view suggestions", 403);
  }

  const suggestions = await ScheduleEntry.find({
    kitchenId: new Types.ObjectId(kitchenId),
    status: "suggested",
  })
    .sort({ date: 1, createdAt: 1 })
    .lean<IScheduleEntry[]>();

  return suggestions;
}

export async function approveSuggestion(
  userId: string,
  entryId: string
): Promise<IScheduleEntry> {
  const entry = await ScheduleEntry.findById(entryId);
  if (!entry) {
    throw createError("Schedule entry not found", 404);
  }

  if (entry.status !== "suggested") {
    throw createError("This entry is not a pending suggestion", 400);
  }

  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  if (!user.kitchenId || !user.kitchenId.equals(entry.kitchenId)) {
    throw createError("You are not a member of this kitchen", 403);
  }

  const kitchen = await Kitchen.findById(entry.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!hasApprovalPermission(userId, kitchen)) {
    throw createError("You do not have permission to approve suggestions", 403);
  }

  const updated = await ScheduleEntry.findByIdAndUpdate(
    entryId,
    {
      $set: {
        status: "confirmed",
        confirmedBy: new Types.ObjectId(userId),
      },
    },
    { new: true }
  );

  if (!updated) {
    throw createError("Schedule entry not found", 404);
  }

  // Fire-and-forget notification
  notifySuggestionApproved(entryId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`Failed to send suggestion_approved notification: ${msg}`);
  });

  return updated;
}

export async function denySuggestion(
  userId: string,
  entryId: string
): Promise<void> {
  const entry = await ScheduleEntry.findById(entryId);
  if (!entry) {
    throw createError("Schedule entry not found", 404);
  }

  if (entry.status !== "suggested") {
    throw createError("This entry is not a pending suggestion", 400);
  }

  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  if (!user.kitchenId || !user.kitchenId.equals(entry.kitchenId)) {
    throw createError("You are not a member of this kitchen", 403);
  }

  const kitchen = await Kitchen.findById(entry.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!hasApprovalPermission(userId, kitchen)) {
    throw createError("You do not have permission to deny suggestions", 403);
  }

  // Capture data needed for notification before deleting (avoids race condition)
  const notificationData = entry.suggestedBy && entry.kitchenId
    ? {
        suggestedBy: entry.suggestedBy,
        kitchenId: entry.kitchenId,
        kitchenName: kitchen.name,
        scheduleEntryId: entry._id,
      }
    : null;

  // Delete first, then notify with pre-loaded data
  await ScheduleEntry.findByIdAndDelete(entryId);

  if (notificationData) {
    notifySuggestionDeniedWithData(notificationData).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send suggestion_denied notification: ${msg}`);
    });
  }
}

export async function importToKitchen(
  userId: string,
  kitchenId: string,
  startDate: Date,
  endDate: Date
): Promise<number> {
  const user = await User.findById(userId)
    .select("kitchenId isPremium premiumExpiresAt timezoneOffsetMinutes")
    .lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  if (!user.kitchenId || !user.kitchenId.equals(kitchenId)) {
    throw createError("You are not a member of this kitchen", 403);
  }

  const kitchen = await Kitchen.findById(kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  const start = stripTime(startDate);
  const end = stripTime(endDate);

  // Free-tier members can only import within the free-tier planning window.
  // Reject if either end of the range falls outside the rolling 5-day band.
  if (
    !hasActivePremium(user) &&
    (isBeyondFreeTierScheduleLimit(end, user.timezoneOffsetMinutes) ||
      isBeyondFreeTierScheduleLimit(start, user.timezoneOffsetMinutes))
  ) {
    throw createError(
      FREE_TIER_SCHEDULE_LIMIT_MESSAGE,
      403
    );
  }

  // Fetch the user's personal entries within the date range
  const personalEntries = await ScheduleEntry.find({
    userId: new Types.ObjectId(userId),
    kitchenId: { $exists: false },
    date: { $gte: start, $lte: end },
  }).lean<IScheduleEntry[]>();

  if (personalEntries.length === 0) {
    return 0;
  }

  const importedRecipeIds = [
    ...new Set(
      personalEntries
        .filter((entry) => entry.recipeId)
        .map((entry) => entry.recipeId!.toString())
    ),
  ];
  await Promise.all(
    importedRecipeIds.map((recipeId) =>
      populateRecipeFields({}, recipeId, userId, true)
    )
  );

  const canEdit = hasScheduleEditPermission(userId, kitchen);
  const status =
    kitchen.scheduleAddPolicy === "all" || canEdit ? "confirmed" : "suggested";

  if (status === "suggested" && kitchen.allowMemberSuggestions === false) {
    throw createError(
      "The kitchen lead has turned off member suggestions.",
      403
    );
  }

  const kitchenEntries = personalEntries.map((entry) => ({
    kitchenId: new Types.ObjectId(kitchenId),
    userId: new Types.ObjectId(userId),
    date: entry.date,
    mealSlot: entry.mealSlot,
    recipeId: entry.recipeId,
    recipeTitle: entry.recipeTitle,
    recipePhoto: entry.recipePhoto,
    recipeAuthorId: entry.recipeAuthorId,
    recipeAuthorName: entry.recipeAuthorName,
    freeformText: entry.freeformText,
    servings: entry.servings,
    status,
    suggestedBy: new Types.ObjectId(userId),
    ...(status === "confirmed"
      ? { confirmedBy: new Types.ObjectId(userId) }
      : {}),
  }));

  const result = await ScheduleEntry.insertMany(kitchenEntries);

  // If the imported entries are suggestions, send a single aggregate
  // notification to the lead + approvers (avoids per-entry spam).
  if (status === "suggested") {
    notifyScheduleImportSuggestions(userId, kitchenId, result.length).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(
          `Failed to send schedule_suggestion import notification: ${msg}`
        );
      }
    );
  }

  return result.length;
}

/**
 * Set (or clear, when `status` is null) the calling member's dinner RSVP on a
 * kitchen schedule entry. Any kitchen member may RSVP; personal entries cannot
 * collect RSVPs. Replaces the member's previous response so each member is
 * counted once. Returns the updated entry with the full `rsvps` array.
 */
export async function setEntryRsvp(
  userId: string,
  entryId: string,
  status: RsvpStatus | null
): Promise<IScheduleEntry> {
  const entry = await ScheduleEntry.findById(entryId).select("kitchenId").lean();
  if (!entry) {
    throw createError("Schedule entry not found", 404);
  }
  if (!entry.kitchenId) {
    throw createError("Only kitchen meals can collect RSVPs", 400);
  }

  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user) {
    throw createError("User not found", 404);
  }
  if (!user.kitchenId || !user.kitchenId.equals(entry.kitchenId)) {
    throw createError("You are not a member of this kitchen", 403);
  }

  const uid = new Types.ObjectId(userId);
  await ScheduleEntry.updateOne({ _id: entry._id }, [
    {
      $set: {
        rsvps: {
          $concatArrays: [
            {
              $filter: {
                input: "$rsvps",
                as: "r",
                cond: { $ne: ["$$r.userId", uid] },
              },
            },
            status ? [{ userId: uid, status }] : [],
          ],
        },
      },
    },
  ]);

  const updated = await ScheduleEntry.findById(entryId).lean<IScheduleEntry>();
  if (!updated) {
    throw createError("Schedule entry not found", 404);
  }
  return updated;
}

function dateKey(date: Date): string {
  const d = stripTime(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function scheduleScopeFilter(
  userId: string,
  kitchenId: Types.ObjectId | null
): Record<string, unknown> {
  return kitchenId
    ? { kitchenId }
    : { userId: new Types.ObjectId(userId), kitchenId: { $exists: false } };
}

export interface CopyWeekSkipCounts {
  filledSlots: number;
  unavailableRecipes: number;
  leftoversWithoutSource: number;
}

export interface CopiedEntryPlan {
  entries: Record<string, unknown>[];
  skipped: CopyWeekSkipCounts;
  lockedDates: number;
  sourceEntryIdByNewId: Map<string, Types.ObjectId>;
}

export interface BuildCopiedEntriesInput {
  sourceEntries: IScheduleEntry[];
  targetStart: Date;
  sourceStart: Date;
  targetEntries: IScheduleEntry[];
  actingUserId: string;
  kitchenId: Types.ObjectId | null;
  status: "confirmed" | "suggested";
  skipFilledSlots: boolean;
  isPremium: boolean;
  timezoneOffsetMinutes?: number;
}

export async function buildCopiedEntries(
  input: BuildCopiedEntriesInput
): Promise<CopiedEntryPlan> {
  const {
    sourceEntries,
    targetStart,
    sourceStart,
    targetEntries,
    actingUserId,
    kitchenId,
    status,
    skipFilledSlots,
    isPremium,
    timezoneOffsetMinutes,
  } = input;

  const shift = Math.round(
    (stripTime(targetStart).getTime() - stripTime(sourceStart).getTime()) /
      86400000
  );

  const sorted = [...sourceEntries].sort((a, b) => {
    const dateDiff =
      stripTime(a.date).getTime() - stripTime(b.date).getTime();
    if (dateDiff !== 0) {
      return dateDiff;
    }
    const slotDiff = a.mealSlot.localeCompare(b.mealSlot);
    if (slotDiff !== 0) {
      return slotDiff;
    }
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const recipeIds = [
    ...new Set(
      sorted
        .filter((entry) => entry.recipeId)
        .map((entry) => entry.recipeId!.toString())
    ),
  ];

  const recipeSnapshots = new Map<string, Record<string, unknown>>();
  const unavailableRecipeIds = new Set<string>();

  for (const recipeId of recipeIds) {
    try {
      const fields: Record<string, unknown> = {};
      await populateRecipeFields(
        fields,
        recipeId,
        actingUserId,
        Boolean(kitchenId)
      );
      recipeSnapshots.set(recipeId, fields);
    } catch {
      unavailableRecipeIds.add(recipeId);
    }
  }

  const occupied = new Set(
    targetEntries.map(
      (entry) => `${dateKey(entry.date)}|${entry.mealSlot.toLowerCase()}`
    )
  );

  const skipped: CopyWeekSkipCounts = {
    filledSlots: 0,
    unavailableRecipes: 0,
    leftoversWithoutSource: 0,
  };

  const actingUserObjectId = new Types.ObjectId(actingUserId);

  function buildDocument(
    entry: IScheduleEntry,
    targetDate: Date,
    recipeSnapshot: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    const doc: Record<string, unknown> = {
      _id: new Types.ObjectId(),
      userId: actingUserObjectId,
      date: targetDate,
      mealSlot: entry.mealSlot,
      status,
    };

    if (kitchenId) {
      doc.kitchenId = kitchenId;
      doc.suggestedBy = actingUserObjectId;
    }

    if (status === "confirmed") {
      doc.confirmedBy = actingUserObjectId;
    }

    if (recipeSnapshot) {
      doc.recipeId = recipeSnapshot.recipeId;
      doc.recipeTitle = recipeSnapshot.recipeTitle;
      doc.recipePhoto = recipeSnapshot.recipePhoto;
      doc.recipeAuthorId = recipeSnapshot.recipeAuthorId;
      doc.recipeAuthorName = recipeSnapshot.recipeAuthorName;
    }

    if (entry.freeformText) {
      doc.freeformText = entry.freeformText;
    }

    if (entry.scheduledTime) {
      doc.scheduledTime = entry.scheduledTime;
    }

    const prepTime = entry.prepTime ?? recipeSnapshot?.prepTime;
    if (prepTime != null) {
      doc.prepTime = prepTime;
    }

    const servings = entry.servings ?? recipeSnapshot?.servings;
    if (servings != null) {
      doc.servings = servings;
    }

    return doc;
  }

  const entries: Record<string, unknown>[] = [];
  const newIdBySourceId = new Map<string, Types.ObjectId>();
  const sourceEntryIdByNewId = new Map<string, Types.ObjectId>();

  for (const entry of sorted) {
    if (entry.leftoverOfEntryId) {
      continue;
    }

    const targetDate = addDays(stripTime(entry.date), shift);
    const key = `${dateKey(targetDate)}|${entry.mealSlot.toLowerCase()}`;

    if (skipFilledSlots && occupied.has(key)) {
      skipped.filledSlots += 1;
      continue;
    }

    const recipeKey = entry.recipeId?.toString();
    if (recipeKey && unavailableRecipeIds.has(recipeKey)) {
      skipped.unavailableRecipes += 1;
      continue;
    }

    const doc = buildDocument(
      entry,
      targetDate,
      recipeKey ? recipeSnapshots.get(recipeKey) : undefined
    );
    entries.push(doc);
    newIdBySourceId.set(entry._id.toString(), doc._id as Types.ObjectId);
    sourceEntryIdByNewId.set((doc._id as Types.ObjectId).toString(), entry._id);
  }

  for (const entry of sorted) {
    if (!entry.leftoverOfEntryId) {
      continue;
    }

    const targetDate = addDays(stripTime(entry.date), shift);
    const key = `${dateKey(targetDate)}|${entry.mealSlot.toLowerCase()}`;

    if (skipFilledSlots && occupied.has(key)) {
      skipped.filledSlots += 1;
      continue;
    }

    const recipeKey = entry.recipeId?.toString();
    if (recipeKey && unavailableRecipeIds.has(recipeKey)) {
      skipped.unavailableRecipes += 1;
      continue;
    }

    const newSourceId = newIdBySourceId.get(
      entry.leftoverOfEntryId.toString()
    );
    if (!newSourceId) {
      skipped.leftoversWithoutSource += 1;
      continue;
    }

    const doc = buildDocument(
      entry,
      targetDate,
      recipeKey ? recipeSnapshots.get(recipeKey) : undefined
    );
    doc.leftoverOfEntryId = newSourceId;
    entries.push(doc);
    sourceEntryIdByNewId.set((doc._id as Types.ObjectId).toString(), entry._id);
  }

  const lockedDates = isPremium
    ? 0
    : new Set(
        entries
          .filter((doc) =>
            isBeyondFreeTierScheduleLimit(
              doc.date as Date,
              timezoneOffsetMinutes
            )
          )
          .map((doc) => dateKey(doc.date as Date))
      ).size;

  return { entries, skipped, lockedDates, sourceEntryIdByNewId };
}

export async function copyWeek(
  userId: string,
  data: {
    sourceStart: Date;
    targetStart: Date;
    skipFilledSlots: boolean;
    dryRun: boolean;
  }
): Promise<{
  created: unknown[];
  skipped: CopyWeekSkipCounts;
  lockedDates: number;
  sourceCount: number;
}> {
  const user = await User.findById(userId)
    .select("kitchenId isPremium premiumExpiresAt timezoneOffsetMinutes")
    .lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  const sourceStart = stripTime(data.sourceStart);
  const targetStart = stripTime(data.targetStart);
  const shift = Math.round(
    (targetStart.getTime() - sourceStart.getTime()) / 86400000
  );

  if (Math.abs(shift) < 7) {
    throw createError(
      "Pick a week that does not overlap the week you are copying into.",
      400
    );
  }

  const kitchenId = user.kitchenId ?? null;
  let status: "confirmed" | "suggested" = "confirmed";

  if (kitchenId) {
    const kitchen = await Kitchen.findById(kitchenId);
    if (!kitchen) {
      throw createError("Kitchen not found", 404);
    }

    const canEdit = hasScheduleEditPermission(userId, kitchen);
    status =
      kitchen.scheduleAddPolicy === "all" || canEdit
        ? "confirmed"
        : "suggested";

    if (status === "suggested" && kitchen.allowMemberSuggestions === false) {
      throw createError(
        "The kitchen lead has turned off member suggestions.",
        403
      );
    }
  }

  const sourceEnd = addDays(sourceStart, 6);
  const sourceEntries = await ScheduleEntry.find({
    ...scheduleScopeFilter(userId, kitchenId),
    status: "confirmed",
    date: { $gte: sourceStart, $lte: sourceEnd },
  }).lean<IScheduleEntry[]>();

  const sourceCount = sourceEntries.length;

  if (sourceCount > 500) {
    throw createError("That week has too many meals to copy at once.", 400);
  }

  const targetEnd = addDays(targetStart, 6);
  const targetEntries = data.skipFilledSlots
    ? await ScheduleEntry.find({
        ...scheduleScopeFilter(userId, kitchenId),
        date: { $gte: targetStart, $lte: targetEnd },
      }).lean<IScheduleEntry[]>()
    : [];

  const plan = await buildCopiedEntries({
    sourceEntries,
    targetStart,
    sourceStart,
    targetEntries,
    actingUserId: userId,
    kitchenId,
    status,
    skipFilledSlots: data.skipFilledSlots,
    isPremium: hasActivePremium(user),
    timezoneOffsetMinutes: user.timezoneOffsetMinutes,
  });

  if (data.dryRun) {
    const sourceEntriesById = new Map(
      sourceEntries.map((entry) => [entry._id.toString(), entry])
    );

    const created = plan.entries.map((doc) => {
      const rest: Record<string, unknown> = { ...doc };
      const newId = (doc._id as Types.ObjectId).toString();
      delete rest._id;
      if (rest.leftoverOfEntryId) {
        const sourceEntryId = plan.sourceEntryIdByNewId.get(newId);
        const sourceEntry = sourceEntryId
          ? sourceEntriesById.get(sourceEntryId.toString())
          : undefined;
        if (sourceEntry?.leftoverOfEntryId) {
          rest.leftoverOfEntryId = sourceEntry.leftoverOfEntryId;
        } else {
          delete rest.leftoverOfEntryId;
        }
      }
      return rest;
    });

    return {
      created,
      skipped: plan.skipped,
      lockedDates: plan.lockedDates,
      sourceCount,
    };
  }

  if (plan.lockedDates > 0) {
    throw createError(
      FREE_TIER_SCHEDULE_LIMIT_MESSAGE,
      403,
      "PREMIUM_REQUIRED"
    );
  }

  if (plan.entries.length === 0) {
    return { created: [], skipped: plan.skipped, lockedDates: 0, sourceCount };
  }

  const inserted = await ScheduleEntry.insertMany(plan.entries);
  await bumpScheduleRevision(userId, kitchenId);

  if (status === "suggested") {
    notifyScheduleImportSuggestions(
      userId,
      kitchenId!.toString(),
      inserted.length
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(
        `Failed to send schedule_suggestion import notification: ${msg}`
      );
    });
  }

  return {
    created: inserted,
    skipped: plan.skipped,
    lockedDates: 0,
    sourceCount,
  };
}

export async function batchDeleteEntries(
  userId: string,
  ids: string[]
): Promise<{ deleted: number }> {
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  const entries = await ScheduleEntry.find({
    _id: { $in: ids },
  }).lean<IScheduleEntry[]>();

  const kitchenCache = new Map<string, IKitchen | null>();
  const permittedIds: Types.ObjectId[] = [];
  const touchedKitchenIds = new Set<string>();
  let touchedPersonal = false;

  for (const entry of entries) {
    if (!entry.kitchenId) {
      if (!entry.userId.equals(userId)) {
        throw createError("You do not own this schedule entry", 403);
      }
      permittedIds.push(entry._id);
      touchedPersonal = true;
      continue;
    }

    if (!user.kitchenId || !user.kitchenId.equals(entry.kitchenId)) {
      throw createError("You are not a member of this kitchen", 403);
    }

    const kitchenKey = entry.kitchenId.toString();
    if (!kitchenCache.has(kitchenKey)) {
      kitchenCache.set(kitchenKey, await Kitchen.findById(entry.kitchenId));
    }
    const kitchen = kitchenCache.get(kitchenKey) ?? null;
    if (!kitchen) {
      throw createError("Kitchen not found", 404);
    }

    const canEdit = hasScheduleEditPermission(userId, kitchen);

    if (entry.status === "confirmed" && !canEdit) {
      throw createError(
        "Only the kitchen lead or editors can delete confirmed entries",
        403
      );
    }

    if (
      entry.status === "suggested" &&
      !entry.suggestedBy?.equals(userId) &&
      !canEdit
    ) {
      throw createError("You can only delete your own suggestions", 403);
    }

    permittedIds.push(entry._id);
    touchedKitchenIds.add(kitchenKey);
  }

  const result = await ScheduleEntry.deleteMany({
    _id: { $in: permittedIds },
  });

  for (const kitchenId of touchedKitchenIds) {
    await bumpScheduleRevision(userId, kitchenId);
  }
  if (touchedPersonal) {
    await bumpScheduleRevision(userId, null);
  }

  return { deleted: result.deletedCount ?? 0 };
}
