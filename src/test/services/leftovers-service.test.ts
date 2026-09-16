import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import ScheduleEntry, { IScheduleEntry } from "../../models/ScheduleEntry";
import Kitchen from "../../models/Kitchen";
import User from "../../models/User";
import { createTestRecipe, createTestUser } from "../helpers";
import {
  planLeftovers,
  getEntries,
  redactLockedEntriesForFree,
  deleteEntry,
  updateEntry,
} from "../../services/schedule-service";
import { listPendingCookPrompts } from "../../services/rating-service";

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

interface CreateEntryOptions {
  userId: Types.ObjectId;
  kitchenId?: Types.ObjectId;
  recipeId?: Types.ObjectId;
  freeformText?: string;
  date?: Date;
  mealSlot?: string;
  servings?: number;
  status?: "confirmed" | "suggested";
  leftoverOfEntryId?: Types.ObjectId;
}

async function createEntry(options: CreateEntryOptions) {
  return ScheduleEntry.create({
    userId: options.userId,
    kitchenId: options.kitchenId,
    recipeId: options.recipeId,
    freeformText: options.freeformText,
    date: options.date ?? daysFromToday(0),
    mealSlot: options.mealSlot ?? "dinner",
    servings: options.servings,
    status: options.status ?? "confirmed",
    leftoverOfEntryId: options.leftoverOfEntryId,
  });
}

describe("planLeftovers personal plan", () => {
  it("creates a leftover on a personal plan with the source's recipe snapshot, leftoverOfEntryId pointing at the source, and the source's servings when cook extra is off", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({
      authorId: user._id,
      title: "Chicken Biryani",
    });
    recipe.photos = ["https://example.com/biryani.jpg"];
    await recipe.save();
    const source = await createEntry({
      userId: user._id,
      recipeId: recipe._id,
      servings: 4,
    });

    const { leftover } = await planLeftovers(
      user._id.toString(),
      source._id.toString(),
      { date: daysFromToday(1), mealSlot: "lunch", cookExtra: false }
    );

    expect(leftover.leftoverOfEntryId?.equals(source._id)).toBe(true);
    expect(leftover.recipeId?.equals(recipe._id)).toBe(true);
    expect(leftover.recipeTitle).toBe("Chicken Biryani");
    expect(leftover.recipePhoto).toBe("https://example.com/biryani.jpg");
    expect(leftover.recipeAuthorId?.equals(user._id)).toBe(true);
    expect(leftover.recipeAuthorName).toBe(user.fullName);
    expect(leftover.servings).toBe(4);
  });
});

describe("planLeftovers Kitchen plan status derivation", () => {
  it("creates a confirmed leftover on a Kitchen plan for the lead", async () => {
    const lead = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Lead Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 1,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    const recipe = await createTestRecipe({ authorId: lead._id });
    const source = await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      recipeId: recipe._id,
    });

    const { leftover } = await planLeftovers(
      lead._id.toString(),
      source._id.toString(),
      { date: daysFromToday(1), mealSlot: "lunch", cookExtra: false }
    );

    expect(leftover.status).toBe("confirmed");
    expect(leftover.confirmedBy?.equals(lead._id)).toBe(true);
  });

  it("creates a confirmed leftover on a Kitchen plan for a member with edit rights", async () => {
    const lead = await createTestUser();
    const editor = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Editor Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
      membersWithScheduleEdit: [editor._id],
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(editor._id, kitchen._id);
    const recipe = await createTestRecipe({ authorId: lead._id });
    const source = await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      recipeId: recipe._id,
    });

    const { leftover } = await planLeftovers(
      editor._id.toString(),
      source._id.toString(),
      { date: daysFromToday(1), mealSlot: "lunch", cookExtra: false }
    );

    expect(leftover.status).toBe("confirmed");
  });

  it("creates a suggested leftover on a Kitchen plan for a member without edit rights, with status derived exactly like addEntry", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Member Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    const recipe = await createTestRecipe({ authorId: lead._id });
    const source = await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      recipeId: recipe._id,
    });

    const { leftover } = await planLeftovers(
      member._id.toString(),
      source._id.toString(),
      { date: daysFromToday(1), mealSlot: "lunch", cookExtra: false }
    );

    expect(leftover.status).toBe("suggested");
    expect(leftover.suggestedBy?.equals(member._id)).toBe(true);
    expect(leftover.confirmedBy).toBeUndefined();
  });

  it("a kitchen whose allowMemberSuggestions is false refuses a member without edit rights with 403", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "No Suggestions Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
      allowMemberSuggestions: false,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    const recipe = await createTestRecipe({ authorId: lead._id });
    const source = await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      recipeId: recipe._id,
    });

    await expect(
      planLeftovers(member._id.toString(), source._id.toString(), {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: false,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "The kitchen lead has turned off member suggestions.",
    });
    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
  });
});

