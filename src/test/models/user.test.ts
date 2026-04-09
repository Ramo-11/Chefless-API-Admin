import { describe, it, expect } from "vitest";
import User from "../../models/User";

describe("User model", () => {
  it("creates a user with valid data", async () => {
    const user = await User.create({
      firebaseUid: "firebase-123",
      email: "test@example.com",
      fullName: "John Doe",
    });

    expect(user.firebaseUid).toBe("firebase-123");
    expect(user.email).toBe("test@example.com");
    expect(user.fullName).toBe("John Doe");
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it("defaults isBanned to false", async () => {
    const user = await User.create({
      firebaseUid: "firebase-ban-test",
      email: "banned-test@example.com",
      fullName: "Ban Test",
    });

    expect(user.isBanned).toBe(false);
  });

  it("defaults isAdmin to false", async () => {
    const user = await User.create({
      firebaseUid: "firebase-admin-test",
      email: "admin-test@example.com",
      fullName: "Admin Test",
    });

    expect(user.isAdmin).toBe(false);
  });

  it("defaults isPublic to true", async () => {
    const user = await User.create({
      firebaseUid: "firebase-public-test",
      email: "public-test@example.com",
      fullName: "Public Test",
    });

    expect(user.isPublic).toBe(true);
  });

  it("defaults followersCount, followingCount, recipesCount, originalRecipesCount to 0", async () => {
    const user = await User.create({
      firebaseUid: "firebase-counts-test",
      email: "counts-test@example.com",
      fullName: "Counts Test",
    });

    expect(user.followersCount).toBe(0);
    expect(user.followingCount).toBe(0);
    expect(user.recipesCount).toBe(0);
    expect(user.originalRecipesCount).toBe(0);
  });

  it("defaults isPremium to false", async () => {
    const user = await User.create({
      firebaseUid: "firebase-premium-test",
      email: "premium-test@example.com",
      fullName: "Premium Test",
    });

    expect(user.isPremium).toBe(false);
  });

  it("defaults onboardingComplete to false", async () => {
    const user = await User.create({
      firebaseUid: "firebase-onboarding-test",
      email: "onboarding-test@example.com",
      fullName: "Onboarding Test",
    });

    expect(user.onboardingComplete).toBe(false);
  });

  it("enforces email uniqueness", async () => {
    await User.ensureIndexes();

    await User.create({
      firebaseUid: "firebase-unique-1",
      email: "duplicate@example.com",
      fullName: "User One",
    });

    await expect(
      User.create({
        firebaseUid: "firebase-unique-2",
        email: "duplicate@example.com",
        fullName: "User Two",
      })
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  it("enforces firebaseUid uniqueness", async () => {
    await User.ensureIndexes();

    await User.create({
      firebaseUid: "firebase-dup-uid",
      email: "uid-test-1@example.com",
      fullName: "User One",
    });

    await expect(
      User.create({
        firebaseUid: "firebase-dup-uid",
        email: "uid-test-2@example.com",
        fullName: "User Two",
      })
    ).rejects.toThrow(/duplicate key|E11000/);
  });

  it("lowercases email", async () => {
    const user = await User.create({
      firebaseUid: "firebase-lowercase-test",
      email: "TestUPPER@Example.COM",
      fullName: "Lowercase Test",
    });

    expect(user.email).toBe("testupper@example.com");
  });

  it("trims fullName", async () => {
    const user = await User.create({
      firebaseUid: "firebase-trim-test",
      email: "trim-test@example.com",
      fullName: "  John Doe  ",
    });

    expect(user.fullName).toBe("John Doe");
  });

  it("requires firebaseUid", async () => {
    await expect(
      User.create({
        email: "no-uid@example.com",
        fullName: "No UID",
      })
    ).rejects.toThrow(/firebaseUid/);
  });

  it("requires email", async () => {
    await expect(
      User.create({
        firebaseUid: "firebase-no-email",
        fullName: "No Email",
      })
    ).rejects.toThrow(/email/);
  });

  it("requires fullName", async () => {
    await expect(
      User.create({
        firebaseUid: "firebase-no-name",
        email: "no-name@example.com",
      })
    ).rejects.toThrow(/fullName/);
  });

  it("stores dietary and cuisine preferences", async () => {
    const user = await User.create({
      firebaseUid: "firebase-prefs-test",
      email: "prefs-test@example.com",
      fullName: "Prefs Test",
      dietaryPreferences: ["vegan", "gluten-free"],
      cuisinePreferences: ["italian", "japanese"],
    });

    expect(user.dietaryPreferences).toEqual(["vegan", "gluten-free"]);
    expect(user.cuisinePreferences).toEqual(["italian", "japanese"]);
  });
});
