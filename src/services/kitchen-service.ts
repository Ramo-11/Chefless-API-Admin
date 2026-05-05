import { Types } from "mongoose";
import { randomInt } from "crypto";
import Kitchen, { IKitchen } from "../models/Kitchen";
import User, { IUser } from "../models/User";
import Recipe, { IRecipe } from "../models/Recipe";
import ScheduleEntry, { IScheduleEntry } from "../models/ScheduleEntry";
import ShoppingList from "../models/ShoppingList";
import KitchenInvite, { IKitchenInvite } from "../models/KitchenInvite";
import RecipeRating from "../models/RecipeRating";
import {
  uploadImage,
  deleteImage,
  publicIdFromUrl,
} from "../lib/cloudinary";
import {
  notifyKitchenInviteWelcome,
  notifyKitchenJoined,
  notifyKitchenLeadTransferred,
  notifyKitchenRemoved,
  notifyKitchenInviteReceived,
  notifyKitchenInviteAccepted,
  notifyKitchenInviteDeclined,
} from "./notification-service";

// ── Lead-transfer warnings ─────────────────────────────────────────────
//
// Surfaced to admins so they can choose to override (e.g. demote a 5-member
// kitchen to a free lead, accepting the over-cap state). For user-initiated
// transfers any warning is a hard error — users can't override.
export type TransferLeadWarning =
  | { code: "OVER_CAPACITY"; memberCount: number; cap: number }
  | { code: "TARGET_BANNED" };

/**
 * Custom error class for admin-side transfer attempts that hit warnings.
 * The admin route maps this to a 409 with the structured warning list so
 * the UI can confirm-and-retry with `force=true`.
 */
export class TransferLeadWarningError extends Error {
  constructor(public readonly warnings: TransferLeadWarning[]) {
    super("Lead transfer has warnings");
    this.name = "TransferLeadWarningError";
  }
}

const FREE_TIER_MAX_MEMBERS = 2;

/** Regex for validating invite codes. Shared with route validation. */
export const INVITE_CODE_REGEX = /^CHEF-[A-Z0-9]{6}$/;

/**
 * How long a newly minted invite code is accepted by `joinKitchen`. After this
 * window the lead must call `regenerateInviteCode` to mint a fresh one. This
 * caps long-lived codes from floating around in group chats or email threads
 * forever and limits the window for brute-force guessing.
 */
const INVITE_CODE_TTL_DAYS = 30;

