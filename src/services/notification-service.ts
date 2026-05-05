import { Types } from "mongoose";
import Notification, {
  INotification,
  NotificationType,
} from "../models/Notification";
import User, { NotificationPreferences } from "../models/User";
import Recipe from "../models/Recipe";
import Kitchen from "../models/Kitchen";
import ScheduleEntry from "../models/ScheduleEntry";
import { sendPushNotification } from "../lib/fcm";

// --- Types ---

interface CreateNotificationParams {
  userId: Types.ObjectId;
  type: NotificationType;
  actorId?: Types.ObjectId;
  actorName?: string;
  actorPhoto?: string;
  recipeId?: Types.ObjectId;
  recipeTitle?: string;
  shareMessage?: string;
  kitchenId?: Types.ObjectId;
  kitchenName?: string;
  scheduleEntryId?: Types.ObjectId;
  inviteId?: Types.ObjectId;
  pushTitle?: string;
  pushBody?: string;
}

interface PaginatedNotifications {
  data: INotification[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// --- Helpers ---

/**
 * Returns the in-app deep-link route that best matches a notification type,
 * so the Flutter client can navigate directly when the notification is tapped.
 */
function deriveRouteForType(params: CreateNotificationParams): string | null {
  switch (params.type) {
    case "recipe_liked":
    case "recipe_forked":
    case "recipe_saved":
    case "recipe_shared":
    case "recipe_cooked":
      return params.recipeId ? `/recipe/${params.recipeId}` : null;
    case "cooked_post_removed":
      return params.recipeId ? `/recipe/${params.recipeId}` : "/notifications";
    case "passport_stamp":
      return "/passport";
    case "new_follower":
    case "follow_request":
    case "follow_accepted":
      return params.actorId ? `/user/${params.actorId}` : null;
    case "schedule_suggestion":
      // Approver-facing — land them on the exact schedule day/slot when we
      // have the entry id, otherwise fall back to the pending list.
      return params.scheduleEntryId
        ? `/schedule?suggestionId=${params.scheduleEntryId}`
        : "/schedule/suggestions";
    case "suggestion_approved":
    case "suggestion_denied":
      // Suggester-facing — land them on the exact entry on the schedule.
      return params.scheduleEntryId
        ? `/schedule?entryId=${params.scheduleEntryId}`
        : "/schedule";
    case "kitchen_joined":
    case "kitchen_invite":
    case "kitchen_removed":
    case "kitchen_invite_accepted":
    case "kitchen_lead_transferred":
      // Accepting lands the user in the kitchen screen; the sender tapping
      // the "accepted" receipt also wants the kitchen view.
      return "/kitchen";
    case "kitchen_invite_received":
    case "kitchen_invite_declined":
      // Received invites host Accept/Decline inline; decline receipts have
      // no dedicated screen. Both route to the notifications feed.
      return "/notifications";
    default:
      return "/notifications";
  }
}

// --- Core Functions ---

/**
 * Create a notification document and send a push notification if the user has an FCM token.
 * Respects user notification preferences — if the type is disabled, neither the
 * in-app notification nor the push is created.
 * Push failures are logged but never thrown.
 */
export async function createNotification(
  params: CreateNotificationParams
): Promise<INotification | null> {
  // Single query to check preferences and get FCM token
  const user = await User.findById(params.userId)
    .select("notificationPreferences fcmToken")
    .lean();

  // Check user's notification preferences before creating
  if (user?.notificationPreferences) {
    const prefs = user.notificationPreferences as NotificationPreferences;
    if (prefs[params.type] === false) return null;
  }

  const notification = await Notification.create({
    userId: params.userId,
    type: params.type,
    actorId: params.actorId,
    actorName: params.actorName,
    actorPhoto: params.actorPhoto,
    recipeId: params.recipeId,
    recipeTitle: params.recipeTitle,
    shareMessage: params.shareMessage,
    kitchenId: params.kitchenId,
    kitchenName: params.kitchenName,
    scheduleEntryId: params.scheduleEntryId,
    inviteId: params.inviteId,
  });

  // Send push notification if user has an FCM token
  if (params.pushTitle && params.pushBody && user?.fcmToken) {
    const pushData: Record<string, string> = {
      notificationId: notification._id.toString(),
      type: params.type,
    };

    if (params.recipeId) {
      pushData.recipeId = params.recipeId.toString();
    }
    if (params.shareMessage) {
      pushData.shareMessage = params.shareMessage;
    }
    if (params.actorId) {
      pushData.actorId = params.actorId.toString();
    }
    if (params.kitchenId) {
      pushData.kitchenId = params.kitchenId.toString();
    }
    if (params.scheduleEntryId) {
      pushData.scheduleEntryId = params.scheduleEntryId.toString();
    }
    if (params.inviteId) {
      pushData.inviteId = params.inviteId.toString();
    }

    // Compute a `route` field so the Flutter app can deep-link directly
    // to the relevant screen when the notification is tapped.
    const route = deriveRouteForType(params);
    if (route) {
      pushData.route = route;
    }

    sendPushNotification(
      user.fcmToken,
      params.pushTitle,
      params.pushBody,
      pushData
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Push notification failed: ${msg}`);
    });
  }

  return notification;
}

export async function getNotifications(
  userId: string,
  page: number,
  limit: number
): Promise<PaginatedNotifications> {
  const skip = (page - 1) * limit;
  const objectId = new Types.ObjectId(userId);

  const [data, total] = await Promise.all([
    Notification.find({ userId: objectId })
      .sort({ isRead: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<INotification[]>(),
    Notification.countDocuments({ userId: objectId }),
  ]);

  return {
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

export async function markAsRead(
  userId: string,
  notificationIds: string[]
): Promise<number> {
  const objectId = new Types.ObjectId(userId);
  const ids = notificationIds.map((id) => new Types.ObjectId(id));

  const result = await Notification.updateMany(
    { _id: { $in: ids }, userId: objectId },
    { $set: { isRead: true } }
  );

  return result.modifiedCount;
}

export async function markAllAsRead(userId: string): Promise<number> {
  const objectId = new Types.ObjectId(userId);

  const result = await Notification.updateMany(
    { userId: objectId, isRead: false },
    { $set: { isRead: true } }
  );

  return result.modifiedCount;
}

export async function clearNotifications(
  userId: string,
  notificationIds?: string[]
): Promise<number> {
  const objectId = new Types.ObjectId(userId);
  const query: Record<string, unknown> = { userId: objectId };

  if (notificationIds && notificationIds.length > 0) {
    query._id = {
      $in: notificationIds.map((id) => new Types.ObjectId(id)),
    };
  }

  const result = await Notification.deleteMany(query);
  return result.deletedCount ?? 0;
}

export async function getUnreadCount(userId: string): Promise<number> {
  const objectId = new Types.ObjectId(userId);
  return Notification.countDocuments({ userId: objectId, isRead: false });
}

// --- Helper: load actor data ---

async function getActorData(
  actorId: string
): Promise<{ _id: Types.ObjectId; fullName: string; profilePicture?: string } | null> {
  return User.findById(actorId)
    .select("fullName profilePicture")
    .lean<{ _id: Types.ObjectId; fullName: string; profilePicture?: string }>();
}

// --- Notification Helpers ---

export async function notifyNewFollower(
  followerId: string,
  targetId: string
): Promise<void> {
  if (followerId === targetId) return;

  const actor = await getActorData(followerId);
  if (!actor) return;

  await createNotification({
    userId: new Types.ObjectId(targetId),
    type: "new_follower",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    pushTitle: "New Follower",
    pushBody: `${actor.fullName} started following you.`,
  });
}

export async function notifyFollowRequest(
  followerId: string,
  targetId: string
): Promise<void> {
  if (followerId === targetId) return;

  const actor = await getActorData(followerId);
  if (!actor) return;

  await createNotification({
    userId: new Types.ObjectId(targetId),
    type: "follow_request",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    pushTitle: "Follow Request",
    pushBody: `${actor.fullName} wants to follow you.`,
  });
}

export async function notifyFollowAccepted(
  userId: string,
  requesterId: string
): Promise<void> {
  if (userId === requesterId) return;

  const actor = await getActorData(userId);
  if (!actor) return;

  await createNotification({
    userId: new Types.ObjectId(requesterId),
    type: "follow_accepted",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    pushTitle: "Follow Request Accepted",
    pushBody: `${actor.fullName} accepted your follow request.`,
  });
}

export async function notifyRecipeLiked(
  likerId: string,
  recipeId: string
): Promise<void> {
  const recipe = await Recipe.findById(recipeId)
    .select("authorId title")
    .lean();
  if (!recipe) return;

  if (likerId === recipe.authorId.toString()) return;

  const actor = await getActorData(likerId);
  if (!actor) return;

  await createNotification({
    userId: recipe.authorId,
    type: "recipe_liked",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    recipeId: new Types.ObjectId(recipeId),
    recipeTitle: recipe.title,
    pushTitle: "Recipe Liked",
    pushBody: `${actor.fullName} liked your recipe "${recipe.title}".`,
  });
}

export async function notifyRecipeSaved(
  saverId: string,
  recipeId: string
): Promise<void> {
  const recipe = await Recipe.findById(recipeId)
    .select("authorId title")
    .lean();
  if (!recipe) return;

  if (saverId === recipe.authorId.toString()) return;

  const actor = await getActorData(saverId);
  if (!actor) return;

  await createNotification({
    userId: recipe.authorId,
    type: "recipe_saved",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    recipeId: new Types.ObjectId(recipeId),
    recipeTitle: recipe.title,
    pushTitle: "Recipe Saved",
    pushBody: `${actor.fullName} saved your recipe "${recipe.title}".`,
  });
}

export async function notifyRecipeForked(
  forkerId: string,
  recipeId: string
): Promise<void> {
  const recipe = await Recipe.findById(recipeId)
    .select("authorId title")
    .lean();
  if (!recipe) return;

  if (forkerId === recipe.authorId.toString()) return;

  const actor = await getActorData(forkerId);
  if (!actor) return;

  await createNotification({
    userId: recipe.authorId,
    type: "recipe_forked",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    recipeId: new Types.ObjectId(recipeId),
    recipeTitle: recipe.title,
    pushTitle: "Recipe remixed",
    pushBody: `${actor.fullName} remixed your recipe "${recipe.title}".`,
  });
}

export async function notifyRecipeShared(
  senderId: string,
  recipientId: string,
  recipeId: string,
  shareMessage?: string
): Promise<void> {
  if (senderId === recipientId) return;

  const [actor, recipe] = await Promise.all([
    getActorData(senderId),
    Recipe.findById(recipeId).select("title").lean(),
  ]);
  if (!actor || !recipe) return;

  const trimmedShareMessage = shareMessage?.trim();
  const shareMessagePreview =
    trimmedShareMessage && trimmedShareMessage.length > 120
      ? `${trimmedShareMessage.slice(0, 117)}...`
      : trimmedShareMessage;

  await createNotification({
    userId: new Types.ObjectId(recipientId),
    type: "recipe_shared",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    recipeId: new Types.ObjectId(recipeId),
    recipeTitle: recipe.title,
    shareMessage: trimmedShareMessage,
    pushTitle: "Recipe Shared",
    pushBody: shareMessagePreview
      ? `${actor.fullName} shared "${recipe.title}" with you: "${shareMessagePreview}"`
      : `${actor.fullName} shared a recipe with you: "${recipe.title}".`,
  });
}

export async function notifyScheduleSuggestion(
  suggesterId: string,
  kitchenId: string,
  entryId: string
): Promise<void> {
  const [actor, kitchen] = await Promise.all([
    getActorData(suggesterId),
    Kitchen.findById(kitchenId).select("leadId membersWithApprovalPower name").lean(),
  ]);
  if (!actor || !kitchen) return;

  // Notify the lead and all members with approval power (except the suggester)
  const approverIds = new Set<string>();
  approverIds.add(kitchen.leadId.toString());
  for (const id of kitchen.membersWithApprovalPower) {
    approverIds.add(id.toString());
  }
  approverIds.delete(suggesterId);

  const promises = Array.from(approverIds).map((approverId) =>
    createNotification({
      userId: new Types.ObjectId(approverId),
      type: "schedule_suggestion",
      actorId: actor._id,
      actorName: actor.fullName,
      actorPhoto: actor.profilePicture,
      kitchenId: new Types.ObjectId(kitchenId),
      kitchenName: kitchen.name,
      scheduleEntryId: new Types.ObjectId(entryId),
      pushTitle: "New Meal Suggestion",
      pushBody: `${actor.fullName} suggested a meal in ${kitchen.name}.`,
    })
  );

  await Promise.all(promises);
}

/**
 * Notify the lead and all approvers when a member imports their personal
 * schedule into the kitchen under `lead_only` policy. A single aggregate
 * notification per approver rather than one per entry to avoid spam.
 */
export async function notifyScheduleImportSuggestions(
  suggesterId: string,
  kitchenId: string,
  count: number
): Promise<void> {
  if (count <= 0) return;

  const [actor, kitchen] = await Promise.all([
    getActorData(suggesterId),
    Kitchen.findById(kitchenId).select("leadId membersWithApprovalPower name").lean(),
  ]);
  if (!actor || !kitchen) return;

  const approverIds = new Set<string>();
  approverIds.add(kitchen.leadId.toString());
  for (const id of kitchen.membersWithApprovalPower) {
    approverIds.add(id.toString());
  }
  approverIds.delete(suggesterId);

  const mealWord = count === 1 ? "meal" : "meals";
  const promises = Array.from(approverIds).map((approverId) =>
    createNotification({
      userId: new Types.ObjectId(approverId),
      type: "schedule_suggestion",
      actorId: actor._id,
      actorName: actor.fullName,
      actorPhoto: actor.profilePicture,
      kitchenId: new Types.ObjectId(kitchenId),
      kitchenName: kitchen.name,
      pushTitle: "New Meal Suggestions",
      pushBody:
        `${actor.fullName} imported ${count} ${mealWord} as suggestions in ${kitchen.name}.`,
    })
  );

  await Promise.all(promises);
}

export async function notifySuggestionApproved(
  entryId: string
): Promise<void> {
  const entry = await ScheduleEntry.findById(entryId).lean();
  if (!entry || !entry.suggestedBy) return;

  const kitchen = await Kitchen.findById(entry.kitchenId)
    .select("name")
    .lean();
  if (!kitchen) return;

  await createNotification({
    userId: entry.suggestedBy,
    type: "suggestion_approved",
    kitchenId: entry.kitchenId,
    kitchenName: kitchen.name,
    scheduleEntryId: entry._id,
    pushTitle: "Suggestion Approved",
    pushBody: `Your meal suggestion in ${kitchen.name} was approved.`,
  });
}

export async function notifySuggestionDenied(
  entryId: string
): Promise<void> {
  const entry = await ScheduleEntry.findById(entryId).lean();
  if (!entry || !entry.suggestedBy) return;

  const kitchen = await Kitchen.findById(entry.kitchenId)
    .select("name")
    .lean();
  if (!kitchen) return;

  await createNotification({
    userId: entry.suggestedBy,
    type: "suggestion_denied",
    kitchenId: entry.kitchenId,
    kitchenName: kitchen.name,
    scheduleEntryId: entry._id,
    pushTitle: "Suggestion Denied",
    pushBody: `Your meal suggestion in ${kitchen.name} was denied.`,
  });
}

/**
 * Notify with pre-loaded entry and kitchen data (avoids race condition
 * when the entry has already been deleted before this runs).
 */
export async function notifySuggestionDeniedWithData(data: {
  suggestedBy: Types.ObjectId;
  kitchenId: Types.ObjectId;
  kitchenName: string;
  scheduleEntryId: Types.ObjectId;
}): Promise<void> {
  await createNotification({
    userId: data.suggestedBy,
    type: "suggestion_denied",
    kitchenId: data.kitchenId,
    kitchenName: data.kitchenName,
    scheduleEntryId: data.scheduleEntryId,
    pushTitle: "Suggestion Denied",
    pushBody: `Your meal suggestion in ${data.kitchenName} was denied.`,
  });
}

export async function notifyKitchenJoined(
  memberId: string,
  kitchenId: string
): Promise<void> {
  const [actor, kitchen] = await Promise.all([
    getActorData(memberId),
    Kitchen.findById(kitchenId).select("leadId name").lean(),
  ]);
  if (!actor || !kitchen) return;

  // Don't notify if the person joining is the lead (creating kitchen)
  if (memberId === kitchen.leadId.toString()) return;

  await createNotification({
    userId: kitchen.leadId,
    type: "kitchen_joined",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    kitchenId: new Types.ObjectId(kitchenId),
    kitchenName: kitchen.name,
    pushTitle: "New Kitchen Member",
    pushBody: `${actor.fullName} joined ${kitchen.name}.`,
  });
}

/** Welcome receipt for the member who joined (uses `kitchen_invite` preference). */
export async function notifyKitchenInviteWelcome(
  newMemberId: string,
  kitchenId: string
): Promise<void> {
  const kitchen = await Kitchen.findById(kitchenId).select("name").lean();
  if (!kitchen) return;

  await createNotification({
    userId: new Types.ObjectId(newMemberId),
    type: "kitchen_invite",
    kitchenId: new Types.ObjectId(kitchenId),
    kitchenName: kitchen.name,
    pushTitle: "Kitchen",
    pushBody: `You're now a member of ${kitchen.name}.`,
  });
}

export async function notifyKitchenRemoved(
  memberId: string,
  kitchenId: string,
  kitchenName: string
): Promise<void> {
  await createNotification({
    userId: new Types.ObjectId(memberId),
    type: "kitchen_removed",
    kitchenId: new Types.ObjectId(kitchenId),
    kitchenName,
    pushTitle: "Removed from Kitchen",
    pushBody: `You were removed from ${kitchenName}.`,
  });
}

/**
 * Notify the recipient of an in-app kitchen invite. Creates a tile with
 * inline Accept/Decline buttons (the UI keys off `inviteId`).
 */
export async function notifyKitchenInviteReceived(
  senderId: string,
  recipientId: string,
  kitchenId: string,
  inviteId: string
): Promise<void> {
  if (senderId === recipientId) return;

  const [actor, kitchen] = await Promise.all([
    getActorData(senderId),
    Kitchen.findById(kitchenId).select("name").lean(),
  ]);
  if (!actor || !kitchen) return;

  await createNotification({
    userId: new Types.ObjectId(recipientId),
    type: "kitchen_invite_received",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    kitchenId: new Types.ObjectId(kitchenId),
    kitchenName: kitchen.name,
    inviteId: new Types.ObjectId(inviteId),
    pushTitle: "Kitchen invite",
    pushBody: `${actor.fullName} invited you to join ${kitchen.name}.`,
  });
}

/** Notify the original sender that their invite was accepted. */
export async function notifyKitchenInviteAccepted(
  accepterId: string,
  kitchenId: string,
  senderId: string
): Promise<void> {
  if (accepterId === senderId) return;

  const [actor, kitchen] = await Promise.all([
    getActorData(accepterId),
    Kitchen.findById(kitchenId).select("name").lean(),
  ]);
  if (!actor || !kitchen) return;

  await createNotification({
    userId: new Types.ObjectId(senderId),
    type: "kitchen_invite_accepted",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    kitchenId: new Types.ObjectId(kitchenId),
    kitchenName: kitchen.name,
    pushTitle: "Invite accepted",
    pushBody: `${actor.fullName} joined ${kitchen.name}.`,
  });
}

/** Notify the original sender that their invite was declined. */
export async function notifyKitchenInviteDeclined(
  declinerId: string,
  kitchenId: string,
  senderId: string
): Promise<void> {
  if (declinerId === senderId) return;

  const [actor, kitchen] = await Promise.all([
    getActorData(declinerId),
    Kitchen.findById(kitchenId).select("name").lean(),
  ]);
  if (!actor || !kitchen) return;

  await createNotification({
    userId: new Types.ObjectId(senderId),
    type: "kitchen_invite_declined",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    kitchenId: new Types.ObjectId(kitchenId),
    kitchenName: kitchen.name,
    pushTitle: "Invite declined",
    pushBody: `${actor.fullName} declined your kitchen invite.`,
  });
}

/**
 * Notify the new lead that they've been promoted. Used by both user-initiated
 * transfer (old lead chooses successor) and admin-initiated transfer (admin
 * reassigns leadership). When `formerLeadId` is provided we render the
 * actor's name in the message; admin-driven transfers omit it so the message
 * reads as a system action.
 */
export async function notifyKitchenLeadTransferred(
  newLeadId: string,
  kitchenId: string,
  formerLeadId?: string
): Promise<void> {
  const [actor, kitchen] = await Promise.all([
    formerLeadId ? getActorData(formerLeadId) : Promise.resolve(null),
    Kitchen.findById(kitchenId).select("name").lean(),
  ]);
  if (!kitchen) return;

  const pushBody = actor
    ? `${actor.fullName} made you the lead of ${kitchen.name}.`
    : `You're now the lead of ${kitchen.name}.`;

  await createNotification({
    userId: new Types.ObjectId(newLeadId),
    type: "kitchen_lead_transferred",
    actorId: actor?._id,
    actorName: actor?.fullName,
    actorPhoto: actor?.profilePicture,
    kitchenId: new Types.ObjectId(kitchenId),
    kitchenName: kitchen.name,
    pushTitle: "Kitchen lead",
    pushBody,
  });
}

// ── "I Cooked It" notifications ─────────────────────────────────────────

/**
 * Notify a recipe's author that someone posted an "I Cooked It" for it.
 * No-op when the actor is the author (silent self-notifications).
 */
export async function notifyRecipeCooked(params: {
  actorId: string;
  recipeId: string;
  recipeTitle: string;
  recipeAuthorId: string;
  photoUrl?: string;
}): Promise<void> {
  if (params.actorId === params.recipeAuthorId) return;

  const actor = await getActorData(params.actorId);
  if (!actor) return;

  await createNotification({
    userId: new Types.ObjectId(params.recipeAuthorId),
    type: "recipe_cooked",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    recipeId: new Types.ObjectId(params.recipeId),
    recipeTitle: params.recipeTitle,
    pushTitle: "Someone cooked your recipe",
    pushBody: `${actor.fullName} cooked "${params.recipeTitle}".`,
  });
}

/**
 * Notify a user they just unlocked a new passport stamp (first time cooking
 * a given cuisine). Stored as a type=passport_stamp notification with the
 * cuisine name stashed in `shareMessage` so existing schema reuse applies.
 */
export async function notifyPassportStamp(params: {
  userId: string;
  cuisine: string;
  regionName: string | null;
}): Promise<void> {
  const suffix = params.regionName ? ` · ${params.regionName}` : "";
  await createNotification({
    userId: new Types.ObjectId(params.userId),
    type: "passport_stamp",
    shareMessage: params.cuisine,
    pushTitle: "New passport stamp",
    pushBody: `Unlocked ${params.cuisine}${suffix}. Tap to see your passport.`,
  });
}

/**
 * Notify a user they just earned a passport badge (tier or regional).
 * Badge identifier is stashed in `shareMessage`.
 */
export async function notifyPassportBadge(params: {
  userId: string;
  badgeId: string;
}): Promise<void> {
  await createNotification({
    userId: new Types.ObjectId(params.userId),
    type: "passport_stamp",
    shareMessage: `badge:${params.badgeId}`,
    pushTitle: "Badge unlocked",
    pushBody: "You earned a new Chefless passport badge.",
  });
}

/**
 * Notify the uploader that a recipe owner has removed their "I Cooked It"
 * photo. The owner-supplied reason is surfaced in the push body so the user
 * understands why without having to open the app.
 */
export async function notifyCookedPostRemoved(params: {
  uploaderId: string;
  recipeId: string | null;
  recipeTitle: string;
  ownerName: string;
  reason: string;
}): Promise<void> {
  const body =
    `${params.ownerName} removed your "I Cooked It" photo for ` +
    `"${params.recipeTitle}". Reason: ${params.reason}`;
  await createNotification({
    userId: new Types.ObjectId(params.uploaderId),
    type: "cooked_post_removed",
    recipeId: params.recipeId ? new Types.ObjectId(params.recipeId) : undefined,
    recipeTitle: params.recipeTitle,
    shareMessage: params.reason,
    pushTitle: "Your cooked-it photo was removed",
    pushBody: body,
  });
}
