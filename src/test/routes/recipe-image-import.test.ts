import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import recipesRouter from "../../routes/recipes";
import { createTestUser, getAuthHeaders } from "../helpers";

const aiMocks = vi.hoisted(() => ({
  extract: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  usage: vi.fn(),
}));

vi.mock("../../services/ai-recipe-service", () => ({
  aiExtractRecipeFromImages: aiMocks.extract,
  aiExtractRecipeFromCaption: vi.fn(),
  reserveImportQuota: aiMocks.reserve,
  releaseAiQuota: aiMocks.release,
  getAiUsage: aiMocks.usage,
}));

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use("/api/recipes", recipesRouter);

describe("POST /api/recipes/import/from-images", () => {
  beforeEach(() => {
    aiMocks.extract.mockReset();
    aiMocks.reserve.mockReset().mockResolvedValue({ day: "2026-09-12", feature: "generate" });
    aiMocks.release.mockReset().mockResolvedValue(undefined);
    aiMocks.usage.mockReset().mockResolvedValue({ used: 1, limit: 10 });
  });

  it("requires at least one image", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    const response = await request(app)
      .post("/api/recipes/import/from-images")
      .set(getAuthHeaders())
      .send({ images: [] });
    expect(response.status).toBe(400);
    expect(aiMocks.reserve).not.toHaveBeenCalled();
  });

  it("rejects unsupported media before using AI quota", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const response = await request(app)
      .post("/api/recipes/import/from-images")
      .set(getAuthHeaders())
      .send({ images: [{ data: "data:image/gif;base64,R0lGODlh" }] });
    expect(response.status).toBe(400);
    const stored = await user.$model("User").findById(user._id).lean();
    expect(stored?.aiRecipeHelperUsageCount ?? 0).toBe(0);
    expect(aiMocks.reserve).not.toHaveBeenCalled();
  });

  it("rejects more than four pages before using AI quota", async () => {
    const user = await createTestUser({ firebaseUid: "test-firebase-uid" });
    const image = { data: "data:image/jpeg;base64,/9j/2Q==" };
    const response = await request(app)
      .post("/api/recipes/import/from-images")
      .set(getAuthHeaders())
      .send({ images: [image, image, image, image, image] });
    expect(response.status).toBe(400);
    const stored = await user.$model("User").findById(user._id).lean();
    expect(stored?.aiRecipeHelperUsageCount ?? 0).toBe(0);
    expect(aiMocks.reserve).not.toHaveBeenCalled();
  });

  it("rejects media whose bytes do not match the declared format", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    const response = await request(app)
      .post("/api/recipes/import/from-images")
      .set(getAuthHeaders())
      .send({ images: [{ data: "data:image/png;base64,/9j/2Q==" }] });
    expect(response.status).toBe(400);
    expect(aiMocks.reserve).not.toHaveBeenCalled();
  });

  it("preserves page order and returns an editable review payload", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    aiMocks.extract.mockResolvedValue({
      recipe: {
        title: "Family soup",
        ingredients: [{ name: "Tomatoes", quantity: 0, unit: "" }],
        steps: [{ order: 1, instruction: "Simmer." }],
        dietaryTags: [],
        cuisineTags: [],
        sourceUrl: "",
      },
      missingFields: ["tomato quantity"],
      warnings: ["The ingredient line is incomplete."],
    });
    const first = "data:image/jpeg;base64,/9j/2Q==";
    const second = "data:image/jpeg;base64,/9j/4Q==";
    const response = await request(app)
      .post("/api/recipes/import/from-images")
      .set(getAuthHeaders())
      .send({ images: [{ data: first }, { data: second }] });

    expect(response.status).toBe(200);
    expect(aiMocks.extract.mock.calls[0][0].map((image: { data: string }) => image.data)).toEqual([
      "/9j/2Q==",
      "/9j/4Q==",
    ]);
    expect(response.body.recipe.ingredients[0].quantity).toBe(0);
    expect(response.body.review).toEqual({
      needsReview: true,
      missingFields: ["tomato quantity"],
      warnings: ["The ingredient line is incomplete."],
    });
    expect(response.body.source).toBeUndefined();
  });

  it("releases reserved quota when no recipe can be read", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    aiMocks.extract.mockResolvedValue(null);
    const response = await request(app)
      .post("/api/recipes/import/from-images")
      .set(getAuthHeaders())
      .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }] });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("IMAGE_NOT_READABLE");
    expect(aiMocks.release).toHaveBeenCalledOnce();
  });

  it("releases reserved quota when the AI call fails", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    aiMocks.extract.mockRejectedValue(new Error("upstream unavailable"));
    const response = await request(app)
      .post("/api/recipes/import/from-images")
      .set(getAuthHeaders())
      .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }] });

    expect(response.status).toBe(500);
    expect(aiMocks.release).toHaveBeenCalledOnce();
  });
});
