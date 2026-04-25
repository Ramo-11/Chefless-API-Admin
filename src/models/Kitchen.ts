import mongoose, { Schema, Document, Types } from "mongoose";

export interface IKitchen extends Document {
  _id: Types.ObjectId;
  name: string;
  leadId: Types.ObjectId;
  inviteCode: string;
  /**
   * When the current `inviteCode` stops being accepted by `joinKitchen`.
   * Undefined for kitchens created before the expiry feature shipped
   * (grandfathered — treated as non-expiring). New kitchens and regenerated
   * codes always get a concrete expiry.
   */
  inviteCodeExpiresAt?: Date;
  photo?: string;
  isPublic: boolean;
  membersWithScheduleEdit: Types.ObjectId[];
  membersWithApprovalPower: Types.ObjectId[];
  memberCount: number;
  /** Custom meal slot names added by the kitchen lead (e.g. "Pre-Workout", "Late Night"). */
  customMealSlots: string[];
  /**
   * Lowercase-canonical names of default meal slots the lead has chosen to hide
   * for this kitchen. Subset of `DEFAULT_MEAL_SLOTS`. Empty by default — every
   * default surfaces to members until the lead opts a slot out. Hiding a slot
   * removes it from the schedule grid and from `mealSlotOrder` (in lockstep).
   */
  hiddenDefaultSlots: string[];
  /**
   * Kitchen-preferred display order for all meal slots (defaults + customs).
   * When set, this is the single source of truth for sorting on the home
   * glance strip and the schedule screen. When `undefined` (grandfathered
   * kitchens that pre-date the reorder feature), clients fall back to
   * `[...defaults, ...customMealSlots]`.
   *
   * Server-side invariant: whenever `customMealSlots` is mutated, if
   * `mealSlotOrder` is set it is spliced in lockstep — never allowed to
   * desync from the set of slots actually in use.
   */
  mealSlotOrder?: string[];
  /**
   * Controls who can reorder `mealSlotOrder`.
   * - `"lead_only"` (default): only the kitchen lead.
   * - `"editors"`: lead + members in `membersWithScheduleEdit`.
   * - `"all"`: any kitchen member.
   */
  slotOrderEditPolicy: "lead_only" | "editors" | "all";
  /**
   * Controls who can add schedule entries directly.
   * - `"lead_only"`: only the lead and members in `membersWithScheduleEdit` add directly;
   *   everyone else's additions become suggestions awaiting approval.
   * - `"all"`: any kitchen member adds entries directly (confirmed).
   */
  scheduleAddPolicy: "lead_only" | "all";
  /**
   * Controls visibility of member ratings on recipes cooked through this kitchen.
   * - `"public"`: ratings feed the recipe's global `avgRating` and are visible to anyone.
   * - `"kitchen_only"`: ratings only power the kitchen's internal aggregate; the public stays at zero.
   * - `"off"`: rating prompts are disabled entirely for this kitchen.
   */
  ratingsVisibility: "public" | "kitchen_only" | "off";
  /**
   * When true (default) and `isPublic` is true, non-member discoverers see the
   * member list on the public kitchen view. When false, the member count is
   * still shown but individual names/avatars are hidden. Private kitchens
   * never expose members to non-members regardless of this flag.
   */
  showMembersPublicly: boolean;
  /**
   * When false, members who are not in `membersWithScheduleEdit` cannot
   * propose meals to the kitchen schedule. The lead (and editors) can still
   * add directly. Independent of `scheduleAddPolicy` — this closes the
   * "suggest" escape hatch entirely.
   */
  allowMemberSuggestions: boolean;
  /**
   * When false, AI-powered weekly plan suggestions are disabled for the
   * kitchen. Currently reserved for the upcoming smart-planner feature;
   * persisted now so the lead can opt out before rollout.
   */
  allowAutoScheduleSuggestions: boolean;
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
    inviteCodeExpiresAt: {
      type: Date,
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
    customMealSlots: {
      type: [String],
      default: [],
      validate: {
        validator: (v: string[]) => v.length <= 20,
        message: "Maximum 20 custom meal slots allowed",
      },
    },
    hiddenDefaultSlots: {
      type: [String],
      default: [],
      validate: {
        // Allowed values are the four canonical defaults — bound by name AND
        // count so a malformed write can't silently grow the array.
        validator: (v: string[]) =>
          v.length <= 4 &&
          v.every((s) =>
            ["breakfast", "lunch", "dinner", "snack"].includes(
              s.trim().toLowerCase()
            )
          ),
        message:
          "hiddenDefaultSlots may only contain breakfast, lunch, dinner, or snack",
      },
    },
    mealSlotOrder: {
      type: [String],
      validate: {
        // 4 defaults + 20 max customs = 24; small cushion so the validator
        // doesn't trip when the API pre-validates the set-equality check.
        validator: (v: string[]) => !v || v.length <= 30,
        message: "mealSlotOrder may contain at most 30 entries",
      },
    },
    slotOrderEditPolicy: {
      type: String,
      enum: ["lead_only", "editors", "all"],
      default: "lead_only",
    },
    scheduleAddPolicy: {
      type: String,
      enum: ["lead_only", "all"],
      default: "lead_only",
    },
    ratingsVisibility: {
      type: String,
      enum: ["public", "kitchen_only", "off"],
      default: "kitchen_only",
    },
    showMembersPublicly: {
      type: Boolean,
      default: true,
    },
    allowMemberSuggestions: {
      type: Boolean,
      default: true,
    },
    allowAutoScheduleSuggestions: {
      type: Boolean,
      default: true,
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
