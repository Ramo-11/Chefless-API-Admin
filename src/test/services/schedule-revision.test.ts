import { afterEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import ScheduleEntry from "../../models/ScheduleEntry";
import Kitchen from "../../models/Kitchen";
import User from "../../models/User";
import { createTestRecipe, createTestUser } from "../helpers";
import {
  addEntry,
  planLeftovers,
  updateEntry,
  deleteEntry,
  approveSuggestion,
  denySuggestion,
  importToKitchen,
  setEntryRsvp,
} from "../../services/schedule-service";
import { markEntryCooked } from "../../services/rating-service";

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
    name: "Revision Kitchen",
    leadId,
    inviteCode: new Types.ObjectId().toString(),
    memberCount: 1,
  });
}

async function userRevision(userId: Types.ObjectId): Promise<number> {
  const doc = await User.findById(userId).select("scheduleRevision").lean();
  return doc?.scheduleRevision ?? 0;
}

async function kitchenRevision(kitchenId: Types.ObjectId): Promise<number> {
  const doc = await Kitchen.findById(kitchenId).select("scheduleRevision").lean();
  return doc?.scheduleRevision ?? 0;
}

describe("bumpScheduleRevision on the mutations that must raise it", () => {
  it("addEntry on a personal plan raises the owner's User.scheduleRevision by exactly one", async () => {
    const user = await createTestUser();
    const before = await userRevision(user._id);

    await addEntry(user._id.toString(), null, {
      date: daysFromToday(0),
      mealSlot: "dinner",
    });

    const after = await userRevision(user._id);
    expect(after).toBe(before + 1);
  });

  it("addEntry on a Kitchen plan raises the Kitchen's scheduleRevision by exactly one and leaves the acting user's own User.scheduleRevision untouched", async () => {
    const lead = await createTestUser();
    const kitchen = await createKitchen(lead._id);
    await putUserInKitchen(lead._id, kitchen._id);
    const kitchenBefore = await kitchenRevision(kitchen._id);
    const userBefore = await userRevision(lead._id);

    await addEntry(lead._id.toString(), kitchen._id.toString(), {
      date: daysFromToday(0),
      mealSlot: "dinner",
    });

    const kitchenAfter = await kitchenRevision(kitchen._id);
    const userAfter = await userRevision(lead._id);
    expect(kitchenAfter).toBe(kitchenBefore + 1);
    expect(userAfter).toBe(userBefore);
  });

  it("planLeftovers on a personal plan raises the owner's User.scheduleRevision by exactly one", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 4,
      status: "confirmed",
    });
    const before = await userRevision(user._id);

    await planLeftovers(user._id.toString(), source._id.toString(), {
      date: daysFromToday(1),
      mealSlot: "lunch",
      cookExtra: false,
    });

    const after = await userRevision(user._id);
    expect(after).toBe(before + 1);
  });

  it("updateEntry raises the entry owner's User.scheduleRevision by exactly one", async () => {
    const user = await createTestUser();
    const entry = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      status: "confirmed",
    });
    const before = await userRevision(user._id);

    await updateEntry(user._id.toString(), entry._id.toString(), {
      mealSlot: "lunch",
    });

    const after = await userRevision(user._id);
    expect(after).toBe(before + 1);
  });

  it("deleteEntry raises the entry owner's User.scheduleRevision by exactly one", async () => {
    const user = await createTestUser();
    const entry = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      status: "confirmed",
    });
    const before = await userRevision(user._id);

    await deleteEntry(user._id.toString(), entry._id.toString());

    const after = await userRevision(user._id);
    expect(after).toBe(before + 1);
  });

  it("deleteEntry with withLeftovers raises the entry owner's User.scheduleRevision by exactly one even though two leftovers are removed alongside the source", async () => {
    const user = await createTestUser();
    const source = await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      status: "confirmed",
    });
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(1),
      mealSlot: "lunch",
      status: "confirmed",
      leftoverOfEntryId: source._id,
    });
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(2),
      mealSlot: "lunch",
      status: "confirmed",
      leftoverOfEntryId: source._id,
    });
    const before = await userRevision(user._id);

    const result = await deleteEntry(user._id.toString(), source._id.toString(), {
      withLeftovers: true,
    });

    expect(result.removedLeftovers).toBe(2);
    const after = await userRevision(user._id);
    expect(after).toBe(before + 1);
  });

  it("approveSuggestion raises the Kitchen's scheduleRevision by exactly one", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await createKitchen(lead._id);
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    const suggestion = await addEntry(member._id.toString(), kitchen._id.toString(), {
      date: daysFromToday(0),
      mealSlot: "dinner",
    });
    expect(suggestion.status).toBe("suggested");
    const before = await kitchenRevision(kitchen._id);

    await approveSuggestion(lead._id.toString(), suggestion._id.toString());

    const after = await kitchenRevision(kitchen._id);
    expect(after).toBe(before + 1);
  });

  it("denySuggestion raises the Kitchen's scheduleRevision by exactly one", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await createKitchen(lead._id);
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    const suggestion = await addEntry(member._id.toString(), kitchen._id.toString(), {
      date: daysFromToday(0),
      mealSlot: "dinner",
    });
    expect(suggestion.status).toBe("suggested");
    const before = await kitchenRevision(kitchen._id);

    await denySuggestion(lead._id.toString(), suggestion._id.toString());

    const after = await kitchenRevision(kitchen._id);
    expect(after).toBe(before + 1);
  });

  it("importToKitchen raises the Kitchen's scheduleRevision by exactly one when it imports a personal entry", async () => {
    const user = await createTestUser();
    const kitchen = await createKitchen(user._id);
    await putUserInKitchen(user._id, kitchen._id);
    await ScheduleEntry.create({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Leftover soup",
      status: "confirmed",
    });
    const before = await kitchenRevision(kitchen._id);

    const count = await importToKitchen(
      user._id.toString(),
      kitchen._id.toString(),
      daysFromToday(-1),
      daysFromToday(1)
    );

    expect(count).toBe(1);
    const after = await kitchenRevision(kitchen._id);
    expect(after).toBe(before + 1);
  });
});

