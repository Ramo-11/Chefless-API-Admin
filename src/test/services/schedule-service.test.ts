import { describe, expect, it } from "vitest";
import ScheduleEntry from "../../models/ScheduleEntry";
import Kitchen from "../../models/Kitchen";
import User from "../../models/User";
import { createTestRecipe, createTestUser } from "../helpers";
import {
  addEntry,
  importToKitchen,
  setEntryRsvp,
  updateEntry,
} from "../../services/schedule-service";

async function createRsvpEntry(kitchenId: string, userId: string) {
  return ScheduleEntry.create({
    kitchenId,
    userId,
    date: new Date(),
    mealSlot: "dinner",
    status: "confirmed",
  });
}

describe("schedule-service setEntryRsvp", () => {
  it("never leaves two RSVP rows for the same member under concurrent submits", async () => {
    const lead = await createTestUser({ email: "rsvp-lead-1@test.com" });
    const kitchen = await Kitchen.create({
      name: "RSVP Kitchen",
      leadId: lead._id,
      inviteCode: "RSVPKIT1",
      memberCount: 1,
    });
    await User.updateOne(
      { _id: lead._id },
      { $set: { kitchenId: kitchen._id } }
    );
    const entry = await createRsvpEntry(
      kitchen._id.toString(),
      lead._id.toString()
    );

    await Promise.all([
      setEntryRsvp(lead._id.toString(), entry._id.toString(), "going"),
      setEntryRsvp(lead._id.toString(), entry._id.toString(), "going"),
      setEntryRsvp(lead._id.toString(), entry._id.toString(), "not_going"),
      setEntryRsvp(lead._id.toString(), entry._id.toString(), "going"),
    ]);

    const updated = await ScheduleEntry.findById(entry._id).lean();
    const mine = (updated?.rsvps ?? []).filter((r) => r.userId.equals(lead._id));
    expect(mine.length).toBe(1);
  });

  it("replaces the previous choice on a sequential resubmit", async () => {
    const lead = await createTestUser({ email: "rsvp-lead-2@test.com" });
    const kitchen = await Kitchen.create({
      name: "RSVP Kitchen 2",
      leadId: lead._id,
      inviteCode: "RSVPKIT2",
      memberCount: 1,
    });
    await User.updateOne(
      { _id: lead._id },
      { $set: { kitchenId: kitchen._id } }
    );
    const entry = await createRsvpEntry(
      kitchen._id.toString(),
      lead._id.toString()
    );

    await setEntryRsvp(lead._id.toString(), entry._id.toString(), "going");
    await setEntryRsvp(lead._id.toString(), entry._id.toString(), "not_going");

    const updated = await ScheduleEntry.findById(entry._id).lean();
    expect(updated?.rsvps).toHaveLength(1);
    expect(updated?.rsvps[0].status).toBe("not_going");
  });

  it("clears the RSVP row when status is null", async () => {
    const lead = await createTestUser({ email: "rsvp-lead-3@test.com" });
    const kitchen = await Kitchen.create({
      name: "RSVP Kitchen 3",
      leadId: lead._id,
      inviteCode: "RSVPKIT3",
      memberCount: 1,
    });
    await User.updateOne(
      { _id: lead._id },
      { $set: { kitchenId: kitchen._id } }
    );
    const entry = await createRsvpEntry(
      kitchen._id.toString(),
      lead._id.toString()
    );

    await setEntryRsvp(lead._id.toString(), entry._id.toString(), "going");
    await setEntryRsvp(lead._id.toString(), entry._id.toString(), null);

    const updated = await ScheduleEntry.findById(entry._id).lean();
    expect(updated?.rsvps).toHaveLength(0);
  });

  it("keeps each kitchen member's RSVP separate", async () => {
    const lead = await createTestUser({ email: "rsvp-lead-4@test.com" });
    const member = await createTestUser({ email: "rsvp-member-4@test.com" });
    const kitchen = await Kitchen.create({
      name: "RSVP Kitchen 4",
      leadId: lead._id,
      inviteCode: "RSVPKIT4",
      memberCount: 2,
    });
    await User.updateMany(
      { _id: { $in: [lead._id, member._id] } },
      { $set: { kitchenId: kitchen._id } }
    );
    const entry = await createRsvpEntry(
      kitchen._id.toString(),
      lead._id.toString()
    );

    await setEntryRsvp(lead._id.toString(), entry._id.toString(), "going");
    await setEntryRsvp(member._id.toString(), entry._id.toString(), "not_going");

    const updated = await ScheduleEntry.findById(entry._id).lean();
    expect(updated?.rsvps).toHaveLength(2);
    const leadRsvp = updated?.rsvps.find((r) => r.userId.equals(lead._id));
    const memberRsvp = updated?.rsvps.find((r) => r.userId.equals(member._id));
    expect(leadRsvp?.status).toBe("going");
    expect(memberRsvp?.status).toBe("not_going");
  });
});

