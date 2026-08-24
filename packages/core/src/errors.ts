export enum ErrorCode {
  ValidationError = "validation_error",
  AuthError = "auth_error",
  UpstreamUnreachable = "upstream_unreachable",
  UpstreamRejected = "upstream_rejected",
  NotFound = "not_found",
  RateLimited = "rate_limited",
  ApprovalRequired = "approval_required",
  DuplicateRequest = "duplicate_request",
  InternalError = "internal_error"
}

const HTTP_HINTS: Record<ErrorCode, string> = {
  [ErrorCode.ValidationError]: "Check the tool input against the schema.",
  [ErrorCode.AuthError]: "Verify credentials in the credential vault.",
  [ErrorCode.UpstreamUnreachable]: "Confirm the upstream system is running and reachable at the configured URL/port.",
  [ErrorCode.UpstreamRejected]: "Inspect line errors returned by the upstream system.",
  [ErrorCode.NotFound]: "The requested record or company does not exist.",
  [ErrorCode.RateLimited]: "Slow down and retry after backoff.",
  [ErrorCode.ApprovalRequired]: "This action requires human approval before execution.",
  [ErrorCode.DuplicateRequest]: "An identical write already completed; reuse the cached result.",
  [ErrorCode.InternalError]: "Unexpected connector failure; see audit log."
};

export class ConnectorError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly detail?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options?: { retryable?: boolean; detail?: Record<string, unknown>; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "ConnectorError";
    this.code = code;
    this.retryable = options?.retryable ?? (code === ErrorCode.UpstreamUnreachable || code === ErrorCode.RateLimited);
    this.detail = options?.detail;
  }

  hint(): string {
    return HTTP_HINTS[this.code] ?? "";
  }

  toPayload(): { code: string; message: string; retryable: boolean; hint: string; detail?: Record<string, unknown> } {
    const payload: { code: string; message: string; retryable: boolean; hint: string; detail?: Record<string, unknown> } = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      hint: this.hint()
    };
    if (this.detail) payload.detail = this.detail;
    return payload;
  }
}

export function isConnectorError(err: unknown): err is ConnectorError {
  return err instanceof ConnectorError;
}

export function wrapUnknown(err: unknown): ConnectorError {
  if (isConnectorError(err)) return err;
  if (err instanceof Error) {
    const msg = String(err.message ?? "");
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(msg)) {
      return new ConnectorError(ErrorCode.UpstreamUnreachable, `Upstream unreachable: ${msg}`, { cause: err });
    }
    if (/401|403/.test(msg)) return new ConnectorError(ErrorCode.AuthError, msg, { cause: err });
    if (/429/.test(msg)) return new ConnectorError(ErrorCode.RateLimited, msg, { cause: err });
    return new ConnectorError(ErrorCode.InternalError, msg, { cause: err });
  }
  return new ConnectorError(ErrorCode.InternalError, String(err));
}
