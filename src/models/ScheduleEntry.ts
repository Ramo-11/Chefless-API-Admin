import mongoose, { Schema, Document, Types } from "mongoose";

/** A member's dinner-attendance response on a kitchen schedule entry. */
export type RsvpStatus = "going" | "not_going";

export interface IScheduleRsvp {
  userId: Types.ObjectId;
  status: RsvpStatus;
}

export interface IScheduleEntry extends Document {
  _id: Types.ObjectId;
  kitchenId?: Types.ObjectId;
  userId: Types.ObjectId;
  date: Date;
  mealSlot: string;
  recipeId?: Types.ObjectId;
  recipeTitle?: string;
  recipePhoto?: string;
  recipeAuthorId?: Types.ObjectId;
  recipeAuthorName?: string;
  freeformText?: string;
  scheduledTime?: string;
  prepTime?: number;
  servings?: number;
  status: "confirmed" | "suggested";
  suggestedBy?: Types.ObjectId;
  confirmedBy?: Types.ObjectId;
  /**
   * Per-member dinner RSVPs. Only meaningful on kitchen entries (where
   * `kitchenId` is set) — personal entries never collect RSVPs. Each member
   * appears at most once; clearing an RSVP removes their entry.
   */
  rsvps: IScheduleRsvp[];
  /**
   * Timestamp when the user marked this entry as cooked. Null while pending.
   * Orthogonal to `status` — a confirmed plan only becomes a cooked plan
   * after the user acknowledges they actually made it.
   */
  cookedAt?: Date | null;
  /**
   * Timestamp when the user dismissed the "did you cook this?" prompt for
   * this entry. Persists across app restarts so a skipped prompt never
   * resurfaces. Null = never skipped.
   */
  ratingPromptSkippedAt?: Date | null;
  leftoverOfEntryId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Response-only flag (never persisted, not in the schema). Set to `true` when
   * the API withholds an entry's content from a free user because it falls on a
   * premium-locked future day — the client then renders an existence-only
   * "locked" teaser. See `redactLockedEntriesForFree` in schedule-service.
   */
  locked?: boolean;
  leftoverOfDate?: Date;
  leftoverCount?: number;
}

const scheduleEntrySchema = new Schema<IScheduleEntry>(
  {
    kitchenId: {
      type: Schema.Types.ObjectId,
      ref: "Kitchen",
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    mealSlot: {
      type: String,
      required: true,
      trim: true,
      maxlength: 50,
    },
    recipeId: {
      type: Schema.Types.ObjectId,
      ref: "Recipe",
    },
    recipeTitle: { type: String, trim: true },
    recipePhoto: { type: String },
    recipeAuthorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    recipeAuthorName: { type: String, trim: true },
    freeformText: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    scheduledTime: {
      type: String,
      trim: true,
      maxlength: 5,
    },
    prepTime: {
      type: Number,
      min: 0,
    },
    servings: {
      type: Number,
      min: 1,
      max: 100,
    },
    status: {
      type: String,
      enum: ["confirmed", "suggested"],
      required: true,
      default: "suggested",
    },
    suggestedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    confirmedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    rsvps: {
      type: [
        new Schema<IScheduleRsvp>(
          {
            userId: {
              type: Schema.Types.ObjectId,
              ref: "User",
              required: true,
            },
            status: {
              type: String,
              enum: ["going", "not_going"],
              required: true,
            },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    cookedAt: {
      type: Date,
      default: null,
    },
    ratingPromptSkippedAt: {
      type: Date,
      default: null,
    },
    leftoverOfEntryId: {
      type: Schema.Types.ObjectId,
      ref: "ScheduleEntry",
    },
  },
  {
    timestamps: true,
  }
);

// Lets the cook-prompt surfacer cheaply find "entries past their date that
// haven't been cooked yet" per user.
scheduleEntrySchema.index({ userId: 1, cookedAt: 1, date: 1 });

// Compound index for querying entries by kitchen and date range
scheduleEntrySchema.index({ kitchenId: 1, date: 1 });

// For querying pending suggestions by kitchen
scheduleEntrySchema.index({ kitchenId: 1, status: 1 });

// For querying personal schedule entries by user and date range
scheduleEntrySchema.index({ userId: 1, date: 1 });

// For querying suggestions by user
scheduleEntrySchema.index({ suggestedBy: 1 });

scheduleEntrySchema.index({ recipeId: 1 });

scheduleEntrySchema.index({ leftoverOfEntryId: 1 });

const ScheduleEntry =
  (mongoose.models.ScheduleEntry as mongoose.Model<IScheduleEntry>) ||
  mongoose.model<IScheduleEntry>("ScheduleEntry", scheduleEntrySchema);

export default ScheduleEntry;
