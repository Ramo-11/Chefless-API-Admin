import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import ShoppingList from "../../models/ShoppingList";
import User from "../../models/User";
import Kitchen from "../../models/Kitchen";
import ScheduleEntry from "../../models/ScheduleEntry";
import { createTestRecipe, createTestUser } from "../helpers";
import { addEntry } from "../../services/schedule-service";
import {
  getList,
  getLists,
  generateFromSchedule,
  refreshFromSchedule,
  addItem,
  updateItem,
  toggleItem,
} from "../../services/shopping-list-service";

function stripTime(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function daysFromToday(offset: number): Date {
  const d = stripTime(new Date());
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

async function putUserInKitchen(userId: Types.ObjectId, kitchenId: Types.ObjectId) {
  await User.updateOne({ _id: userId }, { $set: { kitchenId } });
}

async function createKitchen(leadId: Types.ObjectId) {
  return Kitchen.create({
    name: "Plan Changed Kitchen",
    leadId,
    inviteCode: new Types.ObjectId().toString(),
    memberCount: 1,
  });
}

describe("computePlanChanged through getList and getLists", () => {
  it("is true on a personal list when the owner's revision is ahead of the list's synced revision and the range ends today or later", async () => {
    const user = await createTestUser();
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(1),
      scheduleRevisionAtSync: 0,
    });
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });

    const result = await getList(list._id.toString(), user._id.toString());

    expect(result.planChanged).toBe(true);
  });

  it("is true on a Kitchen list when the kitchen's revision is ahead of the list's synced revision and the range ends today or later", async () => {
    const lead = await createTestUser();
    const kitchen = await createKitchen(lead._id);
    await putUserInKitchen(lead._id, kitchen._id);
    const list = await ShoppingList.create({
      kitchenId: kitchen._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(1),
      scheduleRevisionAtSync: 0,
    });
    await Kitchen.updateOne({ _id: kitchen._id }, { $set: { scheduleRevision: 1 } });

    const result = await getList(list._id.toString(), lead._id.toString());

    expect(result.planChanged).toBe(true);
  });

  it("is false when the owner's revision exactly matches the list's synced revision", async () => {
    const user = await createTestUser();
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(1),
      scheduleRevisionAtSync: 3,
    });
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 3 } });

    const result = await getList(list._id.toString(), user._id.toString());

    expect(result.planChanged).toBe(false);
  });

  it("is false when the range ended before today even though the owner's revision is ahead", async () => {
    const user = await createTestUser();
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-8),
      scheduleEndDate: daysFromToday(-1),
      scheduleRevisionAtSync: 0,
    });
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });

    const result = await getList(list._id.toString(), user._id.toString());

    expect(result.planChanged).toBe(false);
  });

  it("is true when the range ends exactly today, the boundary the past range rule still allows", async () => {
    const user = await createTestUser();
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(0),
      scheduleRevisionAtSync: 0,
    });
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });

    const result = await getList(list._id.toString(), user._id.toString());

    expect(result.planChanged).toBe(true);
  });

  it("is false for a legacy list with no scheduleLinkVersion at all even though the owner's revision is ahead", async () => {
    const user = await createTestUser();
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: false,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(1),
      scheduleRevisionAtSync: 0,
    });
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });

    const result = await getList(list._id.toString(), user._id.toString());

    expect(result.planChanged).toBe(false);
  });

  it("is false for a list whose scheduleLinkVersion is 0", async () => {
    const user = await createTestUser();
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: false,
      scheduleLinkVersion: 0,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(1),
      scheduleRevisionAtSync: 0,
    });
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });

    const result = await getList(list._id.toString(), user._id.toString());

    expect(result.planChanged).toBe(false);
  });

  it("is false for a list whose scheduleLinkVersion is 2, a link version this server does not treat as the current linked shape", async () => {
    const user = await createTestUser();
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: false,
      scheduleLinkVersion: 2,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(1),
      scheduleRevisionAtSync: 0,
    });
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });

    const result = await getList(list._id.toString(), user._id.toString());

    expect(result.planChanged).toBe(false);
  });

  it("is false for a list that was never generated from a plan and carries no schedule dates", async () => {
    const user = await createTestUser();
    const list = await ShoppingList.create({
      userId: user._id,
      items: [{ name: "Napkins", isChecked: false }],
      generatedFromSchedule: false,
    });
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });

    const result = await getList(list._id.toString(), user._id.toString());

    expect(result.planChanged).toBe(false);
  });

  it("is false when the list has schedule dates but no scheduleRevisionAtSync and the owner has never been bumped, then true once the owner is bumped once", async () => {
    const user = await createTestUser();
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(1),
    });

    const beforeAnyEdit = await getList(list._id.toString(), user._id.toString());
    expect(beforeAnyEdit.planChanged).toBe(false);

    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 1 } });

    const afterOneEdit = await getList(list._id.toString(), user._id.toString());
    expect(afterOneEdit.planChanged).toBe(true);
  });

  it("reads the Kitchen's scheduleRevision rather than the viewer's own, so a second member's plan edit makes planChanged true for the first member", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await createKitchen(lead._id);
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    const list = await ShoppingList.create({
      kitchenId: kitchen._id,
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(1),
      scheduleRevisionAtSync: 0,
    });

    await addEntry(member._id.toString(), kitchen._id.toString(), {
      date: daysFromToday(0),
      mealSlot: "dinner",
    });

    const forTheLead = await getList(list._id.toString(), lead._id.toString());

    expect(forTheLead.planChanged).toBe(true);
  });

  it("getLists returns a stale linked list, an in sync linked list, and a manual list each with the correct planChanged value in one call", async () => {
    const user = await createTestUser();
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 5 } });
    await ShoppingList.create({
      userId: user._id,
      name: "Stale",
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(1),
      scheduleRevisionAtSync: 4,
    });
    await ShoppingList.create({
      userId: user._id,
      name: "In sync",
      items: [],
      generatedFromSchedule: true,
      scheduleLinkVersion: 1,
      scheduleStartDate: daysFromToday(-6),
      scheduleEndDate: daysFromToday(1),
      scheduleRevisionAtSync: 5,
    });
    await ShoppingList.create({
      userId: user._id,
      name: "Manual",
      items: [{ name: "Napkins", isChecked: false }],
      generatedFromSchedule: false,
    });

    const lists = await getLists(user._id.toString());
    const byName = new Map(lists.map((list) => [list.name, list.planChanged]));

    expect(byName.get("Stale")).toBe(true);
    expect(byName.get("In sync")).toBe(false);
    expect(byName.get("Manual")).toBe(false);
  });
});

