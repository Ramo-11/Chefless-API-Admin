import { describe, it, expect } from "vitest";
import { Types } from "mongoose";
import {
  generateFromSchedule,
  refreshFromSchedule,
  toggleItem,
} from "../../services/shopping-list-service";
import { createTestRecipe, createTestUser } from "../helpers";
import ScheduleEntry from "../../models/ScheduleEntry";
import User from "../../models/User";

async function createUserInKitchen(kitchenId: Types.ObjectId) {
  const user = await createTestUser();
  await User.findByIdAndUpdate(user._id, { kitchenId });
  return user;
}

describe("shopping-list-service leftovers", () => {
  it("counts a leftover's recipe once, from the source's servings, for a personal plan", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    recipe.servings = 4;
    await recipe.save();
    const source = await ScheduleEntry.create({
      userId: user._id,
      date: new Date("2026-08-02T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    await ScheduleEntry.create({
      userId: user._id,
      date: new Date("2026-08-03T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      leftoverOfEntryId: source._id,
      status: "confirmed",
    });

    const generated = await generateFromSchedule(user._id.toString(), {
      scope: "personal",
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-07T23:59:59.000Z"),
    });

    expect(generated.list.items).toHaveLength(1);
    expect(generated.list.items[0].quantity).toBe(1);
  });

  it("counts a leftover's recipe once, from the source's servings, for a kitchen plan", async () => {
    const kitchenId = new Types.ObjectId();
    const user = await createUserInKitchen(kitchenId);
    const recipe = await createTestRecipe({ authorId: user._id });
    recipe.servings = 4;
    await recipe.save();
    const source = await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-08-02T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-08-03T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      leftoverOfEntryId: source._id,
      status: "confirmed",
    });

    const generated = await generateFromSchedule(user._id.toString(), {
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-07T23:59:59.000Z"),
    });

    expect(generated.list.items).toHaveLength(1);
    expect(generated.list.items[0].quantity).toBe(1);
  });

  it("raising the source's servings to cook extra covers both the meal and its leftover in one line", async () => {
    const kitchenId = new Types.ObjectId();
    const user = await createUserInKitchen(kitchenId);
    const recipe = await createTestRecipe({ authorId: user._id });
    recipe.servings = 4;
    await recipe.save();
    const source = await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-08-02T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 8,
      status: "confirmed",
    });
    await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-08-03T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 8,
      leftoverOfEntryId: source._id,
      status: "confirmed",
    });

    const generated = await generateFromSchedule(user._id.toString(), {
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-07T23:59:59.000Z"),
    });

    expect(generated.list.items).toHaveLength(1);
    expect(generated.list.items[0].quantity).toBe(2);
  });

  it("adding then removing a leftover after generation never changes the refreshed list, and checked items survive both refreshes", async () => {
    const kitchenId = new Types.ObjectId();
    const user = await createUserInKitchen(kitchenId);
    const recipe = await createTestRecipe({ authorId: user._id });
    recipe.servings = 4;
    await recipe.save();
    const source = await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-08-02T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });

    const generated = await generateFromSchedule(user._id.toString(), {
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-07T23:59:59.000Z"),
    });
    expect(generated.list.items).toHaveLength(1);

    const checked = await toggleItem(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.items[0]._id.toString()
    );

    const leftover = await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-08-03T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      leftoverOfEntryId: source._id,
      status: "confirmed",
    });

    const afterAdd = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      checked.revision
    );
    expect(afterAdd.list.items).toHaveLength(1);
    expect(afterAdd.list.items[0].quantity).toBe(1);
    expect(afterAdd.list.items[0].isChecked).toBe(true);
    expect(afterAdd.list.revision).toBe(checked.revision + 1);

    await ScheduleEntry.findByIdAndDelete(leftover._id);

    const afterDelete = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      afterAdd.list.revision
    );
    expect(afterDelete.list.items).toHaveLength(1);
    expect(afterDelete.list.items[0].quantity).toBe(1);
    expect(afterDelete.list.items[0].isChecked).toBe(true);
    expect(afterDelete.list.revision).toBe(afterAdd.list.revision + 1);
  });

  it("generating from a date range with only leftover entries throws the usual no scheduled recipes error", async () => {
    const kitchenId = new Types.ObjectId();
    const user = await createUserInKitchen(kitchenId);
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-08-01T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });
    await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-08-05T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      leftoverOfEntryId: source._id,
      status: "confirmed",
    });

    await expect(
      generateFromSchedule(user._id.toString(), {
        startDate: new Date("2026-08-04T00:00:00.000Z"),
        endDate: new Date("2026-08-06T23:59:59.000Z"),
      })
    ).rejects.toThrow(/No scheduled recipes found in this date range/);
  });

  it("refreshing a list whose range now holds only leftover entries empties the schedule-sourced items", async () => {
    const kitchenId = new Types.ObjectId();
    const user = await createUserInKitchen(kitchenId);
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-09-02T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });

    const generated = await generateFromSchedule(user._id.toString(), {
      startDate: new Date("2026-09-01T00:00:00.000Z"),
      endDate: new Date("2026-09-07T23:59:59.000Z"),
    });
    expect(generated.list.items).toHaveLength(1);

    await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-09-03T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      leftoverOfEntryId: source._id,
      status: "confirmed",
    });
    await ScheduleEntry.updateOne(
      { _id: source._id },
      { $set: { date: new Date("2026-09-10T00:00:00.000Z") } }
    );

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.revision
    );
    expect(refreshed.list.items).toHaveLength(0);
  });
});
