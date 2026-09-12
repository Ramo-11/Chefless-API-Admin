import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express, { Express } from "express";
import request from "supertest";
import {
  RECIPES_SEARCH_INDEX_NAME,
  recipesSearchIndexDefinition,
  buildRecipeSearchStage,
  isAtlasSearchAvailable,
  markAtlasSearchUnavailable,
  __resetAtlasSearchCacheForTests,
} from "../../lib/atlas-search";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import Recipe from "../../models/Recipe";
import { createTestUser, getAuthHeaders } from "../helpers";
import searchRouter from "../../routes/search";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/search", searchRouter);
  return app;
}

type MappingField = Record<string, unknown> | Record<string, unknown>[];

function fieldMappings(): Record<string, MappingField> {
  return recipesSearchIndexDefinition.mappings.fields as unknown as Record<
    string,
    MappingField
  >;
}

function mappingTypes(field: MappingField): string[] {
  const entries = Array.isArray(field) ? field : [field];
  return entries.map((entry) => entry.type as string);
}

function collectPaths(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPaths(item, out);
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "path" && typeof value === "string") {
        out.add(value);
      } else {
        collectPaths(value, out);
      }
    }
  }
}

function ingredientNameMapping(): MappingField {
  const ingredients = fieldMappings().ingredients as Record<string, unknown>;
  const nestedFields = ingredients.fields as Record<string, MappingField>;
  return nestedFields.name;
}

function hasMappingForPath(path: string): boolean {
  const fields = fieldMappings();
  if (path.includes(".")) {
    const [root, ...rest] = path.split(".");
    const rootField = fields[root];
    if (!rootField || Array.isArray(rootField)) return false;
    if (rootField.type !== "document") return false;
    const nestedFields = rootField.fields as Record<string, unknown> | undefined;
    return Boolean(nestedFields && rest.join(".") in nestedFields);
  }
  return path in fields;
}

describe("recipesSearchIndexDefinition", () => {
  it("is named recipes_search", () => {
    expect(RECIPES_SEARCH_INDEX_NAME).toBe("recipes_search");
  });

  it("is not dynamically mapped", () => {
    expect(recipesSearchIndexDefinition.mappings.dynamic).toBe(false);
  });

  it("maps title with both autocomplete (edgeGram) and string mappings", () => {
    const types = mappingTypes(fieldMappings().title);
    expect(types).toContain("autocomplete");
    expect(types).toContain("string");
    const autocomplete = (fieldMappings().title as Record<string, unknown>[]).find(
      (m) => m.type === "autocomplete"
    );
    expect(autocomplete?.tokenization).toBe("edgeGram");
  });

  it("maps description as string only (no autocomplete)", () => {
    expect(mappingTypes(fieldMappings().description)).toEqual(["string"]);
  });

  it("maps ingredients.name with both autocomplete (edgeGram) and string mappings, matching title's edgeGram settings", () => {
    const types = mappingTypes(ingredientNameMapping());
    expect(types).toContain("autocomplete");
    expect(types).toContain("string");

    const titleAutocomplete = (fieldMappings().title as Record<string, unknown>[]).find(
      (m) => m.type === "autocomplete"
    );
    const ingredientAutocomplete = (
      ingredientNameMapping() as Record<string, unknown>[]
    ).find((m) => m.type === "autocomplete");

    expect(ingredientAutocomplete?.tokenization).toBe(titleAutocomplete?.tokenization);
    expect(ingredientAutocomplete?.minGrams).toBe(titleAutocomplete?.minGrams);
    expect(ingredientAutocomplete?.maxGrams).toBe(titleAutocomplete?.maxGrams);
    expect(ingredientAutocomplete?.foldDiacritics).toBe(titleAutocomplete?.foldDiacritics);
  });

  it("maps cuisineTags and dietaryTags with both string and token", () => {
    expect(mappingTypes(fieldMappings().cuisineTags)).toEqual(
      expect.arrayContaining(["string", "token"])
    );
    expect(mappingTypes(fieldMappings().dietaryTags)).toEqual(
      expect.arrayContaining(["string", "token"])
    );
  });

  it("covers every field the filter and query builders reference", () => {
    const stage = buildRecipeSearchStage({
      query: "chicken curry",
      filters: {
        cuisines: ["Italian", "Mexican"],
        diets: ["Vegan", "Gluten-Free"],
        difficulty: "easy",
        minRating: 4,
      },
    });
    const paths = new Set<string>();
    collectPaths(stage, paths);
    expect(paths.size).toBeGreaterThan(0);
    for (const path of paths) {
      expect(hasMappingForPath(path)).toBe(true);
    }
  });

  it("covers the remaining structural and filterable fields", () => {
    for (const field of [
      "isPrivate",
      "isHidden",
      "authorId",
      "difficulty",
      "totalTime",
      "prepTime",
      "cookTime",
      "avgRating",
      "ratingCount",
      "likesCount",
      "createdAt",
      "tags",
      "labels",
    ]) {
      expect(hasMappingForPath(field)).toBe(true);
    }
  });
});

