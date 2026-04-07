import { Types } from "mongoose";
import Kitchen, { IKitchen } from "../models/Kitchen";
import User, { IUser } from "../models/User";
import Recipe, { IRecipe } from "../models/Recipe";
import ScheduleEntry from "../models/ScheduleEntry";
import ShoppingList from "../models/ShoppingList";
import {
  notifyKitchenJoined,
  notifyKitchenRemoved,
} from "./notification-service";

const FREE_TIER_MAX_MEMBERS = 4;

/** Regex for validating invite codes. Shared with route validation. */
export const INVITE_CODE_REGEX = /^CHEF-[A-Z0-9]{6}$/;

interface ServiceError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): ServiceError {
  const error = new Error(message) as ServiceError;
  error.statusCode = statusCode;
  return error;
}

function generateInviteCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "CHEF-";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

const MAX_INVITE_CODE_RETRIES = 10;

async function generateUniqueInviteCode(): Promise<string> {
  for (let attempt = 0; attempt < MAX_INVITE_CODE_RETRIES; attempt++) {
    const code = generateInviteCode();
    const exists = await Kitchen.findOne({ inviteCode: code }).lean();
    if (!exists) return code;
  }
  throw createError("Failed to generate a unique invite code. Please try again.", 500);
}

interface KitchenMember {
  _id: Types.ObjectId;
  fullName: string;
  profilePicture?: string;
  recipesCount?: number;
}

interface KitchenWithMembers {
  kitchen: IKitchen;
  members: KitchenMember[];
}

