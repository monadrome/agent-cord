/**
 * 统一错误（ADR-0021 决策 7）：HTTP 层把 ApiError 映射为 { code, message, details }。
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, "bad_request", message, details);
}

export function notFound(message: string, details?: unknown): ApiError {
  return new ApiError(404, "not_found", message, details);
}

export function conflict(message: string, details?: unknown): ApiError {
  return new ApiError(409, "conflict", message, details);
}

export function internalError(message: string, details?: unknown): ApiError {
  return new ApiError(500, "internal_error", message, details);
}

/** zod safeParse 失败 → 400，issues 收敛为可读路径列表 */
export function parseOrThrow<T>(
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } },
  input: unknown,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.map((p) => String(p)).join(".") || "<root>"}: ${issue.message}`,
    );
    throw badRequest("请求体不符合契约", issues);
  }
  return parsed.data;
}
