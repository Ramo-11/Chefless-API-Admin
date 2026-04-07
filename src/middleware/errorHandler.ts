import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import mongoose from "mongoose";

interface AppError extends Error {
  statusCode?: number;
}

export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = _req.requestId ?? "unknown";
  console.error(`[Error] [${requestId}] ${err.message}`, err.stack);

  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  // Mongoose validation errors
  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.entries(err.errors).map(([field, error]) => ({
      path: field,
      message: error.message,
    }));
    res.status(400).json({ error: "Validation failed", details });
    return;
  }

  // Mongoose cast errors (invalid ObjectId, etc.)
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({ error: `Invalid ${err.path}: ${err.value}` });
    return;
  }

  // Custom app errors with status code
  if (err.statusCode) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Default server error
  res.status(500).json({ error: "Internal server error" });
}
