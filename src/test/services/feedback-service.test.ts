import { describe, it, expect } from "vitest";
import { Types } from "mongoose";
import {
  createFeedback,
  getMyFeedback,
} from "../../services/feedback-service";
import { createTestUser } from "../helpers";
import Feedback from "../../models/Feedback";

describe("feedback-service", () => {
  describe("createFeedback", () => {
    it("creates a feedback item snapshotting the user's identity", async () => {
      const user = await createTestUser({
        email: "chef@test.com",
        fullName: "Chef Alice",
      });

      const feedback = await createFeedback({
        userId: user._id.toString(),
        category: "bug",
        message: "The share sheet closes unexpectedly on iOS.",
        appVersion: "2.0.1",
        platform: "ios",
      });

      expect(feedback.userId.toString()).toBe(user._id.toString());
      expect(feedback.userEmail).toBe("chef@test.com");
      expect(feedback.userName).toBe("Chef Alice");
      expect(feedback.category).toBe("bug");
      expect(feedback.message).toBe(
        "The share sheet closes unexpectedly on iOS."
      );
      expect(feedback.appVersion).toBe("2.0.1");
      expect(feedback.platform).toBe("ios");
      expect(feedback.status).toBe("new");
    });

    it("defaults category to other when not provided", async () => {
      const user = await createTestUser();

      const feedback = await createFeedback({
        userId: user._id.toString(),
        message: "Just some general thoughts to share.",
      });

      expect(feedback.category).toBe("other");
    });

    it("persists the feedback with snapshotted identity", async () => {
      const user = await createTestUser({
        email: "author@test.com",
        fullName: "Author Bob",
      });

      const created = await createFeedback({
        userId: user._id.toString(),
        category: "praise",
        message: "Love the new meal planning features, keep it up!",
      });

      const stored = await Feedback.findById(created._id).lean();
      expect(stored).not.toBeNull();
      expect(stored?.userEmail).toBe("author@test.com");
      expect(stored?.userName).toBe("Author Bob");
      expect(stored?.status).toBe("new");
    });

    it("does not trust client-supplied identity — always snapshots from User", async () => {
      const user = await createTestUser({
        email: "real@test.com",
        fullName: "Real Name",
      });

      // The service signature does not accept identity fields from the caller,
      // but even if extra fields were passed they must be ignored in favor of
      // the authoritative User document.
      const feedback = await createFeedback({
        userId: user._id.toString(),
        message: "Feedback message with at least ten characters.",
      } as Parameters<typeof createFeedback>[0]);

      expect(feedback.userEmail).toBe("real@test.com");
      expect(feedback.userName).toBe("Real Name");
    });

    it("omits admin-only fields from the returned payload", async () => {
      const user = await createTestUser();

      const feedback = await createFeedback({
        userId: user._id.toString(),
        message: "Any feedback message longer than ten chars.",
      });

      expect(feedback).not.toHaveProperty("adminNote");
    });

    it("throws 404 when the user does not exist", async () => {
      const fakeId = new Types.ObjectId();

      try {
        await createFeedback({
          userId: fakeId.toString(),
          message: "A message from a ghost user here.",
        });
        expect.fail("Should have thrown");
      } catch (err: unknown) {
        const error = err as Error & { statusCode?: number };
        expect(error.message).toBe("User not found");
        expect(error.statusCode).toBe(404);
      }
    });
  });

  describe("getMyFeedback", () => {
    it("returns paginated feedback sorted by createdAt descending", async () => {
      const user = await createTestUser();

      for (let i = 0; i < 3; i++) {
        await createFeedback({
          userId: user._id.toString(),
          message: `Feedback number ${i} with enough length.`,
        });
      }

      const result = await getMyFeedback({
        userId: user._id.toString(),
        page: 1,
        limit: 2,
      });

      expect(result.feedback).toHaveLength(2);
      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(2);

      const dates = result.feedback.map((f) =>
        new Date(f.createdAt as string).getTime()
      );
      expect(dates[0]).toBeGreaterThanOrEqual(dates[1]);
    });

    it("returns only the current user's feedback", async () => {
      const mine = await createTestUser();
      const other = await createTestUser();

      await createFeedback({
        userId: mine._id.toString(),
        message: "My own feedback item goes here.",
      });
      await createFeedback({
        userId: other._id.toString(),
        message: "Someone else's feedback item.",
      });

      const result = await getMyFeedback({
        userId: mine._id.toString(),
        page: 1,
        limit: 10,
      });

      expect(result.total).toBe(1);
      expect(result.feedback).toHaveLength(1);
      expect(result.feedback[0].userId.toString()).toBe(mine._id.toString());
    });

    it("excludes admin-only fields from the listing", async () => {
      const user = await createTestUser();

      const created = await createFeedback({
        userId: user._id.toString(),
        message: "Feedback that will later be annotated.",
      });

      await Feedback.findByIdAndUpdate(created._id, {
        adminNote: "Internal triage note",
      });

      const result = await getMyFeedback({
        userId: user._id.toString(),
        page: 1,
        limit: 10,
      });

      expect(result.feedback).toHaveLength(1);
      expect(result.feedback[0]).not.toHaveProperty("adminNote");
    });

    it("returns empty results for page beyond data", async () => {
      const user = await createTestUser();

      const result = await getMyFeedback({
        userId: user._id.toString(),
        page: 5,
        limit: 10,
      });

      expect(result.feedback).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });
});
