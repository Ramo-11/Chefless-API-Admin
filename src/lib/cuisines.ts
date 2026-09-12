/**
 * Server-side cuisine metadata — region mapping + badge definitions used by
 * the Passport feature. The canonical cuisine list lives in the Flutter client
 * (`lib/utils/cuisine_data.dart`); this file mirrors only the structure the
 * server needs to detect region-completion and award stamps/badges.
 *
 * IMPORTANT: keep in sync with `chefless-app/lib/utils/cuisine_data.dart`
 * whenever new cuisines or regions are added.
 */

export interface CuisineRegion {
  id: string;
  name: string;
  emoji: string;
  cuisines: readonly string[];
}

export const CUISINE_REGIONS: readonly CuisineRegion[] = [
  {
    id: "mena",
    name: "Middle East & North Africa",
    emoji: "🕌",
    cuisines: [
      "Lebanese",
      "Palestinian",
      "Syrian",
      "Egyptian",
      "Moroccan",
      "Turkish",
      "Iraqi",
      "Jordanian",
      "Saudi",
      "Yemeni",
      "Emirati",
      "Tunisian",
      "Algerian",
      "Persian",
      "Kuwaiti",
      "Omani",
      "Bahraini",
      "Qatari",
      "Libyan",
      "Mauritanian",
    ],
  },
  {
    id: "east_se_asia",
    name: "East & Southeast Asia",
    emoji: "🏯",
    cuisines: [
      "Japanese",
      "Chinese",
      "Korean",
      "Thai",
      "Vietnamese",
      "Filipino",
      "Indonesian",
      "Malaysian",
      "Singaporean",
      "Taiwanese",
      "Cambodian",
      "Burmese",
      "Laotian",
      "Mongolian",
      "Bruneian",
      "Timorese",
    ],
  },
  {
    id: "south_asia",
    name: "South Asia",
    emoji: "🛕",
    cuisines: [
      "Indian",
      "Pakistani",
      "Sri Lankan",
      "Bangladeshi",
      "Nepali",
      "Afghan",
      "Bhutanese",
      "Maldivian",
    ],
  },
  {
    id: "central_asia",
    name: "Central Asia",
    emoji: "🏔️",
    cuisines: ["Uzbek", "Kazakh", "Kyrgyz", "Tajik", "Turkmen"],
  },
  {
    id: "europe",
    name: "Europe",
    emoji: "🏰",
    cuisines: [
      "Italian",
      "French",
      "Spanish",
      "Greek",
      "Portuguese",
      "German",
      "British",
      "Polish",
      "Swedish",
      "Hungarian",
      "Dutch",
      "Swiss",
      "Austrian",
      "Belgian",
      "Russian",
      "Ukrainian",
      "Georgian",
      "Romanian",
      "Bulgarian",
      "Czech",
      "Croatian",
      "Serbian",
      "Bosnian",
      "Albanian",
      "North Macedonian",
      "Slovenian",
      "Slovak",
      "Finnish",
      "Norwegian",
      "Danish",
      "Irish",
      "Lithuanian",
      "Latvian",
      "Estonian",
      "Montenegrin",
      "Moldovan",
      "Belarusian",
      "Cypriot",
      "Maltese",
      "Icelandic",
      "Armenian",
      "Azerbaijani",
    ],
  },
  {
    id: "americas",
    name: "Americas",
    emoji: "🗽",
    cuisines: [
      "American",
      "Mexican",
      "Brazilian",
      "Peruvian",
      "Argentine",
      "Colombian",
      "Cuban",
      "Jamaican",
      "Canadian",
      "Chilean",
      "Venezuelan",
      "Puerto Rican",
      "Salvadoran",
      "Haitian",
      "Trinidadian",
      "Ecuadorian",
      "Bolivian",
      "Paraguayan",
      "Uruguayan",
      "Guatemalan",
      "Honduran",
      "Nicaraguan",
      "Costa Rican",
      "Panamanian",
      "Dominican",
      "Guyanese",
      "Surinamese",
      "Barbadian",
      "Bahamian",
    ],
  },
  {
    id: "africa",
    name: "Africa",
    emoji: "🦁",
    cuisines: [
      "Ethiopian",
      "Nigerian",
      "South African",
      "Ghanaian",
      "Senegalese",
      "Kenyan",
      "Somali",
      "Tanzanian",
      "Sudanese",
      "Ugandan",
      "Rwandan",
      "Congolese",
      "Cameroonian",
      "Ivorian",
      "Malian",
      "Zimbabwean",
      "Mozambican",
      "Malagasy",
      "Eritrean",
      "Angolan",
      "Zambian",
      "Namibian",
      "Botswanan",
      "Mauritian",
      "Burkinabè",
      "Togolese",
      "Beninese",
      "Sierra Leonean",
      "Liberian",
      "Nigerien",
      "Chadian",
      "Gabonese",
      "Malawian",
      "Swazi",
      "Djiboutian",
      "Cape Verdean",
      "Seychellois",
      "Comoran",
    ],
  },
  {
    id: "oceania",
    name: "Oceania & Pacific",
    emoji: "🌺",
    cuisines: [
      "Australian",
      "New Zealand",
      "Hawaiian",
      "Polynesian",
      "Fijian",
      "Samoan",
      "Tongan",
      "Papua New Guinean",
    ],
  },
] as const;

