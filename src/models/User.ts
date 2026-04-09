import mongoose, { Schema, Document, Types } from "mongoose";

export interface ShippingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface NotificationPreferences {
  new_follower: boolean;
  follow_request: boolean;
  follow_accepted: boolean;
  recipe_liked: boolean;
  recipe_forked: boolean;
  recipe_shared: boolean;
  schedule_suggestion: boolean;
  suggestion_approved: boolean;
  suggestion_denied: boolean;
  kitchen_invite: boolean;
  kitchen_joined: boolean;
  kitchen_removed: boolean;
  system: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  new_follower: true,
  follow_request: true,
  follow_accepted: true,
  recipe_liked: true,
  recipe_forked: true,
  recipe_shared: true,
  schedule_suggestion: true,
  suggestion_approved: true,
  suggestion_denied: true,
  kitchen_invite: true,
  kitchen_joined: true,
  kitchen_removed: true,
  system: true,
};

export interface IUser extends Document {
  _id: Types.ObjectId;
  firebaseUid: string;
  email: string;
  fullName: string;
  phone?: string;
  profilePicture?: string;
  signature?: string;
  bio?: string;
  isPublic: boolean;
  followersCount: number;
  followingCount: number;
  recipesCount: number;
  /** Original recipes only (no remixes) — used for spatula badges and free-tier recipe cap */
  originalRecipesCount: number;
  kitchenId?: Types.ObjectId;
  isPremium: boolean;
  premiumPlan?: "monthly" | "annual";
  premiumExpiresAt?: Date;
  chefHatShipped?: boolean;
  shippingAddress?: ShippingAddress;
  dietaryPreferences?: string[];
  cuisinePreferences?: string[];
  onboardingComplete: boolean;
  fcmToken?: string;
  notificationPreferences: NotificationPreferences;
  isAdmin: boolean;
  isBanned: boolean;
  banReason?: string;
  bannedAt?: Date;
  lastActiveAt: Date;
  createdAt: Date;
  updatedAt: Date;
  /** UTC calendar day (YYYY-MM-DD) for daily AI helper rate limit */
  aiRecipeHelperUsageDay?: string;
  aiRecipeHelperUsageCount?: number;
}

const shippingAddressSchema = new Schema<ShippingAddress>(
  {
    line1: { type: String, required: true },
    line2: { type: String },
    city: { type: String, required: true },
    state: { type: String, required: true },
    zip: { type: String, required: true },
    country: { type: String, required: true },
  },
  { _id: false }
);

const userSchema = new Schema<IUser>(
  {
    firebaseUid: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    phone: { type: String },
    profilePicture: { type: String },
    signature: { type: String },
    bio: {
      type: String,
      maxlength: 150,
    },
    isPublic: {
      type: Boolean,
      default: true,
      index: true,
    },
    followersCount: {
      type: Number,
      default: 0,
    },
    followingCount: {
      type: Number,
      default: 0,
    },
    recipesCount: {
      type: Number,
      default: 0,
    },
    originalRecipesCount: {
      type: Number,
      default: 0,
    },
    kitchenId: {
      type: Schema.Types.ObjectId,
      ref: "Kitchen",
      index: true,
    },
    isPremium: {
      type: Boolean,
      default: false,
    },
    premiumPlan: {
      type: String,
      enum: ["monthly", "annual"],
    },
    premiumExpiresAt: { type: Date },
    // NOTE: chefHatShipped and shippingAddress are reserved for a future
    // "Chef Hat" premium physical reward feature. No API endpoints exist yet.
    chefHatShipped: { type: Boolean },
    shippingAddress: { type: shippingAddressSchema },
    dietaryPreferences: [{ type: String }],
    cuisinePreferences: [{ type: String }],
    onboardingComplete: {
      type: Boolean,
      default: false,
    },
    fcmToken: { type: String },
    notificationPreferences: {
      type: {
        new_follower: { type: Boolean, default: true },
        follow_request: { type: Boolean, default: true },
        follow_accepted: { type: Boolean, default: true },
        recipe_liked: { type: Boolean, default: true },
        recipe_forked: { type: Boolean, default: true },
        recipe_shared: { type: Boolean, default: true },
        schedule_suggestion: { type: Boolean, default: true },
        suggestion_approved: { type: Boolean, default: true },
        suggestion_denied: { type: Boolean, default: true },
        kitchen_invite: { type: Boolean, default: true },
        kitchen_joined: { type: Boolean, default: true },
        kitchen_removed: { type: Boolean, default: true },
        system: { type: Boolean, default: true },
      },
      default: () => ({ ...DEFAULT_NOTIFICATION_PREFERENCES }),
      _id: false,
    },
    // NOTE: isAdmin is used for admin panel badge display only.
    // API authorization is handled by AdminUser collection + express-session.
    isAdmin: {
      type: Boolean,
      default: false,
    },
    isBanned: {
      type: Boolean,
      default: false,
    },
    banReason: { type: String },
    bannedAt: { type: Date },
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
    aiRecipeHelperUsageDay: { type: String },
    aiRecipeHelperUsageCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  }
);

// Text index for search by name
userSchema.index({ fullName: "text" });

const User = (mongoose.models.User as mongoose.Model<IUser>) ||
  mongoose.model<IUser>("User", userSchema);

export default User;
