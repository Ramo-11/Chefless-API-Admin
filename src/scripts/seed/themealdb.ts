/**
 * TheMealDB ingest — fetches every recipe in a given area, normalizes to
 * Chefless's recipe shape, and returns ready-to-insert objects.
 *
 * TheMealDB is free, no API key required for the public test endpoint
 * (https://www.themealdb.com/api/json/v1/1/...). Rate-limit friendly: we
 * sleep 50ms between detail lookups to be polite.
 */

const BASE = "https://www.themealdb.com/api/json/v1/1";

interface MealdbListItem {
  idMeal: string;
  strMeal: string;
  strMealThumb: string;
}

interface MealdbDetail {
  idMeal: string;
  strMeal: string;
  strCategory: string | null;
  strArea: string | null;
  strInstructions: string;
  strMealThumb: string;
  strTags: string | null;
  strYoutube: string | null;
  // strIngredient1 .. strIngredient20, strMeasure1 .. strMeasure20
  [key: string]: string | null;
}

export interface NormalizedRecipe {
  externalId: string;
  title: string;
  description?: string;
  photos: string[];
  ingredients: Array<{ name: string; quantity: number; unit: string }>;
  steps: Array<{ order: number; instruction: string }>;
  cuisineTags: string[];
  tags: string[];
  difficulty?: "easy" | "medium" | "hard";
  servings?: number;
  baseServings: number;
  source: "themealdb" | "curated";
  cuisine: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return (await res.json()) as T;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function listMealsForArea(
  area: string
): Promise<MealdbListItem[]> {
  const url = `${BASE}/filter.php?a=${encodeURIComponent(area)}`;
  const data = await fetchJson<{ meals: MealdbListItem[] | null }>(url);
  return data.meals ?? [];
}

export async function fetchMealDetail(id: string): Promise<MealdbDetail | null> {
  const url = `${BASE}/lookup.php?i=${encodeURIComponent(id)}`;
  const data = await fetchJson<{ meals: MealdbDetail[] | null }>(url);
  return data.meals?.[0] ?? null;
}

/**
 * Parse a free-form measure string ("1 cup", "1/2 tsp", "200g", "to taste")
 * into a numeric quantity + unit. Falls back to quantity=1, unit=measure
 * when no number can be extracted.
 */
function parseMeasure(raw: string): { quantity: number; unit: string } {
  const text = raw.trim();
  if (!text) return { quantity: 1, unit: "to taste" };

  // Handle simple fractions like "1/2", "1 1/2"
  const fractionMatch = text.match(
    /^(?<whole>\d+)?\s*(?<num>\d+)\s*\/\s*(?<den>\d+)\s*(?<unit>.*)$/
  );
  if (fractionMatch?.groups) {
    const whole = fractionMatch.groups.whole
      ? parseInt(fractionMatch.groups.whole, 10)
      : 0;
    const num = parseInt(fractionMatch.groups.num, 10);
    const den = parseInt(fractionMatch.groups.den, 10);
    if (den > 0) {
      const qty = whole + num / den;
      const unit = fractionMatch.groups.unit.trim() || "pc";
      return { quantity: parseFloat(qty.toFixed(3)), unit };
    }
  }

  // Decimal or integer prefix like "200g", "1.5 tbsp"
  const numericMatch = text.match(/^(?<qty>\d+(?:\.\d+)?)\s*(?<unit>.*)$/);
  if (numericMatch?.groups) {
    const qty = parseFloat(numericMatch.groups.qty);
    const unit = numericMatch.groups.unit.trim() || "pc";
    return { quantity: qty, unit };
  }

  // No leading number — treat the entire string as a unit, qty 1.
  return { quantity: 1, unit: text };
}

/** Split TheMealDB's strInstructions field into ordered steps. */
function splitInstructions(raw: string): Array<{ order: number; instruction: string }> {
  const cleaned = raw
    .replace(/\r\n/g, "\n")
    .replace(/STEP\s*\d+\s*[:\-.]?\s*/gi, "")
    .trim();

  // Prefer paragraph splits; fall back to sentence splits if there's only
  // one giant blob.
  let parts = cleaned
    .split(/\n{2,}|\n(?=\d+[.)]\s)/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    parts = cleaned
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return parts.map((instruction, i) => ({
    order: i + 1,
    instruction: instruction.replace(/^\d+[.)]\s*/, ""),
  }));
}

function pullIngredients(
  detail: MealdbDetail
): Array<{ name: string; quantity: number; unit: string }> {
  const out: Array<{ name: string; quantity: number; unit: string }> = [];
  for (let i = 1; i <= 20; i += 1) {
    const name = (detail[`strIngredient${i}`] ?? "")?.toString().trim() ?? "";
    const measure = (detail[`strMeasure${i}`] ?? "")?.toString().trim() ?? "";
    if (!name) continue;
    const { quantity, unit } = parseMeasure(measure);
    out.push({ name, quantity, unit });
  }
  return out;
}

/** Pull every recipe for an area, normalize, and return as Chefless docs. */
export async function ingestArea(
  area: string,
  cuisine: string
): Promise<NormalizedRecipe[]> {
  const list = await listMealsForArea(area);
  const out: NormalizedRecipe[] = [];

  for (const item of list) {
    const detail = await fetchMealDetail(item.idMeal);
    if (!detail) continue;

    const ingredients = pullIngredients(detail);
    const steps = splitInstructions(detail.strInstructions ?? "");

    if (ingredients.length === 0 || steps.length === 0) continue;

    const tags = (detail.strTags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    out.push({
      externalId: `themealdb:${detail.idMeal}`,
      title: detail.strMeal,
      photos: detail.strMealThumb ? [detail.strMealThumb] : [],
      ingredients,
      steps,
      cuisineTags: [cuisine],
      tags,
      baseServings: 4,
      servings: 4,
      source: "themealdb",
      cuisine,
    });

    await sleep(50);
  }

  return out;
}
