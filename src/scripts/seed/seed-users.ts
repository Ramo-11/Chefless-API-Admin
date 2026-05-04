/**
 * Generate fake-but-real-looking seed users tied to a cuisine.
 *
 * Names come from the cuisine's curated name pool (see `data/{cuisine}.json`)
 * — culturally authentic, matches the food. Avatar URLs come from i.pravatar.cc
 * (free, deterministic by seed, real human stock photos). Each user has an
 * unusable Firebase UID so they can't ever log in but appear normally in
 * discovery.
 */
import type { CuratedCuisineData } from "./curated-types";

export interface SeedUserSpec {
  firebaseUid: string;
  email: string;
  fullName: string;
  bio: string;
  profilePicture: string;
  isPublic: true;
  onboardingComplete: true;
  isSeed: true;
  seedSource: "themealdb" | "curated";
  seedCuisine: string;
  cuisinePreferences: string[];
}

const BIO_TEMPLATES: readonly string[] = [
  "Cooking my way around %CUISINE% — recipes from family, not Google.",
  "%CUISINE% home cook. Sharing the dishes I grew up on.",
  "Lifelong love of %CUISINE% food. Always testing, always tasting.",
  "Old recipes, new takes. %CUISINE% kitchen.",
  "%CUISINE% flavors, weeknight friendly.",
  "Learning %CUISINE% cooking from my grandmother and writing it down.",
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length];
}

/**
 * Build a deterministic user spec for a given cuisine + index. Determinism
 * matters so re-runs hit the same emails/UIDs and the upsert logic in the
 * seed script doesn't create duplicates.
 */
export function buildSeedUser(
  data: CuratedCuisineData,
  index: number,
  source: "themealdb" | "curated"
): SeedUserSpec {
  const first = pick(data.names.first, index);
  const last = pick(data.names.last, index * 7 + 3);
  const fullName = `${first} ${last}`;
  const slug = slugify(`${data.cuisine}-${first}-${last}-${index}`);
  const firebaseUid = `seed-${slug}`;
  const email = `${slug}@seed.chefless.test`;
  const bio = pick(BIO_TEMPLATES, index).replace("%CUISINE%", data.cuisine);

  // Pravatar provides a deterministic real-photo avatar per seed string.
  // 300×300 is plenty for the in-app circle render; the CDN is HTTPS + fast.
  const profilePicture = `https://i.pravatar.cc/300?u=${encodeURIComponent(firebaseUid)}`;

  return {
    firebaseUid,
    email,
    fullName,
    bio,
    profilePicture,
    isPublic: true,
    onboardingComplete: true,
    isSeed: true,
    seedSource: source,
    seedCuisine: data.cuisine,
    cuisinePreferences: [data.cuisine],
  };
}
