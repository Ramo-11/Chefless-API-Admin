import { Types } from "mongoose";
import ScheduleEntry, { IScheduleEntry } from "../models/ScheduleEntry";
import Kitchen from "../models/Kitchen";
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
}

function createError(message: string, statusCode: number): ServiceError {
  const error = new Error(message) as ServiceError;
  error.statusCode = statusCode;
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

/**
 * Last schedulable calendar day for the free tier: a rolling window of
 * (today + 6) UTC days, i.e. 7 days inclusive of today. Chosen over an
 * ISO-week boundary so Sunday-night meal planners aren't locked out of
 * scheduling tomorrow.
 */
function freeTierMaxScheduleDateUtc(): Date {
  const today = stripTime(new Date());
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + 6);
  return end;
}

function isBeyondFreeTierScheduleLimit(date: Date): boolean {
  const max = freeTierMaxScheduleDateUtc();
  return stripTime(date) > max;
}

const FREE_TIER_SCHEDULE_LIMIT_MESSAGE =
  "Free tier users can plan up to 7 days ahead. Upgrade to premium for full calendar scheduling.";

interface AddEntryData {
  date: Date;
  mealSlot: string;
  recipeId?: string;
  freeformText?: string;
  scheduledTime?: string;
  prepTime?: number;
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

export async function addEntry(
  userId: string,
  kitchenId: string | null,
  data: AddEntryData
): Promise<IScheduleEntry> {
  const user = await User.findById(userId)
    .select("kitchenId isPremium premiumExpiresAt")
    .lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  const entryDate = stripTime(data.date);

  if (!hasActivePremium(user) && isBeyondFreeTierScheduleLimit(entryDate)) {
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
      await populateRecipeFields(entryFields, data.recipeId, userId);
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
    await populateRecipeFields(entryFields, data.recipeId, userId);
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
  actingUserId: string
): Promise<void> {
  const recipe = await Recipe.findById(recipeId)
    .select("title photos authorId prepTime isPrivate isHidden")
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

  return entries;
}

export async function updateEntry(
  userId: string,
  entryId: string,
  updates: { date?: Date; mealSlot?: string; recipeId?: string; freeformText?: string }
): Promise<IScheduleEntry> {
  const entry = await ScheduleEntry.findById(entryId);
  if (!entry) {
    throw createError("Schedule entry not found", 404);
  }

  const user = await User.findById(userId)
    .select("kitchenId isPremium premiumExpiresAt")
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
    if (!hasActivePremium(user) && isBeyondFreeTierScheduleLimit(newDate)) {
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

  if (updates.recipeId !== undefined) {
    await populateRecipeFields(updateFields, updates.recipeId, userId);
  }

  const updated = await ScheduleEntry.findByIdAndUpdate(
    entryId,
    { $set: updateFields },
    { new: true, runValidators: true }
  );

  if (!updated) {
    throw createError("Schedule entry not found", 404);
  }

  return updated;
}

export async function deleteEntry(
  userId: string,
  entryId: string
): Promise<void> {
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
    await ScheduleEntry.findByIdAndDelete(entryId);
    return;
  }

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

  await ScheduleEntry.findByIdAndDelete(entryId);
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
    .select("kitchenId isPremium premiumExpiresAt")
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
  // Enforce on the end date so imports past the cutoff are rejected cleanly.
  if (!hasActivePremium(user) && isBeyondFreeTierScheduleLimit(end)) {
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
