import mongoose, { Schema, Document, Types } from "mongoose";

export interface IRecipeShare extends Document {
  _id: Types.ObjectId;
  senderId: Types.ObjectId;
  recipientId: Types.ObjectId;
  recipeId: Types.ObjectId;
  message?: string;
  createdAt: Date;
}

const recipeShareSchema = new Schema<IRecipeShare>(
  {
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    recipientId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    recipeId: {
      type: Schema.Types.ObjectId,
      ref: "Recipe",
      required: true,
    },
    message: {
      type: String,
      maxlength: 500,
      trim: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// Unique index to prevent duplicate shares of the same recipe between same users
recipeShareSchema.index(
  { senderId: 1, recipientId: 1, recipeId: 1 },
  { unique: true }
);

// TTL: auto-delete shares older than 365 days
recipeShareSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 365 * 24 * 60 * 60 }
);

const RecipeShare =
  (mongoose.models.RecipeShare as mongoose.Model<IRecipeShare>) ||
  mongoose.model<IRecipeShare>("RecipeShare", recipeShareSchema);

export default RecipeShare;
