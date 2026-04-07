/**
 * Recipe import service.
 *
 * Fetches a URL, extracts structured Recipe data from the page's JSON-LD
 * (schema.org/Recipe), and maps it to the Chefless recipe shape so the
 * client can pre-fill the creation form.
 *
 * No external packages needed — uses the Node 18+ built-in `fetch`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportedIngredient {
  name: string;
  quantity: number;
  unit: string;
}

export interface ImportedStep {
  order: number;
  instruction: string;
}

export interface ImportedRecipe {
  title: string;
  description?: string;
  prepTime?: number; // minutes
  cookTime?: number; // minutes
  servings?: number;
  ingredients: ImportedIngredient[];
  steps: ImportedStep[];
  dietaryTags: string[];
  cuisineTags: string[];
  sourceUrl: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Fetches [url] and attempts to extract a schema.org/Recipe definition.
 * Throws a descriptive error if the URL is unreachable or contains no recipe
 * data.
 */
export async function importRecipeFromUrl(url: string): Promise<ImportedRecipe> {
  validateUrl(url);

  let html: string;
  try {
    const response = await fetch(url, {
      headers: {
        // Polite user-agent — some sites block empty UA strings.
        "User-Agent":
          "Mozilla/5.0 (compatible; Chefless/1.0; +https://chefless.app)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });

    if (!response.ok) {
      throw new Error(`Page responded with HTTP ${response.status}`);
    }

    html = await response.text();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch URL: ${msg}`);
  }

  const schema = extractRecipeSchema(html);
  if (!schema) {
    throw new Error(
      "No recipe data found on that page. The site may not use structured data, " +
        "or the URL may not point to a recipe."
    );
  }

  return mapSchemaToRecipe(schema, url);
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  // Block private / loopback / link-local addresses to prevent SSRF.
  const hostname = parsed.hostname.toLowerCase();

  // Strip IPv6 brackets if present
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

  const isBlocked =
    // Loopback
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("127.") ||
    // Link-local (AWS metadata, Azure IMDS, GCP metadata)
    host.startsWith("169.254.") ||
    // Private class A
    host.startsWith("10.") ||
    // Private class B (172.16.0.0 – 172.31.255.255)
    isPrivateClassB(host) ||
    // Private class C
    host.startsWith("192.168.") ||
    // Multicast
    isMulticast(host) ||
    // Reserved
    isReserved(host) ||
    // Unspecified
    host === "0.0.0.0" ||
    // IPv6 loopback
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    // IPv4-mapped IPv6 loopback/private
    isIPv4MappedPrivate(host) ||
    // IPv6 link-local
    host.startsWith("fe80:") ||
    // IPv6 unique local
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    // IPv6 unspecified
    host === "::" ||
    host === "0:0:0:0:0:0:0:0";

  if (isBlocked) {
    throw new Error("That URL is not accessible.");
  }
}

function isPrivateClassB(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const second = parseInt(parts[1], 10);
  return parts[0] === "172" && second >= 16 && second <= 31;
}

function isMulticast(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const first = parseInt(parts[0], 10);
  return first >= 224 && first <= 239;
}

function isReserved(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const first = parseInt(parts[0], 10);
  return first >= 240;
}

function isIPv4MappedPrivate(host: string): boolean {
  // Matches ::ffff:127.0.0.1, ::ffff:10.x.x.x, etc.
  const match = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (!match) return false;
  const ipv4 = match[1];
  return (
    ipv4.startsWith("127.") ||
    ipv4.startsWith("10.") ||
    ipv4.startsWith("192.168.") ||
    ipv4.startsWith("169.254.") ||
    ipv4 === "0.0.0.0" ||
    isPrivateClassB(ipv4) ||
    isMulticast(ipv4) ||
    isReserved(ipv4)
  );
}

// ---------------------------------------------------------------------------
// JSON-LD extraction
// ---------------------------------------------------------------------------

/**
 * Finds all <script type="application/ld+json"> blocks in [html], parses each
 * one, and returns the first object (or @graph item) whose @type is "Recipe".
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractRecipeSchema(html: string): Record<string, any> | null {
  const scriptRegex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const raw = match[1].trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const recipe = findRecipeInObject(parsed);
    if (recipe) return recipe;
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRecipeInObject(obj: unknown): Record<string, any> | null {
  if (!obj || typeof obj !== "object") return null;

  // Direct @type: "Recipe"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asRecord = obj as Record<string, any>;
  if (isRecipeType(asRecord["@type"])) {
    return asRecord;
  }

  // @graph array (e.g. on sites that bundle multiple schemas in one block)
  if (Array.isArray(asRecord["@graph"])) {
    for (const item of asRecord["@graph"]) {
      const found = findRecipeInObject(item);
      if (found) return found;
    }
  }

  // Top-level array
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findRecipeInObject(item);
      if (found) return found;
    }
  }

  return null;
}

function isRecipeType(type: unknown): boolean {
  if (!type) return false;
  const normalize = (t: string) =>
    t.toLowerCase().replace("http://schema.org/", "").replace("https://schema.org/", "");
  if (typeof type === "string") return normalize(type) === "recipe";
  if (Array.isArray(type)) return type.some((t) => typeof t === "string" && normalize(t) === "recipe");
  return false;
}

// ---------------------------------------------------------------------------
// Mapping schema → Chefless recipe
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSchemaToRecipe(schema: Record<string, any>, sourceUrl: string): ImportedRecipe {
  const title = getString(schema.name) ?? getString(schema.headline) ?? "Imported Recipe";

  const description = getString(schema.description);

  const prepTime = parseDurationMinutes(schema.prepTime);
  const cookTime = parseDurationMinutes(schema.cookTime);

  const servings = parseServings(schema.recipeYield);

  const ingredients = parseIngredients(schema.recipeIngredient);
  const steps = parseSteps(schema.recipeInstructions);

  const dietaryTags = parseDietaryTags(schema.suitableForDiet);
  const cuisineTags = parseCuisineTags(schema.recipeCuisine);

  return {
    title: title.trim().slice(0, 200),
    description: description?.trim().slice(0, 500),
    prepTime,
    cookTime,
    servings,
    ingredients,
    steps,
    dietaryTags,
    cuisineTags,
    sourceUrl,
  };
}

// ---------------------------------------------------------------------------
// Field parsers
// ---------------------------------------------------------------------------

function getString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/**
 * Parses ISO 8601 duration strings like "PT15M", "PT1H30M" into minutes.
 */
function parseDurationMinutes(value: unknown): number | undefined {
  const str = getString(value);
  if (!str) return undefined;

  const match = str.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return undefined;

  const days = parseInt(match[1] ?? "0");
  const hours = parseInt(match[2] ?? "0");
  const minutes = parseInt(match[3] ?? "0");
  const seconds = parseInt(match[4] ?? "0");

  const total = days * 1440 + hours * 60 + minutes + Math.round(seconds / 60);
  return total > 0 ? total : undefined;
}

function parseServings(value: unknown): number | undefined {
  if (typeof value === "number") return Math.round(value);
  const str = getString(value);
  if (!str) return undefined;
  // Handle "4 servings", "4-6", "4" etc.
  const match = str.match(/(\d+)/);
  if (!match) return undefined;
  const n = parseInt(match[1]);
  return n > 0 ? n : undefined;
}

function parseIngredients(value: unknown): ImportedIngredient[] {
  if (!Array.isArray(value)) return [];

  const result: ImportedIngredient[] = [];

  for (const item of value) {
    const raw = typeof item === "string" ? item : getString(item);
    if (!raw) continue;

    const parsed = parseIngredientString(raw.trim());
    if (parsed) {
      result.push(parsed);
    } else {
      // Can't parse quantity/unit — store the whole string as name with quantity 1.
      result.push({ name: raw.trim().slice(0, 200), quantity: 1, unit: "item" });
    }
  }

  return result;
}

/**
 * Very simple ingredient line parser.
 * Handles patterns like "2 cups flour", "1/2 tsp salt", "3 large eggs".
 */
function parseIngredientString(raw: string): ImportedIngredient | null {
  // Match: optional number (int or fraction), optional unit, rest = name.
  const match = raw.match(
    /^([\d./]+\s*(?:–|-|to)\s*[\d./]+|[\d./]+)?\s*([a-zA-Z]{1,20})?\s+(.*)/
  );
  if (!match) return null;

  const quantityRaw = match[1]?.trim();
  const unitRaw = match[2]?.trim().toLowerCase();
  const nameRaw = match[3]?.trim();

  if (!nameRaw) return null;

  const quantity = quantityRaw ? parseFraction(quantityRaw) : 1;
  const unit = unitRaw && isUnit(unitRaw) ? unitRaw : "item";
  const name = unitRaw && !isUnit(unitRaw)
    ? `${unitRaw} ${nameRaw}`.trim()
    : nameRaw;

  return {
    name: name.slice(0, 200),
    quantity: Math.max(quantity, 0),
    unit: unit.slice(0, 50),
  };
}

function parseFraction(str: string): number {
  // Handle range "1-2" or "1 to 2" → take lower bound.
  const rangeParts = str.split(/\s*(?:–|-|to)\s*/);
  const part = rangeParts[0].trim();

  if (part.includes("/")) {
    const [num, den] = part.split("/").map(Number);
    if (!isNaN(num) && !isNaN(den) && den !== 0) return num / den;
  }
  const n = parseFloat(part);
  return isNaN(n) ? 1 : n;
}

const COMMON_UNITS = new Set([
  "cup", "cups", "tbsp", "tablespoon", "tablespoons",
  "tsp", "teaspoon", "teaspoons", "oz", "ounce", "ounces",
  "lb", "lbs", "pound", "pounds", "g", "gram", "grams",
  "kg", "kilogram", "kilograms", "ml", "l", "liter", "liters",
  "clove", "cloves", "slice", "slices", "can", "cans",
  "bunch", "bunch", "stalk", "stalks", "head", "heads",
  "piece", "pieces", "medium", "large", "small", "whole",
  "pinch", "dash", "handful", "package", "packet",
]);

function isUnit(word: string): boolean {
  return COMMON_UNITS.has(word.toLowerCase());
}

function parseSteps(value: unknown): ImportedStep[] {
  if (!Array.isArray(value)) {
    // Some sites use a single string for instructions.
    const str = getString(value);
    if (str) {
      return [{ order: 1, instruction: str.trim().slice(0, 5000) }];
    }
    return [];
  }

  const result: ImportedStep[] = [];
  let order = 1;

  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      result.push({ order: order++, instruction: item.trim().slice(0, 5000) });
    } else if (typeof item === "object" && item !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = item as Record<string, any>;
      const type = (getString(obj["@type"]) ?? "").toLowerCase();

      if (type === "howtostep" || !type) {
        const text = getString(obj.text) ?? getString(obj.name);
        if (text?.trim()) {
          result.push({ order: order++, instruction: text.trim().slice(0, 5000) });
        }
      } else if (type === "howtosection") {
        // Section contains an array of steps.
        const nested = parseSteps(obj.itemListElement);
        for (const step of nested) {
          result.push({ order: order++, instruction: step.instruction });
        }
      }
    }
  }

  return result;
}

const DIETARY_MAP: Record<string, string> = {
  "https://schema.org/VeganDiet": "vegan",
  "https://schema.org/VegetarianDiet": "vegetarian",
  "https://schema.org/GlutenFreeDiet": "gluten-free",
  "https://schema.org/HalalDiet": "halal",
  "https://schema.org/KosherDiet": "kosher",
  "https://schema.org/DiabeticDiet": "diabetic",
  "https://schema.org/LowCalorieDiet": "low-calorie",
  "https://schema.org/LowFatDiet": "low-fat",
  "https://schema.org/LowLactoseDiet": "dairy-free",
  "https://schema.org/LowSaltDiet": "low-sodium",
};

function parseDietaryTags(value: unknown): string[] {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  const tags: string[] = [];

  for (const item of items) {
    const str = typeof item === "string" ? item : getString(item);
    if (!str) continue;
    const mapped = DIETARY_MAP[str] ?? str.toLowerCase().replace(/https?:\/\/schema\.org\//i, "").replace("diet", "").trim();
    if (mapped) tags.push(mapped);
  }

  return [...new Set(tags)].slice(0, 10);
}

function parseCuisineTags(value: unknown): string[] {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  const tags: string[] = [];

  for (const item of items) {
    const str = (typeof item === "string" ? item : getString(item))?.trim();
    if (str && str.length <= 50) {
      tags.push(str.slice(0, 50));
    }
  }

  return [...new Set(tags)].slice(0, 10);
}
