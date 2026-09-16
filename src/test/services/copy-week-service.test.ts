import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import ScheduleEntry from "../../models/ScheduleEntry";
import Kitchen from "../../models/Kitchen";
import User from "../../models/User";
import Recipe from "../../models/Recipe";
import { createTestRecipe, createTestUser } from "../helpers";
import {
  buildCopiedEntries,
  copyWeek,
  batchDeleteEntries,
} from "../../services/schedule-service";
import * as notificationService from "../../services/notification-service";

const FREE_TIER_MESSAGE =
  "Free tier users can plan within 2 days before and 2 days after today. Upgrade to premium for full calendar scheduling.";

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

async function makePremium(userId: Types.ObjectId) {
  await User.updateOne({ _id: userId }, { $set: { isPremium: true } });
}

async function putUserInKitchen(userId: Types.ObjectId, kitchenId: Types.ObjectId) {
  await User.updateOne({ _id: userId }, { $set: { kitchenId } });
}

interface EntryOptions {
  userId: Types.ObjectId;
  kitchenId?: Types.ObjectId;
  date?: Date;
  mealSlot?: string;
  recipeId?: Types.ObjectId;
  freeformText?: string;
  servings?: number;
  prepTime?: number;
  status?: "confirmed" | "suggested";
  leftoverOfEntryId?: Types.ObjectId;
  suggestedBy?: Types.ObjectId;
  confirmedBy?: Types.ObjectId;
  cookedAt?: Date;
  ratingPromptSkippedAt?: Date;
  rsvps?: { userId: Types.ObjectId; status: "going" | "not_going" }[];
}

async function createEntry(options: EntryOptions) {
  return ScheduleEntry.create({
    userId: options.userId,
    kitchenId: options.kitchenId,
    date: options.date ?? daysFromToday(0),
    mealSlot: options.mealSlot ?? "dinner",
    recipeId: options.recipeId,
    freeformText: options.freeformText,
    servings: options.servings,
    prepTime: options.prepTime,
    status: options.status ?? "confirmed",
    leftoverOfEntryId: options.leftoverOfEntryId,
    suggestedBy: options.suggestedBy,
    confirmedBy: options.confirmedBy,
    cookedAt: options.cookedAt,
    ratingPromptSkippedAt: options.ratingPromptSkippedAt,
    rsvps: options.rsvps,
  });
}

function titleOf(item: Record<string, unknown>): unknown {
  return item.recipeTitle ?? item.freeformText;
}

describe("buildCopiedEntries skip filled slots", () => {
  it("skips a meal when the target slot already holds one and skipFilledSlots is on", async () => {
    const user = await createTestUser();
    const source = await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Source meal",
    });
    const target = await createEntry({
      userId: user._id,
      date: daysFromToday(7),
      mealSlot: "dinner",
      freeformText: "Already planned",
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [source],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [target],
      actingUserId: user._id.toString(),
      kitchenId: null,
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.skipped.filledSlots).toBe(1);
    expect(plan.entries).toHaveLength(0);
  });

  it("creates the meal next to the existing one when skipFilledSlots is off", async () => {
    const user = await createTestUser();
    const source = await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Source meal",
    });
    const target = await createEntry({
      userId: user._id,
      date: daysFromToday(7),
      mealSlot: "dinner",
      freeformText: "Already planned",
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [source],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [target],
      actingUserId: user._id.toString(),
      kitchenId: null,
      status: "confirmed",
      skipFilledSlots: false,
      isPremium: true,
    });

    expect(plan.skipped.filledSlots).toBe(0);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].freeformText).toBe("Source meal");
  });

  it("matches slots case insensitively so Dinner in the source does not duplicate dinner in the target", async () => {
    const user = await createTestUser();
    const source = await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "Dinner",
      freeformText: "Source meal",
    });
    const target = await createEntry({
      userId: user._id,
      date: daysFromToday(7),
      mealSlot: "dinner",
      freeformText: "Already planned",
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [source],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [target],
      actingUserId: user._id.toString(),
      kitchenId: null,
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.skipped.filledSlots).toBe(1);
    expect(plan.entries).toHaveLength(0);
  });
});

