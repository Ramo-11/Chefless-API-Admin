import mongoose, { Schema, Document, Types } from "mongoose";

export type ClientErrorPlatform = "ios" | "android" | "web";
export type ClientErrorStatus = "new" | "triaged" | "resolved" | "ignored";
export type ClientErrorSource =
  | "flutter_error"
  | "platform_error"
  | "widget_build"
  | "auth_google"
  | "auth_apple"
  | "auth_email"
  | "manual"
  | "other";

export interface IClientError extends Document {
  _id: Types.ObjectId;
  fingerprint: string;
  platform: ClientErrorPlatform;
  source: ClientErrorSource;
  exception: string;
  reason?: string;
  stack?: string;
  route?: string;
  appVersion?: string;
  buildMode?: string;
  osVersion?: string;
  deviceModel?: string;
  userId?: Types.ObjectId;
  firebaseUid?: string;
  userEmail?: string;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  status: ClientErrorStatus;
  adminNote?: string;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const clientErrorSchema = new Schema<IClientError>(
  {
    // Hash of (platform + appVersion + source + first 2 lines of exception)
    // so the same crash on the same build collapses into one row with a
    // bumped occurrences counter instead of N duplicate rows.
    fingerprint: { type: String, required: true, index: true },
    platform: {
      type: String,
      enum: ["ios", "android", "web"],
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: [
        "flutter_error",
        "platform_error",
        "widget_build",
        "auth_google",
        "auth_apple",
        "auth_email",
        "manual",
        "other",
      ],
      default: "other",
      index: true,
    },
    exception: { type: String, required: true, maxlength: 4000 },
    reason: { type: String, maxlength: 500 },
    stack: { type: String, maxlength: 20000 },
    route: { type: String, maxlength: 500 },
    appVersion: { type: String, maxlength: 50 },
    buildMode: { type: String, maxlength: 30 },
    osVersion: { type: String, maxlength: 100 },
    deviceModel: { type: String, maxlength: 200 },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    firebaseUid: { type: String, maxlength: 128 },
    userEmail: { type: String, maxlength: 320, lowercase: true, trim: true },
    occurrences: { type: Number, default: 1, min: 1 },
    firstSeenAt: { type: Date, required: true, default: Date.now },
    lastSeenAt: { type: Date, required: true, default: Date.now, index: true },
    status: {
      type: String,
      enum: ["new", "triaged", "resolved", "ignored"],
      default: "new",
      index: true,
    },
    adminNote: { type: String, maxlength: 2000 },
    resolvedAt: { type: Date },
  },
  { timestamps: true }
);

clientErrorSchema.index({ status: 1, lastSeenAt: -1 });
clientErrorSchema.index({ fingerprint: 1, status: 1 });

const ClientError =
  (mongoose.models.ClientError as mongoose.Model<IClientError>) ||
  mongoose.model<IClientError>("ClientError", clientErrorSchema);

export default ClientError;
