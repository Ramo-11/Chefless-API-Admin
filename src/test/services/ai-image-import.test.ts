import { describe, expect, it } from "vitest";
import { imageImportInstruction, parseImageRecipeResponse } from "../../services/ai-recipe-service";

describe("AI image recipe import", () => {
  it("preserves unknown quantities without inventing values", () => {
    const result = parseImageRecipeResponse(JSON.stringify({
      outcome: "recipe",
      recipe: {
        title: "Family soup",
        ingredients: [
          { name: "Tomatoes", quantity: 0, unit: "" },
          { name: "Stock", quantity: 2, unit: "cups" },
        ],
        steps: [{ order: 3, instruction: "Simmer until tender." }],
      },
      missingFields: ["quantity for tomatoes"],
      warnings: ["The first ingredient quantity was not visible."],
    }));

    expect(result?.recipe.ingredients[0]).toEqual({
      name: "Tomatoes",
      quantity: 0,
      unit: "",
    });
    expect(result?.missingFields).toEqual(["quantity for tomatoes"]);
  });

  it("accepts a useful partial recipe and normalizes step order", () => {
    const result = parseImageRecipeResponse(JSON.stringify({
      outcome: "recipe",
      recipe: {
        title: "Bread",
        ingredients: [{ name: "Flour", quantity: 500, unit: "g" }],
        steps: [
          { order: 4, instruction: "Bake." },
          { order: 2, instruction: "Mix." },
        ],
      },
      missingFields: ["oven temperature"],
      warnings: ["The final line was cut off."],
    }));

    expect(result?.recipe.steps).toEqual([
      { order: 1, instruction: "Mix." },
      { order: 2, instruction: "Bake." },
    ]);
    expect(result?.warnings).toEqual(["The final line was cut off."]);
  });

  it("keeps a recipe whose missing servings, times, description, and tags come back as null", () => {
    const result = parseImageRecipeResponse(JSON.stringify({
      outcome: "recipe",
      recipe: {
        title: "Guacamole",
        description: null,
        servings: null,
        prepTime: null,
        cookTime: null,
        ingredients: [{ name: "Avocados", quantity: 4, unit: "" }],
        steps: [{ order: 1, instruction: "Halve and pit the avocados." }],
        dietaryTags: null,
        cuisineTags: null,
      },
      missingFields: ["servings", "prepTime", "cookTime"],
      warnings: null,
    }));

    expect(result).not.toBeNull();
    expect(result?.recipe.title).toBe("Guacamole");
    expect(result?.recipe.servings).toBeUndefined();
    expect(result?.recipe.prepTime).toBeUndefined();
    expect(result?.recipe.cookTime).toBeUndefined();
    expect(result?.recipe.description).toBeUndefined();
    expect(result?.recipe.dietaryTags).toEqual([]);
    expect(result?.recipe.cuisineTags).toEqual([]);
    expect(result?.missingFields).toEqual(["servings", "prepTime", "cookTime"]);
    expect(result?.warnings).toEqual([]);
  });

  it("reads a fenced JSON reply with null optional fields", () => {
    const body = JSON.stringify({
      outcome: "recipe",
      recipe: {
        title: "Guacamole",
        servings: null,
        ingredients: [{ name: "Lime", quantity: 0.5, unit: "" }],
        steps: [{ order: 1, instruction: "Add the lime juice." }],
      },
      missingFields: [],
      warnings: [],
    }, null, 2);

    expect(parseImageRecipeResponse(`\`\`\`json\n${body}\n\`\`\``)?.recipe.ingredients[0]).toEqual({
      name: "Lime",
      quantity: 0.5,
      unit: "",
    });
  });

  it("keeps the recipe and treats a zero serving count or a negative time as not shown", () => {
    const result = parseImageRecipeResponse(JSON.stringify({
      outcome: "recipe",
      recipe: {
        title: "Guacamole",
        servings: 0,
        prepTime: -5,
        cookTime: 0,
        ingredients: [{ name: "Avocados", quantity: 4, unit: "" }],
        steps: [{ order: 1, instruction: "Mash the avocados." }],
      },
      missingFields: ["The serving count is not shown."],
      warnings: [],
    }));

    expect(result).not.toBeNull();
    expect(result?.recipe.servings).toBeUndefined();
    expect(result?.recipe.prepTime).toBeUndefined();
    expect(result?.recipe.cookTime).toBe(0);
  });

  it("asks for review notes in the app language when a supported locale is sent", () => {
    expect(imageImportInstruction("ar")).toContain("Write every missingFields and warnings entry in Arabic.");
    expect(imageImportInstruction("tr")).toContain("in Turkish.");
    expect(imageImportInstruction("es-MX")).toContain("in Spanish.");
    expect(imageImportInstruction("EN")).toContain("in English.");
    expect(imageImportInstruction("ar")).toContain("Keep the recipe itself in its source language.");
  });

  it("keeps the original instruction for old apps and unsupported locales", () => {
    const original = "Read these recipe images in order and return the structured result.";
    expect(imageImportInstruction()).toBe(original);
    expect(imageImportInstruction("fr")).toBe(original);
    expect(imageImportInstruction("")).toBe(original);
  });

  it.each([
    { outcome: "no_recipe", reason: "blank" },
    { outcome: "no_recipe", reason: "not_a_recipe" },
    { outcome: "no_recipe", reason: "illegible" },
  ])("rejects $reason image results", (response) => {
    expect(parseImageRecipeResponse(JSON.stringify(response))).toBeNull();
  });

  it("rejects malformed and unusable successful results", () => {
    expect(parseImageRecipeResponse("not json")).toBeNull();
    expect(parseImageRecipeResponse(JSON.stringify({
      outcome: "recipe",
      recipe: { title: "Soup", ingredients: [], steps: [] },
      missingFields: [],
      warnings: [],
    }))).toBeNull();
  });
});
