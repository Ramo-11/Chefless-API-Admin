import { describe, expect, it } from "vitest";
import { parseImageRecipeResponse } from "../../services/ai-recipe-service";

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
