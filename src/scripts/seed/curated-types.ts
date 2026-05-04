/**
 * Schema for the per-cuisine curated JSON files in `data/`. One file per
 * cuisine, hand-curated by subagents from real, named, traditional dishes.
 */

export interface CuratedRecipe {
  /**
   * Canonical English name of the dish — must match a real dish so we can
   * find a Wikipedia/Commons photo of it (e.g., "Koshari", "Pad See Ew").
   */
  title: string;
  description: string;
  ingredients: Array<{ name: string; quantity: number; unit: string }>;
  /** Ordered cooking steps. Each step is one full instruction. */
  steps: string[];
  tags: string[];
  dietaryTags?: string[];
  difficulty: "easy" | "medium" | "hard";
  prepTime: number;
  cookTime: number;
  servings: number;
}

export interface CuratedCuisineData {
  /** Canonical cuisine name (e.g., "Lebanese") matching `lib/cuisines.ts`. */
  cuisine: string;
  /** Culturally-authentic name pools used to generate seed user names. */
  names: { first: string[]; last: string[] };
  /** Real, named, traditional dishes from this cuisine. */
  recipes: CuratedRecipe[];
}