describe("buildCopiedEntries recipe availability", () => {
  it("leaves out a meal whose recipe was deleted and counts it once per meal even when two meals share the recipe", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const first = await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "lunch",
      recipeId: recipe._id,
    });
    const second = await createEntry({
      userId: user._id,
      date: daysFromToday(1),
      mealSlot: "dinner",
      recipeId: recipe._id,
    });
    await Recipe.findByIdAndDelete(recipe._id);

    const plan = await buildCopiedEntries({
      sourceEntries: [first, second],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [],
      actingUserId: user._id.toString(),
      kitchenId: null,
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.skipped.unavailableRecipes).toBe(2);
    expect(plan.entries).toHaveLength(0);
  });

  it("leaves out a recipe that became private when copying into a Kitchen plan, even for its own author", async () => {
    const author = await createTestUser();
    const recipe = await createTestRecipe({
      authorId: author._id,
      isPrivate: true,
    });
    const source = await createEntry({
      userId: author._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [source],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [],
      actingUserId: author._id.toString(),
      kitchenId: new Types.ObjectId(),
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.skipped.unavailableRecipes).toBe(1);
    expect(plan.entries).toHaveLength(0);
  });

  it("still copies a recipe that became private on a personal plan when the person owns it", async () => {
    const author = await createTestUser();
    const recipe = await createTestRecipe({
      authorId: author._id,
      isPrivate: true,
    });
    const source = await createEntry({
      userId: author._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [source],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [],
      actingUserId: author._id.toString(),
      kitchenId: null,
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.skipped.unavailableRecipes).toBe(0);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].recipeId?.toString()).toBe(recipe._id.toString());
  });
});

describe("buildCopiedEntries leftovers", () => {
  it("points a copied leftover at the new copy of its source when the source is in the same batch", async () => {
    const user = await createTestUser();
    const main = await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Main meal",
    });
    const leftover = await createEntry({
      userId: user._id,
      date: daysFromToday(1),
      mealSlot: "lunch",
      freeformText: "Leftover meal",
      leftoverOfEntryId: main._id,
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [main, leftover],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [],
      actingUserId: user._id.toString(),
      kitchenId: null,
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.entries).toHaveLength(2);
    const builtMain = plan.entries.find((e) => e.freeformText === "Main meal")!;
    const builtLeftover = plan.entries.find(
      (e) => e.freeformText === "Leftover meal"
    )!;

    expect((builtLeftover.leftoverOfEntryId as Types.ObjectId).equals(
      builtMain._id as Types.ObjectId
    )).toBe(true);
    expect((builtLeftover.leftoverOfEntryId as Types.ObjectId).equals(main._id)).toBe(
      false
    );
  });

  it("leaves out a leftover whose source meal is not part of the batch and counts it in leftoversWithoutSource", async () => {
    const user = await createTestUser();
    const leftover = await createEntry({
      userId: user._id,
      date: daysFromToday(1),
      mealSlot: "lunch",
      freeformText: "Orphan leftover",
      leftoverOfEntryId: new Types.ObjectId(),
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [leftover],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [],
      actingUserId: user._id.toString(),
      kitchenId: null,
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.skipped.leftoversWithoutSource).toBe(1);
    expect(plan.entries).toHaveLength(0);
  });

  it("leaves out a leftover whose source meal was itself skipped and counts it in leftoversWithoutSource", async () => {
    const user = await createTestUser();
    const main = await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Main meal",
    });
    const leftover = await createEntry({
      userId: user._id,
      date: daysFromToday(1),
      mealSlot: "lunch",
      freeformText: "Leftover meal",
      leftoverOfEntryId: main._id,
    });
    const occupiedTarget = await createEntry({
      userId: user._id,
      date: daysFromToday(7),
      mealSlot: "dinner",
      freeformText: "Blocking meal",
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [main, leftover],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [occupiedTarget],
      actingUserId: user._id.toString(),
      kitchenId: null,
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.skipped.filledSlots).toBe(1);
    expect(plan.skipped.leftoversWithoutSource).toBe(1);
    expect(plan.entries).toHaveLength(0);
  });

  it("records in sourceEntryIdByNewId which source entry produced every built document", async () => {
    const user = await createTestUser();
    const main = await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Main meal",
    });
    const leftover = await createEntry({
      userId: user._id,
      date: daysFromToday(1),
      mealSlot: "lunch",
      freeformText: "Leftover meal",
      leftoverOfEntryId: main._id,
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [main, leftover],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [],
      actingUserId: user._id.toString(),
      kitchenId: null,
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.entries).toHaveLength(2);
    expect(plan.sourceEntryIdByNewId.size).toBe(2);

    const builtMain = plan.entries.find((e) => e.freeformText === "Main meal")!;
    const builtLeftover = plan.entries.find(
      (e) => e.freeformText === "Leftover meal"
    )!;

    const mainSource = plan.sourceEntryIdByNewId.get(
      (builtMain._id as Types.ObjectId).toString()
    );
    const leftoverSource = plan.sourceEntryIdByNewId.get(
      (builtLeftover._id as Types.ObjectId).toString()
    );

    expect(mainSource?.equals(main._id)).toBe(true);
    expect(leftoverSource?.equals(leftover._id)).toBe(true);
  });
});

