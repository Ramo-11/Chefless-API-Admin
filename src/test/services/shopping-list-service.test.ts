import { describe, it, expect, vi } from "vitest";
import { Types } from "mongoose";
import {
  addItem,
  addItems,
  createList,
  duplicateList,
  generateFromSchedule,
  refreshFromSchedule,
  removeItem,
  toggleItem,
  updateItem,
  updateList,
  uncheckAll,
  clearCompleted,
  reorderItems,
} from "../../services/shopping-list-service";
import { createTestRecipe, createTestUser } from "../helpers";
import ShoppingList from "../../models/ShoppingList";
import ScheduleEntry from "../../models/ScheduleEntry";
import User from "../../models/User";

async function createUserInKitchen(kitchenId: Types.ObjectId) {
  const user = await createTestUser();
  await User.findByIdAndUpdate(user._id, { kitchenId });
  return user;
}

describe("shopping-list-service item order", () => {
  describe("order assignment", () => {
    it("numbers seeded items sequentially on create", async () => {
      const user = await createTestUser();

      const list = await createList(user._id.toString(), {
        name: "Weekly run",
        isPrivate: true,
        items: [
          { name: "Milk" },
          { name: "Bread" },
          { name: "Eggs" },
        ],
      });

      expect(list.items.map((item) => item.order)).toEqual([0, 1, 2]);
    });

    it("appends each added item after the current highest order", async () => {
      const user = await createTestUser();
      const list = await createList(user._id.toString(), {
        name: "Pantry",
        isPrivate: true,
        items: [{ name: "Rice" }],
      });

      const afterFirst = await addItem(list._id.toString(), user._id.toString(), {
        name: "Beans",
      });
      const afterSecond = await addItem(
        list._id.toString(),
        user._id.toString(),
        { name: "Lentils" }
      );

      expect(afterFirst.items.map((item) => item.order)).toEqual([0, 1]);
      expect(afterSecond.items.map((item) => item.order)).toEqual([0, 1, 2]);
    });

    it("falls back to array position for legacy items with no order field", async () => {
      const user = await createTestUser();
      const listId = new Types.ObjectId();

      await ShoppingList.collection.insertOne({
        _id: listId,
        userId: user._id,
        name: "Legacy list",
        items: [
          { _id: new Types.ObjectId(), name: "Olives", isChecked: false },
          { _id: new Types.ObjectId(), name: "Feta", isChecked: false },
        ],
        generatedFromSchedule: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await addItem(listId.toString(), user._id.toString(), {
        name: "Pita",
      });

      expect(updated.items[2].order).toBe(2);
    });

    it("preserves item order when a list is duplicated", async () => {
      const user = await createTestUser();
      const list = await createList(user._id.toString(), {
        name: "Original",
        isPrivate: true,
        items: [{ name: "Apples" }, { name: "Pears" }, { name: "Plums" }],
      });

      const reordered = await reorderItems(
        list._id.toString(),
        user._id.toString(),
        [
          list.items[2]._id.toString(),
          list.items[0]._id.toString(),
          list.items[1]._id.toString(),
        ]
      );

      const copy = await duplicateList(
        reordered._id.toString(),
        user._id.toString()
      );

      const byName = new Map(
        copy.items.map((item) => [item.name, item.order])
      );
      expect(byName.get("Plums")).toBe(0);
      expect(byName.get("Apples")).toBe(1);
      expect(byName.get("Pears")).toBe(2);
    });

    it("numbers generated items sequentially", async () => {
      const kitchenId = new Types.ObjectId();
      const user = await createUserInKitchen(kitchenId);
      const recipe = await createTestRecipe({ authorId: user._id });

      await ScheduleEntry.create({
        kitchenId,
        userId: user._id,
        date: new Date("2026-03-02T12:00:00.000Z"),
        mealSlot: "dinner",
        recipeId: recipe._id,
        status: "confirmed",
      });

      const { list } = await generateFromSchedule(user._id.toString(), {
        startDate: new Date("2026-03-01T00:00:00.000Z"),
        endDate: new Date("2026-03-07T23:59:59.000Z"),
      });

      expect(list.items.length).toBeGreaterThan(0);
      expect(list.items.map((item) => item.order)).toEqual(
        list.items.map((_, index) => index)
      );
    });
  });

  describe("reorderItems", () => {
    it("rewrites and persists the new order", async () => {
      const user = await createTestUser();
      const list = await createList(user._id.toString(), {
        name: "Reorder me",
        isPrivate: true,
        items: [{ name: "One" }, { name: "Two" }, { name: "Three" }],
      });

      const [first, second, third] = list.items.map((item) =>
        item._id.toString()
      );

      const updated = await reorderItems(
        list._id.toString(),
        user._id.toString(),
        [third, first, second]
      );

      const orderById = new Map(
        updated.items.map((item) => [item._id.toString(), item.order])
      );
      expect(orderById.get(third)).toBe(0);
      expect(orderById.get(first)).toBe(1);
      expect(orderById.get(second)).toBe(2);

      const reloaded = await ShoppingList.findById(list._id);
      const persisted = new Map(
        (reloaded?.items ?? []).map((item) => [item._id.toString(), item.order])
      );
      expect(persisted.get(third)).toBe(0);
      expect(persisted.get(first)).toBe(1);
      expect(persisted.get(second)).toBe(2);
    });

    it("rejects an order that omits an item", async () => {
      const user = await createTestUser();
      const list = await createList(user._id.toString(), {
        name: "Partial",
        isPrivate: true,
        items: [{ name: "One" }, { name: "Two" }],
      });

      await expect(
        reorderItems(list._id.toString(), user._id.toString(), [
          list.items[0]._id.toString(),
        ])
      ).rejects.toThrow(/exactly once/);
    });

    it("rejects an order that repeats an item", async () => {
      const user = await createTestUser();
      const list = await createList(user._id.toString(), {
        name: "Repeated",
        isPrivate: true,
        items: [{ name: "One" }, { name: "Two" }],
      });

      const first = list.items[0]._id.toString();

      await expect(
        reorderItems(list._id.toString(), user._id.toString(), [first, first])
      ).rejects.toThrow(/exactly once/);
    });

    it("rejects an order containing an unknown item id", async () => {
      const user = await createTestUser();
      const list = await createList(user._id.toString(), {
        name: "Stranger item",
        isPrivate: true,
        items: [{ name: "One" }, { name: "Two" }],
      });

      await expect(
        reorderItems(list._id.toString(), user._id.toString(), [
          list.items[0]._id.toString(),
          new Types.ObjectId().toString(),
        ])
      ).rejects.toThrow(/exactly once/);
    });

    it("leaves the stored order untouched when validation fails", async () => {
      const user = await createTestUser();
      const list = await createList(user._id.toString(), {
        name: "Untouched",
        isPrivate: true,
        items: [{ name: "One" }, { name: "Two" }],
      });

      await expect(
        reorderItems(list._id.toString(), user._id.toString(), [])
      ).rejects.toThrow(/exactly once/);

      const reloaded = await ShoppingList.findById(list._id);
      expect((reloaded?.items ?? []).map((item) => item.order)).toEqual([0, 1]);
    });

    it("refuses callers who cannot access the list", async () => {
      const owner = await createTestUser();
      const stranger = await createTestUser();
      const list = await createList(owner._id.toString(), {
        name: "Private list",
        isPrivate: true,
        items: [{ name: "One" }, { name: "Two" }],
      });

      await expect(
        reorderItems(list._id.toString(), stranger._id.toString(), [
          list.items[1]._id.toString(),
          list.items[0]._id.toString(),
        ])
      ).rejects.toThrow(/do not have access/);
    });

    it("lets another member of the same kitchen reorder a shared list", async () => {
      const kitchenId = new Types.ObjectId();
      const owner = await createUserInKitchen(kitchenId);
      const teammate = await createUserInKitchen(kitchenId);

      const list = await createList(owner._id.toString(), {
        name: "Kitchen list",
        items: [{ name: "One" }, { name: "Two" }],
      });

      const updated = await reorderItems(
        list._id.toString(),
        teammate._id.toString(),
        [list.items[1]._id.toString(), list.items[0]._id.toString()]
      );

      expect(updated.items[1].order).toBe(0);
      expect(updated.items[0].order).toBe(1);
    });
  });
});

describe("shopping-list-service schedule links", () => {
  it("advances the revision for every list mutation path", async () => {
    const user = await createTestUser();
    let list = await createList(user._id.toString(), {
      name: "Revision",
      isPrivate: true,
      items: [{ name: "Milk" }, { name: "Bread" }],
    });
    let revision = list.revision;
    const assertAdvanced = (next: typeof list) => {
      expect(next.revision).toBe(revision + 1);
      revision = next.revision;
      list = next;
    };

    assertAdvanced(
      await updateList(list._id.toString(), user._id.toString(), {
        name: "Revision two",
      })
    );
    assertAdvanced(
      await addItem(list._id.toString(), user._id.toString(), { name: "Eggs" })
    );
    assertAdvanced(
      await addItems(list._id.toString(), user._id.toString(), [
        { name: "Cheese" },
      ])
    );
    assertAdvanced(
      await updateItem(
        list._id.toString(),
        user._id.toString(),
        list.items[0]._id.toString(),
        { quantity: 2 }
      )
    );
    assertAdvanced(
      await toggleItem(
        list._id.toString(),
        user._id.toString(),
        list.items[0]._id.toString()
      )
    );
    assertAdvanced(await uncheckAll(list._id.toString(), user._id.toString()));
    assertAdvanced(
      await reorderItems(
        list._id.toString(),
        user._id.toString(),
        [...list.items].reverse().map((item) => item._id.toString())
      )
    );
    assertAdvanced(
      await toggleItem(
        list._id.toString(),
        user._id.toString(),
        list.items[0]._id.toString()
      )
    );
    assertAdvanced(await clearCompleted(list._id.toString(), user._id.toString()));
    assertAdvanced(
      await removeItem(
        list._id.toString(),
        user._id.toString(),
        list.items[0]._id.toString()
      )
    );
  });

  it("scales each occurrence and refreshes without merging manual overlaps", async () => {
    const kitchenId = new Types.ObjectId();
    const user = await createUserInKitchen(kitchenId);
    const recipe = await createTestRecipe({ authorId: user._id });
    recipe.servings = 4;
    await recipe.save();
    const range = {
      startDate: new Date("2026-03-01T00:00:00.000Z"),
      endDate: new Date("2026-03-07T23:59:59.000Z"),
    };
    await ScheduleEntry.create([
      {
        kitchenId,
        userId: user._id,
        date: new Date("2026-03-02T00:00:00.000Z"),
        mealSlot: "dinner",
        recipeId: recipe._id,
        servings: 2,
        status: "confirmed",
      },
      {
        kitchenId,
        userId: user._id,
        date: new Date("2026-03-03T00:00:00.000Z"),
        mealSlot: "dinner",
        recipeId: recipe._id,
        servings: 8,
        status: "confirmed",
      },
    ]);

    const generated = await generateFromSchedule(user._id.toString(), range);
    expect(generated.list.items[0].quantity).toBe(2.5);
    const withManual = await addItem(
      generated.list._id.toString(),
      user._id.toString(),
      { name: "Salt", quantity: 3, unit: "tsp" }
    );
    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      withManual.revision
    );
    expect(refreshed.list.items).toHaveLength(2);
    expect(refreshed.list.items.map((item) => item.quantity).sort()).toEqual([2.5, 3]);
    await expect(
      refreshFromSchedule(
        generated.list._id.toString(),
        user._id.toString(),
        withManual.revision
      )
    ).rejects.toThrow(/changed/);
  });

  it("does not resurrect a removed generated ingredient", async () => {
    const kitchenId = new Types.ObjectId();
    const user = await createUserInKitchen(kitchenId);
    const recipe = await createTestRecipe({ authorId: user._id });
    const range = {
      startDate: new Date("2026-04-01T00:00:00.000Z"),
      endDate: new Date("2026-04-07T23:59:59.000Z"),
    };
    await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-04-02T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), range);
    const removed = await removeItem(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.items[0]._id.toString()
    );
    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      removed.revision
    );
    expect(refreshed.list.items).toHaveLength(0);
  });

  it("preserves checks, detaches edits, and removes meals moved out of range", async () => {
    const kitchenId = new Types.ObjectId();
    const user = await createUserInKitchen(kitchenId);
    const recipe = await createTestRecipe({ authorId: user._id });
    const entry = await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-05-02T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), {
      startDate: new Date("2026-05-01T00:00:00.000Z"),
      endDate: new Date("2026-05-07T23:59:59.000Z"),
    });
    const checked = await toggleItem(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.items[0]._id.toString()
    );
    const afterCheck = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      checked.revision
    );
    expect(afterCheck.list.items[0].isChecked).toBe(true);

    const edited = await updateItem(
      generated.list._id.toString(),
      user._id.toString(),
      afterCheck.list.items[0]._id.toString(),
      { quantity: 9, category: "Bakery" }
    );
    const afterEdit = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      edited.revision
    );
    expect(afterEdit.list.items).toHaveLength(1);
    expect(afterEdit.list.items[0].quantity).toBe(9);
    expect(afterEdit.list.items[0].category).toBe("Bakery");
    expect(afterEdit.list.items[0].scheduleSource).toBeUndefined();

    await ScheduleEntry.updateOne(
      { _id: entry._id },
      { $set: { date: new Date("2026-05-08T00:00:00.000Z") } }
    );
    const afterMove = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      afterEdit.list.revision
    );
    expect(afterMove.list.items).toHaveLength(1);
    expect(afterMove.list.items[0].quantity).toBe(9);
  });

  it("generates and refreshes only the caller's personal schedule", async () => {
    const kitchenId = new Types.ObjectId();
    const user = await createUserInKitchen(kitchenId);
    const recipe = await createTestRecipe({ authorId: user._id, isPrivate: true });
    recipe.servings = 4;
    await recipe.save();
    await ScheduleEntry.create([
      {
        userId: user._id,
        date: new Date("2026-06-02T00:00:00.000Z"),
        mealSlot: "dinner",
        recipeId: recipe._id,
        servings: 2,
        status: "confirmed",
      },
      {
        kitchenId,
        userId: user._id,
        date: new Date("2026-06-03T00:00:00.000Z"),
        mealSlot: "dinner",
        recipeId: recipe._id,
        servings: 8,
        status: "confirmed",
      },
    ]);
    const generated = await generateFromSchedule(user._id.toString(), {
      scope: "personal",
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: new Date("2026-06-07T23:59:59.000Z"),
    });
    expect(generated.list.userId?.equals(user._id)).toBe(true);
    expect(generated.list.kitchenId).toBeUndefined();
    expect(generated.list.items[0].quantity).toBe(0.5);
    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.revision
    );
    expect(refreshed.list.items[0].quantity).toBe(0.5);
  });

  it("includes a shared recipe from a private co-Kitchen author in a personal list", async () => {
    const kitchenId = new Types.ObjectId();
    const viewer = await createUserInKitchen(kitchenId);
    const author = await createTestUser({ isPublic: false });
    await User.updateOne({ _id: author._id }, { $set: { kitchenId } });
    const recipe = await createTestRecipe({ authorId: author._id });
    await ScheduleEntry.create({
      userId: viewer._id,
      date: new Date("2026-06-12T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(viewer._id.toString(), {
      scope: "personal",
      startDate: new Date("2026-06-10T00:00:00.000Z"),
      endDate: new Date("2026-06-15T23:59:59.000Z"),
    });
    expect(generated.list.items).toHaveLength(1);
  });

  it("includes a shared recipe from a private Kitchen member in the Kitchen list", async () => {
    const kitchenId = new Types.ObjectId();
    const lead = await createUserInKitchen(kitchenId);
    const author = await createTestUser({ isPublic: false });
    await User.updateOne({ _id: author._id }, { $set: { kitchenId } });
    const recipe = await createTestRecipe({ authorId: author._id });
    await ScheduleEntry.create({
      kitchenId,
      userId: author._id,
      date: new Date("2026-06-12T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(lead._id.toString(), {
      startDate: new Date("2026-06-10T00:00:00.000Z"),
      endDate: new Date("2026-06-15T23:59:59.000Z"),
    });
    expect(generated.list.kitchenId?.toString()).toBe(kitchenId.toString());
    expect(generated.list.items).toHaveLength(1);
    expect(generated.meta.skippedPrivateCount).toBe(0);
  });

  it("skips a shared recipe from a private author outside the Kitchen and counts it", async () => {
    const kitchenId = new Types.ObjectId();
    const lead = await createUserInKitchen(kitchenId);
    const outsider = await createTestUser({ isPublic: false });
    const recipe = await createTestRecipe({ authorId: outsider._id });
    await ScheduleEntry.create({
      kitchenId,
      userId: lead._id,
      date: new Date("2026-06-12T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(lead._id.toString(), {
      startDate: new Date("2026-06-10T00:00:00.000Z"),
      endDate: new Date("2026-06-15T23:59:59.000Z"),
      name: "Outsider week",
    });
    expect(generated.list.items).toHaveLength(0);
    expect(generated.meta.skippedPrivateCount).toBe(1);
  });

  it("keeps checked generated items excluded after clearing completed", async () => {
    const kitchenId = new Types.ObjectId();
    const user = await createUserInKitchen(kitchenId);
    const recipe = await createTestRecipe({ authorId: user._id });
    await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-07-02T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), {
      startDate: new Date("2026-07-01T00:00:00.000Z"),
      endDate: new Date("2026-07-07T23:59:59.000Z"),
    });
    const checked = await toggleItem(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.items[0]._id.toString()
    );
    const cleared = await clearCompleted(
      generated.list._id.toString(),
      user._id.toString()
    );
    expect(cleared.items).toHaveLength(0);
    expect(cleared.revision).toBe(checked.revision + 1);
    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      cleared.revision
    );
    expect(refreshed.list.items).toHaveLength(0);
  });

  it("retries clear completed when another item is checked concurrently", async () => {
    const kitchenId = new Types.ObjectId();
    const user = await createUserInKitchen(kitchenId);
    const recipe = await createTestRecipe({ authorId: user._id });
    recipe.ingredients.push({ name: "Pepper", quantity: 1, unit: "tsp" });
    await recipe.save();
    await ScheduleEntry.create({
      kitchenId,
      userId: user._id,
      date: new Date("2026-07-12T00:00:00.000Z"),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), {
      startDate: new Date("2026-07-10T00:00:00.000Z"),
      endDate: new Date("2026-07-15T23:59:59.000Z"),
    });
    const firstChecked = await toggleItem(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.items[0]._id.toString()
    );
    const original = ShoppingList.findOneAndUpdate.bind(ShoppingList);
    const spy = vi.spyOn(ShoppingList, "findOneAndUpdate");
    spy.mockImplementationOnce(((...args: Parameters<typeof ShoppingList.findOneAndUpdate>) => {
      return {
        then: async (resolve: (value: null) => void, reject: (error: unknown) => void) => {
          try {
            await original(
              { _id: generated.list._id },
              {
                $set: { "items.$[item].isChecked": true },
                $inc: { revision: 1 },
              },
              {
                arrayFilters: [{ "item._id": generated.list.items[1]._id }],
              }
            );
            resolve(null);
          } catch (error) {
            reject(error);
          }
        },
      };
    }) as typeof ShoppingList.findOneAndUpdate);

    const cleared = await clearCompleted(
      generated.list._id.toString(),
      user._id.toString()
    );
    spy.mockRestore();
    expect(cleared.revision).toBe(firstChecked.revision + 2);
    expect(cleared.items).toHaveLength(0);
    expect(cleared.excludedScheduleSourceKeys).toHaveLength(2);
    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      cleared.revision
    );
    expect(refreshed.list.items).toHaveLength(0);
  });
});

