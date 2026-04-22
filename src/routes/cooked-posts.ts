import { Router, Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import User from "../models/User";
import {
  createCookedPost,
  deleteCookedPost,
  listCookedPostsForRecipe,
  listCookedPostsForUser,
  removeCookedPostByOwner,
  uploadCookedPostPhoto,
  countCookedPostsForRecipe,
} from "../services/cooked-post-service";

const router = Router();

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

const objectIdParam = z.object({
  id: z.string().refine(isValidObjectId, { message: "Invalid ID format" }),
});

const createCookedPostSchema = z.object({
  recipeId: z
    .string()
    .refine(isValidObjectId, { message: "Invalid recipe ID" }),
  photoUrl: z
    .string()
    .url({ message: "Photo URL must be a valid URL." })
    .max(2048),
  caption: z.string().trim().max(500).optional(),
});

const uploadPhotoSchema = z.object({
  image: z
    .string()
    .min(1, "Image data is required")
    .refine((val) => val.startsWith("data:image/"), {
      message: "Must be a valid base64 data URI (data:image/...)",
    }),
});

const cursorSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// POST /api/cooked-posts/upload-photo — upload a photo and return the secure URL
router.post(
  "/upload-photo",
  requireAuth,
  validate({ body: uploadPhotoSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const { image } = req.body as z.infer<typeof uploadPhotoSchema>;
    const result = await uploadCookedPostPhoto(image, user._id.toString());
    res.status(200).json(result);
  })
);

// POST /api/cooked-posts — create an "I Cooked It" post
router.post(
  "/",
  requireAuth,
  validate({ body: createCookedPostSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const body = req.body as z.infer<typeof createCookedPostSchema>;
    const result = await createCookedPost({
      userId: user._id.toString(),
      recipeId: body.recipeId,
      photoUrl: body.photoUrl,
      caption: body.caption,
    });
    res.status(201).json(result);
  })
);

// GET /api/cooked-posts/recipe/:id — gallery of cooked posts for a recipe
router.get(
  "/recipe/:id",
  requireAuth,
  validate({ params: objectIdParam, query: cursorSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const { id } = req.params as z.infer<typeof objectIdParam>;
    const { cursor, limit } = req.query as unknown as z.infer<
      typeof cursorSchema
    >;
    const [page, count] = await Promise.all([
      listCookedPostsForRecipe(id, user._id.toString(), cursor, limit),
      countCookedPostsForRecipe(id),
    ]);
    res.status(200).json({ ...page, total: count });
  })
);

// GET /api/cooked-posts/user/:id — single user's cooked-post feed
router.get(
  "/user/:id",
  requireAuth,
  validate({ params: objectIdParam, query: cursorSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as z.infer<typeof objectIdParam>;
    const { cursor, limit } = req.query as unknown as z.infer<
      typeof cursorSchema
    >;
    const page = await listCookedPostsForUser(id, cursor, limit);
    res.status(200).json(page);
  })
);

const removePostSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "A reason is required.")
    .max(500, "Reason must be 500 characters or fewer."),
});

// POST /api/cooked-posts/:id/remove — recipe owner removes someone else's post
router.post(
  "/:id/remove",
  requireAuth,
  validate({ params: objectIdParam, body: removePostSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const { id } = req.params as z.infer<typeof objectIdParam>;
    const { reason } = req.body as z.infer<typeof removePostSchema>;
    await removeCookedPostByOwner({
      postId: id,
      ownerId: user._id.toString(),
      reason,
    });
    res.status(200).json({ success: true });
  })
);

// DELETE /api/cooked-posts/:id — delete your own post
router.delete(
  "/:id",
  requireAuth,
  validate({ params: objectIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const firebaseUid = req.user!.uid;
    const user = await User.findOne({ firebaseUid }).select("_id").lean();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const { id } = req.params as z.infer<typeof objectIdParam>;
    await deleteCookedPost(id, user._id.toString());
    res.status(200).json({ success: true });
  })
);

export default router;