describe("buildCopiedEntries never carries source only fields", () => {
  it("never copies cookedAt, rsvps, the rating prompt skip, or the source's suggestedBy and confirmedBy", async () => {
    const actingUser = await createTestUser();
    const otherUser = await createTestUser();
    const source = await createEntry({
      userId: otherUser._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Main meal",
      status: "confirmed",
      suggestedBy: otherUser._id,
      confirmedBy: otherUser._id,
      cookedAt: new Date(),
      ratingPromptSkippedAt: new Date(),
      rsvps: [{ userId: otherUser._id, status: "going" }],
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [source],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [],
      actingUserId: actingUser._id.toString(),
      kitchenId: new Types.ObjectId(),
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.entries).toHaveLength(1);
    const doc = plan.entries[0];

    expect((doc.suggestedBy as Types.ObjectId).equals(actingUser._id)).toBe(true);
    expect((doc.confirmedBy as Types.ObjectId).equals(actingUser._id)).toBe(true);
    expect(doc.cookedAt).toBeUndefined();
    expect(doc.ratingPromptSkippedAt).toBeUndefined();
    expect(doc.rsvps).toBeUndefined();
  });
});

describe("buildCopiedEntries servings and prep time", () => {
  it("uses the source meal's own servings and prep time over the recipe's", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    recipe.servings = 6;
    recipe.prepTime = 20;
    await recipe.save();
    const source = await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
      servings: 2,
      prepTime: 45,
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [source],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [],
      actingUserId: user._id.toString(),
      kitchenId: null,
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.entries[0].servings).toBe(2);
    expect(plan.entries[0].prepTime).toBe(45);
  });

  it("falls back to the recipe's servings and prep time when the source meal has none of its own", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    recipe.servings = 6;
    recipe.prepTime = 20;
    await recipe.save();
    const source = await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      recipeId: recipe._id,
    });

    const plan = await buildCopiedEntries({
      sourceEntries: [source],
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      targetEntries: [],
      actingUserId: user._id.toString(),
      kitchenId: null,
      status: "confirmed",
      skipFilledSlots: true,
      isPremium: true,
    });

    expect(plan.entries[0].servings).toBe(6);
    expect(plan.entries[0].prepTime).toBe(20);
  });
});

