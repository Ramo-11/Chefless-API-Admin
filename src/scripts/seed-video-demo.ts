/**
 * Seed a demo kitchen + recipes + schedule into `chefless_dev` so the
 * marketing video records a believable kitchen state. Safe to run repeatedly —
 * tag `videoDemo: true` on every doc so cleanup is one-query scoped.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://...chefless_dev" \
 *   LEAD_EMAIL="demo-xxx@chefless.test" \
 *   node --import tsx src/scripts/seed-video-demo.ts
 *
 * To undo:
 *   node --import tsx src/scripts/seed-video-demo.ts cleanup
 */
import mongoose from "mongoose";
import User from "../models/User";
import Kitchen from "../models/Kitchen";
import Recipe from "../models/Recipe";
import ScheduleEntry from "../models/ScheduleEntry";

const TAG = { videoDemo: true } as const;

const MEMBERS = [
  { fullName: "Huda Henderson", email: "huda.demo@chefless.test" },
  { fullName: "Yusuf Henderson", email: "yusuf.demo@chefless.test" },
  { fullName: "Layla Henderson", email: "layla.demo@chefless.test" },
];

const RECIPES = [
  {
    title: "Chicken Tikka Masala",
    description: "Creamy tomato-cashew sauce, charred chicken, garam masala finish.",
    cuisineTags: ["indian"],
    difficulty: "medium" as const,
    prepTime: 20,
    cookTime: 25,
    servings: 4,
  },
  {
    title: "Shakshuka & Sourdough",
    description: "Eggs poached in smoked paprika tomato, crusty sourdough soldiers.",
    cuisineTags: ["middle_eastern"],
    difficulty: "easy" as const,
    prepTime: 5,
    cookTime: 20,
    servings: 2,
  },
  {
    title: "Lamb Kofta Wraps",
    description: "Charcoal-grilled lamb, yogurt-tahini, pickled onions, warm laffa.",
    cuisineTags: ["middle_eastern"],
    difficulty: "medium" as const,
    prepTime: 15,
    cookTime: 15,
    servings: 4,
  },
  {
    title: "Date & Pistachio Maamoul",
    description: "Semolina shortbread filled with date paste, crushed pistachio.",
    cuisineTags: ["middle_eastern"],
    difficulty: "medium" as const,
    prepTime: 30,
    cookTime: 22,
    servings: 12,
  },
  {
    title: "Grilled Sea Bass",
    description: "Whole branzino, lemon-za'atar, fennel, roasted potatoes.",
    cuisineTags: ["mediterranean"],
    difficulty: "medium" as const,
    prepTime: 10,
    cookTime: 20,
    servings: 2,
  },
  {
    title: "Miso Oats with Soft Egg",
    description: "Savory oats, white miso, scallion, 6-minute egg.",
    cuisineTags: ["japanese"],
    difficulty: "easy" as const,
    prepTime: 5,
    cookTime: 10,
    servings: 1,
  },
  {
    title: "Roast Chicken & Schmaltz Potatoes",
    description: "Dry-brined whole bird, crispy schmaltz fingerlings.",
    cuisineTags: ["american"],
    difficulty: "medium" as const,
    prepTime: 20,
    cookTime: 80,
    servings: 4,
  },
  {
    title: "Kale Caesar with Anchovy Croutons",
    description: "Massaged kale, parmesan snow, brown-butter croutons with anchovy.",
    cuisineTags: ["american"],
    difficulty: "easy" as const,
    prepTime: 12,
    cookTime: 8,
    servings: 2,
  },
  {
    title: "Biryani (Hyderabadi)",
    description: "Dum-style basmati, saffron, marinated chicken, browned onions.",
    cuisineTags: ["indian"],
    difficulty: "hard" as const,
    prepTime: 45,
    cookTime: 60,
    servings: 6,
  },
  {
    title: "Ginger-Scallion Bowls",
    description: "Jasmine rice, poached chicken, soy-ginger-scallion oil.",
    cuisineTags: ["chinese"],
    difficulty: "easy" as const,
    prepTime: 10,
    cookTime: 25,
    servings: 3,
  },
];

