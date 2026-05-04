/**
 * Per-cuisine seed quotas + TheMealDB ↔ Chefless cuisine mapping.
 *
 * The pipeline runs in two passes:
 *   1. Pull every recipe from TheMealDB for areas we recognise.
 *   2. For any cuisine that TheMealDB doesn't cover (or under-fills), pull
 *      from `data/{cuisine}.json` (curated by subagents — real, named dishes).
 *
 * Quotas are weighted so flagship cuisines fill the discovery feed and
 * niche cuisines still get representation.
 */
import { CUISINE_REGIONS } from "../../lib/cuisines";

/** Tier defines how many seed accounts + recipes the cuisine should get. */
export type CuisineTier = "flagship" | "core" | "standard" | "niche";

export interface CuisineQuota {
  cuisine: string;
  tier: CuisineTier;
  /** Number of seed users to create. */
  accounts: number;
  /** Total recipes for this cuisine, distributed across the accounts. */
  recipes: number;
  /** TheMealDB area name if the API has a matching region; null otherwise. */
  mealdbArea: string | null;
}

const TIER_QUOTAS: Record<CuisineTier, { accounts: number; recipes: number }> = {
  flagship: { accounts: 5, recipes: 25 },
  core: { accounts: 4, recipes: 16 },
  standard: { accounts: 3, recipes: 12 },
  niche: { accounts: 3, recipes: 9 },
};

/**
 * TheMealDB exposes ~28 areas. Our taxonomy has 77 cuisines. This map covers
 * exact 1:1 matches. Cuisines absent from this map are fulfilled entirely
 * from curated JSON in `data/`.
 */
const MEALDB_AREA_BY_CUISINE: Record<string, string> = {
  American: "American",
  British: "British",
  Canadian: "Canadian",
  Chinese: "Chinese",
  Dutch: "Dutch",
  Egyptian: "Egyptian",
  Filipino: "Filipino",
  French: "French",
  Greek: "Greek",
  Indian: "Indian",
  Italian: "Italian",
  Jamaican: "Jamaican",
  Japanese: "Japanese",
  Kenyan: "Kenyan",
  Malaysian: "Malaysian",
  Mexican: "Mexican",
  Moroccan: "Moroccan",
  Polish: "Polish",
  Portuguese: "Portuguese",
  Russian: "Russian",
  Spanish: "Spanish",
  Thai: "Thai",
  Tunisian: "Tunisian",
  Turkish: "Turkish",
  Ukrainian: "Ukrainian",
  Vietnamese: "Vietnamese",
};

/** Flagship — global staples that dominate the discovery feed. */
const FLAGSHIP = new Set([
  "Italian",
  "Indian",
  "Chinese",
  "Mexican",
  "Japanese",
  "Thai",
  "French",
  "American",
  "Lebanese",
  "Greek",
]);

/** Core — large, well-recognised cuisines just below flagship. */
const CORE = new Set([
  "Spanish",
  "Korean",
  "Vietnamese",
  "Turkish",
  "Moroccan",
  "Persian",
  "Pakistani",
  "Brazilian",
  "Egyptian",
  "Ethiopian",
  "British",
  "Filipino",
  "Indonesian",
  "Peruvian",
  "Portuguese",
]);

/** Niche — smaller cuisines that should still be represented. */
const NICHE = new Set([
  "Trinidadian",
  "Salvadoran",
  "Haitian",
  "Puerto Rican",
  "Polynesian",
  "Hawaiian",
  "New Zealand",
  "Tanzanian",
  "Sudanese",
  "Somali",
  "Senegalese",
  "Burmese",
  "Cambodian",
  "Singaporean",
  "Taiwanese",
  "Sri Lankan",
  "Bangladeshi",
  "Nepali",
  "Afghan",
  "Yemeni",
  "Emirati",
  "Algerian",
  "Belgian",
  "Swiss",
  "Austrian",
  "Hungarian",
  "Georgian",
]);

function tierFor(cuisine: string): CuisineTier {
  if (FLAGSHIP.has(cuisine)) return "flagship";
  if (CORE.has(cuisine)) return "core";
  if (NICHE.has(cuisine)) return "niche";
  return "standard";
}

/** Full quota plan, one entry per cuisine in our taxonomy. */
export const CUISINE_QUOTAS: readonly CuisineQuota[] = CUISINE_REGIONS.flatMap(
  (region) =>
    region.cuisines.map((cuisine) => {
      const tier = tierFor(cuisine);
      return {
        cuisine,
        tier,
        accounts: TIER_QUOTAS[tier].accounts,
        recipes: TIER_QUOTAS[tier].recipes,
        mealdbArea: MEALDB_AREA_BY_CUISINE[cuisine] ?? null,
      };
    })
);

/** Total target counts — useful for progress logging. */
export function totalTargets(): { users: number; recipes: number } {
  let users = 0;
  let recipes = 0;
  for (const q of CUISINE_QUOTAS) {
    users += q.accounts;
    recipes += q.recipes;
  }
  return { users, recipes };
}

/**
 * Distribute `total` recipes across `accounts` users as evenly as possible.
 * Returns the recipe count per account in user index order.
 */
export function recipesPerAccount(total: number, accounts: number): number[] {
  if (accounts <= 0) return [];
  const base = Math.floor(total / accounts);
  const remainder = total % accounts;
  return Array.from({ length: accounts }, (_, i) =>
    i < remainder ? base + 1 : base
  );
}
