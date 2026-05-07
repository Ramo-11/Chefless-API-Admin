import { Types } from "mongoose";
import User, { IUser } from "../models/User";
import Follow, { IFollow } from "../models/Follow";
import Recipe from "../models/Recipe";
import Like from "../models/Like";
import SavedRecipe from "../models/SavedRecipe";
import RecipeShare from "../models/RecipeShare";
import Notification from "../models/Notification";
import ShoppingList from "../models/ShoppingList";
import ScheduleEntry from "../models/ScheduleEntry";
import Kitchen from "../models/Kitchen";
import Cookbook from "../models/Cookbook";
import KitchenInvite from "../models/KitchenInvite";
import Report from "../models/Report";
import Block from "../models/Block";
import CookedPost from "../models/CookedPost";
import admin from "firebase-admin";
import { canViewProfile } from "./visibility-service";
import {
  notifyNewFollower,
  notifyFollowRequest,
  notifyFollowAccepted,
} from "./notification-service";
import {
  cloudinary,
  deleteImage,
  publicIdFromUrl,
} from "../lib/cloudinary";

type SpatulaBadge = "silver" | "golden" | "diamond" | "ruby" | null;

interface FollowRecord {
  _id: Types.ObjectId;
  followerId: Types.ObjectId | { _id: Types.ObjectId; fullName: string; profilePicture?: string };
  followingId: Types.ObjectId | { _id: Types.ObjectId; fullName: string; profilePicture?: string };
  status: "active" | "pending";
  createdAt: Date;
}

