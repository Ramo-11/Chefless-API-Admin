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
import ShoppingList from "../models/ShoppingList";

const TAG = { videoDemo: true } as const;

const MEMBERS = [
  { fullName: "Huda Henderson", email: "huda.demo@chefless.test" },
  { fullName: "Yusuf Henderson", email: "yusuf.demo@chefless.test" },
  { fullName: "Layla Henderson", email: "layla.demo@chefless.test" },
];

type RecipeSeed = {
  title: string;
  description: string;
  cuisineTags: string[];
  difficulty: "easy" | "medium" | "hard";
  prepTime: number;
  cookTime: number;
  servings: number;
  photo: string;
  ingredients: Array<{ name: string; quantity: number; unit: string }>;
};

// Unsplash direct image URLs — stable CDN, resized inline
const img = (id: string) =>
  `https://images.unsplash.com/${id}?w=900&h=900&fit=crop&auto=format&q=80`;

const RECIPES: RecipeSeed[] = [
  {
    title: "Chicken Tikka Masala",
    description: "Creamy tomato-cashew sauce, charred chicken, garam masala finish.",
    cuisineTags: ["indian"],
    difficulty: "medium",
    prepTime: 20,
    cookTime: 25,
    servings: 4,
    photo: img("photo-1585937421612-70a008356fbe"),
    ingredients: [
      { name: "Chicken thigh", quantity: 700, unit: "g" },
      { name: "Yogurt", quantity: 200, unit: "g" },
      { name: "Tomato passata", quantity: 400, unit: "g" },
      { name: "Garam masala", quantity: 2, unit: "tsp" },
      { name: "Heavy cream", quantity: 150, unit: "ml" },
    ],
  },
  {
    title: "Shakshuka & Sourdough",
    description: "Eggs poached in smoked paprika tomato, crusty sourdough soldiers.",
    cuisineTags: ["middle_eastern"],
    difficulty: "easy",
    prepTime: 5,
    cookTime: 20,
    servings: 2,
    photo: img("photo-1590412200988-a436970781fa"),
    ingredients: [
      { name: "Eggs", quantity: 4, unit: "pc" },
      { name: "Canned tomatoes", quantity: 400, unit: "g" },
      { name: "Red bell pepper", quantity: 1, unit: "pc" },
      { name: "Smoked paprika", quantity: 1, unit: "tsp" },
      { name: "Sourdough loaf", quantity: 1, unit: "pc" },
    ],
  },
  {
    title: "Lamb Kofta Wraps",
    description: "Charcoal-grilled lamb, yogurt-tahini, pickled onions, warm laffa.",
    cuisineTags: ["middle_eastern"],
    difficulty: "medium",
    prepTime: 15,
    cookTime: 15,
    servings: 4,
    photo: img("photo-1529042410759-befb1204b468"),
    ingredients: [
      { name: "Ground lamb", quantity: 500, unit: "g" },
      { name: "Red onion", quantity: 1, unit: "pc" },
      { name: "Parsley", quantity: 1, unit: "bunch" },
      { name: "Tahini", quantity: 3, unit: "tbsp" },
      { name: "Laffa bread", quantity: 4, unit: "pc" },
    ],
  },
  {
    title: "Date & Pistachio Maamoul",
    description: "Semolina shortbread filled with date paste, crushed pistachio.",
    cuisineTags: ["middle_eastern"],
    difficulty: "medium",
    prepTime: 30,
    cookTime: 22,
    servings: 12,
    photo: img("photo-1534432182912-63863115e106"),
    ingredients: [
      { name: "Semolina flour", quantity: 300, unit: "g" },
      { name: "Medjool dates", quantity: 250, unit: "g" },
      { name: "Pistachios", quantity: 100, unit: "g" },
      { name: "Butter", quantity: 150, unit: "g" },
    ],
  },
  {
    title: "Grilled Sea Bass",
    description: "Whole branzino, lemon-za'atar, fennel, roasted potatoes.",
    cuisineTags: ["mediterranean"],
    difficulty: "medium",
    prepTime: 10,
    cookTime: 20,
    servings: 2,
    photo: img("photo-1519708227418-c8fd9a32b7a2"),
    ingredients: [
      { name: "Whole sea bass", quantity: 2, unit: "pc" },
      { name: "Lemon", quantity: 2, unit: "pc" },
      { name: "Fennel bulb", quantity: 1, unit: "pc" },
      { name: "Baby potatoes", quantity: 500, unit: "g" },
    ],
  },
  {
    title: "Miso Oats with Soft Egg",
    description: "Savory oats, white miso, scallion, 6-minute egg.",
    cuisineTags: ["japanese"],
    difficulty: "easy",
    prepTime: 5,
    cookTime: 10,
    servings: 1,
    photo: img("photo-1542691457-cbe4df041eb2"),
    ingredients: [
      { name: "Rolled oats", quantity: 80, unit: "g" },
      { name: "White miso", quantity: 1, unit: "tbsp" },
      { name: "Eggs", quantity: 1, unit: "pc" },
      { name: "Scallion", quantity: 2, unit: "pc" },
    ],
  },
  {
    title: "Roast Chicken & Schmaltz Potatoes",
    description: "Dry-brined whole bird, crispy schmaltz fingerlings.",
    cuisineTags: ["american"],
    difficulty: "medium",
    prepTime: 20,
    cookTime: 80,
    servings: 4,
    photo: img("photo-1598103442097-8b74394b95c6"),
    ingredients: [
      { name: "Whole chicken", quantity: 1, unit: "pc" },
      { name: "Fingerling potatoes", quantity: 700, unit: "g" },
      { name: "Thyme", quantity: 1, unit: "bunch" },
      { name: "Butter", quantity: 80, unit: "g" },
    ],
  },
  {
    title: "Kale Caesar with Anchovy Croutons",
    description: "Massaged kale, parmesan snow, brown-butter croutons with anchovy.",
    cuisineTags: ["american"],
    difficulty: "easy",
    prepTime: 12,
    cookTime: 8,
    servings: 2,
    photo: img("photo-1546793665-c74683f339c1"),
    ingredients: [
      { name: "Lacinato kale", quantity: 1, unit: "bunch" },
      { name: "Parmesan", quantity: 80, unit: "g" },
      { name: "Anchovy fillets", quantity: 6, unit: "pc" },
      { name: "Sourdough cubes", quantity: 2, unit: "cups" },
    ],
  },
  {
    title: "Biryani (Hyderabadi)",
    description: "Dum-style basmati, saffron, marinated chicken, browned onions.",
    cuisineTags: ["indian"],
    difficulty: "hard",
    prepTime: 45,
    cookTime: 60,
    servings: 6,
    photo: img("photo-1563379091339-03b21ab4a4f8"),
    ingredients: [
      { name: "Basmati rice", quantity: 500, unit: "g" },
      { name: "Chicken", quantity: 1, unit: "kg" },
      { name: "Saffron", quantity: 1, unit: "pinch" },
      { name: "Yogurt", quantity: 200, unit: "g" },
      { name: "Brown onions", quantity: 200, unit: "g" },
    ],
  },
  {
    title: "Ginger-Scallion Bowls",
    description: "Jasmine rice, poached chicken, soy-ginger-scallion oil.",
    cuisineTags: ["chinese"],
    difficulty: "easy",
    prepTime: 10,
    cookTime: 25,
    servings: 3,
    photo: img("photo-1569718212165-3a8278d5f624"),
    ingredients: [
      { name: "Jasmine rice", quantity: 400, unit: "g" },
      { name: "Chicken breast", quantity: 500, unit: "g" },
      { name: "Ginger", quantity: 60, unit: "g" },
      { name: "Scallion", quantity: 6, unit: "pc" },
      { name: "Soy sauce", quantity: 3, unit: "tbsp" },
    ],
  },
];

