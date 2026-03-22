import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

interface ValidationTarget {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export function validate(schemas: ValidationTarget) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: Array<{ location: string; issues: Array<{ path: string; message: string }> }> = [];

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        errors.push({
          location: "body",
          issues: formatZodError(result.error),
        });
      } else {
        req.body = result.data;
      }
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        errors.push({
          location: "query",
          issues: formatZodError(result.error),
        });
      } else {
        (req as Request).query = result.data as typeof req.query;
      }
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        errors.push({
          location: "params",
          issues: formatZodError(result.error),
        });
      } else {
        req.params = result.data as typeof req.params;
      }
    }

    if (errors.length > 0) {
      console.log(
        `[Validation] ${req.method} ${req.path}:`,
        JSON.stringify(errors, null, 2)
      );
      res.status(400).json({ error: "Validation failed", details: errors });
      return;
    }

    next();
  };
}

function formatZodError(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}
