import mongoose, { Schema, Document, Types } from "mongoose";

export interface IIngredient {
  name: string;
  quantity: number;
  unit: string;
  group?: string;
}

export interface IStep {
  order: number;
  instruction: string;
  photo?: string;
}

export interface IForkedFrom {
  /** Nulled out when the origin recipe is deleted; authorName is preserved for attribution. */
  recipeId: Types.ObjectId | null;
  authorId: Types.ObjectId | null;
  authorName: string;
}

export interface IRecipe extends Document {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  title: string;
  description?: string;
  story?: string;
  photos: string[];
  showSignature: boolean;
  labels: string[];
  dietaryTags: string[];
  cuisineTags: string[];
  tags: string[];
  difficulty?: "easy" | "medium" | "hard";
  ingredients: IIngredient[];
  steps: IStep[];
  prepTime?: number;
  cookTime?: number;
  totalTime?: number;
  servings?: number;
  calories?: number;
  costEstimate?: "budget" | "moderate" | "expensive";
  baseServings: number;
  forkedFrom?: IForkedFrom;
  /**
   * Snapshot of the origin author's signature image at the moment this remix
   * was created. Preserved on the remix document itself so the original chef's
   * mark stays visible even if they later remove their signature, change it,
   * or delete the source recipe. Only populated for remixes whose origin
   * author had a signature on file at fork time.
   */
  originalSignatureUrl?: string;
  isModifiedFork: boolean;
  isPrivate: boolean;
  isHidden: boolean;
  reportsCount: number;
  seasonalTags: string[];
  likesCount: number;
  forksCount: number;
  /** Denormalized mean of ratings visible globally (only public-visibility kitchens + solo cooks contribute). */
  avgRating: number;
  /** Count of ratings feeding `avgRating`. Zero when no public ratings exist. */
  ratingCount: number;
  isFeatured: boolean;
  featuredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  /** True when this recipe was inserted by the seed-data pipeline. */
  isSeed?: boolean;
  /** Origin source (themealdb = real api, curated = subagent-curated). */
  seedSource?: "themealdb" | "curated";
  /** Canonical cuisine assigned at seed time. Mirrors `cuisineTags[0]`. */
  seedCuisine?: string;
  /** External id from TheMealDB (e.g. "52772") for de-duping on re-runs. */
  seedExternalId?: string;
}

const ingredientSchema = new Schema<IIngredient>(
  {
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true, trim: true },
    group: { type: String, trim: true },
  },
  { _id: false }
);

const stepSchema = new Schema<IStep>(
  {
    order: { type: Number, required: true },
    instruction: { type: String, required: true },
    photo: { type: String },
  },
  { _id: false }
);

const forkedFromSchema = new Schema<IForkedFrom>(
  {
    // Nullable: when the origin recipe is deleted we clear the ids but keep the attribution name.
    recipeId: {
      type: Schema.Types.ObjectId,
      ref: "Recipe",
      default: null,
    },
    authorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    authorName: { type: String, required: true },
  },
  { _id: false }
);

const recipeSchema = new Schema<IRecipe>(
  {
    authorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
    story: {
      type: String,
      trim: true,
      maxlength: 5000,
    },
    photos: {
      type: [String],
      default: [],
      validate: {
        validator: (val: string[]) => val.length <= 5,
        message: "Maximum 5 photos allowed",
      },
    },
    showSignature: {
      type: Boolean,
      default: false,
    },
    labels: {
      type: [String],
      default: [],
      index: true,
    },
    dietaryTags: {
      type: [String],
      default: [],
      index: true,
    },
    cuisineTags: {
      type: [String],
      default: [],
      index: true,
    },
    tags: {
      type: [String],
      default: [],
      index: true,
    },
    difficulty: {
      type: String,
      enum: ["easy", "medium", "hard"],
    },
    ingredients: {
      type: [ingredientSchema],
      default: [],
    },
    steps: {
      type: [stepSchema],
      default: [],
    },
    prepTime: { type: Number, min: 0 },
    cookTime: { type: Number, min: 0 },
    totalTime: { type: Number, min: 0 },
    servings: { type: Number, min: 1 },
    calories: { type: Number, min: 0 },
    costEstimate: {
      type: String,
      enum: ["budget", "moderate", "expensive"],
    },
    baseServings: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    forkedFrom: {
      type: forkedFromSchema,
    },
    originalSignatureUrl: {
      type: String,
    },
    isModifiedFork: {
      type: Boolean,
      default: false,
    },
    isPrivate: {
      type: Boolean,
      default: false,
    },
    isHidden: {
      type: Boolean,
      default: false,
    },
    reportsCount: {
      type: Number,
      default: 0,
    },
    seasonalTags: {
      type: [String],
      default: [],
    },
    likesCount: {
      type: Number,
      default: 0,
    },
    forksCount: {
      type: Number,
      default: 0,
    },
    avgRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    ratingCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    isFeatured: {
      type: Boolean,
      default: false,
      index: true,
    },
    featuredAt: {
      type: Date,
    },
    isSeed: { type: Boolean, default: false, index: true },
    seedSource: { type: String, enum: ["themealdb", "curated"] },
    seedCuisine: { type: String, index: true },
    seedExternalId: { type: String, index: true },
  },
  {
    timestamps: true,
  }
);

// Compound index for filtering author's recipes by privacy
recipeSchema.index({ authorId: 1, isPrivate: 1 });

// For querying forks of a recipe
recipeSchema.index({ "forkedFrom.recipeId": 1 });

// For sorting by popularity
recipeSchema.index({ likesCount: -1 });

// For sorting by recency
recipeSchema.index({ createdAt: -1 });

// Text index for search
recipeSchema.index({ title: "text", "ingredients.name": "text" });

// Partial index for fast lookup of the currently featured recipe
recipeSchema.index(
  { isFeatured: 1 },
  { partialFilterExpression: { isFeatured: true } }
);

// Compound index for admin Seed Data grouping queries.
recipeSchema.index({ isSeed: 1, seedCuisine: 1 });

const Recipe =
  (mongoose.models.Recipe as mongoose.Model<IRecipe>) ||
  mongoose.model<IRecipe>("Recipe", recipeSchema);

export default Recipe;
