import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * EmailCampaign — a record of one bulk email send to the early-access list.
 * Stores the exact content sent and the delivery outcome so the admin team has
 * an auditable history of what went out to contacts.
 */
export type EmailCampaignStatus = "sending" | "sent" | "partial" | "failed";

export interface IEmailCampaign extends Document {
  _id: Types.ObjectId;
  subject: string;
  /** The raw body the admin typed (plain text, may contain {{firstName}}). */
  body: string;
  status: EmailCampaignStatus;
  recipientCount: number;
  sentCount: number;
  failedCount: number;
  sentByEmail: string;
  /** First error message encountered, surfaced in the UI for partial/failed. */
  errorSummary?: string;
  createdAt: Date;
  updatedAt: Date;
}

const emailCampaignSchema = new Schema<IEmailCampaign>(
  {
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 20000 },
    status: {
      type: String,
      enum: ["sending", "sent", "partial", "failed"],
      default: "sending",
      index: true,
    },
    recipientCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    sentByEmail: { type: String, required: true, trim: true },
    errorSummary: { type: String, trim: true },
  },
  { timestamps: true }
);

emailCampaignSchema.index({ createdAt: -1 });

const EmailCampaign =
  (mongoose.models.EmailCampaign as mongoose.Model<IEmailCampaign>) ||
  mongoose.model<IEmailCampaign>("EmailCampaign", emailCampaignSchema);

export default EmailCampaign;
