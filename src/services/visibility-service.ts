import { Types } from "mongoose";
import Follow from "../models/Follow";
import User, { IUser } from "../models/User";
import { isBlocked } from "./block-service";

export async function buildAccessiblePrivateIds(
  userId: Types.ObjectId
): Promise<Types.ObjectId[]> {
  const [follows, viewer] = await Promise.all([
    Follow.find({ followerId: userId, status: "active" })
      .select("followingId")
      .lean(),
    User.findById(userId).select("kitchenId").lean(),
  ]);
  const followingIds = follows.map((f) => f.followingId);
  const kitchenMemberIds = await getKitchenMemberIds(userId, viewer?.kitchenId);

  return [...followingIds, ...kitchenMemberIds];
}

export async function getKitchenMemberIds(
  userId: Types.ObjectId,
  kitchenId: Types.ObjectId | null | undefined
): Promise<Types.ObjectId[]> {
  if (!kitchenId) return [];
  const members = await User.find({
    kitchenId,
    _id: { $ne: userId },
  })
    .select("_id")
    .lean();
  return members.map((m) => m._id);
}

export function resolveRecipeVisibility(
  viewerId: Types.ObjectId | string | null,
  recipe: { authorId: Types.ObjectId; isPrivate: boolean },
  author: { _id: Types.ObjectId; isPublic: boolean },
  accessiblePrivateIds: Types.ObjectId[]
): boolean {
  if (viewerId && recipe.authorId.equals(viewerId)) {
    return true;
  }
  if (recipe.isPrivate) {
    return false;
  }
  if (author.isPublic) {
    return true;
  }
  if (!viewerId) {
    return false;
  }
  return accessiblePrivateIds.some((id) => id.equals(author._id));
}

export async function canViewProfile(
  viewerId: Types.ObjectId | string | null,
  targetUser: IUser
): Promise<boolean> {
  // Same user can always view their own profile
  if (viewerId && targetUser._id.equals(viewerId)) {
    return true;
  }

  // A block in either direction severs all profile visibility, even for
  // public accounts — a blocked user must not be able to view or re-follow
  // the blocker's profile.
  if (
    viewerId &&
    (await isBlocked(viewerId.toString(), targetUser._id.toString()))
  ) {
    return false;
  }

  // Public accounts are always viewable
  if (targetUser.isPublic) {
    return true;
  }

  // No viewer means no access to private profiles
  if (!viewerId) {
    return false;
  }

  // Check if viewer actively follows the target
  const follow = await Follow.findOne({
    followerId: viewerId,
    followingId: targetUser._id,
    status: "active",
  });

  if (follow) {
    return true;
  }

  // NOTE: Kitchen co-membership does NOT grant profile visibility.
  // Per ARCHITECTURE.md's privacy rules, joining a kitchen grants implicit
  // *recipe* visibility only — profiles remain gated by account privacy and
  // follow status. (See `canViewRecipe` below for the recipe-side rule.)
  return false;
}

export async function canViewRecipe(
  viewerId: Types.ObjectId | string | null,
  recipe: { authorId: Types.ObjectId; isPrivate: boolean },
  author: IUser
): Promise<boolean> {
  // Author can always view their own recipes
  if (viewerId && recipe.authorId.equals(viewerId)) {
    return true;
  }

  // Private recipes: only the author can see
  if (recipe.isPrivate) {
    return false;
  }

  // Shared (non-private) recipe on a public account: anyone can view
  if (author.isPublic) {
    return true;
  }

  // Shared recipe on a private account: only followers + kitchen members
  if (!viewerId) {
    return false;
  }

  // Check if viewer actively follows the author
  const follow = await Follow.findOne({
    followerId: viewerId,
    followingId: author._id,
    status: "active",
  });

  if (follow) {
    return true;
  }

  // Check if they share a kitchen
  if (author.kitchenId) {
    const viewer = await User.findById(viewerId).select("kitchenId").lean();
    if (
      viewer &&
      viewer.kitchenId &&
      author.kitchenId.equals(viewer.kitchenId)
    ) {
      return true;
    }
  }

  return false;
}
