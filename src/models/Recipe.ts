import mongoose, { Schema, Document, Types } from "mongoose";
import { normalizeIngredientName } from "../lib/ingredients";

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

export type RecipeSourceType =
  | "website"
  | "instagram"
  | "tiktok"
  | "youtube"
  | "pinterest"
  | "facebook"
  | "other";

/**
 * External provenance for an imported recipe. Drives the "Imported from {site}"
 * badge on the recipe detail screen, which links back to the original post.
 * `importedVia` records whether the recipe came from structured JSON-LD (free)
 * or from an AI pass over a social caption.
 */
export interface IRecipeSource {
  type: RecipeSourceType;
  url: string;
  siteName?: string;
  author?: string;
  importedVia: "structured" | "ai";
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
  normalizedIngredients: string[];
  steps: IStep[];
  prepTime?: number;
  cookTime?: number;
  totalTime?: number;
  servings?: number;
  calories?: number;
  costEstimate?: "budget" | "moderate" | "expensive";
  baseServings: number;
  forkedFrom?: IForkedFrom;
  /** Set when the recipe was imported from an external URL (website or social post). */
  source?: IRecipeSource;
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
  /** Denormalized count of non-deleted comments and replies on this recipe. */
  commentsCount: number;
  /** Denormalized mean of ratings visible globally (only public-visibility kitchens + solo cooks contribute). */
  avgRating: number;
  /** Count of ratings feeding `avgRating`. Zero when no public ratings exist. */
  ratingCount: number;
  isFeatured: boolean;
  featuredAt?: Date;
  trendingScore: number;
  trendingScoreUpdatedAt?: Date;
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

export function computeNormalizedIngredients(
  ingredients: Array<{ name: string }>
): string[] {
  const set = new Set<string>();
  for (const ingredient of ingredients ?? []) {
    const normalized = normalizeIngredientName(ingredient.name ?? "");
    if (normalized) set.add(normalized);
  }
  return Array.from(set);
}

const ingredientSchema = new Schema<IIngredient>(
  {
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true },
    unit: { type: String, default: "", trim: true },
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

const recipeSourceSchema = new Schema<IRecipeSource>(
  {
    type: {
      type: String,
      required: true,
      enum: [
        "website",
        "instagram",
        "tiktok",
        "youtube",
        "pinterest",
        "facebook",
        "other",
      ],
    },
    url: { type: String, required: true, trim: true },
    siteName: { type: String, trim: true },
    author: { type: String, trim: true },
    importedVia: {
      type: String,
      required: true,
      enum: ["structured", "ai"],
    },
  },
  { _id: false }
);

const recipeSchema = new Schema<IRecipe>(
  {
    authorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
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
    normalizedIngredients: {
      type: [String],
      default: [],
      index: true,
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
    source: {
      type: recipeSourceSchema,
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
      index: true,
    },
    likesCount: {
      type: Number,
      default: 0,
    },
    forksCount: {
      type: Number,
      default: 0,
    },
    commentsCount: {
      type: Number,
      default: 0,
      min: 0,
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
    },
    featuredAt: {
      type: Date,
    },
    trendingScore: {
      type: Number,
      default: 0,
    },
    trendingScoreUpdatedAt: {
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

// Exact ingredient-name lookups for pantry matching ("what can I cook").
recipeSchema.index({ "ingredients.name": 1 });

// Partial index for fast lookup of the currently featured recipe
recipeSchema.index(
  { isFeatured: 1 },
  { partialFilterExpression: { isFeatured: true } }
);

// Compound index for admin Seed Data grouping queries.
recipeSchema.index({ isSeed: 1, seedCuisine: 1 });

recipeSchema.index({ isHidden: 1, cuisineTags: 1, likesCount: -1 });
recipeSchema.index({ isHidden: 1, dietaryTags: 1, likesCount: -1 });
recipeSchema.index({ isHidden: 1, difficulty: 1, likesCount: -1 });
recipeSchema.index({ isHidden: 1, avgRating: -1, ratingCount: 1 });
recipeSchema.index({ isHidden: 1, seasonalTags: 1, likesCount: -1 });

recipeSchema.index({ trendingScore: -1 });

recipeSchema.pre("save", function (next) {
  if (this.isNew || this.isModified("ingredients")) {
    this.normalizedIngredients = computeNormalizedIngredients(this.ingredients);
  }
  next();
});

recipeSchema.pre(
  ["updateOne", "findOneAndUpdate", "updateMany"],
  function (next) {
    const update = this.getUpdate() as Record<string, unknown> | null;
    if (!update) return next();

    const setBlock = update.$set as Record<string, unknown> | undefined;
    if (setBlock && Array.isArray(setBlock.ingredients)) {
      setBlock.normalizedIngredients = computeNormalizedIngredients(
        setBlock.ingredients as Array<{ name: string }>
      );
    } else if (Array.isArray(update.ingredients)) {
      update.normalizedIngredients = computeNormalizedIngredients(
        update.ingredients as Array<{ name: string }>
      );
    }

    next();
  }
);

recipeSchema.pre("insertMany", function (next, docs) {
  if (Array.isArray(docs)) {
    for (const doc of docs as Array<Record<string, unknown>>) {
      if (doc && Array.isArray(doc.ingredients)) {
        doc.normalizedIngredients = computeNormalizedIngredients(
          doc.ingredients as Array<{ name: string }>
        );
      }
    }
  }
  next();
});

const Recipe =
  (mongoose.models.Recipe as mongoose.Model<IRecipe>) ||
  mongoose.model<IRecipe>("Recipe", recipeSchema);

export default Recipe;
