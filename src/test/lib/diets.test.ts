import { describe, expect, it } from "vitest";
import { CANONICAL_DIETS, CANONICAL_MEAL_LABELS, canonicalDiet } from "../../lib/diets";

describe("canonicalDiet", () => {
  it("returns the canonical casing for an exact match", () => {
    expect(canonicalDiet("Vegan")).toBe("Vegan");
  });

  it("matches case-insensitively", () => {
    expect(canonicalDiet("gluten-free")).toBe("Gluten-Free");
    expect(canonicalDiet("GLUTEN-FREE")).toBe("Gluten-Free");
  });

  it("trims surrounding whitespace", () => {
    expect(canonicalDiet("  Halal  ")).toBe("Halal");
  });

  it("returns null for an unrecognized diet", () => {
    expect(canonicalDiet("carnivore")).toBeNull();
  });

  it("returns null for an empty or whitespace-only string", () => {
    expect(canonicalDiet("")).toBeNull();
    expect(canonicalDiet("   ")).toBeNull();
  });

  it("resolves every value in CANONICAL_DIETS back to itself", () => {
    for (const diet of CANONICAL_DIETS) {
      expect(canonicalDiet(diet.toLowerCase())).toBe(diet);
    }
  });
});

describe("CANONICAL_MEAL_LABELS", () => {
  it("lists the six meal labels in order", () => {
    expect(CANONICAL_MEAL_LABELS).toEqual([
      "breakfast",
      "lunch",
      "dinner",
      "snack",
      "dessert",
      "drink",
    ]);
  });
});