describe("bumpScheduleRevision on the mutations that must NOT raise it", () => {
  it("importToKitchen with nothing to import does not raise the Kitchen's scheduleRevision", async () => {
    const user = await createTestUser();
    const kitchen = await createKitchen(user._id);
    await putUserInKitchen(user._id, kitchen._id);
    const before = await kitchenRevision(kitchen._id);

    const count = await importToKitchen(
      user._id.toString(),
      kitchen._id.toString(),
      daysFromToday(-1),
      daysFromToday(1)
    );

    expect(count).toBe(0);
    const after = await kitchenRevision(kitchen._id);
    expect(after).toBe(before);
  });

  it("setEntryRsvp leaves both the Kitchen's and the acting member's own scheduleRevision untouched", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await createKitchen(lead._id);
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    const entry = await ScheduleEntry.create({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      status: "confirmed",
    });
    const kitchenBefore = await kitchenRevision(kitchen._id);
    const memberBefore = await userRevision(member._id);

    await setEntryRsvp(member._id.toString(), entry._id.toString(), "going");

    const kitchenAfter = await kitchenRevision(kitchen._id);
    const memberAfter = await userRevision(member._id);
    expect(kitchenAfter).toBe(kitchenBefore);
    expect(memberAfter).toBe(memberBefore);
  });

  it("markEntryCooked leaves both the entry owner's and the acting member's scheduleRevision, and the shared Kitchen's scheduleRevision, untouched", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await createKitchen(lead._id);
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    const recipe = await createTestRecipe({ authorId: lead._id });
    const entry = await ScheduleEntry.create({
      userId: lead._id,
      kitchenId: kitchen._id,
      recipeId: recipe._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      status: "confirmed",
    });
    const kitchenBefore = await kitchenRevision(kitchen._id);
    const leadBefore = await userRevision(lead._id);
    const memberBefore = await userRevision(member._id);

    await markEntryCooked(member._id.toString(), entry._id.toString());

    const kitchenAfter = await kitchenRevision(kitchen._id);
    const leadAfter = await userRevision(lead._id);
    const memberAfter = await userRevision(member._id);
    expect(kitchenAfter).toBe(kitchenBefore);
    expect(leadAfter).toBe(leadBefore);
    expect(memberAfter).toBe(memberBefore);
  });
});

describe("the counter survives a failure in a cascade write that follows the main one", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("still raises the counter when propagating a replaced recipe to leftovers throws", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const replacement = await createTestRecipe({
      authorId: user._id,
      title: "Replacement",
    });
    await User.updateOne({ _id: user._id }, { $set: { isPremium: true } });
    const entry = await ScheduleEntry.create({
      userId: user._id,
      date: stripTime(new Date()),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });
    await ScheduleEntry.create({
      userId: user._id,
      date: stripTime(new Date()),
      mealSlot: "lunch",
      recipeId: recipe._id,
      status: "confirmed",
      leftoverOfEntryId: entry._id,
    });

    const before =
      (await User.findById(user._id).lean())?.scheduleRevision ?? 0;
    vi.spyOn(ScheduleEntry, "updateMany").mockRejectedValueOnce(
      new Error("cascade failed")
    );

    await expect(
      updateEntry(user._id.toString(), entry._id.toString(), {
        recipeId: replacement._id.toString(),
      })
    ).rejects.toThrow();

    const after = (await User.findById(user._id).lean())?.scheduleRevision ?? 0;
    expect(after).toBe(before + 1);
  });

  it("still raises the counter when removing the leftovers of a deleted meal throws", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const entry = await ScheduleEntry.create({
      userId: user._id,
      date: stripTime(new Date()),
      mealSlot: "dinner",
      recipeId: recipe._id,
      status: "confirmed",
    });

    const before =
      (await User.findById(user._id).lean())?.scheduleRevision ?? 0;
    vi.spyOn(ScheduleEntry, "deleteMany").mockRejectedValueOnce(
      new Error("cascade failed")
    );

    await expect(
      deleteEntry(user._id.toString(), entry._id.toString(), {
        withLeftovers: true,
      })
    ).rejects.toThrow();

    const after = (await User.findById(user._id).lean())?.scheduleRevision ?? 0;
    expect(after).toBe(before + 1);
  });
});