describe("copyWeek dry run and real run parity", () => {
  it("produces the same created meals, dates, slots, titles, leftover flags and skip counts whether run as a dry run or for real", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    const recipe = await createTestRecipe({ authorId: user._id, title: "Kept Recipe" });
    const deletedRecipe = await createTestRecipe({ authorId: user._id });
    const sourceStart = daysFromToday(0);
    const targetStart = daysFromToday(7);

    const kept = await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "breakfast",
      recipeId: recipe._id,
    });
    await createEntry({
      userId: user._id,
      date: daysFromToday(2),
      mealSlot: "lunch",
      freeformText: "Leftover of kept",
      leftoverOfEntryId: kept._id,
    });
    await createEntry({
      userId: user._id,
      date: daysFromToday(1),
      mealSlot: "dinner",
      freeformText: "Will be skipped as filled",
    });
    await createEntry({
      userId: user._id,
      date: daysFromToday(8),
      mealSlot: "dinner",
      freeformText: "Already there",
    });
    await createEntry({
      userId: user._id,
      date: daysFromToday(3),
      mealSlot: "snack",
      recipeId: deletedRecipe._id,
    });
    await Recipe.findByIdAndDelete(deletedRecipe._id);

    const dryRunResult = await copyWeek(user._id.toString(), {
      sourceStart,
      targetStart,
      skipFilledSlots: true,
      dryRun: true,
    });
    const realRunResult = await copyWeek(user._id.toString(), {
      sourceStart,
      targetStart,
      skipFilledSlots: true,
      dryRun: false,
    });

    expect(dryRunResult.sourceCount).toBe(4);
    expect(realRunResult.sourceCount).toBe(4);
    expect(dryRunResult.skipped).toEqual({
      filledSlots: 1,
      unavailableRecipes: 1,
      leftoversWithoutSource: 0,
    });
    expect(realRunResult.skipped).toEqual(dryRunResult.skipped);
    expect(dryRunResult.created).toHaveLength(2);
    expect(realRunResult.created).toHaveLength(2);

    const dryCreated = dryRunResult.created as Record<string, unknown>[];
    const realCreated = realRunResult.created as Record<string, unknown>[];

    for (let i = 0; i < dryCreated.length; i += 1) {
      expect(new Date(dryCreated[i].date as Date).getTime()).toBe(
        new Date(realCreated[i].date as Date).getTime()
      );
      expect(dryCreated[i].mealSlot).toBe(realCreated[i].mealSlot);
      expect(titleOf(dryCreated[i])).toBe(titleOf(realCreated[i]));
      expect(Boolean(dryCreated[i].leftoverOfEntryId)).toBe(
        Boolean(realCreated[i].leftoverOfEntryId)
      );
    }
  });

  it("a dry run writes nothing and moves no revision counter", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Source meal",
    });
    const countBefore = await ScheduleEntry.countDocuments({});
    const revisionBefore = (await User.findById(user._id).lean())?.scheduleRevision;

    await copyWeek(user._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: true,
    });

    const countAfter = await ScheduleEntry.countDocuments({});
    const revisionAfter = (await User.findById(user._id).lean())?.scheduleRevision;

    expect(countAfter).toBe(countBefore);
    expect(revisionAfter).toBe(revisionBefore);
  });

  it("names each preview row's own source meal even when two leftovers land on the same day and the same meal slot", async () => {
    const user = await createTestUser();
    const sourceStart = daysFromToday(0);
    const targetStart = daysFromToday(7);
    const mealA = await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "lunch",
      freeformText: "Meal A",
    });
    const mealB = await createEntry({
      userId: user._id,
      date: daysFromToday(1),
      mealSlot: "lunch",
      freeformText: "Meal B",
    });
    await createEntry({
      userId: user._id,
      date: daysFromToday(3),
      mealSlot: "dinner",
      freeformText: "Leftover A",
      leftoverOfEntryId: mealA._id,
    });
    await createEntry({
      userId: user._id,
      date: daysFromToday(3),
      mealSlot: "dinner",
      freeformText: "Leftover B",
      leftoverOfEntryId: mealB._id,
    });

    const result = await copyWeek(user._id.toString(), {
      sourceStart,
      targetStart,
      skipFilledSlots: true,
      dryRun: true,
    });

    const created = result.created as Record<string, unknown>[];
    expect(created).toHaveLength(4);
    const itemA = created.find((c) => c.freeformText === "Leftover A")!;
    const itemB = created.find((c) => c.freeformText === "Leftover B")!;

    expect(itemA.date).toEqual(itemB.date);
    expect(itemA.mealSlot).toBe(itemB.mealSlot);
    expect((itemA.leftoverOfEntryId as Types.ObjectId).toString()).toBe(
      mealA._id.toString()
    );
    expect((itemB.leftoverOfEntryId as Types.ObjectId).toString()).toBe(
      mealB._id.toString()
    );
    expect((itemA.leftoverOfEntryId as Types.ObjectId).toString()).not.toBe(
      (itemB.leftoverOfEntryId as Types.ObjectId).toString()
    );
  });
});