interface PaginatedRecipes {
  data: IRecipe[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export async function createKitchen(
  userId: string,
  name: string,
  photo?: string
): Promise<IKitchen> {
  const user = await User.findById(userId);
  if (!user) {
    throw createError("User not found", 404);
  }

  if (user.kitchenId) {
    throw createError("You are already in a kitchen", 400);
  }

  const inviteCode = await generateUniqueInviteCode();

  const kitchen = await Kitchen.create({
    name,
    leadId: new Types.ObjectId(userId),
    inviteCode,
    photo,
    membersWithScheduleEdit: [],
    membersWithApprovalPower: [],
    memberCount: 1,
  });

  await User.updateOne(
    { _id: userId },
    { $set: { kitchenId: kitchen._id } }
  );

  return kitchen;
}

export async function getMyKitchen(
  userId: string
): Promise<KitchenWithMembers | null> {
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user || !user.kitchenId) {
    return null;
  }

  const kitchen = await Kitchen.findById(user.kitchenId);
  if (!kitchen) {
    return null;
  }

  const members = await User.find({ kitchenId: kitchen._id })
    .select("fullName profilePicture recipesCount")
    .lean<KitchenMember[]>();

  return { kitchen, members };
}

export async function updateKitchen(
  userId: string,
  updates: { name?: string; photo?: string; isPublic?: boolean }
): Promise<IKitchen> {
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user || !user.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchen = await Kitchen.findById(user.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!kitchen.leadId.equals(userId)) {
    throw createError("Only the kitchen lead can update the kitchen", 403);
  }

  const updateFields: Record<string, string | boolean> = {};
  if (updates.name !== undefined) updateFields.name = updates.name;
  if (updates.photo !== undefined) updateFields.photo = updates.photo;
  if (updates.isPublic !== undefined) updateFields.isPublic = updates.isPublic;

  const updated = await Kitchen.findByIdAndUpdate(
    kitchen._id,
    { $set: updateFields },
    { new: true, runValidators: true }
  );

  if (!updated) {
    throw createError("Kitchen not found", 404);
  }

  return updated;
}

export async function deleteKitchen(userId: string): Promise<void> {
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user || !user.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchen = await Kitchen.findById(user.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!kitchen.leadId.equals(userId)) {
    throw createError("Only the kitchen lead can delete the kitchen", 403);
  }

  // Clean up all kitchen-related data before deleting
  await Promise.all([
    ScheduleEntry.deleteMany({ kitchenId: kitchen._id }),
    ShoppingList.deleteMany({ kitchenId: kitchen._id }),
  ]);

  // Clear kitchenId for all members
  await User.updateMany(
    { kitchenId: kitchen._id },
    { $unset: { kitchenId: 1 } }
  );

  await Kitchen.findByIdAndDelete(kitchen._id);
}

export async function joinKitchen(
  userId: string,
  inviteCode: string
): Promise<IKitchen> {
  const user = await User.findById(userId);
  if (!user) {
    throw createError("User not found", 404);
  }

  if (user.kitchenId) {
    throw createError("You must leave your current kitchen first", 400);
  }

  const kitchen = await Kitchen.findOne({ inviteCode });
  if (!kitchen) {
    throw createError("Invalid invite code", 404);
  }

  // Check capacity based on lead's premium status
  const lead = await User.findById(kitchen.leadId).select("isPremium premiumExpiresAt").lean();
  if (!lead) {
    throw createError("Kitchen lead not found", 404);
  }

  const leadHasPremium = lead.isPremium && (!lead.premiumExpiresAt || new Date(lead.premiumExpiresAt) > new Date());
  if (!leadHasPremium && kitchen.memberCount >= FREE_TIER_MAX_MEMBERS) {
    throw createError(
      "This kitchen has reached its maximum capacity. The kitchen lead needs to upgrade to premium.",
      403
    );
  }

  await User.updateOne(
    { _id: userId },
    { $set: { kitchenId: kitchen._id } }
  );

  const updated = await Kitchen.findByIdAndUpdate(
    kitchen._id,
    { $inc: { memberCount: 1 } },
    { new: true }
  );

  if (!updated) {
    throw createError("Kitchen not found", 404);
  }

  // Fire-and-forget notification
  notifyKitchenJoined(userId, kitchen._id.toString()).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send kitchen_joined notification: ${msg}`);
    }
  );

  return updated;
}

export async function leaveKitchen(userId: string): Promise<void> {
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user || !user.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchen = await Kitchen.findById(user.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  const isLead = kitchen.leadId.equals(userId);

  // Remove the user from the kitchen
  await User.updateOne(
    { _id: userId },
    { $unset: { kitchenId: 1 } }
  );

  // Remove user from permission arrays
  await Kitchen.updateOne(
    { _id: kitchen._id },
    {
      $pull: {
        membersWithScheduleEdit: new Types.ObjectId(userId),
        membersWithApprovalPower: new Types.ObjectId(userId),
      },
    }
  );

  if (kitchen.memberCount <= 1) {
    // Last member — delete the kitchen
    await Kitchen.findByIdAndDelete(kitchen._id);
    return;
  }

  // Decrement member count
  await Kitchen.updateOne(
    { _id: kitchen._id },
    { $inc: { memberCount: -1 } }
  );

  // If lead is leaving, auto-transfer to the longest-tenured member
  if (isLead) {
    const nextLead = await User.findOne({
      kitchenId: kitchen._id,
      _id: { $ne: new Types.ObjectId(userId) },
    })
      .sort({ createdAt: 1 })
      .select("_id")
      .lean();

    if (nextLead) {
      await Kitchen.updateOne(
        { _id: kitchen._id },
        { $set: { leadId: nextLead._id } }
      );
    }
  }
}

export async function removeMember(
  leadId: string,
  memberId: string
): Promise<void> {
  const lead = await User.findById(leadId).select("kitchenId").lean();
  if (!lead || !lead.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchen = await Kitchen.findById(lead.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!kitchen.leadId.equals(leadId)) {
    throw createError("Only the kitchen lead can remove members", 403);
  }

  if (leadId === memberId) {
    throw createError("Cannot remove yourself. Use leave instead.", 400);
  }

  const member = await User.findById(memberId).select("kitchenId").lean();
  if (!member || !member.kitchenId || !member.kitchenId.equals(kitchen._id)) {
    throw createError("User is not a member of this kitchen", 404);
  }

  await User.updateOne(
    { _id: memberId },
    { $unset: { kitchenId: 1 } }
  );

  await Kitchen.updateOne(
    { _id: kitchen._id },
    {
      $inc: { memberCount: -1 },
      $pull: {
        membersWithScheduleEdit: new Types.ObjectId(memberId),
        membersWithApprovalPower: new Types.ObjectId(memberId),
      },
    }
  );

  // Fire-and-forget notification
  notifyKitchenRemoved(memberId, kitchen._id.toString(), kitchen.name).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send kitchen_removed notification: ${msg}`);
    }
  );
}

