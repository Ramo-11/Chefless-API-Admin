import mongoose, { Schema, Document, Types } from "mongoose";
import {
  ClientErrorPlatform,
  ClientErrorSource,
} from "./ClientError";

export interface IIgnoredErrorFingerprint extends Document {
  _id: Types.ObjectId;
  fingerprint: string;
  platform: ClientErrorPlatform;
  source: ClientErrorSource;
  exception: string;
  reason?: string;
  ignoredBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const ignoredErrorFingerprintSchema = new Schema<IIgnoredErrorFingerprint>(
  {
    fingerprint: { type: String, required: true, unique: true, index: true },
    platform: {
      type: String,
      enum: ["ios", "android", "web"],
      required: true,
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
      required: true,
    },
    exception: { type: String, required: true, maxlength: 4000 },
    reason: { type: String, maxlength: 500 },
    ignoredBy: { type: String, required: true, maxlength: 320 },
  },
  { timestamps: true }
);

const IgnoredErrorFingerprint =
  (mongoose.models
    .IgnoredErrorFingerprint as mongoose.Model<IIgnoredErrorFingerprint>) ||
  mongoose.model<IIgnoredErrorFingerprint>(
    "IgnoredErrorFingerprint",
    ignoredErrorFingerprintSchema
  );

export default IgnoredErrorFingerprint;