describe("schedule recipe privacy", () => {
  async function createLeadKitchen(email: string, inviteCode: string) {
    const lead = await createTestUser({ email });
    const kitchen = await Kitchen.create({
      name: "Privacy Kitchen",
      leadId: lead._id,
      inviteCode,
      memberCount: 1,
      scheduleAddPolicy: "all",
    });
    await User.updateOne(
      { _id: lead._id },
      { $set: { kitchenId: kitchen._id } }
    );
    return { lead, kitchen };
  }

  it("allows an owner to keep a private recipe on a personal plan", async () => {
    const user = await createTestUser({ email: "private-personal@test.com" });
    const recipe = await createTestRecipe({
      authorId: user._id,
      isPrivate: true,
    });
    const entry = await addEntry(user._id.toString(), null, {
      date: new Date(),
      mealSlot: "dinner",
      recipeId: recipe._id.toString(),
    });
    expect(entry.recipeId?.equals(recipe._id)).toBe(true);
    expect(entry.kitchenId).toBeUndefined();
  });

  it("rejects a private recipe when creating a Kitchen meal", async () => {
    const { lead, kitchen } = await createLeadKitchen(
      "private-kitchen@test.com",
      "PRIVKIT1"
    );
    const recipe = await createTestRecipe({
      authorId: lead._id,
      isPrivate: true,
    });
    await expect(
      addEntry(lead._id.toString(), kitchen._id.toString(), {
        date: new Date(),
        mealSlot: "dinner",
        recipeId: recipe._id.toString(),
      })
    ).rejects.toThrow(/Private recipes cannot be added/);
    expect(await ScheduleEntry.countDocuments({ kitchenId: kitchen._id })).toBe(0);
  });

  it("preserves the existing Kitchen meal when a private replacement is rejected", async () => {
    const { lead, kitchen } = await createLeadKitchen(
      "private-replace@test.com",
      "PRIVKIT2"
    );
    const shared = await createTestRecipe({ authorId: lead._id, title: "Shared" });
    const privateRecipe = await createTestRecipe({
      authorId: lead._id,
      title: "Private",
      isPrivate: true,
    });
    const entry = await addEntry(lead._id.toString(), kitchen._id.toString(), {
      date: new Date(),
      mealSlot: "dinner",
      recipeId: shared._id.toString(),
    });
    await expect(
      updateEntry(lead._id.toString(), entry._id.toString(), {
        recipeId: privateRecipe._id.toString(),
      })
    ).rejects.toThrow(/Private recipes cannot be added/);
    const stored = await ScheduleEntry.findById(entry._id).lean();
    expect(stored?.recipeId?.equals(shared._id)).toBe(true);
    expect(stored?.recipeTitle).toBe("Shared");
  });

  it("rejects a whole personal import before inserting any Kitchen entries", async () => {
    const { lead, kitchen } = await createLeadKitchen(
      "private-import@test.com",
      "PRIVKIT3"
    );
    const shared = await createTestRecipe({ authorId: lead._id, title: "Shared" });
    const privateRecipe = await createTestRecipe({
      authorId: lead._id,
      title: "Private",
      isPrivate: true,
    });
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    await ScheduleEntry.create([
      {
        userId: lead._id,
        date: now,
        mealSlot: "lunch",
        recipeId: shared._id,
        status: "confirmed",
      },
      {
        userId: lead._id,
        date: now,
        mealSlot: "dinner",
        recipeId: privateRecipe._id,
        status: "confirmed",
      },
    ]);
    await expect(
      importToKitchen(
        lead._id.toString(),
        kitchen._id.toString(),
        now,
        now
      )
    ).rejects.toThrow(/Private recipes cannot be added/);
    expect(await ScheduleEntry.countDocuments({ kitchenId: kitchen._id })).toBe(0);
    expect(
      await ScheduleEntry.countDocuments({
        userId: lead._id,
        kitchenId: { $exists: false },
      })
    ).toBe(2);
  });
});