describe("planLeftovers cook extra", () => {
  it("raises the source's servings by the requested amount and both writes land", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await createEntry({
      userId: user._id,
      recipeId: recipe._id,
      servings: 4,
    });

    const { leftover, source: updatedSource } = await planLeftovers(
      user._id.toString(),
      source._id.toString(),
      {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: true,
        extraServings: 3,
      }
    );

    expect(leftover.servings).toBe(3);
    expect(updatedSource.servings).toBe(7);
    const storedSource = await ScheduleEntry.findById(source._id).lean();
    expect(storedSource?.servings).toBe(7);
  });

  it("defaults extraServings to the source's servings when it is omitted", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await createEntry({
      userId: user._id,
      recipeId: recipe._id,
      servings: 5,
    });

    const { leftover, source: updatedSource } = await planLeftovers(
      user._id.toString(),
      source._id.toString(),
      { date: daysFromToday(1), mealSlot: "lunch", cookExtra: true }
    );

    expect(leftover.servings).toBe(5);
    expect(updatedSource.servings).toBe(10);
  });

  it("rolls back the leftover and leaves the source's servings unchanged when the source update fails", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await createEntry({
      userId: user._id,
      recipeId: recipe._id,
      servings: 4,
    });

    const spy = vi
      .spyOn(ScheduleEntry, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("simulated write failure"));

    await expect(
      planLeftovers(user._id.toString(), source._id.toString(), {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: true,
        extraServings: 3,
      })
    ).rejects.toMatchObject({
      statusCode: 500,
      message: "Could not plan the leftovers. Please try again.",
    });

    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
    const storedSource = await ScheduleEntry.findById(source._id).lean();
    expect(storedSource?.servings).toBe(4);

    spy.mockRestore();
  });

  it("caps the source at 100 servings by clamping the extra to what still fits, so the leftover gets the clamped amount rather than the full request", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await createEntry({
      userId: user._id,
      recipeId: recipe._id,
      servings: 95,
    });

    const { leftover, source: updatedSource } = await planLeftovers(
      user._id.toString(),
      source._id.toString(),
      {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: true,
        extraServings: 10,
      }
    );

    expect(leftover.servings).toBe(5);
    expect(updatedSource.servings).toBe(100);
  });

  it("writes nothing to a source already at 100 servings and gives the leftover the source's own servings", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await createEntry({
      userId: user._id,
      recipeId: recipe._id,
      servings: 100,
    });

    const spy = vi.spyOn(ScheduleEntry, "findOneAndUpdate");

    const { leftover, source: updatedSource } = await planLeftovers(
      user._id.toString(),
      source._id.toString(),
      {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: true,
        extraServings: 5,
      }
    );

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(leftover.servings).toBe(100);
    expect(updatedSource.servings).toBe(100);
    const storedSource = await ScheduleEntry.findById(source._id).lean();
    expect(storedSource?.servings).toBe(100);
  });

  it("refuses cook extra with 403 for a Kitchen member without edit rights", async () => {
    const lead = await createTestUser();
    const member = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Cook Extra Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 2,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    await putUserInKitchen(member._id, kitchen._id);
    const recipe = await createTestRecipe({ authorId: lead._id });
    const source = await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      recipeId: recipe._id,
      servings: 4,
    });

    await expect(
      planLeftovers(member._id.toString(), source._id.toString(), {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: true,
        extraServings: 2,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "Only the kitchen lead or editors can change how much is cooked.",
    });
    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
    const storedSource = await ScheduleEntry.findById(source._id).lean();
    expect(storedSource?.servings).toBe(4);
  });
});