interface PaginatedResult {
  data: FollowRecord[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface PublicProfile {
  _id: Types.ObjectId;
  fullName: string;
  profilePicture?: string;
  isPublic: boolean;
}

interface FullProfile {
  spatulaBadge: SpatulaBadge;
  [key: string]: unknown;
}

type LimitedProfile = PublicProfile & { spatulaBadge: SpatulaBadge; isPrivate: true };

/** Spatula tiers use original recipe count only (no remixes). */
export function computeSpatulaBadge(originalRecipesCount: number): SpatulaBadge {
  if (originalRecipesCount >= 10000) return "ruby";
  if (originalRecipesCount >= 1000) return "diamond";
  if (originalRecipesCount >= 100) return "golden";
  if (originalRecipesCount >= 10) return "silver";
  return null;
}

function spatulaCountForUser(user: {
  originalRecipesCount?: number;
  recipesCount: number;
}): number {
  return user.originalRecipesCount !== undefined && user.originalRecipesCount !== null
    ? user.originalRecipesCount
    : user.recipesCount;
}

export async function getUserById(
  userId: string,
  requesterId?: string
): Promise<FullProfile | LimitedProfile | null> {
  const user = await User.findById(userId);
  if (!user) return null;

  const canView = await canViewProfile(
    requesterId ? new Types.ObjectId(requesterId) : null,
    user
  );

  const badge = computeSpatulaBadge(spatulaCountForUser(user));

  if (!canView) {
    return {
      _id: user._id,
      fullName: user.fullName,
      profilePicture: user.profilePicture,
      isPublic: user.isPublic,
      spatulaBadge: badge,
      isPrivate: true as const,
    };
  }

  const userObj = user.toObject() as unknown as Record<string, unknown>;
  // Strip sensitive fields before returning to a third-party requester
  const isOwnProfile = requesterId && user._id.toString() === requesterId;
  if (!isOwnProfile) {
    delete userObj.fcmToken;
    delete userObj.shippingAddress;
    delete userObj.banReason;
    delete userObj.bannedAt;
    delete userObj.notificationPreferences;
    delete userObj.isAdmin;
  }
  return { ...userObj, spatulaBadge: badge };
}

interface ProfileUpdates {
  fullName?: string;
  bio?: string | null;
  phone?: string | null;
  isPublic?: boolean;
  dietaryPreferences?: string[];
  cuisinePreferences?: string[];
  profilePicture?: string | null;
  onboardingComplete?: boolean;
}

export async function updateProfile(
  userId: string,
  updates: ProfileUpdates
): Promise<IUser | null> {
  const user = await User.findByIdAndUpdate(
    userId,
    { $set: updates },
    { new: true, runValidators: true }
  );
  return user;
}

interface DeleteImpactKitchen {
  kitchenId: string;
  name: string;
  role: "lead" | "member";
  memberCount: number;
  /** True when removing this user wipes the kitchen (lead with no successor). */
  willBeDeleted: boolean;
  photoPublicId: string | null;
}

export interface DeleteImpact {
  user: { id: string; fullName: string; email: string };
  recipes: { count: number; imageCount: number };
  cookedPosts: { count: number; imageCount: number };
  kitchens: DeleteImpactKitchen[];
  profileImages: {
    profilePicture: boolean;
    signature: boolean;
  };
  notifications: {
    /** Notifications addressed to this user — wiped from their own inbox. */
    asRecipient: number;
    /** Notifications elsewhere where this user is the actor — wiped to avoid dangling actorId. */
    asActor: number;
  };
  cloudinary: {
    totalImages: number;
    /** Sum of `bytes` across every Cloudinary asset that will be destroyed. */
    totalBytes: number;
    /** True when at least one publicId failed Cloudinary lookup. Total may undercount. */
    partial: boolean;
  };
}

interface UserAssets {
  recipeIds: Types.ObjectId[];
  /** Every Cloudinary publicId tied to this user (recipe photos, step photos, profile, signature, cooked posts, owned kitchen photo). */
  publicIds: string[];
  recipePhotoCount: number;
  cookedPostCount: number;
  cookedPostPhotoCount: number;
  hasProfilePicture: boolean;
  hasSignature: boolean;
  ownedKitchen: {
    id: Types.ObjectId;
    name: string;
    memberCount: number;
    photoPublicId: string | null;
  } | null;
  memberOfKitchens: Array<{
    id: Types.ObjectId;
    name: string;
    memberCount: number;
  }>;
}

/**
 * Walk the user's content and collect every Cloudinary publicId that will be
 * destroyed when the account is deleted. Used by the admin delete-impact UI
 * AND by the cascade itself, so the two stay in sync.
 */
async function collectUserAssets(userId: string): Promise<UserAssets | null> {
  const objectId = new Types.ObjectId(userId);
  const user = await User.findById(userId)
    .select("kitchenId profilePicture signature")
    .lean();
  if (!user) return null;

  const publicIds: string[] = [];
  const pushUrl = (url: string | null | undefined) => {
    if (!url) return;
    const id = publicIdFromUrl(url);
    if (id) publicIds.push(id);
  };

  pushUrl(user.profilePicture);
  pushUrl(user.signature);

  const recipes = await Recipe.find({ authorId: objectId })
    .select("_id photos steps")
    .lean();
  let recipePhotoCount = 0;
  for (const r of recipes) {
    for (const p of r.photos ?? []) {
      pushUrl(p);
      recipePhotoCount += 1;
    }
    for (const s of r.steps ?? []) {
      if (s.photo) {
        pushUrl(s.photo);
        recipePhotoCount += 1;
      }
    }
  }

  const cookedPosts = await CookedPost.find({ userId: objectId })
    .select("photoUrl")
    .lean();
  let cookedPostPhotoCount = 0;
  for (const cp of cookedPosts) {
    if (cp.photoUrl) {
      pushUrl(cp.photoUrl);
      cookedPostPhotoCount += 1;
    }
  }

  let ownedKitchen: UserAssets["ownedKitchen"] = null;
  const memberOfKitchens: UserAssets["memberOfKitchens"] = [];

  if (user.kitchenId) {
    const kitchen = await Kitchen.findById(user.kitchenId)
      .select("_id name leadId photo")
      .lean();
    if (kitchen) {
      const memberCount = await User.countDocuments({ kitchenId: kitchen._id });
      const isLead = kitchen.leadId.equals(objectId);
      if (isLead) {
        const photoPublicId = kitchen.photo ? publicIdFromUrl(kitchen.photo) : null;
        if (photoPublicId) publicIds.push(photoPublicId);
        ownedKitchen = {
          id: kitchen._id,
          name: kitchen.name,
          memberCount,
          photoPublicId,
        };
      } else {
        memberOfKitchens.push({
          id: kitchen._id,
          name: kitchen.name,
          memberCount,
        });
      }
    }
  }

  return {
    recipeIds: recipes.map((r) => r._id),
    publicIds,
    recipePhotoCount,
    cookedPostCount: cookedPosts.length,
    cookedPostPhotoCount,
    hasProfilePicture: Boolean(user.profilePicture),
    hasSignature: Boolean(user.signature),
    ownedKitchen,
    memberOfKitchens,
  };
}

/**
 * Look up Cloudinary `bytes` for a list of publicIds. Cloudinary caps each
 * `resources_by_ids` call at 100 ids — we chunk and sum. A missing id (asset
 * already gone) is silently skipped and surfaced via the `partial` flag.
 */
async function cloudinaryBytesForIds(
  publicIds: string[]
): Promise<{ totalBytes: number; partial: boolean }> {
  if (publicIds.length === 0) return { totalBytes: 0, partial: false };

  const unique = Array.from(new Set(publicIds));
  let totalBytes = 0;
  let foundCount = 0;

  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    try {
      const result = (await cloudinary.api.resources_by_ids(batch)) as {
        resources: Array<{ bytes?: number }>;
      };
      for (const r of result.resources ?? []) {
        if (typeof r.bytes === "number") totalBytes += r.bytes;
        foundCount += 1;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Cloudinary resources_by_ids failed: ${msg}`);
    }
  }

  return { totalBytes, partial: foundCount < unique.length };
}

/**
 * Pre-flight summary of everything that gets removed when an admin deletes
 * a user: recipe count, kitchen impact, Cloudinary asset count + size.
 * Display-only — no mutations.
 */
export async function getDeleteImpact(
  userId: string
): Promise<DeleteImpact | null> {
  const user = await User.findById(userId)
    .select("fullName email")
    .lean();
  if (!user) return null;

  const assets = await collectUserAssets(userId);
  if (!assets) return null;

  const { totalBytes, partial } = await cloudinaryBytesForIds(assets.publicIds);

  const [notifAsRecipient, notifAsActor] = await Promise.all([
    Notification.countDocuments({ userId: new Types.ObjectId(userId) }),
    Notification.countDocuments({ actorId: new Types.ObjectId(userId) }),
  ]);

  const kitchens: DeleteImpactKitchen[] = [];
  if (assets.ownedKitchen) {
    kitchens.push({
      kitchenId: assets.ownedKitchen.id.toString(),
      name: assets.ownedKitchen.name,
      role: "lead",
      memberCount: assets.ownedKitchen.memberCount,
      willBeDeleted: true,
      photoPublicId: assets.ownedKitchen.photoPublicId,
    });
  }
  for (const k of assets.memberOfKitchens) {
    kitchens.push({
      kitchenId: k.id.toString(),
      name: k.name,
      role: "member",
      memberCount: k.memberCount,
      willBeDeleted: false,
      photoPublicId: null,
    });
  }

  return {
    user: {
      id: user._id.toString(),
      fullName: user.fullName,
      email: user.email,
    },
    recipes: {
      count: assets.recipeIds.length,
      imageCount: assets.recipePhotoCount,
    },
    cookedPosts: {
      count: assets.cookedPostCount,
      imageCount: assets.cookedPostPhotoCount,
    },
    kitchens,
    profileImages: {
      profilePicture: assets.hasProfilePicture,
      signature: assets.hasSignature,
    },
    notifications: {
      asRecipient: notifAsRecipient,
      asActor: notifAsActor,
    },
    cloudinary: {
      totalImages: assets.publicIds.length,
      totalBytes,
      partial,
    },
  };
}

/**
 * Delete the user and cascade-remove every document that references them.
 * Runs steps serially (not in a transaction) — if it fails midway the caller
 * may retry and the remaining orphaned rows will be cleaned up.
 *
 * Cascade covers: follows, likes, saves, recipes (with their likes/saves/shares
 * + Cloudinary photos), cookbooks, cooked posts (with photos), kitchen invites,
 * reports, blocks, kitchen membership (lead → full kitchen wipe; member →
 * removal), notifications, shopping lists, schedule entries, recipe shares,
 * profile + signature images, the User doc, and the Firebase Auth account.
 */
export async function deleteAccount(userId: string): Promise<void> {
  const objectId = new Types.ObjectId(userId);

  // Snapshot every Cloudinary publicId before MongoDB rows disappear. Asset
  // destruction runs at the end (fire-and-forget) so a Cloudinary stall can't
  // stall the user-facing delete.
  const assets = await collectUserAssets(userId);
  if (!assets) return;

  // Load the user to get their firebaseUid and kitchenId
  const user = await User.findById(userId).select("firebaseUid kitchenId").lean();
  if (!user) return;

  // Follow counter adjustments — collect both directions first
  const [followsAsFollower, followsAsFollowing] = await Promise.all([
    Follow.find({ followerId: objectId, status: "active" }).lean(),
    Follow.find({ followingId: objectId, status: "active" }).lean(),
  ]);

  // Decrement followersCount for users this person was following
  if (followsAsFollower.length > 0) {
    const followingIds = followsAsFollower.map((f) => f.followingId);
    await User.updateMany(
      { _id: { $in: followingIds } },
      { $inc: { followersCount: -1 } }
    );
  }

  // Decrement followingCount for users who were following this person
  if (followsAsFollowing.length > 0) {
    const followerIds = followsAsFollowing.map((f) => f.followerId);
    await User.updateMany(
      { _id: { $in: followerIds } },
      { $inc: { followingCount: -1 } }
    );
  }

  // Delete every follow record involving this user (both directions, any status)
  await Follow.deleteMany({
    $or: [{ followerId: objectId }, { followingId: objectId }],
  });

  // Decrement likesCount on recipes this user liked, then drop their Like rows
  const myLikes = await Like.find({ userId: objectId }).select("recipeId").lean();
  if (myLikes.length > 0) {
    // Count likes per recipe so we do one $inc per recipe (handles dup rows defensively)
    const counts = new Map<string, number>();
    for (const l of myLikes) {
      const key = l.recipeId.toString();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    await Recipe.bulkWrite(
      Array.from(counts.entries()).map(([rid, n]) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(rid) },
          update: { $inc: { likesCount: -n } },
        },
      }))
    );
    await Like.deleteMany({ userId: objectId });
  }

  // Drop the user's saved-recipe rows. The user is being deleted, so their
  // own savedRecipesCount is moot — no per-user adjustment needed here.
  await SavedRecipe.deleteMany({ userId: objectId });

  // Delete all recipes authored by this user (plus their likes/saves/shares)
  const userRecipes = await Recipe.find({ authorId: objectId }).select("_id").lean();
  if (userRecipes.length > 0) {
    const recipeIds = userRecipes.map((r) => r._id);

    // Capture every OTHER user that had any of these recipes saved BEFORE we
    // wipe the SavedRecipe rows. Each of those users must have their
    // savedRecipesCount decremented by the count of this user's recipes they
    // saved, so the free-tier combined cap stays consistent post-delete.
    const cascadingSaves = await SavedRecipe.find({
      recipeId: { $in: recipeIds },
    })
      .select("userId")
      .lean();

    await Promise.all([
      Like.deleteMany({ recipeId: { $in: recipeIds } }),
      SavedRecipe.deleteMany({ recipeId: { $in: recipeIds } }),
      RecipeShare.deleteMany({ recipeId: { $in: recipeIds } }),
      // Preserve fork chain display: null out the link but keep the attribution name
      Recipe.updateMany(
        { "forkedFrom.recipeId": { $in: recipeIds } },
        { $set: { "forkedFrom.recipeId": null, "forkedFrom.authorId": null } }
      ),
    ]);

    if (cascadingSaves.length > 0) {
      const counts = new Map<string, number>();
      for (const s of cascadingSaves) {
        const key = s.userId.toString();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      await User.bulkWrite(
        Array.from(counts.entries()).map(([uid, n]) => ({
          updateOne: {
            filter: {
              _id: new Types.ObjectId(uid),
              savedRecipesCount: { $gte: n },
            },
            update: { $inc: { savedRecipesCount: -n } },
          },
        }))
      );
    }

    await Recipe.deleteMany({ authorId: objectId });
  }

  // Forks whose authorId points at this user but whose origin recipe belongs to someone else
  await Recipe.updateMany(
    { "forkedFrom.authorId": objectId },
    { $set: { "forkedFrom.authorId": null } }
  );

  // Delete cookbooks owned by this user (cookbooks contain recipe references only, no denorm counters)
  await Cookbook.deleteMany({ ownerId: objectId });

  // Kitchen invites the user was part of (either side)
  await KitchenInvite.deleteMany({
    $or: [{ senderId: objectId }, { recipientId: objectId }],
  });

  // Content-moderation rows filed by the user (target rows remain — history preserved against deleted content)
  await Report.deleteMany({ reporterId: objectId });

  // Every block row the user was on either side of
  await Block.deleteMany({
    $or: [{ blockerId: objectId }, { blockedId: objectId }],
  });

  // Cooked posts authored by this user — delete the rows; their Cloudinary
  // photos are destroyed in the asset sweep below.
  await CookedPost.deleteMany({ userId: objectId });

  // Kitchen handling: if the user is the lead, wipe the whole kitchen (no
  // automatic successor). If they're a regular member, just remove them.
  if (assets.ownedKitchen) {
    const kitchenId = assets.ownedKitchen.id;
    await Promise.all([
      ScheduleEntry.deleteMany({ kitchenId }),
      ShoppingList.deleteMany({ kitchenId }),
      KitchenInvite.deleteMany({ kitchenId }),
      User.updateMany({ kitchenId }, { $unset: { kitchenId: 1 } }),
    ]);
    await Kitchen.findByIdAndDelete(kitchenId);
  } else if (user.kitchenId) {
    await Kitchen.updateOne(
      { _id: user.kitchenId },
      {
        $inc: { memberCount: -1 },
        $pull: {
          membersWithScheduleEdit: objectId,
          membersWithApprovalPower: objectId,
        },
      }
    );
  }

  // Notifications / shopping lists / schedule entries / recipe shares tied to this user.
  // Notifications are deleted from BOTH directions: the user's own inbox AND
  // any notifications elsewhere where this user was the actor (e.g. "X liked
  // your recipe" sitting in someone else's feed) — otherwise those rows leak
  // with a dangling actorId pointing at a deleted account.
  await Promise.all([
    Notification.deleteMany({
      $or: [{ userId: objectId }, { actorId: objectId }],
    }),
    ShoppingList.deleteMany({ userId: objectId }),
    ScheduleEntry.deleteMany({
      $or: [{ userId: objectId }, { suggestedBy: objectId }],
    }),
    RecipeShare.deleteMany({ $or: [{ senderId: objectId }, { recipientId: objectId }] }),
  ]);

  // Delete the user document from MongoDB
  await User.findByIdAndDelete(userId);

  // Destroy every Cloudinary asset tied to the deleted account. Awaited so
  // an admin-triggered delete reports a clean exit, but each `deleteImage`
  // already swallows per-asset failures so one bad id can't abort the sweep.
  if (assets.publicIds.length > 0) {
    const unique = Array.from(new Set(assets.publicIds));
    await Promise.all(unique.map((id) => deleteImage(id)));
  }

  // Delete the Firebase Auth user (best-effort — client may have already deleted it)
  try {
    await admin.auth().deleteUser(user.firebaseUid);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // USER_NOT_FOUND is fine — Firebase account may already be gone
    if (!msg.includes("USER_NOT_FOUND")) {
      console.error(`Failed to delete Firebase Auth user: ${msg}`);
    }
  }
}

export async function getFollowers(
  userId: string,
  page: number,
  limit: number
): Promise<PaginatedResult> {
  const skip = (page - 1) * limit;
  const objectId = new Types.ObjectId(userId);

  const [data, total] = await Promise.all([
    Follow.find({ followingId: objectId, status: "active" })
      .populate("followerId", "fullName profilePicture")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<FollowRecord[]>(),
    Follow.countDocuments({ followingId: objectId, status: "active" }),
  ]);

  return {
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getFollowing(
  userId: string,
  page: number,
  limit: number
): Promise<PaginatedResult> {
  const skip = (page - 1) * limit;
  const objectId = new Types.ObjectId(userId);

  const [data, total] = await Promise.all([
    Follow.find({ followerId: objectId, status: "active" })
      .populate("followingId", "fullName profilePicture")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<FollowRecord[]>(),
    Follow.countDocuments({ followerId: objectId, status: "active" }),
  ]);

  return {
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getPendingRequests(
  userId: string,
  page: number,
  limit: number
): Promise<PaginatedResult> {
  const objectId = new Types.ObjectId(userId);
  const skip = (page - 1) * limit;

  const [data, total] = await Promise.all([
    Follow.find({ followingId: objectId, status: "pending" })
      .populate("followerId", "fullName profilePicture")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<FollowRecord[]>(),
    Follow.countDocuments({ followingId: objectId, status: "pending" }),
  ]);

  return {
    data,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}

export async function followUser(
  followerId: string,
  targetId: string
): Promise<{ follow: IFollow; status: "active" | "pending" }> {
  if (followerId === targetId) {
    const error = new Error("Cannot follow yourself") as Error & {
      statusCode: number;
    };
    error.statusCode = 400;
    throw error;
  }

  const target = await User.findById(targetId);
  if (!target) {
    const error = new Error("User not found") as Error & {
      statusCode: number;
    };
    error.statusCode = 404;
    throw error;
  }

  // Check if already following
  const existing = await Follow.findOne({
    followerId: new Types.ObjectId(followerId),
    followingId: new Types.ObjectId(targetId),
  });

  if (existing) {
    const error = new Error(
      existing.status === "active"
        ? "Already following this user"
        : "Follow request already pending"
    ) as Error & { statusCode: number };
    error.statusCode = 409;
    throw error;
  }

  const status = target.isPublic ? "active" : "pending";

  const follow = await Follow.create({
    followerId: new Types.ObjectId(followerId),
    followingId: new Types.ObjectId(targetId),
    status,
  });

  // If active follow, increment counters atomically
  if (status === "active") {
    await Promise.all([
      User.updateOne(
        { _id: followerId },
        { $inc: { followingCount: 1 } }
      ),
      User.updateOne(
        { _id: targetId },
        { $inc: { followersCount: 1 } }
      ),
    ]);

    // Fire-and-forget notification
    notifyNewFollower(followerId, targetId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send new_follower notification: ${msg}`);
    });
  } else {
    // Fire-and-forget notification for pending request
    notifyFollowRequest(followerId, targetId).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send follow_request notification: ${msg}`);
    });
  }

  return { follow, status };
}

export async function unfollowUser(
  followerId: string,
  targetId: string
): Promise<void> {
  const follow = await Follow.findOneAndDelete({
    followerId: new Types.ObjectId(followerId),
    followingId: new Types.ObjectId(targetId),
  });

  if (!follow) {
    const error = new Error("Not following this user") as Error & {
      statusCode: number;
    };
    error.statusCode = 404;
    throw error;
  }

  // Only decrement counters if the follow was active
  if (follow.status === "active") {
    await Promise.all([
      User.updateOne(
        { _id: followerId },
        { $inc: { followingCount: -1 } }
      ),
      User.updateOne(
        { _id: targetId },
        { $inc: { followersCount: -1 } }
      ),
    ]);
  }
}

export async function acceptFollowRequest(
  userId: string,
  followId: string
): Promise<IFollow> {
  const follow = await Follow.findById(followId);

  if (!follow) {
    const error = new Error("Follow request not found") as Error & {
      statusCode: number;
    };
    error.statusCode = 404;
    throw error;
  }

  // Ensure the request is addressed to this user
  if (!follow.followingId.equals(userId)) {
    const error = new Error("Not authorized to accept this request") as Error & {
      statusCode: number;
    };
    error.statusCode = 403;
    throw error;
  }

  if (follow.status !== "pending") {
    const error = new Error("This request is not pending") as Error & {
      statusCode: number;
    };
    error.statusCode = 400;
    throw error;
  }

  follow.status = "active";
  await follow.save();

  // Increment counters atomically
  await Promise.all([
    User.updateOne(
      { _id: follow.followerId },
      { $inc: { followingCount: 1 } }
    ),
    User.updateOne(
      { _id: follow.followingId },
      { $inc: { followersCount: 1 } }
    ),
  ]);

  // Fire-and-forget notification
  notifyFollowAccepted(userId, follow.followerId.toString()).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to send follow_accepted notification: ${msg}`);
    }
  );

  return follow;
}

export async function denyFollowRequest(
  userId: string,
  followId: string
): Promise<void> {
  const follow = await Follow.findById(followId);

  if (!follow) {
    const error = new Error("Follow request not found") as Error & {
      statusCode: number;
    };
    error.statusCode = 404;
    throw error;
  }

  if (!follow.followingId.equals(userId)) {
    const error = new Error("Not authorized to deny this request") as Error & {
      statusCode: number;
    };
    error.statusCode = 403;
    throw error;
  }

  if (follow.status !== "pending") {
    const error = new Error("This request is not pending") as Error & {
      statusCode: number;
    };
    error.statusCode = 400;
    throw error;
  }

  await Follow.findByIdAndDelete(followId);
}

export async function isFollowing(
  followerId: string,
  targetId: string
): Promise<{ following: boolean; status: "active" | "pending" | null }> {
  const follow = await Follow.findOne({
    followerId: new Types.ObjectId(followerId),
    followingId: new Types.ObjectId(targetId),
  }).lean();

  if (!follow) {
    return { following: false, status: null };
  }

  return { following: follow.status === "active", status: follow.status };
}
