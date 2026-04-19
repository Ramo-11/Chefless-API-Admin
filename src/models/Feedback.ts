import mongoose, { Schema, Document, Types } from "mongoose";

export type FeedbackCategory =
  | "bug"
  | "idea"
  | "improvement"
  | "praise"
  | "other";
export type FeedbackPlatform = "ios" | "android" | "web";
export type FeedbackStatus = "new" | "triaged" | "resolved" | "archived";

export interface IFeedback extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  userEmail: string;
  userName: string;
  category: FeedbackCategory;
  message: string;
  appVersion?: string;
  platform?: FeedbackPlatform;
  status: FeedbackStatus;
  adminNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

const feedbackSchema = new Schema<IFeedback>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userEmail: {
      type: String,
      required: true,
      trim: true,
    },
    userName: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ["bug", "idea", "improvement", "praise", "other"],
      default: "other",
      index: true,
    },
    message: {
      type: String,
      required: true,
      minlength: 10,
      maxlength: 2000,
      trim: true,
    },
    appVersion: {
      type: String,
      trim: true,
    },
    platform: {
      type: String,
      enum: ["ios", "android", "web"],
    },
    status: {
      type: String,
      enum: ["new", "triaged", "resolved", "archived"],
      default: "new",
      index: true,
    },
    adminNote: {
      type: String,
      maxlength: 2000,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// For listing feedback by recency (admin queue, user's "my feedback")
feedbackSchema.index({ createdAt: -1 });

const Feedback =
  (mongoose.models.Feedback as mongoose.Model<IFeedback>) ||
  mongoose.model<IFeedback>("Feedback", feedbackSchema);

export default Feedback;