describe("shopping-list-service bulk add", () => {
  it("appends a whole recipe in one call, numbered after the existing items", async () => {
    const user = await createTestUser();
    const list = await createList(user._id.toString(), {
      name: "Dinner",
      isPrivate: true,
      items: [{ name: "Rice" }],
    });

    const updated = await addItems(list._id.toString(), user._id.toString(), [
      { name: "Onion", quantity: 2, unit: "piece" },
      { name: "Garlic", quantity: 3, unit: "clove" },
    ]);

    expect(updated.items.map((item) => item.name)).toEqual([
      "Rice",
      "Onion",
      "Garlic",
    ]);
    expect(updated.items.map((item) => item.order)).toEqual([0, 1, 2]);
  });

  it("adds the amount to an existing line when the name and unit match", async () => {
    const user = await createTestUser();
    const list = await createList(user._id.toString(), {
      name: "Dinner",
      isPrivate: true,
    });

    await addItems(list._id.toString(), user._id.toString(), [
      { name: "Onion", quantity: 2, unit: "piece" },
    ]);
    const updated = await addItems(list._id.toString(), user._id.toString(), [
      { name: "onion", quantity: 3, unit: "piece" },
    ]);

    expect(updated.items).toHaveLength(1);
    expect(updated.items[0].quantity).toBe(5);
  });

  it("keeps a separate line when the same ingredient arrives in another unit", async () => {
    const user = await createTestUser();
    const list = await createList(user._id.toString(), {
      name: "Dinner",
      isPrivate: true,
    });

    await addItems(list._id.toString(), user._id.toString(), [
      { name: "Flour", quantity: 2, unit: "cup" },
    ]);
    const updated = await addItems(list._id.toString(), user._id.toString(), [
      { name: "Flour", quantity: 250, unit: "g" },
    ]);

    expect(updated.items).toHaveLength(2);
  });

  it("refuses to push a list past the item ceiling", async () => {
    const user = await createTestUser();
    const list = await createList(user._id.toString(), {
      name: "Huge",
      isPrivate: true,
      items: Array.from({ length: 200 }, (_, i) => ({ name: `Item ${i}` })),
    });

    await expect(
      addItems(
        list._id.toString(),
        user._id.toString(),
        Array.from({ length: 301 }, (_, i) => ({ name: `Extra ${i}` }))
      )
    ).rejects.toThrow(/limited to 500 items/);
  });

  it("refuses a member who cannot see the list", async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const list = await createList(owner._id.toString(), {
      name: "Private",
      isPrivate: true,
    });

    await expect(
      addItems(list._id.toString(), stranger._id.toString(), [
        { name: "Milk" },
      ])
    ).rejects.toThrow();
  });
});