describe("planLeftovers refusals", () => {
  it("refuses a source that is itself a leftover", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const base = await createEntry({ userId: user._id, recipeId: recipe._id });
    const source = await createEntry({
      userId: user._id,
      recipeId: recipe._id,
      leftoverOfEntryId: base._id,
    });

    await expect(
      planLeftovers(user._id.toString(), source._id.toString(), {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: false,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Leftovers cannot have their own leftovers.",
    });
    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
  });

  it("refuses a source with no recipe because it is freeform", async () => {
    const user = await createTestUser();
    const source = await createEntry({
      userId: user._id,
      freeformText: "Whatever was in the fridge",
    });

    await expect(
      planLeftovers(user._id.toString(), source._id.toString(), {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: false,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Only meals with a recipe can have leftovers.",
    });
    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
  });

  it("refuses a source whose status is suggested", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await createEntry({
      userId: user._id,
      recipeId: recipe._id,
      status: "suggested",
    });

    await expect(
      planLeftovers(user._id.toString(), source._id.toString(), {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: false,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message:
        "This meal is waiting for approval. Plan leftovers once it is approved.",
    });
    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
  });

  it("refuses a leftover date before the source date", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await createEntry({
      userId: user._id,
      recipeId: recipe._id,
      date: daysFromToday(0),
    });

    await expect(
      planLeftovers(user._id.toString(), source._id.toString(), {
        date: daysFromToday(-1),
        mealSlot: "lunch",
        cookExtra: false,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Leftovers go on the same day as the meal or a later day.",
    });
    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
  });

  it("refuses a source belonging to a Kitchen the caller is not in", async () => {
    const lead = await createTestUser();
    const outsider = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Members Only Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 1,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    const recipe = await createTestRecipe({ authorId: lead._id });
    const source = await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      recipeId: recipe._id,
    });

    await expect(
      planLeftovers(outsider._id.toString(), source._id.toString(), {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: false,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "You are not a member of this kitchen",
    });
    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
  });

  it("refuses a personal source belonging to someone else", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const recipe = await createTestRecipe({ authorId: owner._id });
    const source = await createEntry({ userId: owner._id, recipeId: recipe._id });

    await expect(
      planLeftovers(other._id.toString(), source._id.toString(), {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: false,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "You do not own this schedule entry",
    });
    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
  });
});

describe("planLeftovers free tier window", () => {
  it("refuses a free user asking for a leftover date more than two days ahead, with the existing free tier message", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await createEntry({
      userId: user._id,
      recipeId: recipe._id,
      date: daysFromToday(0),
    });

    await expect(
      planLeftovers(user._id.toString(), source._id.toString(), {
        date: daysFromToday(5),
        mealSlot: "lunch",
        cookExtra: false,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message:
        "Free tier users can plan within 2 days before and 2 days after today. Upgrade to premium for full calendar scheduling.",
    });
    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
  });

  it("lets a premium user plan a leftover on the same far future date that a free user was refused", async () => {
    const user = await createTestUser();
    await User.updateOne({ _id: user._id }, { $set: { isPremium: true } });
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await createEntry({
      userId: user._id,
      recipeId: recipe._id,
      date: daysFromToday(0),
    });

    const { leftover } = await planLeftovers(
      user._id.toString(),
      source._id.toString(),
      { date: daysFromToday(5), mealSlot: "lunch", cookExtra: false }
    );

    expect(leftover.leftoverOfEntryId?.equals(source._id)).toBe(true);
  });
});