/** Flat set of every known cuisine across all regions — used for validation. */
export const ALL_KNOWN_CUISINES: ReadonlySet<string> = new Set(
  CUISINE_REGIONS.flatMap((r) => r.cuisines)
);

/** Lowercase → canonical-case lookup so client inputs match server casing. */
const CANONICAL_CASE_BY_LOWER = new Map<string, string>(
  [...ALL_KNOWN_CUISINES].map((c) => [c.toLowerCase(), c])
);

/**
 * Normalize a user-supplied cuisine tag to its canonical form. Returns null
 * when the cuisine isn't recognised — the caller decides whether to drop it,
 * keep it as-is, or reject the request.
 */
export function canonicalCuisine(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return CANONICAL_CASE_BY_LOWER.get(trimmed.toLowerCase()) ?? null;
}

/** Returns the region object a cuisine belongs to, or null if unknown. */
export function regionForCuisine(cuisine: string): CuisineRegion | null {
  const canonical = canonicalCuisine(cuisine);
  if (!canonical) return null;
  for (const region of CUISINE_REGIONS) {
    if (region.cuisines.includes(canonical)) return region;
  }
  return null;
}

// ── Badges ──────────────────────────────────────────────────────────────
//
// Badges are awarded based on the set of unique cuisines a user has posted
// an "I Cooked It" for. Tiered global badges gamify breadth; regional badges
// reward completion of a geographic section.

export type BadgeTier = "bronze" | "silver" | "gold" | "legend";

export interface BadgeDefinition {
  id: string;
  title: string;
  subtitle: string;
  emoji: string;
  tier: BadgeTier;
  /**
   * Number of unique cuisines required (for global badges). For regional
   * badges this is derived at evaluation time (all cuisines in the region).
   */
  threshold?: number;
  /** Populated for regional badges; null for breadth badges. */
  regionId?: string;
}

export const GLOBAL_BADGES: readonly BadgeDefinition[] = [
  {
    id: "first_bite",
    title: "First Bite",
    subtitle: "Cooked your first dish.",
    emoji: "🥢",
    tier: "bronze",
    threshold: 1,
  },
  {
    id: "explorer",
    title: "Explorer",
    subtitle: "10 cuisines tasted.",
    emoji: "🧭",
    tier: "silver",
    threshold: 10,
  },
  {
    id: "globetrotter",
    title: "Globetrotter",
    subtitle: "25 cuisines tasted.",
    emoji: "🌍",
    tier: "gold",
    threshold: 25,
  },
  {
    id: "culinary_citizen",
    title: "Culinary Citizen",
    subtitle: "50 cuisines tasted.",
    emoji: "🎖️",
    tier: "gold",
    threshold: 50,
  },
  {
    id: "planet_eater",
    title: "Planet Eater",
    subtitle: "Every known cuisine — legendary.",
    emoji: "🪐",
    tier: "legend",
    threshold: ALL_KNOWN_CUISINES.size,
  },
] as const;

export const REGIONAL_BADGES: readonly BadgeDefinition[] = CUISINE_REGIONS.map(
  (region) => ({
    id: `region_${region.id}`,
    title: `${region.name} Master`,
    subtitle: `Cooked every ${region.name} cuisine.`,
    emoji: region.emoji,
    tier: "gold" as const,
    regionId: region.id,
  })
);

export const ALL_BADGES: readonly BadgeDefinition[] = [
  ...GLOBAL_BADGES,
  ...REGIONAL_BADGES,
];

/**
 * Returns the ids of every badge the user has earned given the set of unique
 * cuisines they've posted a cooked-it for.
 */
export function earnedBadgeIds(
  uniqueCuisines: ReadonlySet<string>
): Set<string> {
  const earned = new Set<string>();
  const size = uniqueCuisines.size;

  for (const badge of GLOBAL_BADGES) {
    if (badge.threshold !== undefined && size >= badge.threshold) {
      earned.add(badge.id);
    }
  }

  for (const region of CUISINE_REGIONS) {
    const complete = region.cuisines.every((c) => uniqueCuisines.has(c));
    if (complete) {
      earned.add(`region_${region.id}`);
    }
  }

  return earned;
}