/** Monday 00:00 of the week containing `d`. */
function weekStart(d: Date): Date {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay(); // 0=Sun..6=Sat
  const delta = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + delta);
  return date;
}

async function run() {
  const uri = process.env.MONGODB_URI;
  const leadEmail = process.env.LEAD_EMAIL;
  if (!uri) throw new Error("MONGODB_URI env var required");
  if (!leadEmail) throw new Error("LEAD_EMAIL env var required");
  if (!uri.includes("chefless_dev")) {
    throw new Error(
      `Refusing to run: MONGODB_URI must point at chefless_dev (got ${uri.replace(/:[^@]+@/, ":***@")})`,
    );
  }

  await mongoose.connect(uri);
  console.log("connected to", mongoose.connection.db?.databaseName);

  if (process.argv[2] === "cleanup") {
    await cleanup();
    await mongoose.disconnect();
    return;
  }

  const lead = await User.findOne({ email: leadEmail.toLowerCase() });
  if (!lead) throw new Error(`Lead user not found: ${leadEmail}`);
  console.log("lead:", lead.fullName, lead._id.toString());

  // 1. Create 3 fake members
  const memberDocs = await Promise.all(
    MEMBERS.map(async (m, i) => {
      const existing = await User.findOne({ email: m.email });
      if (existing) return existing;
      return User.create({
        firebaseUid: `video-demo-fake-${Date.now()}-${i}`,
        email: m.email,
        fullName: m.fullName,
        lastActiveAt: new Date(),
        videoDemo: true,
      });
    }),
  );
  console.log("members ready:", memberDocs.map((m) => m.fullName).join(", "));

  // 2. Create / reuse kitchen
  let kitchen = await Kitchen.findOne({
    name: "The Hendersons",
    leadId: lead._id,
  });
  if (!kitchen) {
    kitchen = await Kitchen.create({
      name: "The Hendersons",
      leadId: lead._id,
      inviteCode: "CHF-X7K2",
      inviteCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      memberCount: 1 + memberDocs.length,
      customMealSlots: ["Iftar"],
      scheduleAddPolicy: "all",
      ratingsVisibility: "kitchen_only",
      membersWithScheduleEdit: memberDocs.map((m) => m._id),
      membersWithApprovalPower: [],
      isPublic: false,
      videoDemo: true,
    });
  }
  console.log("kitchen:", kitchen.name, kitchen._id.toString());

  // 3. Link all members + lead to kitchen
  await User.updateMany(
    { _id: { $in: [lead._id, ...memberDocs.map((m) => m._id)] } },
    { $set: { kitchenId: kitchen._id } },
  );

  // 4. Seed recipes (half authored by lead, half by members)
  const authors = [lead, ...memberDocs];
  const recipeDocs = await Promise.all(
    RECIPES.map(async (r, i) => {
      const author = authors[i % authors.length];
      const existing = await Recipe.findOne({
        authorId: author._id,
        title: r.title,
      });
      if (existing) return { recipe: existing, author };
      const doc = await Recipe.create({
        ...r,
        authorId: author._id,
        totalTime: (r.prepTime ?? 0) + (r.cookTime ?? 0),
        baseServings: r.servings ?? 2,
        tags: [],
        labels: [],
        dietaryTags: [],
        ingredients: [],
        steps: [],
        photos: [],
        isPrivate: false,
        isHidden: false,
        videoDemo: true,
      });
      return { recipe: doc, author };
    }),
  );
  console.log("recipes ready:", recipeDocs.length);

  // 5. Build schedule for current week — breakfast/lunch/dinner per day
  const SLOTS: Array<{ slot: string; time: string }> = [
    { slot: "breakfast", time: "08:00" },
    { slot: "lunch", time: "13:00" },
    { slot: "dinner", time: "19:30" },
  ];

  const monday = weekStart(new Date());
  const entries: Array<Record<string, unknown>> = [];
  const now = new Date();

  for (let day = 0; day < 7; day++) {
    const date = new Date(monday);
    date.setDate(monday.getDate() + day);
    for (const { slot, time } of SLOTS) {
      // Skip some slots so it looks realistic (~85% filled)
      const skipSeed = (day * 31 + slot.charCodeAt(0) * 7) % 11;
      if (skipSeed < 2) continue;

      const recipeIdx = (day * 3 + slot.length) % recipeDocs.length;
      const { recipe, author } = recipeDocs[recipeIdx];
      const isPast = date < now;
      const cooked = isPast && skipSeed % 2 === 0;

      entries.push({
        kitchenId: kitchen._id,
        userId: author._id,
        date,
        mealSlot: slot,
        recipeId: recipe._id,
        recipeTitle: recipe.title,
        recipeAuthorId: recipe.authorId,
        recipeAuthorName: author.fullName,
        scheduledTime: time,
        status: "confirmed",
        confirmedBy: lead._id,
        cookedAt: cooked ? new Date(date.getTime() + 1000 * 60 * 60 * 2) : null,
        videoDemo: true,
      });
    }
  }

  // Clear prior demo schedule entries for this kitchen+week, then insert
  const weekEnd = new Date(monday);
  weekEnd.setDate(monday.getDate() + 7);
  await ScheduleEntry.deleteMany({
    kitchenId: kitchen._id,
    date: { $gte: monday, $lt: weekEnd },
  });
  await ScheduleEntry.insertMany(entries);
  console.log("schedule entries:", entries.length);

  // 6. Pin one uncooked dinner for *today* — this is the "mark as cooked + rate" demo
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const tikka = recipeDocs.find((r) => r.recipe.title === "Chicken Tikka Masala");
  if (tikka) {
    await ScheduleEntry.findOneAndUpdate(
      {
        kitchenId: kitchen._id,
        date: todayMidnight,
        mealSlot: "dinner",
      },
      {
        $set: {
          kitchenId: kitchen._id,
          userId: lead._id,
          date: todayMidnight,
          mealSlot: "dinner",
          recipeId: tikka.recipe._id,
          recipeTitle: tikka.recipe.title,
          recipeAuthorId: tikka.author._id,
          recipeAuthorName: tikka.author.fullName,
          scheduledTime: "19:30",
          status: "confirmed",
          confirmedBy: lead._id,
          cookedAt: null,
          videoDemo: true,
        },
      },
      { upsert: true, new: true },
    );
    console.log("pinned tonight's dinner: Chicken Tikka Masala");
  }

  console.log("\n✅ seeded. Log in with", leadEmail, "/ DemoPass_2026!");
  console.log("kitchen id:", kitchen._id.toString());

  await mongoose.disconnect();
}

async function cleanup() {
  const kitchen = await Kitchen.findOne({ name: "The Hendersons" });
  if (kitchen) {
    await ScheduleEntry.deleteMany({ kitchenId: kitchen._id });
    await Kitchen.deleteOne({ _id: kitchen._id });
    console.log("removed kitchen + schedule");
  }
  await User.updateMany(
    { email: { $in: MEMBERS.map((m) => m.email) } },
    { $unset: { kitchenId: 1 } },
  );
  const delFakes = await User.deleteMany({
    email: { $in: MEMBERS.map((m) => m.email) },
  });
  console.log("removed fake members:", delFakes.deletedCount);
  const delRecipes = await Recipe.deleteMany({
    title: { $in: RECIPES.map((r) => r.title) },
  });
  console.log("removed demo recipes:", delRecipes.deletedCount);
  // Leave the real demo user (Omar Henderson) alone — we remove it separately
  // via Firebase Auth + /api/users/me DELETE during the post-approval cleanup.
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