describe("copyWeek kitchen status derivation", () => {
  it("gives the kitchen lead confirmed meals", async () => {
    const lead = await createTestUser();
    await makePremium(lead._id);
    const kitchen = await Kitchen.create({
      name: "Lead Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 1,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Kitchen meal",
    });

    const result = await copyWeek(lead._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    const created = result.created as Array<{ status: string; confirmedBy?: Types.ObjectId }>;
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe("confirmed");
    expect(created[0].confirmedBy?.equals(lead._id)).toBe(true);
  });

  it("gives a member without edit rights suggestions under the lead only policy", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    await makePremium(member._id);
    const kitchen = await Kitchen.create({
      name: "Member Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Kitchen meal",
    });

    const result = await copyWeek(member._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    const created = result.created as Array<{
      status: string;
      suggestedBy?: Types.ObjectId;
      confirmedBy?: Types.ObjectId;
    }>;
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe("suggested");
    expect(created[0].suggestedBy?.equals(member._id)).toBe(true);
    expect(created[0].confirmedBy).toBeUndefined();
  });

  it("gives a member without edit rights confirmed meals when the kitchen lets everyone add directly", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    await makePremium(member._id);
    const kitchen = await Kitchen.create({
      name: "Open Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
      scheduleAddPolicy: "all",
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Kitchen meal",
    });

    const result = await copyWeek(member._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    const created = result.created as Array<{ status: string; confirmedBy?: Types.ObjectId }>;
    expect(created).toHaveLength(1);
    expect(created[0].status).toBe("confirmed");
    expect(created[0].confirmedBy?.equals(member._id)).toBe(true);
  });
});

describe("copyWeek suggestion notification", () => {
  it("sends exactly one aggregate notification for a member's copy, never one per meal", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    await makePremium(member._id);
    const kitchen = await Kitchen.create({
      name: "Notify Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(0),
      mealSlot: "breakfast",
      freeformText: "Meal 1",
    });
    await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(1),
      mealSlot: "lunch",
      freeformText: "Meal 2",
    });
    await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(2),
      mealSlot: "dinner",
      freeformText: "Meal 3",
    });
    const spy = vi.spyOn(notificationService, "notifyScheduleImportSuggestions");

    const result = await copyWeek(member._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    expect(result.created).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      member._id.toString(),
      kitchen._id.toString(),
      3
    );

    spy.mockRestore();
  });
});

describe("copyWeek member suggestions blocked", () => {
  it("refuses a member's copy with 403 and writes nothing when the kitchen has turned off member suggestions", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Locked Down Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
      allowMemberSuggestions: false,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Kitchen meal",
    });
    const revisionBefore = (await Kitchen.findById(kitchen._id).lean())
      ?.scheduleRevision;

    await expect(
      copyWeek(member._id.toString(), {
        sourceStart: daysFromToday(0),
        targetStart: daysFromToday(7),
        skipFilledSlots: true,
        dryRun: false,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "The kitchen lead has turned off member suggestions.",
    });

    expect(
      await ScheduleEntry.countDocuments({
        kitchenId: kitchen._id,
        date: { $gte: daysFromToday(7) },
      })
    ).toBe(0);
    const revisionAfter = (await Kitchen.findById(kitchen._id).lean())
      ?.scheduleRevision;
    expect(revisionAfter).toBe(revisionBefore);
  });
});

