import { describe, it, expect } from "vitest";
import {
  generateFromSchedule,
  refreshFromSchedule,
  toggleItem,
} from "../../services/shopping-list-service";
import { createTestRecipe, createTestUser } from "../helpers";
import ScheduleEntry from "../../models/ScheduleEntry";

async function createRecipeWithUnitlessIngredients(authorId: Parameters<typeof createTestRecipe>[0]["authorId"]) {
  const recipe = await createTestRecipe({ authorId });
  recipe.servings = 4;
  recipe.set("ingredients", [
    { name: "Eggs", quantity: 4, unit: "" },
    { name: "Onion", quantity: 1 },
    { name: "Salt", quantity: 1, unit: "tsp" },
  ]);
  await recipe.save();
  return recipe;
}

describe("shopping lists from a plan with ingredients that have no unit", () => {
  it("generates a linked list when a planned recipe counts eggs and onions without a unit, which recipes have been allowed to save since 1.3", async () => {
    const user = await createTestUser();
    const recipe = await createRecipeWithUnitlessIngredients(user._id);
    await ScheduleEntry.create({
      userId: user._id,
      date: new Date("2026-08-02T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 8,
      status: "confirmed",
    });

    const generated = await generateFromSchedule(user._id.toString(), {
      scope: "personal",
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-07T23:59:59.000Z"),
    });

    const byName = new Map(generated.list.items.map((item) => [item.name, item]));
    expect(generated.list.items).toHaveLength(3);
    expect(byName.get("Eggs")?.quantity).toBe(8);
    expect(byName.get("Eggs")?.unit).toBe("");
    expect(byName.get("Eggs")?.scheduleSource?.unit).toBe("");
    expect(byName.get("Onion")?.quantity).toBe(2);
    expect(byName.get("Onion")?.scheduleSource?.unit).toBe("");
    expect(byName.get("Salt")?.scheduleSource?.unit).toBe("tsp");
  });

  it("refreshes that list after the plan changes and keeps a checked unitless item checked", async () => {
    const user = await createTestUser();
    const recipe = await createRecipeWithUnitlessIngredients(user._id);
    const entry = await ScheduleEntry.create({
      userId: user._id,
      date: new Date("2026-08-02T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), {
      scope: "personal",
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-07T23:59:59.000Z"),
    });
    const eggs = generated.list.items.find((item) => item.name === "Eggs");
    const checked = await toggleItem(
      generated.list._id.toString(),
      user._id.toString(),
      eggs!._id.toString()
    );
    await ScheduleEntry.updateOne({ _id: entry._id }, { $set: { servings: 12 } });

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      checked.revision
    );

    const refreshedEggs = refreshed.list.items.find((item) => item.name === "Eggs");
    expect(refreshed.list.items).toHaveLength(3);
    expect(refreshedEggs?.quantity).toBe(12);
    expect(refreshedEggs?.unit).toBe("");
    expect(refreshedEggs?.isChecked).toBe(true);
  });
});