function nextInviteCodeExpiry(): Date {
  return new Date(Date.now() + INVITE_CODE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

interface ServiceError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): ServiceError {
  const error = new Error(message) as ServiceError;
  error.statusCode = statusCode;
  return error;
}

function generateInviteCode(): string {
  // Use crypto.randomInt so codes cannot be predicted by an attacker observing
  // timing or other state. Math.random is not cryptographically secure and must
  // never be used for security-relevant tokens like invite codes.
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "CHEF-";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(randomInt(0, chars.length));
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
    inviteCodeExpiresAt: nextInviteCodeExpiry(),
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
  updates: {
    name?: string;
    photo?: string;
    isPublic?: boolean;
    scheduleAddPolicy?: "lead_only" | "all";
    slotOrderEditPolicy?: "lead_only" | "editors" | "all";
    ratingsVisibility?: "public" | "kitchen_only" | "off";
    showMembersPublicly?: boolean;
    allowMemberSuggestions?: boolean;
    allowAutoScheduleSuggestions?: boolean;
  }
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
  if (updates.scheduleAddPolicy !== undefined) {
    updateFields.scheduleAddPolicy = updates.scheduleAddPolicy;
  }
  if (updates.slotOrderEditPolicy !== undefined) {
    updateFields.slotOrderEditPolicy = updates.slotOrderEditPolicy;
  }
  if (updates.ratingsVisibility !== undefined) {
    updateFields.ratingsVisibility = updates.ratingsVisibility;
  }
  if (updates.showMembersPublicly !== undefined) {
    updateFields.showMembersPublicly = updates.showMembersPublicly;
  }
  if (updates.allowMemberSuggestions !== undefined) {
    updateFields.allowMemberSuggestions = updates.allowMemberSuggestions;
  }
  if (updates.allowAutoScheduleSuggestions !== undefined) {
    updateFields.allowAutoScheduleSuggestions =
      updates.allowAutoScheduleSuggestions;
  }

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

/** Default meal slots present in every kitchen — mirrors the Flutter client. */
export const DEFAULT_MEAL_SLOTS: readonly string[] = [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
];

/** Defaults the lead has not hidden — subtract `hiddenDefaultSlots` from the canonical four. */
export function activeDefaultSlots(
  kitchen: Pick<IKitchen, "hiddenDefaultSlots">
): string[] {
  const hidden = new Set(
    (kitchen.hiddenDefaultSlots ?? []).map((s) => s.trim().toLowerCase())
  );
  return DEFAULT_MEAL_SLOTS.filter((d) => !hidden.has(d));
}

function hasSlotOrderEditPermission(
  userId: string,
  kitchen: Pick<
    IKitchen,
    "leadId" | "membersWithScheduleEdit" | "slotOrderEditPolicy"
  >
): boolean {
  if (kitchen.leadId.equals(userId)) return true;
  switch (kitchen.slotOrderEditPolicy) {
    case "all":
      // Any kitchen member — membership is enforced separately via kitchenId.
      return true;
    case "editors":
      return kitchen.membersWithScheduleEdit.some((id) => id.equals(userId));
    case "lead_only":
    default:
      return false;
  }
}

/**
 * Reorders the kitchen's meal slots. The submitted list must contain exactly
 * the same slots currently in use (defaults + customs) — same multiset,
 * possibly in a new order. Any addition/removal must go through the
 * custom-slots endpoint first so schedule entries can be cascade-handled.
 */
export async function updateMealSlotOrder(
  userId: string,
  submittedOrder: string[]
): Promise<IKitchen> {
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user || !user.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchen = await Kitchen.findById(user.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!hasSlotOrderEditPermission(userId, kitchen)) {
    throw createError(
      "You don't have permission to reorder this kitchen's meal slots",
      403
    );
  }

  const expected = [...activeDefaultSlots(kitchen), ...kitchen.customMealSlots];
  const normaliseKey = (s: string) => s.trim().toLowerCase();
  const expectedKeys = [...expected].map(normaliseKey).sort();
  const submittedKeys = [...submittedOrder].map(normaliseKey).sort();

  const sameSet =
    expectedKeys.length === submittedKeys.length &&
    expectedKeys.every((k, i) => k === submittedKeys[i]);

  if (!sameSet) {
    throw createError(
      "mealSlotOrder must contain exactly the kitchen's current slots",
      400
    );
  }

  // Persist in the exact casing the caller sent, so custom slots like
  // "Pre-Workout" keep their chosen display form.
  kitchen.mealSlotOrder = submittedOrder.map((s) => s.trim());
  await kitchen.save();

  return kitchen;
}

/**
 * Keeps `mealSlotOrder` in sync with a freshly-written `customMealSlots` list.
 * Called by the custom-slots PUT handler after the new list is saved. A no-op
 * for grandfathered kitchens (`mealSlotOrder == null`), so the fallback path
 * on the client keeps working.
 */
export async function syncMealSlotOrderWithCustomSlots(
  kitchenId: Types.ObjectId | string,
  newCustomSlots: string[]
): Promise<void> {
  const kitchen = await Kitchen.findById(kitchenId).select(
    "mealSlotOrder customMealSlots hiddenDefaultSlots"
  );
  if (!kitchen || !kitchen.mealSlotOrder) return;

  const lower = (s: string) => s.trim().toLowerCase();
  const customLowerToCased = new Map(newCustomSlots.map((s) => [lower(s), s]));
  const activeDefaultSet = new Set(activeDefaultSlots(kitchen).map(lower));

  const retained = kitchen.mealSlotOrder.filter((slot) => {
    const key = lower(slot);
    return activeDefaultSet.has(key) || customLowerToCased.has(key);
  });
  const retainedKeys = new Set(retained.map(lower));
  const appended = [...customLowerToCased.entries()]
    .filter(([key]) => !retainedKeys.has(key))
    .map(([, cased]) => cased);

  kitchen.mealSlotOrder = [...retained, ...appended];
  await kitchen.save();
}

/**
 * Result of [setHiddenDefaultSlots]. Mirrors the cascade-confirmation flow of
 * the custom-slots PUT handler: a `needsConfirmation` outcome lets the client
 * surface a count-aware warning before re-submitting with `force=true`.
 */
export type SetHiddenDefaultsResult =
  | { kind: "ok"; kitchen: IKitchen; deletedEntries: number; removedSlots: string[] }
  | {
      kind: "needs_confirmation";
      affectedCount: number;
      removedSlots: string[];
      affectedBySlot: Record<string, number>;
    };

/**
 * Replaces the kitchen's hidden-default-slot list (lead only). Members lose
 * access to the hidden defaults — the slot vanishes from the schedule grid,
 * the slot picker, and `mealSlotOrder` (kept in lockstep). Any schedule
 * entries planned in a slot being newly hidden cascade-delete on `force=true`.
 *
 * Unhiding a default is unconditional (no orphans to consider) and reuses this
 * same path with a shorter input list.
 */
export async function setHiddenDefaultSlots(
  userId: string,
  hiddenSlots: string[],
  options: { force?: boolean } = {}
): Promise<SetHiddenDefaultsResult> {
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user || !user.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchen = await Kitchen.findById(user.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!kitchen.leadId.equals(userId)) {
    throw createError("Only the kitchen lead can manage meal slots", 403);
  }

  const lower = (s: string) => s.trim().toLowerCase();
  const allowed = new Set(DEFAULT_MEAL_SLOTS.map(lower));
  const normalised = [
    ...new Set(hiddenSlots.map(lower).filter((s) => allowed.has(s))),
  ];

  // Slots becoming hidden in this call (i.e. not previously hidden) — those
  // are the ones whose schedule entries we may need to cascade-delete.
  const previouslyHidden = new Set(
    (kitchen.hiddenDefaultSlots ?? []).map(lower)
  );
  const newlyHidden = normalised.filter((s) => !previouslyHidden.has(s));

  let affectedCount = 0;
  const affectedBySlot: Record<string, number> = {};
  if (newlyHidden.length > 0) {
    for (const slot of newlyHidden) {
      const count = await ScheduleEntry.countDocuments({
        kitchenId: kitchen._id,
        // Schedule entries store mealSlot in canonical lowercase already, but
        // we match case-insensitively so legacy mixed-case data still cascades.
        mealSlot: { $regex: `^${slot}$`, $options: "i" },
      });
      affectedBySlot[slot] = count;
      affectedCount += count;
    }
  }

  if (affectedCount > 0 && options.force !== true) {
    return {
      kind: "needs_confirmation",
      affectedCount,
      removedSlots: newlyHidden,
      affectedBySlot,
    };
  }

  kitchen.hiddenDefaultSlots = normalised;
  await kitchen.save();

  // Drop the now-hidden defaults from `mealSlotOrder` if it's set, so the
  // ordered view doesn't render slots that no longer exist.
  await syncMealSlotOrderWithCustomSlots(
    kitchen._id,
    kitchen.customMealSlots
  );

  let deletedEntries = 0;
  if (newlyHidden.length > 0 && affectedCount > 0) {
    const deleteResult = await ScheduleEntry.deleteMany({
      kitchenId: kitchen._id,
      mealSlot: {
        $in: newlyHidden.map((s) => new RegExp(`^${s}$`, "i")),
      },
    });
    deletedEntries = deleteResult.deletedCount ?? 0;
  }

  const fresh = await Kitchen.findById(kitchen._id);
  if (!fresh) {
    throw createError("Kitchen not found", 404);
  }

  return {
    kind: "ok",
    kitchen: fresh,
    deletedEntries,
    removedSlots: newlyHidden,
  };
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
    KitchenInvite.deleteMany({
      kitchenId: kitchen._id,
      status: "pending",
    }),
  ]);

  // Clear kitchenId for all members
  await User.updateMany(
    { kitchenId: kitchen._id },
    { $unset: { kitchenId: 1 } }
  );

  // Destroy the Cloudinary asset (if any) before dropping the kitchen doc.
  // Fire-and-forget — `deleteImage` already swallows errors so an upstream
  // Cloudinary hiccup can't block the delete.
  if (kitchen.photo) {
    const publicId = publicIdFromUrl(kitchen.photo);
    if (publicId) {
      void deleteImage(publicId);
    }
  }

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

  // Invite codes expire 30 days after issue. Legacy kitchens created before
  // the expiry feature shipped have `inviteCodeExpiresAt` undefined and are
  // grandfathered through as non-expiring; new and regenerated codes always
  // have a concrete expiry.
  if (
    kitchen.inviteCodeExpiresAt &&
    kitchen.inviteCodeExpiresAt.getTime() < Date.now()
  ) {
    throw createError(
      "This invite code has expired. Ask the kitchen lead to share a fresh one.",
      410
    );
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

  // Passive cleanup: if the user had pending in-app invites to other kitchens
  // (or to this one), mark them as declined. No notifications are sent to the
  // original senders — the user chose a kitchen another way.
  await KitchenInvite.updateMany(
    {
      recipientId: new Types.ObjectId(userId),
      status: "pending",
    },
    { $set: { status: "declined" } }
  );

  notifyKitchenJoined(userId, kitchen._id.toString()).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send kitchen_joined notification: ${msg}`);
    }
  );

  notifyKitchenInviteWelcome(userId, kitchen._id.toString()).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send kitchen_invite notification: ${msg}`);
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

  // Cancel any pending invites this user sent — they can no longer vouch for a
  // kitchen they've left. Delete outright (not marked declined) because the
  // departure is a silent cancellation, not a recipient-side decision.
  await KitchenInvite.deleteMany({
    senderId: new Types.ObjectId(userId),
    kitchenId: kitchen._id,
    status: "pending",
  });

  // Silently drop any pending schedule suggestions this user left behind.
  // The suggester is no longer a member, so approving/denying would notify a
  // non-member — cleanest to delete and leave the approvers' queue clean.
  await ScheduleEntry.deleteMany({
    kitchenId: kitchen._id,
    suggestedBy: new Types.ObjectId(userId),
    status: "suggested",
  });

  if (kitchen.memberCount <= 1) {
    // Last member — delete the kitchen and drop any remaining pending invites.
    await KitchenInvite.deleteMany({
      kitchenId: kitchen._id,
      status: "pending",
    });
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

  // Silently drop any pending schedule suggestions this member left behind.
  await ScheduleEntry.deleteMany({
    kitchenId: kitchen._id,
    suggestedBy: new Types.ObjectId(memberId),
    status: "suggested",
  });

  // Fire-and-forget notification
  notifyKitchenRemoved(memberId, kitchen._id.toString(), kitchen.name).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send kitchen_removed notification: ${msg}`);
    }
  );
}

/**
 * Run all warning checks on a candidate lead transfer. Pure function — no
 * writes. Both the user path and the admin path call this; the user path
 * throws on any warning, the admin path may bypass with `force=true`.
 */
async function evaluateLeadTransferWarnings(
  kitchen: IKitchen,
  newLead: { _id: Types.ObjectId; isPremium: boolean; premiumExpiresAt?: Date | null; isBanned: boolean }
): Promise<TransferLeadWarning[]> {
  const warnings: TransferLeadWarning[] = [];

  if (newLead.isBanned) {
    warnings.push({ code: "TARGET_BANNED" });
  }

  // Member-cap regression: if the new lead doesn't carry premium, the kitchen
  // must already fit inside the free-tier cap or it'll silently violate its
  // own rule and block all future joins.
  const newLeadHasPremium =
    newLead.isPremium &&
    (!newLead.premiumExpiresAt || new Date(newLead.premiumExpiresAt) > new Date());
  if (!newLeadHasPremium && kitchen.memberCount > FREE_TIER_MAX_MEMBERS) {
    warnings.push({
      code: "OVER_CAPACITY",
      memberCount: kitchen.memberCount,
      cap: FREE_TIER_MAX_MEMBERS,
    });
  }

  return warnings;
}

/**
 * Atomic core of the transfer. Asserts the lead hasn't shifted under us,
 * cleans up the ex-lead's pending invites, and notifies the new lead.
 * Callers are responsible for all validation.
 */
async function performLeadTransfer(
  kitchenId: Types.ObjectId,
  currentLeadId: Types.ObjectId,
  newLeadId: Types.ObjectId
): Promise<IKitchen> {
  // Atomic conditional update: only transfer if `leadId` still equals the
  // pre-check value. If another request transferred or changed the lead in
  // the meantime, modifiedCount is 0 and we surface a 409 rather than
  // silently overwriting someone else's transfer.
  const result = await Kitchen.updateOne(
    { _id: kitchenId, leadId: currentLeadId },
    { $set: { leadId: newLeadId } }
  );

  if (result.modifiedCount === 0) {
    throw createError("Lead changed concurrently. Please refresh and try again.", 409);
  }

  // The ex-lead's pending invites should no longer carry their authority. Keep
  // them out of the recipient's inbox by deleting silently — the new lead can
  // re-invite anyone they want.
  await KitchenInvite.deleteMany({
    kitchenId,
    senderId: currentLeadId,
    status: "pending",
  });

  notifyKitchenLeadTransferred(
    newLeadId.toString(),
    kitchenId.toString(),
    currentLeadId.toString()
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`Failed to send kitchen_lead_transferred notification: ${msg}`);
  });

  const updated = await Kitchen.findById(kitchenId);
  if (!updated) {
    throw createError("Kitchen not found", 404);
  }
  return updated;
}

/**
 * User-facing transfer: the current lead promotes a member. Hard-fails on
 * any warning — users can't override over-capacity or hand the kitchen to
 * a banned account.
 */
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

  const newLead = await User.findById(newLeadId)
    .select("kitchenId isPremium premiumExpiresAt isBanned")
    .lean();
  if (!newLead || !newLead.kitchenId || !newLead.kitchenId.equals(kitchen._id)) {
    throw createError("Target user is not a member of this kitchen", 404);
  }

  const warnings = await evaluateLeadTransferWarnings(kitchen, {
    _id: newLead._id,
    isPremium: newLead.isPremium,
    premiumExpiresAt: newLead.premiumExpiresAt,
    isBanned: newLead.isBanned,
  });

  for (const w of warnings) {
    if (w.code === "OVER_CAPACITY") {
      throw createError(
        `This kitchen has ${w.memberCount} members. Free accounts can lead kitchens with up to ${w.cap} members. The new lead needs premium first.`,
        403
      );
    }
    if (w.code === "TARGET_BANNED") {
      throw createError("This member can't be made kitchen lead.", 403);
    }
  }

  return performLeadTransfer(
    kitchen._id,
    new Types.ObjectId(currentLeadId),
    new Types.ObjectId(newLeadId)
  );
}

/**
 * Admin transfer: bypasses the lead-authority check (admins act on the
 * kitchen directly) and surfaces warnings instead of throwing, so the
 * admin UI can confirm-and-retry with `force=true`.
 *
 * Returns the updated kitchen and the warnings that were active at the
 * time of the transfer (empty when forced through a clean state). Throws
 * `TransferLeadWarningError` when warnings are present and `force` is false.
 */
export async function adminTransferLead(
  kitchenId: string,
  newLeadId: string,
  opts: { force?: boolean } = {}
): Promise<{ kitchen: IKitchen; warnings: TransferLeadWarning[] }> {
  const kitchen = await Kitchen.findById(kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (kitchen.leadId.toString() === newLeadId) {
    throw createError("User is already the kitchen lead", 400);
  }

  const newLead = await User.findById(newLeadId)
    .select("kitchenId isPremium premiumExpiresAt isBanned")
    .lean();
  if (!newLead || !newLead.kitchenId || !newLead.kitchenId.equals(kitchen._id)) {
    throw createError("Target user is not a member of this kitchen", 404);
  }

  const warnings = await evaluateLeadTransferWarnings(kitchen, {
    _id: newLead._id,
    isPremium: newLead.isPremium,
    premiumExpiresAt: newLead.premiumExpiresAt,
    isBanned: newLead.isBanned,
  });

  if (warnings.length > 0 && !opts.force) {
    throw new TransferLeadWarningError(warnings);
  }

  const updated = await performLeadTransfer(
    kitchen._id,
    kitchen.leadId,
    new Types.ObjectId(newLeadId)
  );

  return { kitchen: updated, warnings };
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
    {
      $set: {
        inviteCode: newCode,
        inviteCodeExpiresAt: nextInviteCodeExpiry(),
      },
    },
    { new: true }
  );

  if (!updated) {
    throw createError("Kitchen not found", 404);
  }

  return updated;
}

// ─── Kitchen Invites (in-app) ────────────────────────────────────────────────

interface PopulatedKitchenInvite {
  _id: Types.ObjectId;
  kitchenId: Types.ObjectId;
  kitchenName: string;
  senderId: {
    _id: Types.ObjectId;
    fullName: string;
    profilePicture?: string;
  };
  recipientId: Types.ObjectId;
  status: "pending" | "accepted" | "declined";
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Check whether the kitchen has capacity for another member, taking the
 * lead's premium status into account. Throws the same 403 error as
 * `joinKitchen` so the user-facing message stays consistent.
 */
async function assertKitchenHasCapacity(
  kitchen: IKitchen
): Promise<void> {
  const lead = await User.findById(kitchen.leadId)
    .select("isPremium premiumExpiresAt")
    .lean();
  if (!lead) {
    throw createError("Kitchen lead not found", 404);
  }

  const leadHasPremium =
    lead.isPremium &&
    (!lead.premiumExpiresAt ||
      new Date(lead.premiumExpiresAt) > new Date());

  if (!leadHasPremium && kitchen.memberCount >= FREE_TIER_MAX_MEMBERS) {
    throw createError(
      "This kitchen has reached its maximum capacity. The kitchen lead needs to upgrade to premium.",
      403
    );
  }
}

export async function sendKitchenInvite(
  senderId: string,
  recipientUserId: string
): Promise<IKitchenInvite> {
  if (senderId === recipientUserId) {
    throw createError("You can't invite yourself.", 400);
  }

  const sender = await User.findById(senderId)
    .select("kitchenId isBanned")
    .lean();
  if (!sender || !sender.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }
  if (sender.isBanned) {
    throw createError("Your account cannot send invites.", 403);
  }

  const kitchen = await Kitchen.findById(sender.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  const recipient = await User.findById(recipientUserId)
    .select("kitchenId isBanned isSeed")
    .lean();
  if (!recipient) {
    throw createError("User not found", 404);
  }
  if (recipient.isBanned) {
    throw createError("This user cannot receive invites.", 400);
  }
  if (recipient.isSeed) {
    // Seed accounts have unusable Firebase UIDs, so they can never accept an
    // invite. Block here instead of leaving a pending invite hanging.
    throw createError("This user cannot receive invites.", 400);
  }
  if (recipient.kitchenId) {
    if (recipient.kitchenId.equals(kitchen._id)) {
      throw createError("This user is already in your kitchen.", 400);
    }
    throw createError("This user is already in another kitchen.", 400);
  }

  await assertKitchenHasCapacity(kitchen);

  const existingPending = await KitchenInvite.findOne({
    kitchenId: kitchen._id,
    recipientId: new Types.ObjectId(recipientUserId),
    status: "pending",
  }).lean();
  if (existingPending) {
    throw createError("You've already sent this user an invite.", 409);
  }

  let invite: IKitchenInvite;
  try {
    invite = await KitchenInvite.create({
      kitchenId: kitchen._id,
      kitchenName: kitchen.name,
      senderId: new Types.ObjectId(senderId),
      recipientId: new Types.ObjectId(recipientUserId),
      status: "pending",
    });
  } catch (err: unknown) {
    // Race condition: the unique partial index on
    // `{kitchenId, recipientId, status:"pending"}` rejected a duplicate that
    // slipped past the pre-check above. Surface a friendly 409 instead of a
    // raw Mongo error.
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw createError("You've already sent this user an invite.", 409);
    }
    throw err;
  }

  // Fire-and-forget push + in-app notification.
  notifyKitchenInviteReceived(
    senderId,
    recipientUserId,
    kitchen._id.toString(),
    invite._id.toString()
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`Failed to send kitchen_invite_received notification: ${msg}`);
  });

  return invite;
}

export async function acceptKitchenInvite(
  userId: string,
  inviteId: string
): Promise<{ kitchen: IKitchen }> {
  const invite = await KitchenInvite.findById(inviteId);
  if (!invite) {
    throw createError("Invite not found", 404);
  }

  if (!invite.recipientId.equals(userId)) {
    throw createError("This invite is not for you", 403);
  }

  if (invite.status !== "pending") {
    throw createError("This invite is no longer pending.", 409);
  }

  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user) {
    throw createError("User not found", 404);
  }
  if (user.kitchenId) {
    throw createError("You must leave your current kitchen first", 400);
  }

  const kitchen = await Kitchen.findById(invite.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen no longer exists", 404);
  }

  await assertKitchenHasCapacity(kitchen);

  // Move the user into the kitchen and mark the invite accepted.
  await User.updateOne(
    { _id: userId },
    { $set: { kitchenId: kitchen._id } }
  );

  const updatedKitchen = await Kitchen.findByIdAndUpdate(
    kitchen._id,
    { $inc: { memberCount: 1 } },
    { new: true }
  );
  if (!updatedKitchen) {
    throw createError("Kitchen not found", 404);
  }

  invite.status = "accepted";
  await invite.save();

  // Auto-decline any other pending invites for this recipient — they can
  // only be in one kitchen at a time.
  await KitchenInvite.updateMany(
    {
      recipientId: new Types.ObjectId(userId),
      status: "pending",
      _id: { $ne: invite._id },
    },
    { $set: { status: "declined" } }
  );

  // Notify the original sender.
  notifyKitchenInviteAccepted(
    userId,
    kitchen._id.toString(),
    invite.senderId.toString()
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `Failed to send kitchen_invite_accepted notification: ${msg}`
    );
  });

  // If the sender is the lead, the "invite accepted" receipt already informs
  // them. Skip the generic kitchen_joined duplicate in that case.
  if (!kitchen.leadId.equals(invite.senderId)) {
    notifyKitchenJoined(userId, kitchen._id.toString()).catch(
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`Failed to send kitchen_joined notification: ${msg}`);
      }
    );
  }

  return { kitchen: updatedKitchen };
}

export async function declineKitchenInvite(
  userId: string,
  inviteId: string
): Promise<{ success: true }> {
  const invite = await KitchenInvite.findById(inviteId);
  if (!invite) {
    throw createError("Invite not found", 404);
  }

  if (!invite.recipientId.equals(userId)) {
    throw createError("This invite is not for you", 403);
  }

  if (invite.status !== "pending") {
    throw createError("This invite is no longer pending.", 409);
  }

  invite.status = "declined";
  await invite.save();

  notifyKitchenInviteDeclined(
    userId,
    invite.kitchenId.toString(),
    invite.senderId.toString()
  ).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `Failed to send kitchen_invite_declined notification: ${msg}`
    );
  });

  return { success: true };
}

export async function listPendingInvitesForRecipient(
  userId: string
): Promise<PopulatedKitchenInvite[]> {
  const invites = await KitchenInvite.find({
    recipientId: new Types.ObjectId(userId),
    status: "pending",
  })
    .sort({ createdAt: -1 })
    .populate<{
      senderId: {
        _id: Types.ObjectId;
        fullName: string;
        profilePicture?: string;
      };
    }>("senderId", "fullName profilePicture")
    .lean<PopulatedKitchenInvite[]>();

  return invites;
}

export async function cancelKitchenInvite(
  senderId: string,
  inviteId: string
): Promise<void> {
  const invite = await KitchenInvite.findById(inviteId);
  if (!invite) {
    throw createError("Invite not found", 404);
  }

  if (!invite.senderId.equals(senderId)) {
    throw createError("Only the sender can cancel this invite", 403);
  }

  if (invite.status !== "pending") {
    throw createError("This invite is no longer pending.", 409);
  }

  await KitchenInvite.deleteOne({ _id: invite._id });
}

/**
 * Returns shared (non-private) recipes by active members of this kitchen.
 *
 * Visibility rules (per ARCHITECTURE.md):
 * - Co-members can see each other's **shared** recipes regardless of the
 *   author's account privacy (kitchen membership grants implicit recipe-level
 *   visibility).
 * - Private recipes are NEVER included — they remain invisible even to
 *   fellow kitchen members.
 * - Hidden recipes (moderated) and recipes by banned authors are excluded.
 * - When a specific `memberId` is requested, it must be a current member;
 *   otherwise the caller gets 400.
 */
export async function getKitchenRecipes(
  kitchenId: string,
  page: number,
  limit: number,
  memberId?: string
): Promise<PaginatedRecipes> {
  const skip = (page - 1) * limit;
  const kitchenObjectId = new Types.ObjectId(kitchenId);
  const memberObjectId = memberId ? new Types.ObjectId(memberId) : null;

  // Get all non-banned members of this kitchen. Banned members' recipes must
  // be filtered out: the existing recipe model has `isHidden` which admins use
  // to hide individual content, but a banned-author filter needs to happen at
  // the author layer.
  const activeMembers = await User.find({
    kitchenId: kitchenObjectId,
    isBanned: { $ne: true },
  })
    .select("_id")
    .lean();
  const memberIds = activeMembers.map((u) => u._id);

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

// ── Public kitchen discovery ───────────────────────────────────────────────

export interface PublicKitchenView {
  kitchen: IKitchen;
  members: KitchenMember[] | null;
  memberCount: number;
  isMember: boolean;
  isLead: boolean;
  lead: KitchenMember | null;
}

/**
 * Returns the discoverable representation of a kitchen for any signed-in user.
 *
 * Visibility rules:
 * - If `isPublic` is true, anyone can see name/photo/memberCount/lead.
 *   Members are exposed only when `showMembersPublicly` is true.
 * - If `isPublic` is false, the only viewer allowed through is an actual
 *   kitchen member; everyone else gets 404.
 *
 * The `isMember` / `isLead` booleans let the client decide whether to show
 * member-only affordances (ratings history, schedule edits, etc.) without a
 * second round-trip.
 */
export async function getPublicKitchen(
  viewerId: string,
  kitchenId: string
): Promise<PublicKitchenView> {
  if (!Types.ObjectId.isValid(kitchenId)) {
    throw createError("Invalid kitchen id", 400);
  }

  const kitchen = await Kitchen.findById(kitchenId);
  if (!kitchen) throw createError("Kitchen not found", 404);

  const viewer = await User.findById(viewerId).select("kitchenId").lean();
  const isMember = !!viewer?.kitchenId && viewer.kitchenId.equals(kitchen._id);
  const isLead = kitchen.leadId.equals(viewerId);

  if (!kitchen.isPublic && !isMember) {
    // Preserve privacy — a private kitchen should be indistinguishable from
    // a non-existent one to non-members.
    throw createError("Kitchen not found", 404);
  }

  const leadUser = await User.findById(kitchen.leadId)
    .select("fullName profilePicture recipesCount")
    .lean<KitchenMember | null>();

  const canSeeMembers = isMember || kitchen.showMembersPublicly;
  let members: KitchenMember[] | null = null;

  if (canSeeMembers) {
    members = await User.find({ kitchenId: kitchen._id })
      .select("fullName profilePicture recipesCount")
      .lean<KitchenMember[]>();
  }

  return {
    kitchen,
    members,
    memberCount: kitchen.memberCount,
    isMember,
    isLead,
    lead: leadUser,
  };
}

/**
 * Returns upcoming + recent schedule entries for a kitchen's public view.
 *
 * Window: 7 days back through 21 days forward — enough to convey cadence to a
 * curious non-member without dumping the kitchen's entire history. Respects
 * the same visibility gate as `getPublicKitchen`.
 */
export async function getPublicKitchenSchedule(
  viewerId: string,
  kitchenId: string
): Promise<IScheduleEntry[]> {
  if (!Types.ObjectId.isValid(kitchenId)) {
    throw createError("Invalid kitchen id", 400);
  }

  const kit = await Kitchen.findById(kitchenId)
    .select("isPublic")
    .lean();
  if (!kit) throw createError("Kitchen not found", 404);

  const viewer = await User.findById(viewerId).select("kitchenId").lean();
  const isMember =
    !!viewer?.kitchenId && viewer.kitchenId.equals(new Types.ObjectId(kitchenId));

  if (!kit.isPublic && !isMember) {
    throw createError("Kitchen not found", 404);
  }

  const now = stripToUtcDay(new Date());
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 7);
  const to = new Date(now);
  to.setUTCDate(to.getUTCDate() + 21);

  // Only confirmed entries in the public view — pending suggestions are
  // internal to the kitchen and shouldn't leak to curious onlookers.
  const baseStatusFilter = isMember
    ? { status: { $in: ["confirmed", "suggested"] } }
    : { status: "confirmed" };

  const entries = await ScheduleEntry.find({
    kitchenId: new Types.ObjectId(kitchenId),
    date: { $gte: from, $lte: to },
    ...baseStatusFilter,
  })
    .sort({ date: 1 })
    .lean<IScheduleEntry[]>();

  return entries;
}

/**
 * Returns recipes discoverable through a public kitchen view. Same visibility
 * gate as `getPublicKitchen`. For members this delegates to the existing
 * `getKitchenRecipes`; for non-members we also limit to non-private recipes
 * authored by members of this specific kitchen.
 */
export async function getPublicKitchenRecipes(
  viewerId: string,
  kitchenId: string,
  page: number,
  limit: number
): Promise<PaginatedRecipes> {
  if (!Types.ObjectId.isValid(kitchenId)) {
    throw createError("Invalid kitchen id", 400);
  }

  const kit = await Kitchen.findById(kitchenId)
    .select("isPublic")
    .lean();
  if (!kit) throw createError("Kitchen not found", 404);

  const viewer = await User.findById(viewerId).select("kitchenId").lean();
  const isMember =
    !!viewer?.kitchenId && viewer.kitchenId.equals(new Types.ObjectId(kitchenId));

  if (!kit.isPublic && !isMember) {
    throw createError("Kitchen not found", 404);
  }

  return getKitchenRecipes(kitchenId, page, limit);
}

function stripToUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

// ── Kitchen ratings history ────────────────────────────────────────────────

export interface KitchenRatingHistoryItem {
  _id: string;
  recipeId: string;
  recipeTitle: string;
  recipePhoto: string | null;
  stars: number;
  note: string | null;
  cookedAt: Date;
  ratedAt: Date;
  rater: {
    _id: string;
    fullName: string;
    profilePicture: string | null;
  };
}

export interface KitchenRatingHistoryPage {
  items: KitchenRatingHistoryItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  /** Average stars across every rating in the kitchen — not just this page. */
  avg: number;
}

/**
 * Returns every rating recorded by members of the viewer's kitchen. Members-
 * only view: non-members throw 403. Joined against Recipe (title/photo) and
 * User (rater name/avatar) once so the client renders in one pass.
 */
export async function getKitchenRatingsHistory(
  userId: string,
  page: number,
  limit: number
): Promise<KitchenRatingHistoryPage> {
  const viewer = await User.findById(userId).select("kitchenId").lean();
  if (!viewer?.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchenId = viewer.kitchenId;
  const skip = (page - 1) * limit;

  const [raw, total, avgRow] = await Promise.all([
    RecipeRating.aggregate([
      { $match: { kitchenId } },
      { $sort: { ratedAt: -1 as const } },
      { $skip: skip },
      { $limit: limit },
      {
        $lookup: {
          from: "recipes",
          localField: "recipeId",
          foreignField: "_id",
          as: "_recipe",
          pipeline: [{ $project: { title: 1, photos: 1 } }],
        },
      },
      { $unwind: { path: "$_recipe", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "_user",
          pipeline: [{ $project: { fullName: 1, profilePicture: 1 } }],
        },
      },
      { $unwind: { path: "$_user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          stars: 1,
          note: 1,
          cookedAt: 1,
          ratedAt: 1,
          recipeId: 1,
          "_recipe.title": 1,
          "_recipe.photos": 1,
          "_user._id": 1,
          "_user.fullName": 1,
          "_user.profilePicture": 1,
        },
      },
    ]),
    RecipeRating.countDocuments({ kitchenId }),
    // Whole-kitchen average so the hub shows a stable figure even when the
    // user has thousands of ratings and we're only paginating the first
    // chunk. Runs in parallel with the list + count queries.
    RecipeRating.aggregate([
      { $match: { kitchenId } },
      { $group: { _id: null, avg: { $avg: "$stars" } } },
    ]),
  ]);
  const avgRaw = (avgRow[0] as { avg?: number } | undefined)?.avg;
  const avg = avgRaw ? Number(avgRaw.toFixed(2)) : 0;

  interface RawRow {
    _id: Types.ObjectId;
    recipeId: Types.ObjectId;
    stars: number;
    note?: string;
    cookedAt: Date;
    ratedAt: Date;
    _recipe?: { title?: string; photos?: string[] };
    _user?: {
      _id: Types.ObjectId;
      fullName?: string;
      profilePicture?: string;
    };
  }

  const items: KitchenRatingHistoryItem[] = (raw as RawRow[]).map((r) => ({
    _id: r._id.toString(),
    recipeId: r.recipeId.toString(),
    recipeTitle: r._recipe?.title ?? "Untitled recipe",
    recipePhoto: r._recipe?.photos?.[0] ?? null,
    stars: r.stars,
    note: r.note ?? null,
    cookedAt: r.cookedAt,
    ratedAt: r.ratedAt,
    rater: {
      _id: r._user?._id?.toString() ?? "",
      fullName: r._user?.fullName ?? "A kitchen member",
      profilePicture: r._user?.profilePicture ?? null,
    },
  }));

  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    avg,
  };
}

// ── Kitchen photo lifecycle ─────────────────────────────────────────────────

/**
 * Uploads a base64 data URI to Cloudinary under a kitchen-scoped folder and
 * updates `Kitchen.photo`. If the kitchen already has a photo, the previous
 * Cloudinary asset is destroyed first so the account doesn't accrete orphans
 * across every re-upload.
 *
 * Lead-only. A non-lead member calling this throws 403.
 */
export async function uploadKitchenPhoto(
  userId: string,
  dataUri: string
): Promise<IKitchen> {
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user?.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchen = await Kitchen.findById(user.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!kitchen.leadId.equals(userId)) {
    throw createError(
      "Only the kitchen lead can update the kitchen photo",
      403
    );
  }

  // Upload first; only mutate the kitchen doc once Cloudinary confirms the
  // new asset exists. If the upload throws we never end up in a "photo field
  // points to nothing" state.
  const result = await uploadImage(
    dataUri,
    `kitchens/${kitchen._id.toString()}/photos`
  );

  const previousPhoto = kitchen.photo;

  const updated = await Kitchen.findByIdAndUpdate(
    kitchen._id,
    { $set: { photo: result.secureUrl } },
    { new: true }
  );

  if (!updated) {
    throw createError("Kitchen not found", 404);
  }

  // Best-effort cleanup of the superseded asset. `deleteImage` already
  // swallows Cloudinary errors so a failed delete doesn't break the user
  // flow — we just log and move on.
  if (previousPhoto) {
    const prevPublicId = publicIdFromUrl(previousPhoto);
    if (prevPublicId) {
      void deleteImage(prevPublicId);
    }
  }

  return updated;
}

/**
 * Removes the kitchen photo and destroys the Cloudinary asset. Idempotent —
 * returns the current kitchen even when there's no photo to remove. Lead-only.
 */
export async function deleteKitchenPhoto(userId: string): Promise<IKitchen> {
  const user = await User.findById(userId).select("kitchenId").lean();
  if (!user?.kitchenId) {
    throw createError("You are not in a kitchen", 400);
  }

  const kitchen = await Kitchen.findById(user.kitchenId);
  if (!kitchen) {
    throw createError("Kitchen not found", 404);
  }

  if (!kitchen.leadId.equals(userId)) {
    throw createError(
      "Only the kitchen lead can remove the kitchen photo",
      403
    );
  }

  const previousPhoto = kitchen.photo;

  const updated = await Kitchen.findByIdAndUpdate(
    kitchen._id,
    { $unset: { photo: 1 } },
    { new: true }
  );

  if (!updated) {
    throw createError("Kitchen not found", 404);
  }

  if (previousPhoto) {
    const prevPublicId = publicIdFromUrl(previousPhoto);
    if (prevPublicId) {
      void deleteImage(prevPublicId);
    }
  }

  return updated;
}

/**
 * Admin helper: remove the photo on any kitchen by id, bypassing lead
 * ownership. Used by moderation when a photo violates policy. Idempotent.
 */
export async function adminDeleteKitchenPhoto(
  kitchenId: string
): Promise<IKitchen | null> {
  if (!Types.ObjectId.isValid(kitchenId)) return null;
  const kitchen = await Kitchen.findById(kitchenId);
  if (!kitchen) return null;

  const previousPhoto = kitchen.photo;
  const updated = await Kitchen.findByIdAndUpdate(
    kitchen._id,
    { $unset: { photo: 1 } },
    { new: true }
  );

  if (previousPhoto) {
    const prevPublicId = publicIdFromUrl(previousPhoto);
    if (prevPublicId) {
      void deleteImage(prevPublicId);
    }
  }

  return updated;
}
