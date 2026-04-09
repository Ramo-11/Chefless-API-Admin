import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import User from "../models/User";
import { env } from "../lib/env";
import type { ImportedRecipe, ImportedIngredient, ImportedStep } from "./recipe-import-service";

const AI_DAILY_LIMIT = 20;

const ingredientSchema = z.object({
  name: z.string(),
  quantity: z.number(),
  unit: z.string(),
});

const stepSchema = z.object({
  order: z.number().int().positive(),
  instruction: z.string(),
});

const recipeJsonSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  prepTime: z.number().nonnegative().optional(),
  cookTime: z.number().nonnegative().optional(),
  servings: z.number().positive().optional(),
  ingredients: z.array(ingredientSchema),
  steps: z.array(stepSchema),
  dietaryTags: z.array(z.string()).optional(),
  cuisineTags: z.array(z.string()).optional(),
});

interface ServiceError extends Error {
  statusCode: number;
}

function createError(message: string, statusCode: number): ServiceError {
  const err = new Error(message) as ServiceError;
  err.statusCode = statusCode;
  return err;
}

function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw createError("AI Recipe Helper is not configured.", 503);
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function assertAiQuota(userId: string): Promise<void> {
  const day = utcDayKey();
  const user = await User.findById(userId)
    .select("aiRecipeHelperUsageDay aiRecipeHelperUsageCount")
    .lean();
  if (!user) {
    throw createError("User not found", 404);
  }
  const count =
    user.aiRecipeHelperUsageDay === day ? user.aiRecipeHelperUsageCount ?? 0 : 0;
  if (count >= AI_DAILY_LIMIT) {
    throw createError(
      `Daily AI limit reached (${AI_DAILY_LIMIT} uses). Try again tomorrow.`,
      429
    );
  }
}

export async function recordAiUsage(userId: string): Promise<void> {
  const day = utcDayKey();
  const user = await User.findById(userId).select(
    "aiRecipeHelperUsageDay aiRecipeHelperUsageCount"
  );
  if (!user) return;
  const count =
    user.aiRecipeHelperUsageDay === day ? user.aiRecipeHelperUsageCount ?? 0 : 0;
  user.aiRecipeHelperUsageDay = day;
  user.aiRecipeHelperUsageCount = count + 1;
  await user.save();
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(trimmed);
  if (fence) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

async function runRecipeJsonPrompt(system: string, userMessage: string): Promise<ImportedRecipe> {
  const client = getClient();
  const resp = await client.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: userMessage }],
  });
  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw createError("AI returned no text", 502);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(block.text));
  } catch {
    throw createError("AI returned invalid JSON", 502);
  }
  const data = recipeJsonSchema.parse(parsed);
  const ingredients: ImportedIngredient[] = data.ingredients.map((i) => ({
    name: i.name,
    quantity: i.quantity,
    unit: i.unit,
  }));
  const steps: ImportedStep[] = data.steps
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ order: s.order, instruction: s.instruction }));

  return {
    title: data.title,
    description: data.description,
    prepTime: data.prepTime,
    cookTime: data.cookTime,
    servings: data.servings,
    ingredients,
    steps,
    dietaryTags: data.dietaryTags ?? [],
    cuisineTags: data.cuisineTags ?? [],
    sourceUrl: "",
  };
}

const JSON_ONLY_SYSTEM = `You are a cooking assistant for the Chefless app. Reply with a single JSON object only (no markdown), matching this shape:
{
  "title": string,
  "description"?: string,
  "prepTime"?: number (minutes),
  "cookTime"?: number (minutes),
  "servings"?: number,
  "ingredients": [{ "name": string, "quantity": number, "unit": string }],
  "steps": [{ "order": number (1-based), "instruction": string }],
  "dietaryTags"?: string[],
  "cuisineTags"?: string[]
}
Use sensible metric/imperial units (e.g. g, ml, tsp, cup).`;

export async function aiGenerateFromIngredients(prompt: string): Promise<ImportedRecipe> {
  const p = prompt.trim();
  if (!p) throw createError("Prompt is required", 400);
  if (p.length > 4000) throw createError("Prompt is too long", 400);
  return runRecipeJsonPrompt(
    JSON_ONLY_SYSTEM,
    `Create a complete recipe from what the user has. User input:\n${p}`
  );
}

export async function aiSuggestSubstitutions(
  ingredients: string,
  dietaryNeed: string
): Promise<{ substitutions: { original: string; replacement: string; note?: string }[] }> {
  const ing = ingredients.trim();
  const need = dietaryNeed.trim();
  if (!ing || !need) throw createError("ingredients and dietaryNeed are required", 400);

  const client = getClient();
  const subSchema = z.object({
    substitutions: z.array(
      z.object({
        original: z.string(),
        replacement: z.string(),
        note: z.string().optional(),
      })
    ),
  });

  const resp = await client.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 2048,
    system:
      "Reply with JSON only: { \"substitutions\": [{ \"original\", \"replacement\", \"note?\" }] }",
    messages: [
      {
        role: "user",
        content: `Suggest ingredient substitutions for this dietary need: ${need}\n\nCurrent ingredients / recipe context:\n${ing.slice(0, 8000)}`,
      },
    ],
  });
  const block = resp.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw createError("AI returned no text", 502);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(block.text));
  } catch {
    throw createError("AI returned invalid JSON", 502);
  }
  return subSchema.parse(parsed);
}

export async function aiFormatRoughNotes(notes: string): Promise<ImportedRecipe> {
  const n = notes.trim();
  if (!n) throw createError("Notes are required", 400);
  if (n.length > 12000) throw createError("Notes are too long", 400);
  return runRecipeJsonPrompt(
    JSON_ONLY_SYSTEM,
    `Turn these rough cooking notes into a structured recipe with estimated quantities and clear steps:\n${n}`
  );
}