describe("refreshFromSchedule", () => {
  it("sets scheduleRevisionAtSync to the owner's current revision and stamps scheduleSyncedAt on a successful refresh", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const range = { startDate: daysFromToday(-3), endDate: daysFromToday(3) };
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), range);
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 7 } });

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.revision
    );

    expect(refreshed.list.scheduleRevisionAtSync).toBe(7);
    expect(refreshed.list.scheduleSyncedAt).toBeInstanceOf(Date);
  });

  it("counts meta.added for a newly scheduled meal's ingredient lines", async () => {
    const user = await createTestUser();
    const recipeOne = await createTestRecipe({ authorId: user._id, title: "Recipe One" });
    const range = { startDate: daysFromToday(-1), endDate: daysFromToday(5) };
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipeOne._id,
      servings: 4,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), range);
    expect(generated.list.items).toHaveLength(1);

    const recipeTwo = await createTestRecipe({ authorId: user._id, title: "Recipe Two" });
    recipeTwo.ingredients = [{ name: "Pepper", quantity: 2, unit: "tsp" }];
    await recipeTwo.save();
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(1),
      mealSlot: "dinner",
      recipeId: recipeTwo._id,
      servings: 4,
      status: "confirmed",
    });

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.revision
    );

    expect(refreshed.meta.added).toBe(1);
    expect(refreshed.meta.removed).toBe(0);
    expect(refreshed.meta.updated).toBe(0);
    expect(refreshed.list.items).toHaveLength(2);
  });

  it("counts meta.removed for an ingredient line whose meal was taken off the plan", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const range = { startDate: daysFromToday(-1), endDate: daysFromToday(5) };
    const entry = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), range);
    expect(generated.list.items).toHaveLength(1);

    await ScheduleEntry.deleteOne({ _id: entry._id });

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.revision
    );

    expect(refreshed.meta.removed).toBe(1);
    expect(refreshed.meta.added).toBe(0);
    expect(refreshed.meta.updated).toBe(0);
    expect(refreshed.list.items).toHaveLength(0);
  });

  it("counts meta.updated when a meal's servings change scales an existing ingredient line's quantity", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    recipe.servings = 4;
    await recipe.save();
    const range = { startDate: daysFromToday(-1), endDate: daysFromToday(5) };
    const entry = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), range);
    expect(generated.list.items[0].quantity).toBe(1);

    await ScheduleEntry.updateOne({ _id: entry._id }, { $set: { servings: 8 } });

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.revision
    );

    expect(refreshed.meta.updated).toBe(1);
    expect(refreshed.meta.added).toBe(0);
    expect(refreshed.meta.removed).toBe(0);
    expect(refreshed.list.items[0].quantity).toBe(2);
  });

  it("counts added, removed, and updated together in a single refresh", async () => {
    const user = await createTestUser();
    const staying = await createTestRecipe({ authorId: user._id, title: "Staying Recipe" });
    staying.servings = 4;
    await staying.save();
    const leaving = await createTestRecipe({ authorId: user._id, title: "Leaving Recipe" });
    leaving.ingredients = [{ name: "Cumin", quantity: 1, unit: "tsp" }];
    await leaving.save();
    const range = { startDate: daysFromToday(-1), endDate: daysFromToday(5) };
    const stayingEntry = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: staying._id,
      servings: 4,
      status: "confirmed",
    });
    const leavingEntry = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(1),
      mealSlot: "lunch",
      recipeId: leaving._id,
      servings: 4,
      status: "confirmed",
    });

    const generated = await generateFromSchedule(user._id.toString(), range);
    expect(generated.list.items).toHaveLength(2);

    await ScheduleEntry.deleteOne({ _id: leavingEntry._id });
    await ScheduleEntry.updateOne({ _id: stayingEntry._id }, { $set: { servings: 8 } });
    const arriving = await createTestRecipe({ authorId: user._id, title: "Arriving Recipe" });
    arriving.ingredients = [{ name: "Paprika", quantity: 1, unit: "tsp" }];
    await arriving.save();
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(2),
      mealSlot: "dinner",
      recipeId: arriving._id,
      servings: 4,
      status: "confirmed",
    });

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.revision
    );

    expect(refreshed.meta.added).toBe(1);
    expect(refreshed.meta.removed).toBe(1);
    expect(refreshed.meta.updated).toBe(1);
    expect(refreshed.list.items).toHaveLength(2);
  });

  it("leaves a hand edited line uncounted in added, removed, or updated, keeps it on the list, and excludes its schedule source key from the next generation", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const range = { startDate: daysFromToday(-1), endDate: daysFromToday(5) };
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), range);
    const sourceKey = generated.list.items[0].scheduleSource?.key;
    expect(sourceKey).toBeTruthy();

    const edited = await updateItem(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.items[0]._id.toString(),
      { quantity: 99 }
    );

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      edited.revision
    );

    expect(refreshed.meta.added).toBe(0);
    expect(refreshed.meta.removed).toBe(0);
    expect(refreshed.meta.updated).toBe(0);
    expect(refreshed.list.items).toHaveLength(1);
    expect(refreshed.list.items[0].quantity).toBe(99);
    expect(refreshed.list.excludedScheduleSourceKeys).toContain(sourceKey);
  });

  it("returns added, removed, and updated all as zero when nothing about the plan changed", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const range = { startDate: daysFromToday(-1), endDate: daysFromToday(5) };
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), range);

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.revision
    );

    expect(refreshed.meta.added).toBe(0);
    expect(refreshed.meta.removed).toBe(0);
    expect(refreshed.meta.updated).toBe(0);
  });

  it("keeps meta.skippedPrivateCount counting a scheduled recipe the rest of the kitchen cannot see, unchanged by this feature", async () => {
    const lead = await createTestUser();
    const kitchen = await createKitchen(lead._id);
    await putUserInKitchen(lead._id, kitchen._id);
    const visibleRecipe = await createTestRecipe({ authorId: lead._id, title: "Visible" });
    const privateRecipe = await createTestRecipe({
      authorId: lead._id,
      title: "Private",
      isPrivate: true,
    });
    const range = { startDate: daysFromToday(-1), endDate: daysFromToday(5) };
    await ScheduleEntry.create({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: visibleRecipe._id,
      servings: 4,
      status: "confirmed",
    });
    await ScheduleEntry.create({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(1),
      mealSlot: "lunch",
      recipeId: privateRecipe._id,
      servings: 4,
      status: "confirmed",
    });

    const generated = await generateFromSchedule(lead._id.toString(), range);
    expect(generated.meta.skippedPrivateCount).toBe(1);

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      lead._id.toString(),
      generated.list.revision
    );
    expect(refreshed.meta.skippedPrivateCount).toBe(1);
  });

  it("still throws 409 with the existing message on a stale revision and leaves the list unmodified", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const range = { startDate: daysFromToday(-1), endDate: daysFromToday(5) };
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), range);
    const staleRevision = generated.list.revision;
    await addItem(generated.list._id.toString(), user._id.toString(), { name: "Napkins" });

    await expect(
      refreshFromSchedule(generated.list._id.toString(), user._id.toString(), staleRevision)
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "This shopping list changed. Reload it and try again",
    });

    const stored = await ShoppingList.findById(generated.list._id).lean();
    expect(stored?.items).toHaveLength(2);
  });

  it("still throws 409 with its own message when refreshing a list that predates schedule linking", async () => {
    const user = await createTestUser();
    const list = await ShoppingList.create({
      userId: user._id,
      items: [],
      generatedFromSchedule: false,
    });

    await expect(
      refreshFromSchedule(list._id.toString(), user._id.toString(), list.revision)
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "This older shopping list cannot be updated from the plan",
    });
  });

  it("returns planChanged false on the list included in a successful refresh response", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const range = { startDate: daysFromToday(-1), endDate: daysFromToday(5) };
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), range);
    await User.updateOne({ _id: user._id }, { $set: { scheduleRevision: 3 } });
    const staleCheck = await getList(generated.list._id.toString(), user._id.toString());
    expect(staleCheck.planChanged).toBe(true);

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.revision
    );

    expect(refreshed.list.planChanged).toBe(false);
  });

  it("keeps a checked item checked and keeps a manually added item across a refresh", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const range = { startDate: daysFromToday(-1), endDate: daysFromToday(5) };
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    const generated = await generateFromSchedule(user._id.toString(), range);
    const checked = await toggleItem(
      generated.list._id.toString(),
      user._id.toString(),
      generated.list.items[0]._id.toString()
    );
    expect(checked.items[0].isChecked).toBe(true);
    const withManual = await addItem(checked._id.toString(), user._id.toString(), {
      name: "Napkins",
      quantity: 1,
      unit: "pack",
    });

    const refreshed = await refreshFromSchedule(
      generated.list._id.toString(),
      user._id.toString(),
      withManual.revision
    );

    const byName = new Map(refreshed.list.items.map((item) => [item.name, item]));
    expect(byName.get("Salt")?.isChecked).toBe(true);
    expect(byName.get("Napkins")).toBeTruthy();
    expect(refreshed.list.items).toHaveLength(2);
  });
});
