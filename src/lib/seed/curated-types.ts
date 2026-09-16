export interface CuratedRecipe {
  title: string;
  description: string;
  ingredients: Array<{ name: string; quantity: number; unit: string }>;
  steps: string[];
  tags: string[];
  dietaryTags?: string[];
  difficulty: "easy" | "medium" | "hard";
  prepTime: number;
  cookTime: number;
  servings: number;
  image?: string;
  imageAlt?: string;
  imageQuery?: string;
  imageSourceId?: number;
}

export interface CuratedCuisineData {
  cuisine: string;
  names: { first: string[]; last: string[] };
  recipes: CuratedRecipe[];
}