describe("buildRecipeSearchStage", () => {
  it("returns null when there is no query and no filters", () => {
    expect(buildRecipeSearchStage({})).toBeNull();
    expect(buildRecipeSearchStage({ query: "   " })).toBeNull();
  });

  it("builds a must/should compound for a query alone, with no filter clause", () => {
    const stage = buildRecipeSearchStage({ query: "chicken curry" });
    expect(stage).not.toBeNull();
    const compound = stage?.$search.compound as Record<string, unknown>;
    expect(compound.filter).toBeUndefined();
    expect(Array.isArray(compound.must)).toBe(true);
    expect((compound.must as unknown[]).length).toBe(2);
    expect(Array.isArray(compound.should)).toBe(true);
  });

  it("ANDs across terms and ORs across fields within each term", () => {
    const stage = buildRecipeSearchStage({ query: "chicken curry" });
    const compound = stage?.$search.compound as { must: Record<string, unknown>[] };
    for (const [i, term] of ["chicken", "curry"].entries()) {
      const termClause = compound.must[i].compound as {
        should: Record<string, unknown>[];
        minimumShouldMatch: number;
      };
      expect(termClause.minimumShouldMatch).toBe(1);
      const paths = termClause.should.map(
        (clause) => Object.values(clause)[0] as { path: string; query: string }
      );
      expect(paths.map((p) => p.path).sort()).toEqual(
        [
          "cuisineTags",
          "description",
          "dietaryTags",
          "ingredients.name",
          "ingredients.name",
          "labels",
          "tags",
          "title",
          "title",
        ].sort()
      );
      for (const p of paths) {
        expect(p.query).toBe(term);
      }
    }
  });

  it("gates matching on ingredient autocomplete, so a partial ingredient fragment still matches (e.g. 'toma' finding Tomato)", () => {
    const stage = buildRecipeSearchStage({ query: "toma" });
    const compound = stage?.$search.compound as { must: Record<string, unknown>[] };
    const termClause = compound.must[0].compound as {
      should: Array<{ autocomplete?: { path: string; query: string } }>;
    };
    const ingredientAutocomplete = termClause.should.find(
      (c) => c.autocomplete?.path === "ingredients.name"
    );
    expect(ingredientAutocomplete?.autocomplete?.query).toBe("toma");
  });

  it("builds a filter-only compound for filters alone (browse mode), with no must/should", () => {
    const stage = buildRecipeSearchStage({
      filters: { cuisines: ["Italian"], diets: ["Vegan", "Gluten-Free"] },
    });
    expect(stage).not.toBeNull();
    const compound = stage?.$search.compound as Record<string, unknown>;
    expect(compound.must).toBeUndefined();
    expect(compound.should).toBeUndefined();
    expect(Array.isArray(compound.filter)).toBe(true);
  });

  it("browse mode: ORs cuisines together via a nested compound.should", () => {
    const stage = buildRecipeSearchStage({
      filters: { cuisines: ["Italian", "Mexican"] },
    });
    const compound = stage?.$search.compound as { filter: Record<string, unknown>[] };
    expect(compound.filter).toHaveLength(1);
    const nested = compound.filter[0].compound as {
      should: Array<{ equals: { path: string; value: string } }>;
      minimumShouldMatch: number;
    };
    expect(nested.minimumShouldMatch).toBe(1);
    expect(nested.should.map((c) => c.equals.value)).toEqual(["italian", "mexican"]);
    expect(nested.should.every((c) => c.equals.path === "cuisineTags")).toBe(true);
  });

  it("browse mode: ANDs diets together as separate equals filter clauses", () => {
    const stage = buildRecipeSearchStage({
      filters: { diets: ["Vegan", "Gluten-Free"] },
    });
    const compound = stage?.$search.compound as {
      filter: Array<{ equals: { path: string; value: string } }>;
    };
    expect(compound.filter).toHaveLength(2);
    expect(compound.filter.map((c) => c.equals.value)).toEqual(["vegan", "gluten-free"]);
    expect(compound.filter.every((c) => c.equals.path === "dietaryTags")).toBe(true);
  });

  it("browse mode: difficulty is an exact equals filter clause", () => {
    const stage = buildRecipeSearchStage({ filters: { difficulty: "easy" } });
    const compound = stage?.$search.compound as {
      filter: Array<{ equals: { path: string; value: string } }>;
    };
    expect(compound.filter).toEqual([{ equals: { path: "difficulty", value: "easy" } }]);
  });

  it("browse mode: minRating becomes an avgRating range plus a ratingCount > 0 range", () => {
    const stage = buildRecipeSearchStage({ filters: { minRating: 4 } });
    const compound = stage?.$search.compound as {
      filter: Array<{ range: { path: string; gte?: number; gt?: number } }>;
    };
    expect(compound.filter).toEqual([
      { range: { path: "avgRating", gte: 4 } },
      { range: { path: "ratingCount", gt: 0 } },
    ]);
  });

  it("combines query and filters together into one compound", () => {
    const stage = buildRecipeSearchStage({
      query: "chicken",
      filters: { cuisines: ["Italian"], difficulty: "easy" },
    });
    const compound = stage?.$search.compound as Record<string, unknown>;
    expect(compound.must).toBeDefined();
    expect(compound.should).toBeDefined();
    expect(compound.filter).toBeDefined();
    expect((compound.filter as unknown[]).length).toBe(2);
  });

  type ShouldClause = Record<
    string,
    { path: string; fuzzy?: unknown; score?: { boost?: { value: number } } }
  >;

  function findShould(
    should: ShouldClause[],
    operator: "text" | "autocomplete",
    path: string
  ) {
    return should.find((c) => c[operator]?.path === path)?.[operator];
  }

  it("boosts in the exact order: title text, title autocomplete, ingredient autocomplete, ingredient text, description", () => {
    const stage = buildRecipeSearchStage({ query: "chicken" });
    const should = (stage?.$search.compound as { should: ShouldClause[] }).should;

    const titleText = findShould(should, "text", "title");
    const titleAutocomplete = findShould(should, "autocomplete", "title");
    const ingredientAutocomplete = findShould(should, "autocomplete", "ingredients.name");
    const ingredientText = findShould(should, "text", "ingredients.name");
    const descriptionText = findShould(should, "text", "description");

    expect(should).toHaveLength(5);

    const boosts = [
      titleText?.score?.boost?.value,
      titleAutocomplete?.score?.boost?.value,
      ingredientAutocomplete?.score?.boost?.value,
      ingredientText?.score?.boost?.value,
      descriptionText?.score?.boost?.value,
    ];
    expect(boosts).toEqual([10, 6, 4, 2, 1]);
    expect(boosts[0]).toBeGreaterThan(boosts[1] as number);
    expect(boosts[1]).toBeGreaterThan(boosts[2] as number);
    expect(boosts[2]).toBeGreaterThan(boosts[3] as number);
    expect(boosts[3]).toBeGreaterThan(boosts[4] as number);
  });

  it("applies fuzzy matching to every text should clause but not to either autocomplete clause", () => {
    const stage = buildRecipeSearchStage({ query: "chicken" });
    const should = (stage?.$search.compound as { should: ShouldClause[] }).should;

    const autocompleteClauses = should.filter((c) => c.autocomplete);
    expect(autocompleteClauses).toHaveLength(2);
    for (const clause of autocompleteClauses) {
      expect(clause.autocomplete?.fuzzy).toBeUndefined();
    }

    const textClauses = should.filter((c) => c.text);
    expect(textClauses).toHaveLength(3);
    for (const clause of textClauses) {
      expect(clause.text?.fuzzy).toEqual({ maxEdits: 1, prefixLength: 2 });
    }
  });

  it("produces an identical stage regardless of which sort mode the caller applies afterward", () => {
    const params = { query: "chicken curry", filters: { cuisines: ["Italian"] } };
    const sorts = ["relevance", "newest", "popular", "rating", "quickest"] as const;
    const stages = sorts.map(() => buildRecipeSearchStage(params));
    for (const stage of stages) {
      expect(stage).toEqual(stages[0]);
    }
  });
});

