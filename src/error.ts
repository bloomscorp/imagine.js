/**
 * Every failure is an `ImagineError`, so callers branch on `code`, never on text.
 *
 * Server codes pass through unchanged (`SESSION_LIMIT`, `PROMPT_REQUIRED`,
 * `ORIGIN_NOT_ALLOWED`, `RATE_LIMITED`, …; api.md §3). The library's own:
 *
 *   SESSION_TOKEN_FAILED  `getSessionToken()` threw or returned no token
 *   NETWORK_FAILURE       blooms.ai could not be reached, after the retries
 *   TIMEOUT               an attempt took longer than `timeoutMs`, after the retries
 *   BAD_RESPONSE          blooms.ai answered with something that is not its JSON
 *   NO_FETCH              there is no `fetch` to use
 *
 * Checked before an upload starts (the server uses the same codes):
 *
 *   VALIDATION_ERROR      no files
 *   TOO_MANY_REFERENCES   more than 5 files
 *   TOO_LARGE             a file over 10 MB
 *   BAD_REFERENCE         a file that is not PNG, JPEG or WebP
 */
export class ImagineError extends Error {
	/** A stable code to branch on. */
	readonly code: string;
	/** The HTTP status, or 0 when there was no response (network, timeout, a local check). */
	readonly status: number;
	/** Seconds to wait before trying again, when blooms.ai said so (`Retry-After`). */
	readonly retryAfter?: number;
	/** Extra fields from the server's error body, when there were any. */
	readonly details?: Record<string, unknown>;

	constructor(code: string, message: string, extra: {
		status?: number; retryAfter?: number; details?: Record<string, unknown>; cause?: unknown;
	} = {}) {
		super(message);
		this.name = 'ImagineError';
		this.code = code;
		this.status = extra.status ?? 0;
		if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
		if (extra.details !== undefined) this.details = extra.details;
		if (extra.cause !== undefined) (this as {cause?: unknown}).cause = extra.cause;
	}
}

/** True for an `ImagineError`, also across bundle copies (where `instanceof` can fail). */
export function isImagineError(value: unknown): value is ImagineError {
	return value instanceof ImagineError
		|| (typeof value === 'object' && value !== null && (value as {name?: unknown}).name === 'ImagineError'
			&& typeof (value as {code?: unknown}).code === 'string');
}