describe("planLeftovers recipe visibility", () => {
  it("refuses a private recipe scheduled as a leftover on a Kitchen plan", async () => {
    const lead = await createTestUser();
    const kitchen = await Kitchen.create({
      name: "Privacy Kitchen",
      leadId: lead._id,
      inviteCode: new Types.ObjectId().toString(),
      memberCount: 1,
    });
    await putUserInKitchen(lead._id, kitchen._id);
    const recipe = await createTestRecipe({
      authorId: lead._id,
      isPrivate: true,
    });
    const source = await createEntry({
      userId: lead._id,
      kitchenId: kitchen._id,
      recipeId: recipe._id,
    });

    await expect(
      planLeftovers(lead._id.toString(), source._id.toString(), {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: false,
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("Private recipes cannot be added"),
    });
    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
  });

  it("refuses a recipe the caller cannot see", async () => {
    const author = await createTestUser({ isPublic: false });
    const caller = await createTestUser();
    const recipe = await createTestRecipe({ authorId: author._id });
    const source = await createEntry({ userId: caller._id, recipeId: recipe._id });

    await expect(
      planLeftovers(caller._id.toString(), source._id.toString(), {
        date: daysFromToday(1),
        mealSlot: "lunch",
        cookExtra: false,
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: "You do not have permission to schedule this recipe",
    });
    expect(
      await ScheduleEntry.countDocuments({ leftoverOfEntryId: source._id })
    ).toBe(0);
  });
});

describe("getEntries leftover enrichment", () => {
  it("attaches leftoverOfDate on a leftover whose source is inside the fetched range", async () => {
    const user = await createTestUser();
    const source = await createEntry({
      userId: user._id,
      mealSlot: "source-inside",
      date: daysFromToday(0),
    });
    const leftover = await createEntry({
      userId: user._id,
      mealSlot: "leftover-inside",
      date: daysFromToday(1),
      leftoverOfEntryId: source._id,
    });

    const entries = await getEntries(
      { userId: user._id.toString() },
      daysFromToday(-1),
      daysFromToday(2)
    );

    const found = entries.find((e) => e._id.equals(leftover._id));
    expect(found?.leftoverOfDate?.getTime()).toBe(source.date.getTime());
  });

  it("attaches leftoverOfDate on a leftover whose source is outside the fetched range", async () => {
    const user = await createTestUser();
    const source = await createEntry({
      userId: user._id,
      mealSlot: "source-outside",
      date: daysFromToday(-10),
    });
    const leftover = await createEntry({
      userId: user._id,
      mealSlot: "leftover-outside",
      date: daysFromToday(0),
      leftoverOfEntryId: source._id,
    });

    const entries = await getEntries(
      { userId: user._id.toString() },
      daysFromToday(-1),
      daysFromToday(1)
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]._id.equals(leftover._id)).toBe(true);
    expect(entries[0].leftoverOfDate?.getTime()).toBe(source.date.getTime());
  });

  it("omits leftoverOfDate when the source was deleted", async () => {
    const user = await createTestUser();
    const leftover = await createEntry({
      userId: user._id,
      mealSlot: "orphan-leftover",
      date: daysFromToday(0),
      leftoverOfEntryId: new Types.ObjectId(),
    });

    const entries = await getEntries(
      { userId: user._id.toString() },
      daysFromToday(-1),
      daysFromToday(1)
    );

    const found = entries.find((e) => e._id.equals(leftover._id));
    expect(found?.leftoverOfDate).toBeUndefined();
  });

  it("attaches leftoverCount to a source that has leftovers while leaving entries without leftovers untouched", async () => {
    const user = await createTestUser();
    const source = await createEntry({
      userId: user._id,
      mealSlot: "source-with-leftovers",
      date: daysFromToday(0),
    });
    await createEntry({
      userId: user._id,
      mealSlot: "leftover-1",
      date: daysFromToday(1),
      leftoverOfEntryId: source._id,
    });
    await createEntry({
      userId: user._id,
      mealSlot: "leftover-2",
      date: daysFromToday(2),
      leftoverOfEntryId: source._id,
    });
    const unrelated = await createEntry({
      userId: user._id,
      mealSlot: "unrelated",
      date: daysFromToday(1),
    });

    const entries = await getEntries(
      { userId: user._id.toString() },
      daysFromToday(-1),
      daysFromToday(3)
    );

    const foundSource = entries.find((e) => e._id.equals(source._id));
    const foundUnrelated = entries.find((e) => e._id.equals(unrelated._id));
    expect(foundSource?.leftoverCount).toBe(2);
    expect(foundUnrelated?.leftoverCount).toBeUndefined();
  });
});

describe("redactLockedEntriesForFree leftover fields", () => {
  it("clears leftoverOfEntryId, leftoverOfDate, and leftoverCount on a locked future entry for a free user", async () => {
    const user = await createTestUser();
    const created = await createEntry({
      userId: user._id,
      date: daysFromToday(10),
      leftoverOfEntryId: new Types.ObjectId(),
    });
    const entry = (await ScheduleEntry.findById(
      created._id
    ).lean()) as IScheduleEntry;
    entry.leftoverOfDate = daysFromToday(9);
    entry.leftoverCount = 3;

    redactLockedEntriesForFree([entry], false);

    expect(entry.leftoverOfEntryId).toBeUndefined();
    expect(entry.leftoverOfDate).toBeUndefined();
    expect(entry.leftoverCount).toBeUndefined();
    expect(entry.locked).toBe(true);
  });
});

describe("deleteEntry withLeftovers", () => {
  it("removes the source and its leftovers and reports the count when withLeftovers is true", async () => {
    const user = await createTestUser();
    const source = await createEntry({ userId: user._id, mealSlot: "source" });
    const leftoverOne = await createEntry({
      userId: user._id,
      mealSlot: "leftover-1",
      leftoverOfEntryId: source._id,
    });
    const leftoverTwo = await createEntry({
      userId: user._id,
      mealSlot: "leftover-2",
      leftoverOfEntryId: source._id,
    });

    const result = await deleteEntry(
      user._id.toString(),
      source._id.toString(),
      { withLeftovers: true }
    );

    expect(result.removedLeftovers).toBe(2);
    expect(await ScheduleEntry.findById(source._id).lean()).toBeNull();
    expect(await ScheduleEntry.findById(leftoverOne._id).lean()).toBeNull();
    expect(await ScheduleEntry.findById(leftoverTwo._id).lean()).toBeNull();
  });

  it("leaves the leftovers in place as ordinary entries and reports zero when the flag is absent", async () => {
    const user = await createTestUser();
    const source = await createEntry({ userId: user._id, mealSlot: "source" });
    const leftover = await createEntry({
      userId: user._id,
      mealSlot: "leftover",
      leftoverOfEntryId: source._id,
    });

    const result = await deleteEntry(user._id.toString(), source._id.toString());

    expect(result.removedLeftovers).toBe(0);
    expect(await ScheduleEntry.findById(source._id).lean()).toBeNull();
    const stored = await ScheduleEntry.findById(leftover._id).lean();
    expect(stored).not.toBeNull();
    expect(stored?.leftoverOfEntryId?.equals(source._id)).toBe(true);
  });

  it("never touches the source when deleting a leftover", async () => {
    const user = await createTestUser();
    const source = await createEntry({ userId: user._id, mealSlot: "source" });
    const leftover = await createEntry({
      userId: user._id,
      mealSlot: "leftover",
      leftoverOfEntryId: source._id,
    });

    const result = await deleteEntry(
      user._id.toString(),
      leftover._id.toString(),
      { withLeftovers: true }
    );

    expect(result.removedLeftovers).toBe(0);
    expect(await ScheduleEntry.findById(leftover._id).lean()).toBeNull();
    const storedSource = await ScheduleEntry.findById(source._id).lean();
    expect(storedSource).not.toBeNull();
  });
});

describe("updateEntry recipe snapshot propagation", () => {
  it("propagates a new recipe snapshot to the source's leftovers without changing their servings, date, or meal slot", async () => {
    const user = await createTestUser();
    const originalRecipe = await createTestRecipe({
      authorId: user._id,
      title: "Original Dish",
    });
    const newRecipe = await createTestRecipe({
      authorId: user._id,
      title: "New Dish",
    });
    newRecipe.photos = ["https://example.com/new-dish.jpg"];
    await newRecipe.save();
    const source = await ScheduleEntry.create({
      userId: user._id,
      recipeId: originalRecipe._id,
      recipeTitle: originalRecipe.title,
      mealSlot: "source",
      servings: 4,
      date: daysFromToday(0),
      status: "confirmed",
    });
    const leftoverDate = daysFromToday(1);
    const leftover = await ScheduleEntry.create({
      userId: user._id,
      recipeId: originalRecipe._id,
      recipeTitle: originalRecipe.title,
      mealSlot: "leftover",
      servings: 2,
      date: leftoverDate,
      status: "confirmed",
      leftoverOfEntryId: source._id,
    });

    await updateEntry(user._id.toString(), source._id.toString(), {
      recipeId: newRecipe._id.toString(),
    });

    const storedLeftover = await ScheduleEntry.findById(leftover._id).lean();
    expect(storedLeftover?.recipeId?.equals(newRecipe._id)).toBe(true);
    expect(storedLeftover?.recipeTitle).toBe("New Dish");
    expect(storedLeftover?.recipePhoto).toBe("https://example.com/new-dish.jpg");
    expect(storedLeftover?.recipeAuthorId?.equals(user._id)).toBe(true);
    expect(storedLeftover?.servings).toBe(2);
    expect(storedLeftover?.date.getTime()).toBe(leftoverDate.getTime());
    expect(storedLeftover?.mealSlot).toBe("leftover");
  });

  it("leaves a leftover's existing photo in place when the replacement recipe has no photo of its own, because the propagation only sets fields and never unsets them", async () => {
    const user = await createTestUser();
    const originalRecipe = await createTestRecipe({
      authorId: user._id,
      title: "Original Dish",
    });
    const newRecipe = await createTestRecipe({
      authorId: user._id,
      title: "New Dish",
    });
    const source = await ScheduleEntry.create({
      userId: user._id,
      recipeId: originalRecipe._id,
      recipeTitle: originalRecipe.title,
      recipePhoto: "https://example.com/old-photo.jpg",
      mealSlot: "source",
      servings: 4,
      date: daysFromToday(0),
      status: "confirmed",
    });
    const leftover = await ScheduleEntry.create({
      userId: user._id,
      recipeId: originalRecipe._id,
      recipeTitle: originalRecipe.title,
      recipePhoto: "https://example.com/old-photo.jpg",
      mealSlot: "leftover",
      servings: 2,
      date: daysFromToday(1),
      status: "confirmed",
      leftoverOfEntryId: source._id,
    });

    await updateEntry(user._id.toString(), source._id.toString(), {
      recipeId: newRecipe._id.toString(),
    });

    const storedLeftover = await ScheduleEntry.findById(leftover._id).lean();
    expect(storedLeftover?.recipeTitle).toBe("New Dish");
    expect(storedLeftover?.recipePhoto).toBe("https://example.com/old-photo.jpg");
  });

  it("never touches the source when a leftover's own recipe is replaced", async () => {
    const user = await createTestUser();
    const originalRecipe = await createTestRecipe({
      authorId: user._id,
      title: "Original Dish",
    });
    const newRecipe = await createTestRecipe({
      authorId: user._id,
      title: "New Dish",
    });
    const source = await ScheduleEntry.create({
      userId: user._id,
      recipeId: originalRecipe._id,
      recipeTitle: originalRecipe.title,
      mealSlot: "source",
      servings: 4,
      date: daysFromToday(0),
      status: "confirmed",
    });
    const leftover = await ScheduleEntry.create({
      userId: user._id,
      recipeId: originalRecipe._id,
      recipeTitle: originalRecipe.title,
      mealSlot: "leftover",
      servings: 2,
      date: daysFromToday(1),
      status: "confirmed",
      leftoverOfEntryId: source._id,
    });

    await updateEntry(user._id.toString(), leftover._id.toString(), {
      recipeId: newRecipe._id.toString(),
    });

    const storedSource = await ScheduleEntry.findById(source._id).lean();
    expect(storedSource?.recipeId?.equals(originalRecipe._id)).toBe(true);
    expect(storedSource?.recipeTitle).toBe("Original Dish");
    expect(storedSource?.servings).toBe(4);
  });
});

describe("cook prompts and leftovers", () => {
  it("never asks whether a leftover was cooked, because a leftover cannot be marked cooked", async () => {
    const user = await createTestUser();
    const recipe = await createTestRecipe({ authorId: user._id });
    const source = await ScheduleEntry.create({
      userId: user._id,
      recipeId: recipe._id,
      recipeTitle: recipe.title,
      mealSlot: "breakfast",
      servings: 4,
      date: daysFromToday(-1),
      status: "confirmed",
      cookedAt: null,
    });
    await ScheduleEntry.create({
      userId: user._id,
      recipeId: recipe._id,
      recipeTitle: recipe.title,
      mealSlot: "breakfast",
      servings: 4,
      date: daysFromToday(-1),
      status: "confirmed",
      cookedAt: null,
      leftoverOfEntryId: source._id,
    });

    const prompts = (await listPendingCookPrompts(
      user._id.toString(),
      0
    )) as IScheduleEntry[];

    expect(prompts).toHaveLength(1);
    expect(prompts[0]._id.equals(source._id)).toBe(true);
  });
});
