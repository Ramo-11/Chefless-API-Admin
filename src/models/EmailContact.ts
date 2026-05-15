import mongoose, { Schema, Document, Types } from "mongoose";
import { randomBytes } from "crypto";

/**
 * EmailContact — a marketing/early-access contact, imported from the Google
 * Form early-signup sheet. This collection is intentionally SEPARATE from the
 * `User` collection: these people are not app accounts. Nothing here is linked
 * to app data, auth, or privacy rules.
 */
export type EmailContactStatus = "subscribed" | "unsubscribed" | "bounced";

export interface IEmailContact extends Document {
  _id: Types.ObjectId;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  /** Free-text answers carried over from the signup form, for reference only. */
  excitedAbout?: string;
  hearAbout?: string;
  notify?: string;
  ethnicity?: string;
  country?: string;
  phoneType?: string;
  /** When the person filled out the form (the sheet's Timestamp column). */
  signedUpAt?: Date;
  /** Where this contact came from — e.g. "google_form". */
  source: string;
  status: EmailContactStatus;
  /**
   * True when the email address didn't pass basic validation on import
   * (e.g. the form respondent typed a space in the middle of their address).
   * The row is kept so nothing is lost; sends skip these contacts and the
   * admin UI surfaces a warning so the address can be fixed in place.
   */
  needsReview: boolean;
  /** Opaque token used in the public one-click unsubscribe link. */
  unsubToken: string;
  lastEmailedAt?: Date;
  emailsSent: number;
  createdAt: Date;
  updatedAt: Date;
}

const emailContactSchema = new Schema<IEmailContact>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    phone: { type: String, trim: true },
    excitedAbout: { type: String, trim: true },
    hearAbout: { type: String, trim: true },
    notify: { type: String, trim: true },
    ethnicity: { type: String, trim: true },
    country: { type: String, trim: true },
    phoneType: { type: String, trim: true },
    signedUpAt: { type: Date },
    source: { type: String, default: "google_form", trim: true },
    status: {
      type: String,
      enum: ["subscribed", "unsubscribed", "bounced"],
      default: "subscribed",
      index: true,
    },
    needsReview: { type: Boolean, default: false, index: true },
    unsubToken: {
      type: String,
      required: true,
      default: () => randomBytes(24).toString("hex"),
    },
    lastEmailedAt: { type: Date },
    emailsSent: { type: Number, default: 0 },
  },
  { timestamps: true }
);

emailContactSchema.index({ createdAt: -1 });

const EmailContact =
  (mongoose.models.EmailContact as mongoose.Model<IEmailContact>) ||
  mongoose.model<IEmailContact>("EmailContact", emailContactSchema);

export default EmailContact;
