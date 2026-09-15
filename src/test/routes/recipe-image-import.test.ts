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

  it("old request shape without sourceUrl returns the unchanged response shape", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    aiMocks.extract.mockResolvedValue({
      recipe: {
        title: "Family soup",
        ingredients: [{ name: "Tomatoes", quantity: 2, unit: "" }],
        steps: [{ order: 1, instruction: "Simmer." }],
        dietaryTags: [],
        cuisineTags: [],
        sourceUrl: "",
      },
      missingFields: [],
      warnings: [],
    });
    const response = await request(app)
      .post("/api/recipes/import/from-images")
      .set(getAuthHeaders())
      .send({
        images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }],
        timezoneOffsetMinutes: -300,
      });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(["recipe", "review", "usage"]);
    expect(response.body.recipe.sourceUrl).toBe("");
    expect(response.body.review).toEqual({
      needsReview: true,
      missingFields: [],
      warnings: [],
    });
  });

  it("passes the app locale to extraction and leaves it undefined for the old request shape", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    aiMocks.extract.mockResolvedValue({
      recipe: {
        title: "Soup",
        ingredients: [{ name: "Water", quantity: 1, unit: "l" }],
        steps: [{ order: 1, instruction: "Boil." }],
        dietaryTags: [],
        cuisineTags: [],
        sourceUrl: "",
      },
      missingFields: [],
      warnings: [],
    });
    const image = { data: "data:image/jpeg;base64,/9j/2Q==" };

    const withLocale = await request(app)
      .post("/api/recipes/import/from-images")
      .set(getAuthHeaders())
      .send({ images: [image], locale: "ar" });
    const withoutLocale = await request(app)
      .post("/api/recipes/import/from-images")
      .set(getAuthHeaders())
      .send({ images: [image] });

    expect(withLocale.status).toBe(200);
    expect(withoutLocale.status).toBe(200);
    expect(aiMocks.extract.mock.calls[0][2]).toBe("ar");
    expect(aiMocks.extract.mock.calls[1][2]).toBeUndefined();
    expect(Object.keys(withLocale.body).sort()).toEqual(["recipe", "review", "usage"]);
  });

  it("rejects a non string locale before reserving quota", async () => {
    await createTestUser({ firebaseUid: "test-firebase-uid" });
    const response = await request(app)
      .post("/api/recipes/import/from-images")
      .set(getAuthHeaders())
      .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }], locale: 7 });

    expect(response.status).toBe(400);
    expect(aiMocks.reserve).not.toHaveBeenCalled();
  });

  describe("with sourceUrl", () => {
    beforeEach(() => {
      aiMocks.extract.mockResolvedValue({
        recipe: {
          title: "Family soup",
          ingredients: [{ name: "Tomatoes", quantity: 2, unit: "" }],
          steps: [{ order: 1, instruction: "Simmer." }],
          dietaryTags: [],
          cuisineTags: [],
          sourceUrl: "",
        },
        missingFields: [],
        warnings: [],
      });
    });

    it("accepted for a public website URL and credits the recipe source", async () => {
      await createTestUser({ firebaseUid: "test-firebase-uid" });
      const sourceUrl = "https://www.allrecipes.com/recipe/123";
      const response = await request(app)
        .post("/api/recipes/import/from-images")
        .set(getAuthHeaders())
        .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }], sourceUrl });

      expect(response.status).toBe(200);
      expect(response.body.source).toEqual({
        type: "website",
        url: sourceUrl,
        siteName: "allrecipes.com",
        importedVia: "ai",
      });
      expect(response.body.recipe.sourceUrl).toBe(sourceUrl);
    });

    it("accepted for an Instagram post URL", async () => {
      await createTestUser({ firebaseUid: "test-firebase-uid" });
      const sourceUrl = "https://www.instagram.com/reel/abc123/";
      const response = await request(app)
        .post("/api/recipes/import/from-images")
        .set(getAuthHeaders())
        .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }], sourceUrl });

      expect(response.status).toBe(200);
      expect(response.body.source.type).toBe("instagram");
      expect(response.body.source.siteName).toBe("Instagram");
      expect(response.body.recipe.sourceUrl).toBe(sourceUrl);
    });

    it("accepted for a YouTube URL", async () => {
      await createTestUser({ firebaseUid: "test-firebase-uid" });
      const sourceUrl = "https://youtube.com/watch?v=x";
      const response = await request(app)
        .post("/api/recipes/import/from-images")
        .set(getAuthHeaders())
        .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }], sourceUrl });

      expect(response.status).toBe(200);
      expect(response.body.source.type).toBe("youtube");
      expect(response.body.source.siteName).toBe("YouTube");
      expect(response.body.recipe.sourceUrl).toBe(sourceUrl);
    });

    it.each([
      ["not a URL string", "definitely not a url"],
      ["an ftp scheme", "ftp://example.com/file"],
      ["localhost", "http://localhost/x"],
      ["IPv4 loopback", "http://127.0.0.1/x"],
      ["a private class A address", "http://10.0.0.5/x"],
      ["a private class C address", "http://192.168.1.1/x"],
      ["the cloud metadata address", "http://169.254.169.254/latest/meta-data"],
      ["IPv6 loopback", "http://[::1]/x"],
      ["a URL longer than 2048 characters", `https://example.com/${"a".repeat(2100)}`],
    ])("rejects sourceUrl that is %s with 400 and reserves no quota", async (_label, sourceUrl) => {
      await createTestUser({ firebaseUid: "test-firebase-uid" });
      const response = await request(app)
        .post("/api/recipes/import/from-images")
        .set(getAuthHeaders())
        .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }], sourceUrl });

      expect(response.status).toBe(400);
      expect(aiMocks.reserve).not.toHaveBeenCalled();
      expect(aiMocks.extract).not.toHaveBeenCalled();
    });

    it.each([
      "https://fcbarcelona.com/recipe",
      "https://fc2.com/recipe",
      "https://10.wiki/page",
      "https://172.example.org/recipe",
    ])("accepts the public site %s whose name only looks like a private address", async (sourceUrl) => {
      await createTestUser({ firebaseUid: "test-firebase-uid" });
      const response = await request(app)
        .post("/api/recipes/import/from-images")
        .set(getAuthHeaders())
        .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }], sourceUrl });

      expect(response.status).toBe(200);
      expect(response.body.source.url).toBe(sourceUrl);
    });

    it.each([
      "http://172.16.0.1/x",
      "http://0.0.0.0/x",
      "http://[fd00::1]/x",
      "http://printer.local/x",
      "http://metadata.internal/x",
    ])("still rejects the private address %s", async (sourceUrl) => {
      await createTestUser({ firebaseUid: "test-firebase-uid" });
      const response = await request(app)
        .post("/api/recipes/import/from-images")
        .set(getAuthHeaders())
        .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }], sourceUrl });

      expect(response.status).toBe(400);
      expect(aiMocks.reserve).not.toHaveBeenCalled();
    });

    it("rejects a non string sourceUrl with 400 and reserves no quota", async () => {
      await createTestUser({ firebaseUid: "test-firebase-uid" });
      const response = await request(app)
        .post("/api/recipes/import/from-images")
        .set(getAuthHeaders())
        .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }], sourceUrl: 12345 });

      expect(response.status).toBe(400);
      expect(aiMocks.reserve).not.toHaveBeenCalled();
      expect(aiMocks.extract).not.toHaveBeenCalled();
    });

    it("returns IMAGE_NOT_READABLE with 422 and releases quota once when sourceUrl is present", async () => {
      await createTestUser({ firebaseUid: "test-firebase-uid" });
      aiMocks.extract.mockResolvedValue(null);
      const response = await request(app)
        .post("/api/recipes/import/from-images")
        .set(getAuthHeaders())
        .send({
          images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }],
          sourceUrl: "https://www.allrecipes.com/recipe/123",
        });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe("IMAGE_NOT_READABLE");
      expect(aiMocks.release).toHaveBeenCalledOnce();
    });

    it("saves an imported recipe whose unknown quantity keeps a blank unit", async () => {
      await createTestUser({ firebaseUid: "test-firebase-uid" });
      const sourceUrl = "https://www.allrecipes.com/recipe/123";
      const importResponse = await request(app)
        .post("/api/recipes/import/from-images")
        .set(getAuthHeaders())
        .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }], sourceUrl });

      const createResponse = await request(app)
        .post("/api/recipes")
        .set(getAuthHeaders())
        .send({
          title: "Guacamole",
          ingredients: [
            { name: "Avocados", quantity: 4, unit: "pieces" },
            { name: "Cilantro", quantity: 0, unit: "" },
          ],
          steps: [{ order: 1, instruction: "Garnish with cilantro." }],
          source: importResponse.body.source,
        });

      expect(createResponse.status).toBe(201);
      expect(createResponse.body.recipe.ingredients[1]).toMatchObject({
        name: "Cilantro",
        quantity: 0,
        unit: "",
      });
      expect(createResponse.body.recipe.source.url).toBe(sourceUrl);
    });

    it("the returned source is accepted by recipe creation and credits the original link", async () => {
      await createTestUser({ firebaseUid: "test-firebase-uid" });
      const sourceUrl = "https://www.allrecipes.com/recipe/123";
      const importResponse = await request(app)
        .post("/api/recipes/import/from-images")
        .set(getAuthHeaders())
        .send({ images: [{ data: "data:image/jpeg;base64,/9j/2Q==" }], sourceUrl });

      expect(importResponse.status).toBe(200);

      const createResponse = await request(app)
        .post("/api/recipes")
        .set(getAuthHeaders())
        .send({
          title: "Family soup",
          ingredients: [{ name: "Tomatoes", quantity: 2, unit: "cup" }],
          steps: [{ order: 1, instruction: "Simmer." }],
          source: importResponse.body.source,
        });

      expect(createResponse.status).toBe(201);
      expect(createResponse.body.recipe.source.url).toBe(sourceUrl);
      expect(createResponse.body.recipe.source.importedVia).toBe("ai");
    });
  });
});
