import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Permanent ledger of every billable Claude call the API makes.
 *
 * One row per model invocation, with the exact token counts Anthropic
 * returned and the dollar cost computed at insert time from the model's
 * published per-token pricing (so later price changes never rewrite
 * history). Powers the admin AI cost/usage analytics. Rows only exist from
 * the day this shipped; calls made before then were never token-tracked and
 * cannot be backfilled.
 */
export type AiUsageFeature = "generate" | "substitutions" | "format" | "import" | "ask";

export interface IAiUsageEvent extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  feature: AiUsageFeature;
  /** Anthropic model ID, e.g. "claude-haiku-4-5". Named modelId because
   * mongoose Document already reserves `model`. */
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  createdAt: Date;
}

const aiUsageEventSchema = new Schema<IAiUsageEvent>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    feature: {
      type: String,
      required: true,
      enum: ["generate", "substitutions", "format", "import", "ask"],
    },
    modelId: { type: String, required: true },
    inputTokens: { type: Number, required: true, default: 0 },
    outputTokens: { type: Number, required: true, default: 0 },
    cacheCreationTokens: { type: Number, required: true, default: 0 },
    cacheReadTokens: { type: Number, required: true, default: 0 },
    costUsd: { type: Number, required: true, default: 0 },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

const AiUsageEvent =
  (mongoose.models.AiUsageEvent as mongoose.Model<IAiUsageEvent>) ||
  mongoose.model<IAiUsageEvent>("AiUsageEvent", aiUsageEventSchema);

export default AiUsageEvent;
