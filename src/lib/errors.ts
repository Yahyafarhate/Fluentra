export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (message: string, code = "BAD_REQUEST", details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = "Authentication required") => new AppError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You do not have permission to do this", code = "FORBIDDEN") => new AppError(403, code, message);
export const notFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (message: string, code = "CONFLICT", details?: unknown) => new AppError(409, code, message, details);
export const unprocessable = (message: string, code = "UNPROCESSABLE", details?: unknown) => new AppError(422, code, message, details);
export const tooMany = (retryAfterSec: number) => new AppError(429, "RATE_LIMITED", "Too many requests. Please try again later.", { retryAfterSec });
export const planLimit = (message: string, details?: unknown) => new AppError(402, "PLAN_LIMIT", message, details);
