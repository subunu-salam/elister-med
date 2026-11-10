export type ErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "PERIOD_LOCKED"
  | "UNBALANCED"
  | "UNAUTHENTICATED";

const STATUS: Record<ErrorCode, number> = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 422,
  PERIOD_LOCKED: 423,
  UNBALANCED: 422,
  UNAUTHENTICATED: 401,
};

export class AppError extends Error {
  readonly status: number;
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}
