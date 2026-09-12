export const CANONICAL_DIETS = [
  "Halal",
  "Vegetarian",
  "Vegan",
  "Pescatarian",
  "Gluten-Free",
  "Dairy-Free",
  "Nut-Free",
  "Egg-Free",
  "Soy-Free",
  "Shellfish-Free",
  "Low Sugar",
  "Low Sodium",
  "Low Carb",
  "High Protein",
  "Keto",
  "Paleo",
  "Low FODMAP",
  "Kosher",
] as const;

const CANONICAL_DIET_BY_LOWER = new Map<string, string>(
  CANONICAL_DIETS.map((d) => [d.toLowerCase(), d])
);

export function canonicalDiet(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return CANONICAL_DIET_BY_LOWER.get(trimmed.toLowerCase()) ?? null;
}

export const CANONICAL_MEAL_LABELS = [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "dessert",
  "drink",
] as const;
