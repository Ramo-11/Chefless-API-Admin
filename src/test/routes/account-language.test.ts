import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import usersRouter from "../../routes/users";
import authRouter from "../../routes/auth";
import User from "../../models/User";
import { createTestUser, getAuthHeaders } from "../helpers";

const app = express();
app.use(express.json());
app.use("/api/users", usersRouter);
app.use("/api/auth", authRouter);

describe("account language", () => {
  it.each(["ar", "es", "tr", "en"] as const)(
    "PATCH /api/users/me persists language %s",
    async (language) => {
      await User.ensureIndexes();
      const user = await createTestUser({ firebaseUid: "test-firebase-uid" });

      const response = await request(app)
        .patch("/api/users/me")
        .set(getAuthHeaders())
        .send({ language });

      expect(response.status).toBe(200);

      const stored = await User.findById(user._id);
      expect(stored?.language).toBe(language);
    }
  );

  it("POST /api/auth/register with language ar creates a user with language ar", async () => {
    await User.ensureIndexes();

    const response = await request(app)
      .post("/api/auth/register")
      .set(getAuthHeaders())
      .send({ fullName: "New User", language: "ar" });

    expect(response.status).toBe(201);

    const stored = await User.findOne({ firebaseUid: "test-firebase-uid" });
    expect(stored?.language).toBe("ar");
  });

  it("POST /api/auth/register without language defaults to en", async () => {
    const response = await request(app)
      .post("/api/auth/register")
      .set(getAuthHeaders())
      .send({ fullName: "New User" });

    expect(response.status).toBe(201);

    const stored = await User.findOne({ firebaseUid: "test-firebase-uid" });
    expect(stored?.language).toBe("en");
  });
});
