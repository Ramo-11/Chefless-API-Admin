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
  recipe_saved: boolean;
  recipe_shared: boolean;
  schedule_suggestion: boolean;
  suggestion_approved: boolean;
  suggestion_denied: boolean;
  kitchen_invite: boolean;
  kitchen_invite_received: boolean;
  kitchen_invite_accepted: boolean;
  kitchen_invite_declined: boolean;
  kitchen_joined: boolean;
  kitchen_removed: boolean;
  kitchen_lead_transferred: boolean;
  recipe_cooked: boolean;
  cooked_post_removed: boolean;
  passport_stamp: boolean;
  system: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  new_follower: true,
  follow_request: true,
  follow_accepted: true,
  recipe_liked: true,
  recipe_forked: true,
  recipe_saved: true,
  recipe_shared: true,
  schedule_suggestion: true,
  suggestion_approved: true,
  suggestion_denied: true,
  kitchen_invite: true,
  kitchen_invite_received: true,
  kitchen_invite_accepted: true,
  kitchen_invite_declined: true,
  kitchen_joined: true,
  kitchen_removed: true,
  kitchen_lead_transferred: true,
  recipe_cooked: true,
  cooked_post_removed: true,
  passport_stamp: true,
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
  /** Recipes the user has saved/bookmarked — counted toward combined free-tier cap (originals + saves ≤ 5). */
  savedRecipesCount: number;
  /** Remixes the user has authored — gated to 1 max for free tier. */
  remixesCount: number;
  kitchenId?: Types.ObjectId;
  isPremium: boolean;
  premiumPlan?: "monthly" | "annual" | "admin";
  premiumExpiresAt?: Date;
  /** AdminUser._id of the admin who granted premium (only set when premiumPlan === "admin"). */
  premiumGrantedBy?: Types.ObjectId;
  /** When the admin grant happened. Cleared on revoke or on real purchase. */
  premiumGrantedAt?: Date;
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
  /**
   * Minutes east of UTC for the user's last-known local timezone, captured
   * from the client on each AI call (e.g. `-240` for UTC-4 / New York DST,
   * `540` for Tokyo). Used so the daily AI quota resets at the user's local
   * midnight instead of UTC midnight. Optional — falls back to UTC when
   * absent. Stored to keep a record visible in the admin panel.
   */
  timezoneOffsetMinutes?: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Local calendar day (YYYY-MM-DD in `timezone`, or UTC fallback) the daily
   * counter is scoped to. `aiRecipeHelperUsageCount` resets when this rolls
   * over to a new day.
   */
  aiRecipeHelperUsageDay?: string;
  /** Count of AI calls made during [aiRecipeHelperUsageDay]. */
  aiRecipeHelperUsageCount?: number;
  /** Lifetime count across all AI features. */
  aiTotalMessagesSent?: number;
  /** Lifetime per-feature counters. */
  aiGenerateCount?: number;
  aiSubstitutionsCount?: number;
  aiFormatCount?: number;
  /** Timestamp of the most recent successful AI call. */
  aiLastUsedAt?: Date;
  /**
   * True for synthetic accounts created by the seed-data pipeline. Seed users
   * have unusable Firebase UIDs (`seed-{cuisine}-{n}`) and exist solely to
   * populate the discovery feed during early launch. Visible-only on the
   * admin Seed Data tab; hidden from public lists like follow suggestions.
   */
  isSeed?: boolean;
  /** Where the seed user came from. Useful for filtering in the admin tab. */
  seedSource?: "themealdb" | "curated";
  /** Canonical cuisine the seed user belongs to (e.g., "Lebanese"). */
  seedCuisine?: string;
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
    savedRecipesCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    remixesCount: {
      type: Number,
      default: 0,
      min: 0,
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
      enum: ["monthly", "annual", "admin"],
    },
    premiumExpiresAt: { type: Date },
    premiumGrantedBy: {
      type: Schema.Types.ObjectId,
      ref: "AdminUser",
    },
    premiumGrantedAt: { type: Date },
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
        recipe_saved: { type: Boolean, default: true },
        recipe_shared: { type: Boolean, default: true },
        schedule_suggestion: { type: Boolean, default: true },
        suggestion_approved: { type: Boolean, default: true },
        suggestion_denied: { type: Boolean, default: true },
        kitchen_invite: { type: Boolean, default: true },
        kitchen_invite_received: { type: Boolean, default: true },
        kitchen_invite_accepted: { type: Boolean, default: true },
        kitchen_invite_declined: { type: Boolean, default: true },
        kitchen_joined: { type: Boolean, default: true },
        kitchen_removed: { type: Boolean, default: true },
        kitchen_lead_transferred: { type: Boolean, default: true },
        recipe_cooked: { type: Boolean, default: true },
        cooked_post_removed: { type: Boolean, default: true },
        passport_stamp: { type: Boolean, default: true },
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
    timezoneOffsetMinutes: { type: Number },
    aiRecipeHelperUsageDay: { type: String },
    aiRecipeHelperUsageCount: { type: Number, default: 0 },
    aiTotalMessagesSent: { type: Number, default: 0 },
    aiGenerateCount: { type: Number, default: 0 },
    aiSubstitutionsCount: { type: Number, default: 0 },
    aiFormatCount: { type: Number, default: 0 },
    aiLastUsedAt: { type: Date },
    isSeed: { type: Boolean, default: false, index: true },
    seedSource: { type: String, enum: ["themealdb", "curated"] },
    seedCuisine: { type: String, index: true },
  },
  {
    timestamps: true,
  }
);

// Text index for search by name
userSchema.index({ fullName: "text" });

// Compound index used by the admin Seed Data table when grouping by cuisine.
userSchema.index({ isSeed: 1, seedCuisine: 1 });

const User = (mongoose.models.User as mongoose.Model<IUser>) ||
  mongoose.model<IUser>("User", userSchema);

export default User;
