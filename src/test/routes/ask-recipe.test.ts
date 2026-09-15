import request from "supertest";
import express from "express";
import { Types } from "mongoose";
import { describe, it, expect, beforeEach, vi } from "vitest";
import aiRouter from "../../routes/ai";
import { errorHandler } from "../../middleware/errorHandler";
import { createTestUser, getAuthHeaders } from "../helpers";
import Recipe from "../../models/Recipe";
import User from "../../models/User";
import Follow from "../../models/Follow";
import AiUsageEvent from "../../models/AiUsageEvent";

const anthropicMocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: vi.fn().mockImplementation(function AnthropicMock() {
    return { messages: { create: anthropicMocks.create } };
  }),
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ai", aiRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

function successResponse() {
  return {
    content: [{ type: "text", text: "Yes, up to a day ahead." }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

async function createRecipeFor(
  authorId: Types.ObjectId,
  overrides: Record<string, unknown> = {}
) {
  return Recipe.create({
    authorId,
    title: "Weeknight Chicken Soup",
    baseServings: 4,
    ingredients: [{ name: "Chicken broth", quantity: 4, unit: "cup" }],
    steps: [{ order: 1, instruction: "Simmer the broth for twenty minutes." }],
    ...overrides,
  });
}

function askBody(
  recipeId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    recipeId,
    question: "Can I make this ahead of time",
    locale: "en",
    ...overrides,
  };
}

async function expectValidationFailure(
  userId: Types.ObjectId,
  body: Record<string, unknown>
) {
  const response = await request(app)
    .post("/api/ai/ask-recipe")
    .set(getAuthHeaders())
    .send(body);
  expect(response.status).toBe(400);
  expect(anthropicMocks.create).not.toHaveBeenCalled();
  const stored = await User.findById(userId)
    .select("aiAskCount aiAskFreeQuestionUsedAt aiRecipeHelperUsageCount")
    .lean();
  expect(stored?.aiAskCount ?? 0).toBe(0);
  expect(stored?.aiAskFreeQuestionUsedAt).toBeUndefined();
  expect(stored?.aiRecipeHelperUsageCount ?? 0).toBe(0);
  return response;
}

async function waitForAiUsageEvent(userId: Types.ObjectId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const event = await AiUsageEvent.findOne({ userId }).lean();
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

describe("POST /api/ai/ask-recipe", () => {
  beforeEach(() => {
    anthropicMocks.create.mockReset();
    anthropicMocks.create.mockResolvedValue(successResponse());
  });

  it("gives a free account its first answer for free without touching the shared daily AI quota", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(user._id);
    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));

    expect(response.status).toBe(200);
    expect(response.body.usage).toBeNull();
    expect(response.body.freeQuestionRemaining).toBe(0);
    expect(response.body.answer).toBe("Yes, up to a day ahead.");

    const stored = await User.findById(user._id)
      .select("aiAskFreeQuestionUsedAt aiAskCount aiRecipeHelperUsageCount")
      .lean();
    expect(stored?.aiAskFreeQuestionUsedAt).toBeInstanceOf(Date);
    expect(stored?.aiAskCount).toBe(1);
    expect(stored?.aiRecipeHelperUsageCount ?? 0).toBe(0);
  });

  it("refuses a free account's second question with premium required and never calls the model", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(user._id);
    await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));

    anthropicMocks.create.mockClear();
    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString(), { question: "What about freezing it" }));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("PREMIUM_REQUIRED");
    expect(anthropicMocks.create).not.toHaveBeenCalled();
  });

  it("releases the free question when the model call fails, so the next attempt still gets an answer", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(user._id);
    anthropicMocks.create.mockRejectedValueOnce(new Error("upstream timeout"));

    const failed = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe("AI_UNAVAILABLE");

    const afterFailure = await User.findById(user._id)
      .select("aiAskFreeQuestionUsedAt aiAskCount")
      .lean();
    expect(afterFailure?.aiAskFreeQuestionUsedAt).toBeUndefined();
    expect(afterFailure?.aiAskCount).toBe(0);

    const succeeded = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(succeeded.status).toBe(200);
  });

  it("treats an empty model answer as a failure and releases the free question", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(user._id);
    anthropicMocks.create.mockResolvedValueOnce({
      content: [{ type: "text", text: "   " }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 0 },
    });

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("AI_UNAVAILABLE");

    const stored = await User.findById(user._id)
      .select("aiAskFreeQuestionUsedAt aiAskCount")
      .lean();
    expect(stored?.aiAskFreeQuestionUsedAt).toBeUndefined();
    expect(stored?.aiAskCount).toBe(0);
  });

  it("treats a refusal stop reason as a failure and releases the free question", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(user._id);
    anthropicMocks.create.mockResolvedValueOnce({
      content: [{ type: "text", text: "I can only help with recipe questions." }],
      stop_reason: "refusal",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("AI_UNAVAILABLE");

    const stored = await User.findById(user._id)
      .select("aiAskFreeQuestionUsedAt aiAskCount")
      .lean();
    expect(stored?.aiAskFreeQuestionUsedAt).toBeUndefined();
    expect(stored?.aiAskCount).toBe(0);
  });

  it("admits exactly one winner when a free account fires six first questions at once", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(user._id);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app)
          .post("/api/ai/ask-recipe")
          .set(getAuthHeaders())
          .send(askBody(recipe._id.toString()))
      )
    );

    const succeeded = responses.filter((r) => r.status === 200);
    const refused = responses.filter(
      (r) =>
        (r.status === 403 && r.body.code === "PREMIUM_REQUIRED") ||
        (r.status === 409 && r.body.code === "AI_ASK_IN_PROGRESS")
    );
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(5);
    expect(anthropicMocks.create).toHaveBeenCalledOnce();
  });

  it("answers a question in progress elsewhere with a try again shortly error instead of the paywall, so an interrupted answer never looks like a used free question", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(user._id);
    await User.updateOne({ _id: user._id }, { $set: { aiAskFreeQuestionClaimedAt: new Date() } });

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("AI_ASK_IN_PROGRESS");
    expect(anthropicMocks.create).not.toHaveBeenCalled();
    const stored = await User.findById(user._id).select("aiAskFreeQuestionUsedAt").lean();
    expect(stored?.aiAskFreeQuestionUsedAt).toBeUndefined();
  });

  it("gives the free question back after the server stopped mid answer, once the abandoned claim goes stale", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(user._id);
    await User.updateOne(
      { _id: user._id },
      { $set: { aiAskFreeQuestionClaimedAt: new Date(Date.now() - 61 * 1000) } }
    );
    anthropicMocks.create.mockResolvedValue(successResponse());

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));

    expect(response.status).toBe(200);
    expect(response.body.freeQuestionRemaining).toBe(0);
    const stored = await User.findById(user._id)
      .select("aiAskFreeQuestionUsedAt aiAskFreeQuestionClaimedAt aiAskCount")
      .lean();
    expect(stored?.aiAskFreeQuestionUsedAt).toBeInstanceOf(Date);
    expect(stored?.aiAskFreeQuestionClaimedAt).toBeUndefined();
    expect(stored?.aiAskCount).toBe(1);
  });

  it("lets a Pro account keep asking without ever touching the free question", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await User.updateOne({ _id: user._id }, { $set: { isPremium: true } });
    const recipe = await createRecipeFor(user._id);

    const first = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(first.status).toBe(200);
    expect(first.body.usage).toEqual({ used: 1, limit: 20 });
    expect(first.body.freeQuestionRemaining).toBe(1);

    const second = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString(), { question: "Can I swap the chicken broth" }));
    expect(second.status).toBe(200);
    expect(second.body.usage).toEqual({ used: 2, limit: 20 });
    expect(second.body.freeQuestionRemaining).toBe(1);

    const stored = await User.findById(user._id)
      .select("aiAskCount aiAskFreeQuestionUsedAt")
      .lean();
    expect(stored?.aiAskCount).toBe(2);
    expect(stored?.aiAskFreeQuestionUsedAt).toBeUndefined();
  });

  it("treats a Pro account with an expired premium date as a free account", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await User.updateOne(
      { _id: user._id },
      { $set: { isPremium: true, premiumExpiresAt: new Date(Date.now() - 60_000) } }
    );
    const recipe = await createRecipeFor(user._id);

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(200);
    expect(response.body.usage).toBeNull();
    expect(response.body.freeQuestionRemaining).toBe(0);
  });

  it("stops a Pro account at the shared daily cap and never calls the model", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const today = new Date().toISOString().slice(0, 10);
    await User.updateOne(
      { _id: user._id },
      { $set: { isPremium: true, aiRecipeHelperUsageDay: today, aiRecipeHelperUsageCount: 20 } }
    );
    const recipe = await createRecipeFor(user._id);

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(429);
    expect(response.body.code).toBe("AI_QUOTA_EXCEEDED");
    expect(anthropicMocks.create).not.toHaveBeenCalled();
  });

  it("admits exactly two concurrent Pro questions when eighteen of the daily twenty are already used", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const today = new Date().toISOString().slice(0, 10);
    await User.updateOne(
      { _id: user._id },
      { $set: { isPremium: true, aiRecipeHelperUsageDay: today, aiRecipeHelperUsageCount: 18 } }
    );
    const recipe = await createRecipeFor(user._id);

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(app)
          .post("/api/ai/ask-recipe")
          .set(getAuthHeaders())
          .send(askBody(recipe._id.toString(), { question: `Follow up question ${i}` }))
      )
    );

    const succeeded = responses.filter((r) => r.status === 200);
    const blocked = responses.filter((r) => r.status === 429);
    expect(succeeded).toHaveLength(2);
    expect(blocked).toHaveLength(3);

    const stored = await User.findById(user._id).select("aiRecipeHelperUsageCount").lean();
    expect(stored?.aiRecipeHelperUsageCount).toBe(20);
  });

  it("releases the reserved unit for a Pro account when the model call fails", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await User.updateOne({ _id: user._id }, { $set: { isPremium: true } });
    const recipe = await createRecipeFor(user._id);
    anthropicMocks.create.mockRejectedValueOnce(new Error("upstream timeout"));

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(503);

    const stored = await User.findById(user._id)
      .select("aiRecipeHelperUsageCount aiAskCount")
      .lean();
    expect(stored?.aiRecipeHelperUsageCount ?? 0).toBe(0);
    expect(stored?.aiAskCount ?? 0).toBe(0);
  });

  it("shares the twenty a day allowance with the other AI features rather than keeping a separate ask bucket", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const today = new Date().toISOString().slice(0, 10);
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          isPremium: true,
          aiRecipeHelperUsageDay: today,
          aiRecipeHelperUsageCount: 19,
          aiGenerateCount: 19,
        },
      }
    );
    const recipe = await createRecipeFor(user._id);

    const allowed = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(allowed.status).toBe(200);
    expect(allowed.body.usage).toEqual({ used: 20, limit: 20 });

    const blocked = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString(), { question: "One more question" }));
    expect(blocked.status).toBe(429);

    const stored = await User.findById(user._id)
      .select("aiAskCount aiGenerateCount aiRecipeHelperUsageCount")
      .lean();
    expect(stored?.aiAskCount).toBe(1);
    expect(stored?.aiGenerateCount).toBe(19);
    expect(stored?.aiRecipeHelperUsageCount).toBe(20);
  });

  it("returns recipe not found for a recipe id that does not exist and never calls the model", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(new Types.ObjectId().toString()));
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("RECIPE_NOT_FOUND");
    expect(anthropicMocks.create).not.toHaveBeenCalled();

    const stored = await User.findById(user._id).select("aiAskFreeQuestionUsedAt").lean();
    expect(stored?.aiAskFreeQuestionUsedAt).toBeUndefined();
  });

  it("returns recipe not found for a private recipe that belongs to someone else", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    const author = await createTestUser();
    const recipe = await createRecipeFor(author._id, { isPrivate: true });
    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("RECIPE_NOT_FOUND");
    expect(anthropicMocks.create).not.toHaveBeenCalled();
  });

  it("returns recipe not found for a hidden recipe that belongs to someone else", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    const author = await createTestUser();
    const recipe = await createRecipeFor(author._id, { isHidden: true });
    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("RECIPE_NOT_FOUND");
    expect(anthropicMocks.create).not.toHaveBeenCalled();
  });

  it("returns recipe not found for a recipe whose author is banned", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    const author = await createTestUser({ isBanned: true });
    const recipe = await createRecipeFor(author._id);
    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("RECIPE_NOT_FOUND");
    expect(anthropicMocks.create).not.toHaveBeenCalled();
  });

  it("lets the author ask about their own private recipe", async () => {
    const author = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(author._id, { isPrivate: true });
    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(200);
  });

  it("lets the author ask about their own hidden recipe", async () => {
    const author = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(author._id, { isHidden: true });
    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(200);
  });

  it("lets an active follower ask about a shared recipe from a private account", async () => {
    const viewer = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const author = await createTestUser({ isPublic: false });
    const recipe = await createRecipeFor(author._id);
    await Follow.create({ followerId: viewer._id, followingId: author._id, status: "active" });

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(200);
  });

  it("lets a kitchen co member ask about a shared recipe from a private account", async () => {
    const kitchenId = new Types.ObjectId();
    const viewer = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await User.updateOne({ _id: viewer._id }, { $set: { kitchenId } });
    const author = await createTestUser({ isPublic: false });
    await User.updateOne({ _id: author._id }, { $set: { kitchenId } });
    const recipe = await createRecipeFor(author._id);

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(200);
  });

  it("returns recipe not found for a shared recipe from a private account when the asker is a stranger", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    const author = await createTestUser({ isPublic: false });
    const recipe = await createRecipeFor(author._id);

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("RECIPE_NOT_FOUND");
  });

  it("rejects a request with no question", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const body = askBody(new Types.ObjectId().toString());
    delete body.question;
    await expectValidationFailure(user._id, body);
  });

  it("rejects a question that is only whitespace", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const body = askBody(new Types.ObjectId().toString(), { question: "      " });
    await expectValidationFailure(user._id, body);
  });

  it("rejects a question longer than 500 characters", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const body = askBody(new Types.ObjectId().toString(), { question: "a".repeat(501) });
    await expectValidationFailure(user._id, body);
  });

  it("rejects a history longer than eight turns", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const history = Array.from({ length: 9 }, (_, i) => ({
      question: `Earlier question ${i}`,
      answer: `Earlier answer ${i}`,
    }));
    const body = askBody(new Types.ObjectId().toString(), { history });
    await expectValidationFailure(user._id, body);
  });

  it("rejects a history turn whose answer is longer than 4000 characters", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const body = askBody(new Types.ObjectId().toString(), {
      history: [{ question: "How long does this keep", answer: "a".repeat(4001) }],
    });
    await expectValidationFailure(user._id, body);
  });

  it("rejects a recipe id that is not a valid Mongo id", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const body = askBody("not-a-real-id");
    await expectValidationFailure(user._id, body);
  });

  it("rejects zero servings", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const body = askBody(new Types.ObjectId().toString(), { servings: 0 });
    await expectValidationFailure(user._id, body);
  });

  it("rejects more than 100 servings", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const body = askBody(new Types.ObjectId().toString(), { servings: 101 });
    await expectValidationFailure(user._id, body);
  });

  it("rejects a request with no locale", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const body = askBody(new Types.ObjectId().toString());
    delete body.locale;
    await expectValidationFailure(user._id, body);
  });

  it("rejects a locale the app does not support", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const body = askBody(new Types.ObjectId().toString(), { locale: "fr" });
    await expectValidationFailure(user._id, body);
  });

  it("rejects a negative step index", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const body = askBody(new Types.ObjectId().toString(), { stepIndex: -1 });
    await expectValidationFailure(user._id, body);
  });

  it("rejects a measurement system the app does not know", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const body = askBody(new Types.ObjectId().toString(), { measurementSystem: "freedom units" });
    await expectValidationFailure(user._id, body);
  });

  it("sends eight history turns to the model as seventeen alternating messages ending with the current question", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(user._id);
    const history = Array.from({ length: 8 }, (_, i) => ({
      question: `Earlier question ${i}`,
      answer: `Earlier answer ${i}`,
    }));

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString(), { history, question: "Final question" }));
    expect(response.status).toBe(200);

    const call = anthropicMocks.create.mock.calls[0][0];
    expect(call.messages).toHaveLength(17);
    expect(call.messages[0]).toEqual({ role: "user", content: "Earlier question 0" });
    expect(call.messages[1]).toEqual({ role: "assistant", content: "Earlier answer 0" });
    expect(call.messages[16]).toEqual({ role: "user", content: "Final question" });
  });

  it("does not require Chefless Premium at the middleware level, only after the free question is spent", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(user._id);
    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).not.toBe(403);
    expect(response.status).toBe(200);
  });

  it("calls the model with the ask recipe model id and a capped token budget, and records the usage event", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const recipe = await createRecipeFor(user._id);

    const response = await request(app)
      .post("/api/ai/ask-recipe")
      .set(getAuthHeaders())
      .send(askBody(recipe._id.toString()));
    expect(response.status).toBe(200);

    const call = anthropicMocks.create.mock.calls[0][0];
    expect(call.model).toBe("claude-haiku-4-5");
    expect(call.max_tokens).toBeLessThanOrEqual(600);

    const event = await waitForAiUsageEvent(user._id);
    expect(event?.feature).toBe("ask");
  });
});
