/**
 * Adds a small remix tree to the demo seed for the App Store "Lineage" screenshot.
 * Picks "Chicken Tikka Masala" as root, creates 3 children + 1 grandchild.
 * Tagged with appstoreDemo: true for clean teardown.
 */
import mongoose from "mongoose";
import User from "../models/User";
import Recipe from "../models/Recipe";

const TAG = { appstoreDemo: true } as const;

const ROOT_TITLE = "Chicken Tikka Masala";

const FORKS = [
  {
    forkerEmail: "huda.demo@chefless.test",
    title: "Smoky Tikka Masala",
    description: "Heavy on the kasuri methi and a kiss of liquid smoke.",
    notes: "Adds smoke + extra fenugreek.",
  },
  {
    forkerEmail: "yusuf.demo@chefless.test",
    title: "Coconut Tikka Masala",
    description: "Coconut milk swap for a sweeter, richer sauce.",
    notes: "Coconut milk replaces cream.",
  },
  {
    forkerEmail: "layla.demo@chefless.test",
    title: "Weeknight Tikka Masala",
    description: "30-min version with pantry shortcuts.",
    notes: "Halves spice list, uses canned passata only.",
  },
];

const GRANDCHILD = {
  forkerEmail: "layla.demo@chefless.test",
  parentTitle: "Coconut Tikka Masala",
  title: "Coconut-Lime Tikka",
  description: "Bright lime finish on the coconut variation.",
  notes: "Adds lime zest + juice at the end.",
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI required");
  if (!uri.includes("chefless_dev")) {
    throw new Error(
      `Refusing to run: MONGODB_URI must point at chefless_dev (got ${uri.replace(/:[^@]+@/, ":***@")})`,
    );
  }
  await mongoose.connect(uri);

  const cleanup = process.argv.includes("cleanup");
  if (cleanup) {
    const r = await Recipe.deleteMany(TAG);
    console.log("removed remix recipes:", r.deletedCount);
    await mongoose.disconnect();
    return;
  }

  const root = await Recipe.findOne({ title: ROOT_TITLE });
  if (!root) throw new Error(`Root recipe not found: ${ROOT_TITLE}`);
  const rootAuthor = await User.findById(root.authorId);
  if (!rootAuthor) throw new Error("Root author missing");

  for (const fork of FORKS) {
    const forker = await User.findOne({ email: fork.forkerEmail });
    if (!forker) {
      console.warn(`skip ${fork.title}: forker missing ${fork.forkerEmail}`);
      continue;
    }
    const exists = await Recipe.findOne({ title: fork.title, authorId: forker._id });
    if (exists) {
      console.log("skip existing:", fork.title);
      continue;
    }
    await Recipe.create({
      ...root.toObject(),
      _id: undefined,
      title: fork.title,
      description: fork.description,
      authorId: forker._id,
      authorName: forker.fullName,
      forkedFrom: {
        recipeId: root._id,
        authorId: rootAuthor._id,
        authorName: rootAuthor.fullName,
      },
      isModifiedFork: true,
      forksCount: 0,
      likesCount: Math.floor(Math.random() * 12) + 1,
      remixNote: fork.notes,
      ...TAG,
    });
    await Recipe.updateOne({ _id: root._id }, { $inc: { forksCount: 1 } });
    console.log("created fork:", fork.title);
  }

  // Grandchild fork
  const parent = await Recipe.findOne({ title: GRANDCHILD.parentTitle });
  const gcForker = await User.findOne({ email: GRANDCHILD.forkerEmail });
  if (parent && gcForker) {
    const exists = await Recipe.findOne({ title: GRANDCHILD.title, authorId: gcForker._id });
    if (!exists) {
      const parentAuthor = await User.findById(parent.authorId);
      await Recipe.create({
        ...parent.toObject(),
        _id: undefined,
        title: GRANDCHILD.title,
        description: GRANDCHILD.description,
        authorId: gcForker._id,
        authorName: gcForker.fullName,
        forkedFrom: {
          recipeId: parent._id,
          authorId: parentAuthor!._id,
          authorName: parentAuthor!.fullName,
        },
        isModifiedFork: true,
        forksCount: 0,
        likesCount: Math.floor(Math.random() * 8) + 1,
        remixNote: GRANDCHILD.notes,
        ...TAG,
      });
      await Recipe.updateOne({ _id: parent._id }, { $inc: { forksCount: 1 } });
      console.log("created grandchild:", GRANDCHILD.title);
    } else {
      console.log("skip existing grandchild");
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
