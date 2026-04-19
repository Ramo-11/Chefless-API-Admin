import { Types } from "mongoose";
import Feedback, {
  FeedbackCategory,
  FeedbackPlatform,
} from "../models/Feedback";
import User from "../models/User";

interface CreateFeedbackInput {
  userId: string;
  category?: FeedbackCategory;
  message: string;
  appVersion?: string;
  platform?: FeedbackPlatform;
}

interface GetMyFeedbackFilters {
  userId: string;
  page: number;
  limit: number;
}

export async function createFeedback(input: CreateFeedbackInput) {
  const { userId, category, message, appVersion, platform } = input;

  // Snapshot the authed user's identity from the User document. We never trust
  // client-supplied identity fields — admin context should reflect the real
  // account state at submit time, even if the user later renames themselves.
  const user = await User.findById(userId)
    .select("fullName email")
    .lean();

  if (!user) {
    throw Object.assign(new Error("User not found"), { statusCode: 404 });
  }

  const feedback = await Feedback.create({
    userId: new Types.ObjectId(userId),
    userEmail: user.email,
    userName: user.fullName,
    category: category ?? "other",
    message,
    appVersion,
    platform,
  });

  // Strip admin-only fields before returning to the client.
  const obj = feedback.toObject();
  return {
    _id: obj._id,
    userId: obj.userId,
    userEmail: obj.userEmail,
    userName: obj.userName,
    category: obj.category,
    message: obj.message,
    appVersion: obj.appVersion,
    platform: obj.platform,
    status: obj.status,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

export async function getMyFeedback(filters: GetMyFeedbackFilters) {
  const { userId, page, limit } = filters;
  const skip = (page - 1) * limit;

  const query = { userId: new Types.ObjectId(userId) };

  const [items, total] = await Promise.all([
    Feedback.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      // Hide admin-only fields from the user-facing view.
      .select("-adminNote")
      .lean(),
    Feedback.countDocuments(query),
  ]);

  return {
    feedback: items,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}
