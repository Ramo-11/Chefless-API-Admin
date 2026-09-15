import request from "supertest";
import express from "express";
import { describe, it, expect, vi } from "vitest";
import authRouter from "../../routes/auth";
import aiRouter from "../../routes/ai";
import { errorHandler } from "../../middleware/errorHandler";
import { createTestUser, getAuthHeaders } from "../helpers";
import { claimFreeAskQuestion, completeFreeAskQuestion } from "../../services/ask-recipe-service";
import User from "../../models/User";

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
  app.use("/api/auth", authRouter);
  app.use("/api/ai", aiRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

describe("backward compatible user payload and premium AI route contracts", () => {
  it("keeps the GET /api/auth/me shape for a legacy user with no ai ask free question field", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    const response = await request(app).get("/api/auth/me").set(getAuthHeaders());
    expect(response.status).toBe(200);

    const body = response.body.user;
    expect(Object.prototype.hasOwnProperty.call(body, "aiAskFreeQuestionUsedAt")).toBe(false);
    expect(typeof body.firebaseUid).toBe("string");
    expect(typeof body.email).toBe("string");
    expect(typeof body.fullName).toBe("string");
    expect(typeof body.isPremium).toBe("boolean");
    expect(typeof body.aiRecipeHelperUsageCount).toBe("number");
  });

  it("adds aiAskFreeQuestionUsedAt as an ISO date string once the free question is used, keeping every previous key", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const before = await request(app).get("/api/auth/me").set(getAuthHeaders());
    const beforeKeys = Object.keys(before.body.user);

    const claimedAt = await claimFreeAskQuestion(user._id.toString());
    if (!claimedAt) throw new Error("expected the free question to be claimable");
    await completeFreeAskQuestion(user._id.toString(), claimedAt);

    const after = await request(app).get("/api/auth/me").set(getAuthHeaders());
    const afterBody = after.body.user;
    expect(typeof afterBody.aiAskFreeQuestionUsedAt).toBe("string");
    expect(Number.isNaN(new Date(afterBody.aiAskFreeQuestionUsedAt).getTime())).toBe(false);
    for (const key of beforeKeys) {
      expect(Object.prototype.hasOwnProperty.call(afterBody, key)).toBe(true);
    }
  });

  it("keeps the old 403 body for POST /api/ai/generate-recipe when a free user calls a premium only route", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    const response = await request(app)
      .post("/api/ai/generate-recipe")
      .set(getAuthHeaders())
      .send({ prompt: "chicken and rice" });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "This feature requires a premium subscription." });
    expect(response.body.code).toBeUndefined();
  });

  it("keeps the old recipe and usage shape for POST /api/ai/format-recipe with the old notes only request body", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    await User.updateOne({ _id: user._id }, { $set: { isPremium: true } });
    anthropicMocks.create.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Pasta Aglio e Olio",
            ingredients: [{ name: "Spaghetti", quantity: 200, unit: "g" }],
            steps: [{ order: 1, instruction: "Boil the pasta." }],
          }),
        },
      ],
      usage: { input_tokens: 20, output_tokens: 15 },
    });

    const response = await request(app)
      .post("/api/ai/format-recipe")
      .set(getAuthHeaders())
      .send({ notes: "spaghetti with garlic and olive oil" });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(["recipe", "usage"]);
    expect(response.body.recipe.title).toBe("Pasta Aglio e Olio");
    expect(response.body.usage).toEqual({ used: 1, limit: 20 });
  });
});