// Split recipe authorship so Omar (lead) owns 6 — makes Recipes tab look full.
const LEAD_RECIPE_INDEXES = new Set([0, 4, 6, 7, 8, 9]);

const SHOPPING_ITEMS: Array<{ name: string; quantity: number; unit: string; category: string }> = [
  { name: "Chicken thighs", quantity: 1, unit: "kg", category: "Meat & Seafood" },
  { name: "Whole sea bass", quantity: 2, unit: "pc", category: "Meat & Seafood" },
  { name: "Greek yogurt", quantity: 500, unit: "g", category: "Dairy" },
  { name: "Heavy cream", quantity: 250, unit: "ml", category: "Dairy" },
  { name: "Parmesan", quantity: 200, unit: "g", category: "Dairy" },
  { name: "Eggs", quantity: 12, unit: "pc", category: "Dairy" },
  { name: "Lemons", quantity: 4, unit: "pc", category: "Produce" },
  { name: "Scallions", quantity: 1, unit: "bunch", category: "Produce" },
  { name: "Lacinato kale", quantity: 2, unit: "bunches", category: "Produce" },
  { name: "Red bell peppers", quantity: 3, unit: "pc", category: "Produce" },
  { name: "Basmati rice", quantity: 1, unit: "kg", category: "Pantry" },
  { name: "Tomato passata", quantity: 800, unit: "g", category: "Pantry" },
  { name: "Sourdough loaf", quantity: 1, unit: "pc", category: "Bakery" },
  { name: "Laffa bread", quantity: 1, unit: "pack", category: "Bakery" },
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

  // 4. Seed recipes with photos + ingredients. Lead (Omar) owns 6, members split the rest.
  const memberRotation = [...memberDocs];
  let memberIdx = 0;
  const recipeDocs = await Promise.all(
    RECIPES.map(async (r, i) => {
      const author = LEAD_RECIPE_INDEXES.has(i)
        ? lead
        : memberRotation[memberIdx++ % memberRotation.length];
      const existing = await Recipe.findOne({
        authorId: author._id,
        title: r.title,
      });
      if (existing) {
        // Backfill photo + ingredients if missing
        let dirty = false;
        if (!existing.photos || existing.photos.length === 0) {
          existing.photos = [r.photo];
          dirty = true;
        }
        if (!existing.ingredients || existing.ingredients.length === 0) {
          existing.ingredients = r.ingredients as never;
          dirty = true;
        }
        if (dirty) await existing.save();
        return { recipe: existing, author };
      }
      const doc = await Recipe.create({
        title: r.title,
        description: r.description,
        cuisineTags: r.cuisineTags,
        difficulty: r.difficulty,
        prepTime: r.prepTime,
        cookTime: r.cookTime,
        servings: r.servings,
        authorId: author._id,
        totalTime: r.prepTime + r.cookTime,
        baseServings: r.servings,
        tags: [],
        labels: [],
        dietaryTags: [],
        ingredients: r.ingredients,
        steps: [],
        photos: [r.photo],
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

  // 7. Seed the week's shopping list — categorized items, a few pre-checked.
  const weekStartDate = weekStart(new Date());
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setDate(weekStartDate.getDate() + 6);

  await ShoppingList.deleteMany({ kitchenId: kitchen._id, generatedFromSchedule: true });
  await ShoppingList.create({
    kitchenId: kitchen._id,
    userId: lead._id,
    name: "This Week",
    generatedFromSchedule: true,
    scheduleStartDate: weekStartDate,
    scheduleEndDate: weekEndDate,
    items: SHOPPING_ITEMS.map((it, i) => ({
      ...it,
      isChecked: i < 3, // a few checked for social-proof of active use
      addedBy: lead._id,
    })),
    videoDemo: true,
  });
  console.log("shopping list items:", SHOPPING_ITEMS.length);

  console.log("\n✅ seeded. Log in with", leadEmail, "/ DemoPass_2026!");
  console.log("kitchen id:", kitchen._id.toString());

  await mongoose.disconnect();
}

async function cleanup() {
  const kitchen = await Kitchen.findOne({ name: "The Hendersons" });
  if (kitchen) {
    await ScheduleEntry.deleteMany({ kitchenId: kitchen._id });
    await ShoppingList.deleteMany({ kitchenId: kitchen._id });
    await Kitchen.deleteOne({ _id: kitchen._id });
    console.log("removed kitchen + schedule + shopping");
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
