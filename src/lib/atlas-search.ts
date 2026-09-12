import mongoose from "mongoose";
import { env } from "./env";
import { logger } from "./logger";

export const RECIPES_SEARCH_INDEX_NAME = "recipes_search";

export const recipesSearchIndexDefinition = {
  mappings: {
    dynamic: false,
    fields: {
      title: [
        {
          type: "autocomplete",
          tokenization: "edgeGram",
          minGrams: 2,
          maxGrams: 15,
          foldDiacritics: true,
        },
        { type: "string" },
      ],
      description: { type: "string" },
      ingredients: {
        type: "document",
        fields: {
          name: [
            {
              type: "autocomplete",
              tokenization: "edgeGram",
              minGrams: 2,
              maxGrams: 15,
              foldDiacritics: true,
            },
            { type: "string" },
          ],
        },
      },
      cuisineTags: [
        { type: "string" },
        { type: "token", normalizer: "lowercase" },
      ],
      dietaryTags: [
        { type: "string" },
        { type: "token", normalizer: "lowercase" },
      ],
      tags: { type: "string" },
      labels: { type: "string" },
      difficulty: { type: "token", normalizer: "lowercase" },
      isPrivate: { type: "boolean" },
      isHidden: { type: "boolean" },
      authorId: { type: "objectId" },
      totalTime: { type: "number" },
      prepTime: { type: "number" },
      cookTime: { type: "number" },
      avgRating: { type: "number" },
      ratingCount: { type: "number" },
      likesCount: { type: "number" },
      createdAt: { type: "date" },
    },
  },
} as const;

export interface RecipeSearchFilters {
  cuisines?: string[];
  diets?: string[];
  difficulty?: "easy" | "medium" | "hard";
  minRating?: number;
}

export interface BuildRecipeSearchStageParams {
  query?: string;
  filters?: RecipeSearchFilters;
}

const TITLE_TEXT_BOOST = 10;
const TITLE_AUTOCOMPLETE_BOOST = 6;
const INGREDIENT_AUTOCOMPLETE_BOOST = 4;
const INGREDIENT_TEXT_BOOST = 2;
const DESCRIPTION_TEXT_BOOST = 1;
const FUZZY_OPTIONS = { maxEdits: 1, prefixLength: 2 } as const;

function parseSearchTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function buildTermMustClause(term: string): Record<string, unknown> {
  return {
    compound: {
      should: [
        { autocomplete: { query: term, path: "title" } },
        { text: { query: term, path: "title" } },
        { text: { query: term, path: "description" } },
        { autocomplete: { query: term, path: "ingredients.name" } },
        { text: { query: term, path: "ingredients.name" } },
        { text: { query: term, path: "dietaryTags" } },
        { text: { query: term, path: "cuisineTags" } },
        { text: { query: term, path: "tags" } },
        { text: { query: term, path: "labels" } },
      ],
      minimumShouldMatch: 1,
    },
  };
}

function buildRelevanceShouldClauses(query: string): Record<string, unknown>[] {
  return [
    {
      text: {
        query,
        path: "title",
        fuzzy: FUZZY_OPTIONS,
        score: { boost: { value: TITLE_TEXT_BOOST } },
      },
    },
    {
      autocomplete: {
        query,
        path: "title",
        score: { boost: { value: TITLE_AUTOCOMPLETE_BOOST } },
      },
    },
    {
      autocomplete: {
        query,
        path: "ingredients.name",
        score: { boost: { value: INGREDIENT_AUTOCOMPLETE_BOOST } },
      },
    },
    {
      text: {
        query,
        path: "ingredients.name",
        fuzzy: FUZZY_OPTIONS,
        score: { boost: { value: INGREDIENT_TEXT_BOOST } },
      },
    },
    {
      text: {
        query,
        path: "description",
        fuzzy: FUZZY_OPTIONS,
        score: { boost: { value: DESCRIPTION_TEXT_BOOST } },
      },
    },
  ];
}

function buildStructuredFilterClauses(
  filters: RecipeSearchFilters
): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [];

  if (filters.cuisines && filters.cuisines.length > 0) {
    clauses.push({
      compound: {
        should: filters.cuisines.map((c) => ({
          equals: { path: "cuisineTags", value: c.toLowerCase() },
        })),
        minimumShouldMatch: 1,
      },
    });
  }

  if (filters.diets && filters.diets.length > 0) {
    for (const diet of filters.diets) {
      clauses.push({
        equals: { path: "dietaryTags", value: diet.toLowerCase() },
      });
    }
  }

  if (filters.difficulty) {
    clauses.push({
      equals: { path: "difficulty", value: filters.difficulty.toLowerCase() },
    });
  }

  if (filters.minRating !== undefined) {
    clauses.push({ range: { path: "avgRating", gte: filters.minRating } });
    clauses.push({ range: { path: "ratingCount", gt: 0 } });
  }

  return clauses;
}

export function buildRecipeSearchStage(
  params: BuildRecipeSearchStageParams
): { $search: Record<string, unknown> } | null {
  const query = params.query?.trim();
  const hasQuery = Boolean(query && query.length > 0);
  const filters = params.filters ?? {};
  const filterClauses = buildStructuredFilterClauses(filters);

  const compound: Record<string, unknown> = {};

  if (hasQuery) {
    const terms = parseSearchTerms(query as string);
    if (terms.length === 0) return null;
    compound.must = terms.map(buildTermMustClause);
    compound.should = buildRelevanceShouldClauses(query as string);
  }

  if (filterClauses.length > 0) {
    compound.filter = filterClauses;
  }

  if (!hasQuery && filterClauses.length === 0) {
    return null;
  }

  return {
    $search: {
      index: RECIPES_SEARCH_INDEX_NAME,
      compound,
    },
  };
}

export type AtlasSearchProbe = () => Promise<boolean>;

let cachedAvailable: boolean | null = null;
let inFlightProbe: Promise<boolean> | null = null;
let hasLoggedRuntimeFailure = false;

async function defaultProbe(): Promise<boolean> {
  const db = mongoose.connection.db;
  if (!db) return false;
  try {
    await db
      .collection("recipes")
      .aggregate([
        {
          $search: {
            index: RECIPES_SEARCH_INDEX_NAME,
            exists: { path: "title" },
          },
        },
        { $limit: 1 },
      ])
      .toArray();
    return true;
  } catch {
    return false;
  }
}

export async function isAtlasSearchAvailable(
  probe: AtlasSearchProbe = defaultProbe
): Promise<boolean> {
  if (env.ATLAS_SEARCH_MODE === "on") return true;
  if (env.ATLAS_SEARCH_MODE === "off") return false;

  if (cachedAvailable !== null) return cachedAvailable;

  if (!inFlightProbe) {
    inFlightProbe = probe().catch(() => false);
  }

  cachedAvailable = await inFlightProbe;
  return cachedAvailable;
}

export function markAtlasSearchUnavailable(error: unknown): void {
  cachedAvailable = false;
  inFlightProbe = Promise.resolve(false);
  if (!hasLoggedRuntimeFailure) {
    hasLoggedRuntimeFailure = true;
    logger.error(
      { err: error },
      "Atlas Search ($search) failed at request time; falling back to regex search for the remainder of this process"
    );
  }
}

export function __resetAtlasSearchCacheForTests(): void {
  cachedAvailable = null;
  inFlightProbe = null;
  hasLoggedRuntimeFailure = false;
}
