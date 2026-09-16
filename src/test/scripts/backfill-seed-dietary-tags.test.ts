import { describe, expect, it } from "vitest";
import { buildDietaryTagsMap } from "../../scripts/backfill-seed-dietary-tags";
import type { CuratedCuisineData, CuratedRecipe } from "../../lib/seed/curated-types";

function makeRecipe(title: string, dietaryTags?: string[]): CuratedRecipe {
  return {
    title,
    description: "A dish.",
    ingredients: [],
    steps: [],
    tags: [],
    dietaryTags,
    difficulty: "easy",
    prepTime: 10,
    cookTime: 10,
    servings: 4,
  };
}

function makeFile(cuisine: string, recipes: CuratedRecipe[]): CuratedCuisineData {
  return { cuisine, names: { first: [], last: [] }, recipes };
}

describe("buildDietaryTagsMap", () => {
  it("maps a curated recipe's dietary tags to their canonical casing, keyed by its seedExternalId", () => {
    const { map, skippedUnknownTag } = buildDietaryTagsMap([
      makeFile("Lebanese", [makeRecipe("Tabbouleh", ["vegetarian", "gluten-free"])]),
    ]);

    expect(map.get("curated:tabbouleh")).toEqual(["Vegetarian", "Gluten-Free"]);
    expect(skippedUnknownTag).toBe(0);
  });

  it("dedupes duplicate canonical tags on the same recipe", () => {
    const { map } = buildDietaryTagsMap([
      makeFile("Lebanese", [makeRecipe("Hummus", ["vegan", "Vegan", "VEGAN"])]),
    ]);

    expect(map.get("curated:hummus")).toEqual(["Vegan"]);
  });

  it("drops an unrecognized tag but keeps the recognized ones", () => {
    const { map, skippedUnknownTag } = buildDietaryTagsMap([
      makeFile("Lebanese", [makeRecipe("Fattoush", ["vegetarian", "carnivore"])]),
    ]);

    expect(map.get("curated:fattoush")).toEqual(["Vegetarian"]);
    expect(skippedUnknownTag).toBe(0);
  });

  it("skips a recipe whose every tag is unrecognized, and counts it", () => {
    const { map, skippedUnknownTag } = buildDietaryTagsMap([
      makeFile("Lebanese", [makeRecipe("Mystery Dish", ["carnivore", "keto-ish"])]),
    ]);

    expect(map.has("curated:mystery_dish")).toBe(false);
    expect(skippedUnknownTag).toBe(1);
  });

  it("omits a recipe with no dietaryTags at all, without counting it as skipped", () => {
    const { map, skippedUnknownTag } = buildDietaryTagsMap([
      makeFile("Lebanese", [makeRecipe("Plain Dish")]),
    ]);

    expect(map.has("curated:plain_dish")).toBe(false);
    expect(skippedUnknownTag).toBe(0);
  });

  it("combines recipes across multiple curated files", () => {
    const { map } = buildDietaryTagsMap([
      makeFile("Lebanese", [makeRecipe("Tabbouleh", ["vegetarian"])]),
      makeFile("Thai", [makeRecipe("Pad See Ew", ["pescatarian"])]),
    ]);

    expect(map.get("curated:tabbouleh")).toEqual(["Vegetarian"]);
    expect(map.get("curated:pad_see_ew")).toEqual(["Pescatarian"]);
    expect(map.size).toBe(2);
  });
});
