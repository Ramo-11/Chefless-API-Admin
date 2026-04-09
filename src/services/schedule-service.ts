import { Types } from "mongoose";
import ScheduleEntry, { IScheduleEntry } from "../models/ScheduleEntry";
import Kitchen from "../models/Kitchen";
import Recipe from "../models/Recipe";
import User from "../models/User";
import {
  notifyScheduleSuggestion,
  notifySuggestionApproved,
  notifySuggestionDeniedWithData,
} from "./notification-service";
import { hasActivePremium } from "../lib/premium";

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

/** Last schedulable calendar day for free tier: Sunday of next week (UTC). */
function freeTierMaxScheduleDateUtc(): Date {
  const mon = utcMondayOf(new Date());
  const end = new Date(mon);
  end.setUTCDate(end.getUTCDate() + 13);
  return end;
}

function isBeyondFreeTierScheduleLimit(date: Date): boolean {
  const max = freeTierMaxScheduleDateUtc();
  return stripTime(date) > max;
}

interface AddEntryData {
  date: Date;
  mealSlot: string;
  recipeId?: string;
  freeformText?: string;
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
  kitchenId: string,
  data: AddEntryData
): Promise<IScheduleEntry> {
  const user = await User.findById(userId)
    .select("kitchenId isPremium premiumExpiresAt")
    .lean();
  if (!user) {
    throw createError("User not found", 404);
  }

  if (!user.kitchenId || !user.kitchenId.equals(kitchenId)) {
    throw createError("You are not a member of this kitchen", 403);
  }

  const entryDate = stripTime(data.date);

  if (!hasActivePremium(user) && isBeyondFreeTierScheduleLimit(entryDate)) {
    throw createError(
      "Free tier users can plan through the end of next week only. Upgrade to premium for monthly scheduling.",
      403
    );
  }

  const kitchen = await Kitchen.findById(kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  const canEdit = hasScheduleEditPermission(userId, kitchen);
  const status = canEdit ? "confirmed" : "suggested";

  const entryFields: Record<string, unknown> = {
    kitchenId: new Types.ObjectId(kitchenId),
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

  // Denormalize recipe data if recipeId provided
  if (data.recipeId) {
    const recipe = await Recipe.findById(data.recipeId)
      .select("title photos authorId")
      .lean();
    if (!recipe) {
      throw createError("Recipe not found", 404);
    }

    const author = await User.findById(recipe.authorId)
      .select("fullName")
      .lean();

    entryFields.recipeId = new Types.ObjectId(data.recipeId);
    entryFields.recipeTitle = recipe.title;
    entryFields.recipePhoto = recipe.photos.length > 0 ? recipe.photos[0] : undefined;
    entryFields.recipeAuthorId = recipe.authorId;
    entryFields.recipeAuthorName = author?.fullName;
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

export async function getEntries(
  kitchenId: string,
  startDate: Date,
  endDate: Date
): Promise<IScheduleEntry[]> {
  const start = stripTime(startDate);
  const end = stripTime(endDate);

  const entries = await ScheduleEntry.find({
    kitchenId: new Types.ObjectId(kitchenId),
    date: { $gte: start, $lte: end },
  })
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

  const updateFields: Record<string, unknown> = {};

  if (updates.date !== undefined) {
    const newDate = stripTime(updates.date);
    if (!hasActivePremium(user) && isBeyondFreeTierScheduleLimit(newDate)) {
      throw createError(
        "Free tier users can plan through the end of next week only. Upgrade to premium for monthly scheduling.",
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
    const recipe = await Recipe.findById(updates.recipeId)
      .select("title photos authorId")
      .lean();
    if (!recipe) {
      throw createError("Recipe not found", 404);
    }

    const author = await User.findById(recipe.authorId)
      .select("fullName")
      .lean();

    updateFields.recipeId = new Types.ObjectId(updates.recipeId);
    updateFields.recipeTitle = recipe.title;
    updateFields.recipePhoto = recipe.photos.length > 0 ? recipe.photos[0] : undefined;
    updateFields.recipeAuthorId = recipe.authorId;
    updateFields.recipeAuthorName = author?.fullName;
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
  const notificationData = entry.suggestedBy
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
