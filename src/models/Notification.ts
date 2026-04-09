import mongoose, { Schema, Document, Types } from "mongoose";

export const NOTIFICATION_TYPES = [
  "new_follower",
  "follow_request",
  "follow_accepted",
  "recipe_liked",
  "recipe_forked",
  "recipe_shared",
  "schedule_suggestion",
  "suggestion_approved",
  "suggestion_denied",
  "kitchen_invite", // Welcome / invite receipt for members who join a kitchen
  "kitchen_joined",
  "kitchen_removed",
  "system",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface INotification extends Document {
  _id: Types.ObjectId;
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
  isRead: boolean;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    actorName: { type: String, trim: true },
    actorPhoto: { type: String },
    recipeId: {
      type: Schema.Types.ObjectId,
      ref: "Recipe",
    },
    recipeTitle: { type: String, trim: true },
    shareMessage: { type: String, trim: true, maxlength: 500 },
    kitchenId: {
      type: Schema.Types.ObjectId,
      ref: "Kitchen",
    },
    kitchenName: { type: String, trim: true },
    scheduleEntryId: {
      type: Schema.Types.ObjectId,
      ref: "ScheduleEntry",
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Compound index for fetching user's notifications: unread first, then by date
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

// For counting unread
notificationSchema.index({ userId: 1 });

// Pagination index
notificationSchema.index({ userId: 1, createdAt: -1 });

// TTL: auto-delete notifications older than 90 days
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }
);

const Notification =
  (mongoose.models.Notification as mongoose.Model<INotification>) ||
  mongoose.model<INotification>("Notification", notificationSchema);

export default Notification;
