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
  kitchenId?: Types.ObjectId;
  kitchenName?: string;
  scheduleEntryId?: Types.ObjectId;
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
    case "recipe_shared":
      return params.recipeId ? `/recipe/${params.recipeId}` : null;
    case "new_follower":
    case "follow_request":
    case "follow_accepted":
      return params.actorId ? `/user/${params.actorId}` : null;
    case "schedule_suggestion":
    case "suggestion_approved":
    case "suggestion_denied":
      return "/schedule";
    case "kitchen_joined":
    case "kitchen_removed":
      return "/kitchen";
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
    kitchenId: params.kitchenId,
    kitchenName: params.kitchenName,
    scheduleEntryId: params.scheduleEntryId,
  });

  console.log(
    `[FCM-DEBUG] createNotification: type="${params.type}", ` +
      `userId="${params.userId}", hasPushTitle=${!!params.pushTitle}, ` +
      `hasPushBody=${!!params.pushBody}, userFcmToken=${user?.fcmToken ? `"${user.fcmToken.slice(0, 12)}..."` : "NONE"}`
  );

  // Send push notification if user has an FCM token
  if (params.pushTitle && params.pushBody && user?.fcmToken) {
    const pushData: Record<string, string> = {
      notificationId: notification._id.toString(),
      type: params.type,
    };

    if (params.recipeId) {
      pushData.recipeId = params.recipeId.toString();
    }
    if (params.actorId) {
      pushData.actorId = params.actorId.toString();
    }
    if (params.kitchenId) {
      pushData.kitchenId = params.kitchenId.toString();
    }

    // Compute a `route` field so the Flutter app can deep-link directly
    // to the relevant screen when the notification is tapped.
    const route = deriveRouteForType(params);
    if (route) {
      pushData.route = route;
    }

    console.log(
      `[FCM-DEBUG] Dispatching push: title="${params.pushTitle}", route="${route}", ` +
        `data=${JSON.stringify(pushData)}`
    );

    sendPushNotification(
      user.fcmToken,
      params.pushTitle,
      params.pushBody,
      pushData
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[FCM-DEBUG] Push notification failed: ${msg}`);
    });
  } else {
    console.log(
      `[FCM-DEBUG] SKIPPING push: pushTitle=${!!params.pushTitle}, ` +
        `pushBody=${!!params.pushBody}, hasFcmToken=${!!user?.fcmToken}`
    );
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
    pushTitle: "Recipe Forked",
    pushBody: `${actor.fullName} forked your recipe "${recipe.title}".`,
  });
}

export async function notifyRecipeShared(
  senderId: string,
  recipientId: string,
  recipeId: string
): Promise<void> {
  if (senderId === recipientId) return;

  const [actor, recipe] = await Promise.all([
    getActorData(senderId),
    Recipe.findById(recipeId).select("title").lean(),
  ]);
  if (!actor || !recipe) return;

  await createNotification({
    userId: new Types.ObjectId(recipientId),
    type: "recipe_shared",
    actorId: actor._id,
    actorName: actor.fullName,
    actorPhoto: actor.profilePicture,
    recipeId: new Types.ObjectId(recipeId),
    recipeTitle: recipe.title,
    pushTitle: "Recipe Shared",
    pushBody: `${actor.fullName} shared a recipe with you: "${recipe.title}".`,
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