describe("copyWeek free planning window", () => {
  it("refuses a free account's real copy that would land on a locked day and writes nothing", async () => {
    const user = await createTestUser();
    await createEntry({
      userId: user._id,
      date: daysFromToday(-14),
      mealSlot: "dinner",
      freeformText: "Meal 1",
    });
    await createEntry({
      userId: user._id,
      date: daysFromToday(-13),
      mealSlot: "lunch",
      freeformText: "Meal 2",
    });

    await expect(
      copyWeek(user._id.toString(), {
        sourceStart: daysFromToday(-14),
        targetStart: daysFromToday(7),
        skipFilledSlots: true,
        dryRun: false,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "PREMIUM_REQUIRED",
      message: FREE_TIER_MESSAGE,
    });

    expect(
      await ScheduleEntry.countDocuments({
        userId: user._id,
        date: { $gte: daysFromToday(7) },
      })
    ).toBe(0);
  });

  it("still succeeds as a dry run for a free account and reports locked dates greater than zero", async () => {
    const user = await createTestUser();
    await createEntry({
      userId: user._id,
      date: daysFromToday(-14),
      mealSlot: "dinner",
      freeformText: "Meal 1",
    });
    await createEntry({
      userId: user._id,
      date: daysFromToday(-13),
      mealSlot: "lunch",
      freeformText: "Meal 2",
    });

    const result = await copyWeek(user._id.toString(), {
      sourceStart: daysFromToday(-14),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: true,
    });

    expect(result.lockedDates).toBeGreaterThan(0);
    expect(result.created).toHaveLength(2);
  });

  it("lets a premium account copy the same dates for real and always reports zero locked dates", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    await createEntry({
      userId: user._id,
      date: daysFromToday(-14),
      mealSlot: "dinner",
      freeformText: "Meal 1",
    });

    const result = await copyWeek(user._id.toString(), {
      sourceStart: daysFromToday(-14),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    expect(result.lockedDates).toBe(0);
    expect(result.created).toHaveLength(1);
  });
});

describe("copyWeek pending suggestions", () => {
  it("never copies a pending suggestion from the source week", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    await makePremium(lead._id);
    const kitchen = await Kitchen.create({
      name: "Pending Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Confirmed meal",
      status: "confirmed",
    });
    await createEntry({
      userId: member._id,
      kitchenId: kitchen._id,
      date: daysFromToday(1),
      mealSlot: "lunch",
      freeformText: "Pending suggestion",
      status: "suggested",
      suggestedBy: member._id,
    });

    const result = await copyWeek(lead._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    expect(result.sourceCount).toBe(1);
    const created = result.created as Record<string, unknown>[];
    expect(created).toHaveLength(1);
    expect(created[0].freeformText).toBe("Confirmed meal");
  });
});

describe("copyWeek overlapping weeks", () => {
  it("refuses two weeks that overlap", async () => {
    const user = await createTestUser();
    const countBefore = await ScheduleEntry.countDocuments({});

    await expect(
      copyWeek(user._id.toString(), {
        sourceStart: daysFromToday(0),
        targetStart: daysFromToday(3),
        skipFilledSlots: true,
        dryRun: false,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Pick a week that does not overlap the week you are copying into.",
    });

    expect(await ScheduleEntry.countDocuments({})).toBe(countBefore);
  });

  it("refuses copying a week onto itself", async () => {
    const user = await createTestUser();

    await expect(
      copyWeek(user._id.toString(), {
        sourceStart: daysFromToday(0),
        targetStart: daysFromToday(0),
        skipFilledSlots: true,
        dryRun: false,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Pick a week that does not overlap the week you are copying into.",
    });
  });
});

describe("copyWeek source week size limit", () => {
  it("refuses a source week with more than 500 confirmed meals", async () => {
    const user = await createTestUser();
    const sourceStart = daysFromToday(0);
    const docs = Array.from({ length: 501 }, (_, i) => ({
      userId: user._id,
      date: sourceStart,
      mealSlot: "dinner",
      freeformText: `Meal ${i}`,
      status: "confirmed" as const,
    }));
    await ScheduleEntry.insertMany(docs);

    await expect(
      copyWeek(user._id.toString(), {
        sourceStart,
        targetStart: daysFromToday(7),
        skipFilledSlots: true,
        dryRun: false,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "That week has too many meals to copy at once.",
    });

    expect(await ScheduleEntry.countDocuments({})).toBe(501);
  });
});

describe("copyWeek empty source week", () => {
  it("answers with an empty result, zero counters, no revision bump and no notification", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Empty Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    const spy = vi.spyOn(notificationService, "notifyScheduleImportSuggestions");
    const revisionBefore = (await Kitchen.findById(kitchen._id).lean())
      ?.scheduleRevision;

    const result = await copyWeek(member._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    expect(result).toEqual({
      created: [],
      skipped: { filledSlots: 0, unavailableRecipes: 0, leftoversWithoutSource: 0 },
      lockedDates: 0,
      sourceCount: 0,
    });
    expect(spy).not.toHaveBeenCalled();
    const revisionAfter = (await Kitchen.findById(kitchen._id).lean())
      ?.scheduleRevision;
    expect(revisionAfter).toBe(revisionBefore);

    spy.mockRestore();
  });
});

describe("copyWeek plan scope", () => {
  it("reads and writes only Kitchen entries for a Kitchen member", async () => {
    const lead = await createTestUser();
    await makePremium(lead._id);
    const kitchen = await Kitchen.create({
      name: "Scoped Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 1,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Kitchen Meal",
    });
    await createEntry({
      userId: lead._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Personal Meal",
    });

    const result = await copyWeek(lead._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    expect(result.sourceCount).toBe(1);
    const created = result.created as Record<string, unknown>[];
    expect(created).toHaveLength(1);
    expect(created[0].freeformText).toBe("Kitchen Meal");
    expect(created[0].kitchenId).toBeDefined();
    expect(
      await ScheduleEntry.countDocuments({ freeformText: "Personal Meal" })
    ).toBe(1);
  });

  it("reads and writes only personal entries for a person with no Kitchen", async () => {
    const solo = await createTestUser();
    await makePremium(solo._id);
    const otherLead = await createTestUser();
    const otherKitchen = await Kitchen.create({
      name: "Other Kitchen",
      leadId: otherLead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 1,
    });
    await putUserInKitchen(otherLead._id, otherKitchen._id);
    await createEntry({
      userId: solo._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "My Meal",
    });
    await createEntry({
      userId: otherLead._id,
      kitchenId: otherKitchen._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Other Kitchen Meal",
    });

    const result = await copyWeek(solo._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    expect(result.sourceCount).toBe(1);
    const created = result.created as Record<string, unknown>[];
    expect(created).toHaveLength(1);
    expect(created[0].freeformText).toBe("My Meal");
    expect(created[0].kitchenId).toBeUndefined();
  });
});

describe("copyWeek schedule revision counter", () => {
  it("bumps the user's counter once on a personal real copy", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Meal",
    });
    const before = (await User.findById(user._id).lean())?.scheduleRevision ?? 0;

    await copyWeek(user._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    const after = (await User.findById(user._id).lean())?.scheduleRevision ?? 0;
    expect(after).toBe(before + 1);
  });

  it("bumps the kitchen's counter once on a Kitchen real copy without touching the user's own counter", async () => {
    const lead = await createTestUser();
    await makePremium(lead._id);
    const kitchen = await Kitchen.create({
      name: "Revision Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 1,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Meal",
    });
    const kitchenBefore =
      (await Kitchen.findById(kitchen._id).lean())?.scheduleRevision ?? 0;
    const userBefore = (await User.findById(lead._id).lean())?.scheduleRevision ?? 0;

    await copyWeek(lead._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    const kitchenAfter =
      (await Kitchen.findById(kitchen._id).lean())?.scheduleRevision ?? 0;
    const userAfter = (await User.findById(lead._id).lean())?.scheduleRevision ?? 0;
    expect(kitchenAfter).toBe(kitchenBefore + 1);
    expect(userAfter).toBe(userBefore);
  });

  it("does not bump any counter when the copy creates nothing", async () => {
    const user = await createTestUser();
    await makePremium(user._id);
    await createEntry({
      userId: user._id,
      date: daysFromToday(0),
      mealSlot: "dinner",
      freeformText: "Source meal",
    });
    await createEntry({
      userId: user._id,
      date: daysFromToday(7),
      mealSlot: "dinner",
      freeformText: "Blocking meal",
    });
    const before = (await User.findById(user._id).lean())?.scheduleRevision ?? 0;

    const result = await copyWeek(user._id.toString(), {
      sourceStart: daysFromToday(0),
      targetStart: daysFromToday(7),
      skipFilledSlots: true,
      dryRun: false,
    });

    expect(result.created).toHaveLength(0);
    const after = (await User.findById(user._id).lean())?.scheduleRevision ?? 0;
    expect(after).toBe(before);
  });
});

describe("batchDeleteEntries", () => {
  it("removes exactly the listed meals and answers with the count", async () => {
    const user = await createTestUser();
    const keep = await createEntry({ userId: user._id, mealSlot: "keep" });
    const removeOne = await createEntry({ userId: user._id, mealSlot: "remove-1" });
    const removeTwo = await createEntry({ userId: user._id, mealSlot: "remove-2" });

    const result = await batchDeleteEntries(user._id.toString(), [
      removeOne._id.toString(),
      removeTwo._id.toString(),
    ]);

    expect(result.deleted).toBe(2);
    expect(await ScheduleEntry.findById(keep._id).lean()).not.toBeNull();
    expect(await ScheduleEntry.findById(removeOne._id).lean()).toBeNull();
    expect(await ScheduleEntry.findById(removeTwo._id).lean()).toBeNull();
  });

  it("ignores ids that no longer exist without treating them as an error", async () => {
    const user = await createTestUser();
    const real = await createEntry({ userId: user._id, mealSlot: "real" });
    const missingId = new Types.ObjectId().toString();

    const result = await batchDeleteEntries(user._id.toString(), [
      real._id.toString(),
      missingId,
    ]);

    expect(result.deleted).toBe(1);
    expect(await ScheduleEntry.findById(real._id).lean()).toBeNull();
  });

  it("refuses with nothing deleted when one id belongs to someone else", async () => {
    const user = await createTestUser();
    const other = await createTestUser();
    const own = await createEntry({ userId: user._id, mealSlot: "own" });
    const notOwned = await createEntry({ userId: other._id, mealSlot: "not-owned" });

    await expect(
      batchDeleteEntries(user._id.toString(), [
        own._id.toString(),
        notOwned._id.toString(),
      ])
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "You do not own this schedule entry",
    });

    expect(await ScheduleEntry.findById(own._id).lean()).not.toBeNull();
    expect(await ScheduleEntry.findById(notOwned._id).lean()).not.toBeNull();
  });

  it("refuses a confirmed Kitchen meal for a member without edit rights", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Delete Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    const confirmedEntry = await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      mealSlot: "dinner",
      status: "confirmed",
    });

    await expect(
      batchDeleteEntries(member._id.toString(), [confirmedEntry._id.toString()])
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Only the kitchen lead or editors can delete confirmed entries",
    });

    expect(await ScheduleEntry.findById(confirmedEntry._id).lean()).not.toBeNull();
  });

  it("allows a member to delete their own suggestion", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Own Suggestion Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    const ownSuggestion = await createEntry({
      userId: member._id,
      kitchenId: kitchen._id,
      mealSlot: "dinner",
      status: "suggested",
      suggestedBy: member._id,
    });

    const result = await batchDeleteEntries(member._id.toString(), [
      ownSuggestion._id.toString(),
    ]);

    expect(result.deleted).toBe(1);
    expect(await ScheduleEntry.findById(ownSuggestion._id).lean()).toBeNull();
  });

  it("moves the personal revision counter once even when deleting several entries in one call", async () => {
    const user = await createTestUser();
    const first = await createEntry({ userId: user._id, mealSlot: "first" });
    const second = await createEntry({ userId: user._id, mealSlot: "second" });
    const before = (await User.findById(user._id).lean())?.scheduleRevision ?? 0;

    await batchDeleteEntries(user._id.toString(), [
      first._id.toString(),
      second._id.toString(),
    ]);

    const after = (await User.findById(user._id).lean())?.scheduleRevision ?? 0;
    expect(after).toBe(before + 1);
  });

  it("moves the kitchen revision counter once even when deleting several entries in one call", async () => {
    const lead = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Bulk Delete Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 1,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    const first = await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      mealSlot: "first",
    });
    const second = await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      mealSlot: "second",
    });
    const before = (await Kitchen.findById(kitchen._id).lean())?.scheduleRevision ?? 0;

    await batchDeleteEntries(lead._id.toString(), [
      first._id.toString(),
      second._id.toString(),
    ]);

    const after = (await Kitchen.findById(kitchen._id).lean())?.scheduleRevision ?? 0;
    expect(after).toBe(before + 1);
  });

  it("bumps both the personal and the kitchen counter once each when a single call deletes one of each", async () => {
    const lead = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Mixed Delete Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 1,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    const personalEntry = await createEntry({ userId: lead._id, mealSlot: "personal" });
    const kitchenEntry = await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      mealSlot: "kitchen",
    });
    const userBefore = (await User.findById(lead._id).lean())?.scheduleRevision ?? 0;
    const kitchenBefore =
      (await Kitchen.findById(kitchen._id).lean())?.scheduleRevision ?? 0;

    await batchDeleteEntries(lead._id.toString(), [
      personalEntry._id.toString(),
      kitchenEntry._id.toString(),
    ]);

    const userAfter = (await User.findById(lead._id).lean())?.scheduleRevision ?? 0;
    const kitchenAfter =
      (await Kitchen.findById(kitchen._id).lean())?.scheduleRevision ?? 0;
    expect(userAfter).toBe(userBefore + 1);
    expect(kitchenAfter).toBe(kitchenBefore + 1);
  });

  it("never cascades to a leftover when its source meal is batch deleted", async () => {
    const user = await createTestUser();
    const source = await createEntry({ userId: user._id, mealSlot: "source" });
    const leftover = await createEntry({
      userId: user._id,
      mealSlot: "leftover",
      leftoverOfEntryId: source._id,
    });

    await batchDeleteEntries(user._id.toString(), [source._id.toString()]);

    expect(await ScheduleEntry.findById(source._id).lean()).toBeNull();
    expect(await ScheduleEntry.findById(leftover._id).lean()).not.toBeNull();
  });

  it("loads each kitchen at most once when several entries in the batch belong to the same kitchen", async () => {
    const lead = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "N Plus One Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 1,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    const entries = await Promise.all(
      ["one", "two", "three"].map((slot) =>
        createEntry({ userId: lead._id, kitchenId: kitchen._id, mealSlot: slot })
      )
    );
    const spy = vi.spyOn(Kitchen, "findById");

    await batchDeleteEntries(
      lead._id.toString(),
      entries.map((e) => e._id.toString())
    );

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