export async function transferLead(
  currentLeadId: string,
  newLeadId: string
): Promise<IKitchen> {
  if (currentLeadId === newLeadId) {
    throw createError("Cannot transfer leadership to yourself", 400);
  }

  const lead = await User.findById(currentLeadId).select("kitchenId").lean();
  if (!lead || !lead.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchen = await Kitchen.findById(lead.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!kitchen.leadId.equals(currentLeadId)) {
    throw createError("Only the kitchen lead can transfer leadership", 403);
  }

  const newLead = await User.findById(newLeadId).select("kitchenId").lean();
  if (!newLead || !newLead.kitchenId || !newLead.kitchenId.equals(kitchen._id)) {
    throw createError("Target user is not a member of this kitchen", 404);
  }

  const updated = await Kitchen.findByIdAndUpdate(
    kitchen._id,
    { $set: { leadId: new Types.ObjectId(newLeadId) } },
    { new: true }
  );

  if (!updated) {
    throw createError("Kitchen not found", 404);
  }

  return updated;
}

export async function updatePermissions(
  leadId: string,
  permissions: {
    membersWithScheduleEdit?: string[];
    membersWithApprovalPower?: string[];
  }
): Promise<IKitchen> {
  const lead = await User.findById(leadId).select("kitchenId").lean();
  if (!lead || !lead.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchen = await Kitchen.findById(lead.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!kitchen.leadId.equals(leadId)) {
    throw createError("Only the kitchen lead can update permissions", 403);
  }

  // Verify all user IDs belong to actual kitchen members
  const allProvidedIds = [
    ...(permissions.membersWithScheduleEdit ?? []),
    ...(permissions.membersWithApprovalPower ?? []),
  ];

  if (allProvidedIds.length > 0) {
    const memberCount = await User.countDocuments({
      _id: { $in: allProvidedIds.map((id) => new Types.ObjectId(id)) },
      kitchenId: kitchen._id,
    });
    if (memberCount !== allProvidedIds.length) {
      throw createError("One or more users are not members of this kitchen", 400);
    }
  }

  const updateFields: Record<string, Types.ObjectId[]> = {};

  if (permissions.membersWithScheduleEdit !== undefined) {
    updateFields.membersWithScheduleEdit =
      permissions.membersWithScheduleEdit.map((id) => new Types.ObjectId(id));
  }

  if (permissions.membersWithApprovalPower !== undefined) {
    updateFields.membersWithApprovalPower =
      permissions.membersWithApprovalPower.map((id) => new Types.ObjectId(id));
  }

  const updated = await Kitchen.findByIdAndUpdate(
    kitchen._id,
    { $set: updateFields },
    { new: true }
  );

  if (!updated) {
    throw createError("Kitchen not found", 404);
  }

  return updated;
}

export async function regenerateInviteCode(
  userId: string
): Promise<IKitchen> {
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user || !user.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchen = await Kitchen.findById(user.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!kitchen.leadId.equals(userId)) {
    throw createError("Only the kitchen lead can regenerate the invite code", 403);
  }

  const newCode = await generateUniqueInviteCode();

  const updated = await Kitchen.findByIdAndUpdate(
    kitchen._id,
    { $set: { inviteCode: newCode } },
    { new: true }
  );

  if (!updated) {
    throw createError("Kitchen not found", 404);
  }

  return updated;
}

export async function getKitchenRecipes(
  kitchenId: string,
  page: number,
  limit: number,
  memberId?: string
): Promise<PaginatedRecipes> {
  const skip = (page - 1) * limit;
  const kitchenObjectId = new Types.ObjectId(kitchenId);
  const memberObjectId = memberId ? new Types.ObjectId(memberId) : null;

  // Get all members of this kitchen
  const memberIds = await User.find({ kitchenId: kitchenObjectId })
    .select("_id")
    .lean()
    .then((users) => users.map((u) => u._id));

  if (
    memberObjectId &&
    !memberIds.some((id) => id.toString() === memberObjectId.toString())
  ) {
    throw createError("Selected user is not a member of this kitchen", 400);
  }

  const filter = {
    authorId: memberObjectId ? memberObjectId : { $in: memberIds },
    isPrivate: false,
    isHidden: { $ne: true },
  };

  const [data, total] = await Promise.all([
    Recipe.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<IRecipe[]>(),
    Recipe.countDocuments(filter),
  ]);

  return {
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}