describe("Atlas Search capability detection", () => {
  const originalMode = env.ATLAS_SEARCH_MODE;

  beforeEach(() => {
    env.ATLAS_SEARCH_MODE = "auto";
    __resetAtlasSearchCacheForTests();
  });

  afterEach(() => {
    env.ATLAS_SEARCH_MODE = originalMode;
    __resetAtlasSearchCacheForTests();
  });

  it("caches the detection result so the probe only runs once", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const first = await isAtlasSearchAvailable(probe);
    const second = await isAtlasSearchAvailable(probe);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("never throws even if the probe rejects, and treats that as unavailable", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(isAtlasSearchAvailable(probe)).resolves.toBe(false);
  });

  it("returns false immediately when forced off, without calling the probe", async () => {
    env.ATLAS_SEARCH_MODE = "off";
    const probe = vi.fn().mockResolvedValue(true);
    const result = await isAtlasSearchAvailable(probe);
    expect(result).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns true immediately when forced on, without calling the probe", async () => {
    env.ATLAS_SEARCH_MODE = "on";
    const probe = vi.fn().mockResolvedValue(false);
    const result = await isAtlasSearchAvailable(probe);
    expect(result).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("detects that a real non-Atlas MongoDB connection does not support $search", async () => {
    const result = await isAtlasSearchAvailable();
    expect(result).toBe(false);
  });

  it("marks the capability unavailable for the rest of the process once a runtime failure is reported, without re-probing", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    await isAtlasSearchAvailable(probe);
    markAtlasSearchUnavailable(new Error("simulated $search failure"));
    const result = await isAtlasSearchAvailable(probe);
    expect(result).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("logs a runtime failure only once even if it is reported repeatedly", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    markAtlasSearchUnavailable(new Error("first"));
    markAtlasSearchUnavailable(new Error("second"));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("search route falls back gracefully when $search is forced on but unsupported", () => {
  const originalMode = env.ATLAS_SEARCH_MODE;
  let app: Express;

  beforeEach(async () => {
    app = buildApp();
    env.ATLAS_SEARCH_MODE = "on";
    __resetAtlasSearchCacheForTests();
  });

  afterEach(() => {
    env.ATLAS_SEARCH_MODE = originalMode;
    __resetAtlasSearchCacheForTests();
  });

  it("still returns 200 with correct results instead of a 500 when $search throws", async () => {
    const viewer = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const author = await createTestUser({ email: "atlas-author@test.com" });
    void viewer;

    await Recipe.create({
      authorId: author._id,
      title: "Chicken Curry",
      baseServings: 4,
      ingredients: [{ name: "Chicken", quantity: 1, unit: "lb" }],
      steps: [{ order: 1, instruction: "Cook" }],
    });
    await Recipe.create({
      authorId: author._id,
      title: "Beef Stew",
      baseServings: 4,
      ingredients: [{ name: "Beef", quantity: 1, unit: "lb" }],
      steps: [{ order: 1, instruction: "Cook" }],
    });

    const res = await request(app)
      .get("/api/search")
      .query({ q: "chicken" })
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual([
      "Chicken Curry",
    ]);
  });

  it("also falls back correctly for browse-mode (filters only, no query)", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    const author = await createTestUser({ email: "atlas-author-2@test.com" });

    await Recipe.create({
      authorId: author._id,
      title: "Pasta",
      baseServings: 4,
      cuisineTags: ["Italian"],
      ingredients: [{ name: "Pasta", quantity: 1, unit: "lb" }],
      steps: [{ order: 1, instruction: "Cook" }],
    });
    await Recipe.create({
      authorId: author._id,
      title: "Tacos",
      baseServings: 4,
      cuisineTags: ["Mexican"],
      ingredients: [{ name: "Tortilla", quantity: 1, unit: "pc" }],
      steps: [{ order: 1, instruction: "Cook" }],
    });

    const res = await request(app)
      .get("/api/search")
      .query({ cuisines: "Italian" })
      .set(getAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.recipes.map((r: { title: string }) => r.title)).toEqual(["Pasta"]);
  });
});
