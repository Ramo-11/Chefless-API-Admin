import { describe, it, expect } from "vitest";
import { Types } from "mongoose";
import Feedback from "../../models/Feedback";

describe("Feedback model", () => {
  it("creates a feedback with valid data", async () => {
    const userId = new Types.ObjectId();

    const feedback = await Feedback.create({
      userId,
      userEmail: "user@test.com",
      userName: "Test User",
      category: "bug",
      message: "The recipe editor crashes when I add a step.",
      appVersion: "1.2.3",
      platform: "ios",
    });

    expect(feedback.userId.toString()).toBe(userId.toString());
    expect(feedback.userEmail).toBe("user@test.com");
    expect(feedback.userName).toBe("Test User");
    expect(feedback.category).toBe("bug");
    expect(feedback.message).toBe("The recipe editor crashes when I add a step.");
    expect(feedback.appVersion).toBe("1.2.3");
    expect(feedback.platform).toBe("ios");
    expect(feedback.status).toBe("new");
    expect(feedback.createdAt).toBeInstanceOf(Date);
    expect(feedback.updatedAt).toBeInstanceOf(Date);
  });

  it("defaults category to other", async () => {
    const feedback = await Feedback.create({
      userId: new Types.ObjectId(),
      userEmail: "user@test.com",
      userName: "Test User",
      message: "Just wanted to say hi to the team.",
    });

    expect(feedback.category).toBe("other");
  });

  it("defaults status to new", async () => {
    const feedback = await Feedback.create({
      userId: new Types.ObjectId(),
      userEmail: "user@test.com",
      userName: "Test User",
      category: "idea",
      message: "Would love a dark mode for the app.",
    });

    expect(feedback.status).toBe("new");
  });

  it("requires userId", async () => {
    await expect(
      Feedback.create({
        userEmail: "user@test.com",
        userName: "Test User",
        message: "Missing userId here though.",
      })
    ).rejects.toThrow(/userId/);
  });

  it("requires userEmail", async () => {
    await expect(
      Feedback.create({
        userId: new Types.ObjectId(),
        userName: "Test User",
        message: "No email snapshot on this one.",
      })
    ).rejects.toThrow(/userEmail/);
  });

  it("requires userName", async () => {
    await expect(
      Feedback.create({
        userId: new Types.ObjectId(),
        userEmail: "user@test.com",
        message: "No name snapshot on this one.",
      })
    ).rejects.toThrow(/userName/);
  });

  it("requires message", async () => {
    await expect(
      Feedback.create({
        userId: new Types.ObjectId(),
        userEmail: "user@test.com",
        userName: "Test User",
      })
    ).rejects.toThrow(/message/);
  });

  it("rejects messages shorter than 10 characters", async () => {
    await expect(
      Feedback.create({
        userId: new Types.ObjectId(),
        userEmail: "user@test.com",
        userName: "Test User",
        message: "too short",
      })
    ).rejects.toThrow(/message/);
  });

  it("rejects messages longer than 2000 characters", async () => {
    await expect(
      Feedback.create({
        userId: new Types.ObjectId(),
        userEmail: "user@test.com",
        userName: "Test User",
        message: "x".repeat(2001),
      })
    ).rejects.toThrow(/message/);
  });

  it("rejects invalid category enum value", async () => {
    await expect(
      Feedback.create({
        userId: new Types.ObjectId(),
        userEmail: "user@test.com",
        userName: "Test User",
        category: "complaint",
        message: "This should not be accepted.",
      })
    ).rejects.toThrow(/category/);
  });

  it("rejects invalid platform enum value", async () => {
    await expect(
      Feedback.create({
        userId: new Types.ObjectId(),
        userEmail: "user@test.com",
        userName: "Test User",
        message: "This should not be accepted.",
        platform: "windows",
      })
    ).rejects.toThrow(/platform/);
  });

  it("rejects invalid status enum value", async () => {
    await expect(
      Feedback.create({
        userId: new Types.ObjectId(),
        userEmail: "user@test.com",
        userName: "Test User",
        message: "This should not be accepted.",
        status: "pending",
      })
    ).rejects.toThrow(/status/);
  });

  it("accepts all valid category values", async () => {
    const categories = ["bug", "idea", "improvement", "praise", "other"] as const;

    for (const category of categories) {
      const feedback = await Feedback.create({
        userId: new Types.ObjectId(),
        userEmail: "user@test.com",
        userName: "Test User",
        category,
        message: "A valid feedback message here.",
      });
      expect(feedback.category).toBe(category);
    }
  });

  it("accepts all valid platform values", async () => {
    const platforms = ["ios", "android", "web"] as const;

    for (const platform of platforms) {
      const feedback = await Feedback.create({
        userId: new Types.ObjectId(),
        userEmail: "user@test.com",
        userName: "Test User",
        message: "A valid feedback message here.",
        platform,
      });
      expect(feedback.platform).toBe(platform);
    }
  });

  it("accepts all valid status values", async () => {
    const statuses = ["new", "triaged", "resolved", "archived"] as const;

    for (const status of statuses) {
      const feedback = await Feedback.create({
        userId: new Types.ObjectId(),
        userEmail: "user@test.com",
        userName: "Test User",
        message: "A valid feedback message here.",
        status,
      });
      expect(feedback.status).toBe(status);
    }
  });

  it("trims message whitespace", async () => {
    const feedback = await Feedback.create({
      userId: new Types.ObjectId(),
      userEmail: "user@test.com",
      userName: "Test User",
      message: "   some useful feedback here   ",
    });

    expect(feedback.message).toBe("some useful feedback here");
  });

  it("stores optional adminNote when provided", async () => {
    const feedback = await Feedback.create({
      userId: new Types.ObjectId(),
      userEmail: "user@test.com",
      userName: "Test User",
      message: "A valid feedback message here.",
      adminNote: "Triaged to mobile team.",
    });

    expect(feedback.adminNote).toBe("Triaged to mobile team.");
  });

  it("allows same user to submit multiple feedback items", async () => {
    const userId = new Types.ObjectId();

    const first = await Feedback.create({
      userId,
      userEmail: "user@test.com",
      userName: "Test User",
      message: "First piece of feedback here.",
    });
    const second = await Feedback.create({
      userId,
      userEmail: "user@test.com",
      userName: "Test User",
      message: "Second piece of feedback here.",
    });

    expect(first._id.toString()).not.toBe(second._id.toString());
  });
});
