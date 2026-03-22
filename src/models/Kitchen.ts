import mongoose, { Schema, Document, Types } from "mongoose";

export interface IKitchen extends Document {
  _id: Types.ObjectId;
  name: string;
  leadId: Types.ObjectId;
  inviteCode: string;
  photo?: string;
  isPublic: boolean;
  membersWithScheduleEdit: Types.ObjectId[];
  membersWithApprovalPower: Types.ObjectId[];
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const kitchenSchema = new Schema<IKitchen>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    leadId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    inviteCode: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    photo: { type: String },
    isPublic: {
      type: Boolean,
      default: false,
      index: true,
    },
    membersWithScheduleEdit: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    membersWithApprovalPower: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    memberCount: {
      type: Number,
      default: 1,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

const Kitchen =
  (mongoose.models.Kitchen as mongoose.Model<IKitchen>) ||
  mongoose.model<IKitchen>("Kitchen", kitchenSchema);

export default Kitchen;
