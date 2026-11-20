import {ImagineError, isImagineError} from './error';
import type {
	CreatedJob, CreateJobOptions, CreateJobRequest, ImagineBrowserOptions, Job, JobStatus, JobWithImages,
	Reference, Session, SessionTokenResult, WatchJobOptions,
} from './types';

/**
 * The browser client for Imagine (blooms.ai documentation/imagine/api.md §5, §11.1).
 *
 * - It never sees an API key. Your backend mints a short-lived session token with
 *   `@bloomscorp/imagine-node` and hands it to `getSessionToken()`.
 * - The token is fetched lazily, kept until 30 seconds before it expires, and fetched
 *   once more (then the call retried once) when blooms.ai answers `SESSION_EXPIRED`.
 * - 429, 5xx and network errors are retried with backoff, honouring `Retry-After`.
 *   A create is retried only when it carries an idempotency key.
 * - Every failure is an `ImagineError` with a `code`.
 * - No browser globals are touched until a method is called, so it is safe to import
 *   during server-side rendering.
 */

const DEFAULT_BASE = 'https://z.bloomscorp.com';
const API_PATH = '/api/v1/imagine/browser';
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Ask for a new token this long before the current one expires. */
const REFRESH_MARGIN_MS = 30_000;
/** A session read made to learn a new token's expiry answers the next `session()` within this time. */
const PROBE_REUSE_MS = 5_000;
const TERMINAL: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

/** What upload limits the client checks before sending (api.md §4: 1–5 files, PNG/JPEG/WebP, ≤ 10 MB). */
const MAX_REFERENCES = 5;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const REFERENCE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * When a failed attempt may be repeated:
 * - `always`: reads, cancel, and a create with an idempotency key (429, 5xx, network)
 * - `refused`: an upload, only on 429, which means nothing was stored
 * - `never`: a create without an idempotency key
 */
type RetryPolicy = 'always' | 'refused' | 'never';

interface RequestSpec {
	method: 'GET' | 'POST';
	path: string;
	json?: unknown;
	/** Built afresh for every attempt. */
	form?: () => FormData;
	idempotencyKey?: string;
	retry: RetryPolicy;
	timeoutMs?: number;
	signal?: AbortSignal;
}

interface Envelope<T> {
	success: boolean;
	data: T;
	message?: string;
	code?: string;
	[extra: string]: unknown;
}

/** @internal test seam: how the client waits between attempts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const realSleep: Sleep = (ms, signal) => new Promise((resolve, reject) => {
	if (signal?.aborted) return reject(aborted());
	const timer = setTimeout(() => {
		signal?.removeEventListener('abort', onAbort);
		resolve();
	}, ms);
	const onAbort = (): void => {
		clearTimeout(timer);
		reject(aborted());
	};
	signal?.addEventListener('abort', onAbort, {once: true});
});

const aborted = (): ImagineError => new ImagineError('ABORTED', 'the request was stopped');

export class ImagineBrowser {
	private readonly getSessionToken: () => SessionTokenResult | Promise<SessionTokenResult>;
	private readonly base: string;
	private readonly timeoutMs: number;
	private readonly uploadTimeoutMs: number;
	private readonly maxRetries: number;
	private readonly maxRetryWaitMs: number;
	private readonly fetchImpl: typeof fetch | undefined;
	private sleep: Sleep = realSleep;

	private token: {value: string; expiresAt: number | null} | null = null;
	private pendingToken: Promise<string> | null = null;
	private probe: {token: string; session: Session; at: number} | null = null;

	constructor(options: ImagineBrowserOptions) {
		if (typeof options?.getSessionToken !== 'function') {
			throw new ImagineError('SESSION_TOKEN_FAILED',
				'getSessionToken is required: a function that asks your backend for an Imagine session token.');
		}
		this.getSessionToken = options.getSessionToken;
		this.base = String(options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
		this.maxRetries = Math.max(0, options.maxRetries ?? 3);
		this.maxRetryWaitMs = options.maxRetryWaitMs ?? 60_000;
		this.fetchImpl = options.fetch;
	}

	// ── Calls ───────────────────────────────────────────────────────────────

	/** What this session may do: expiry, modes, image allowance, models and presets. */
	async session(): Promise<Session> {
		const token = await this.currentToken();
		const probe = this.probe;
		this.probe = null;
		if (probe && probe.token === token && Date.now() - probe.at < PROBE_REUSE_MS) return probe.session;
		const session = await this.request<Session>({method: 'GET', path: '/session', retry: 'always'});
		this.noteExpiry(token, session?.expiresAt);
		return session;
	}

	/**
	 * Upload 1–5 product photos or images to edit (PNG, JPEG or WebP, up to 10 MB each).
	 * Use the returned ids as a recipe's `referenceIds`.
	 */
	async uploadReferences(files: ArrayLike<Blob> | Iterable<Blob>): Promise<Reference[]> {
		const list = Array.from(files as ArrayLike<Blob>);
		if (!list.length) throw new ImagineError('VALIDATION_ERROR', 'Choose 1 to 5 images to upload.');
		if (list.length > MAX_REFERENCES) {
			throw new ImagineError('TOO_MANY_REFERENCES', `At most ${MAX_REFERENCES} images can be uploaded at once.`);
		}
		list.forEach((file, i) => {
			if (!isBlob(file)) throw new ImagineError('BAD_REFERENCE', `Item ${i + 1} is not a File or Blob.`);
			if (file.size > MAX_REFERENCE_BYTES) {
				throw new ImagineError('TOO_LARGE', `${fileName(file, i)} is larger than 10 MB.`);
			}
			if (file.type && !REFERENCE_TYPES.includes(file.type)) {
				throw new ImagineError('BAD_REFERENCE', `${fileName(file, i)} is ${file.type}; use PNG, JPEG or WebP.`);
			}
		});
		const form = (): FormData => {
			const body = new FormData();
			list.forEach((file, i) => body.append('images', file, fileName(file, i)));
			return body;
		};
		return this.request<Reference[]>({
			method: 'POST', path: '/references', form, retry: 'refused', timeoutMs: this.uploadTimeoutMs,
		});
	}

	/**
	 * Ask for images. Answers at once with the queued job (its `pacePerMinute` and
	 * `schedule` say when it will run); follow it with `watchJob`.
	 */
	async createJob(request: CreateJobRequest, options: CreateJobOptions = {}): Promise<CreatedJob> {
		const idempotencyKey = options.idempotencyKey ?? randomKey();
		const envelope = await this.requestEnvelope<CreatedJob | {job: CreatedJob; replay?: boolean}>({
			method: 'POST', path: '/jobs', json: request, idempotencyKey, retry: idempotencyKey ? 'always' : 'never',
		});
		const data = envelope.data as CreatedJob & {job?: CreatedJob; replay?: boolean};
		// The job is `data` (api.md §4); a `{ job }` wrapper is accepted too.
		const job: CreatedJob = data && !data._id && data.job ? {...data.job} : {...data};
		if (data?.replay === true || envelope.replay === true) job.replay = true;
		return job;
	}

	/** The job, with the images made so far (presigned URLs). Only jobs this session created. */
	async getJob(jobId: string): Promise<JobWithImages> {
		return this.fetchJob(jobId);
	}

	/** Stop the job: waiting images are cancelled; one already being made still finishes. */
	async cancelJob(jobId: string): Promise<Job> {
		return this.request<Job>({method: 'POST', path: `/jobs/${encodeURIComponent(jobId)}/cancel`, retry: 'always'});
	}

	/**
	 * Poll a job until it ends. Each new image is passed to `onImage` once, in `seq`
	 * order. Polls start at `intervalMs` (2 s), slow down to `maxIntervalMs` (10 s)
	 * while nothing changes, and speed up again when something does. Watching stops
	 * after `onDone`, after `onError`, or when you call the returned function.
	 */
	watchJob(jobId: string, options: WatchJobOptions = {}): () => void {
		const first = Math.max(250, options.intervalMs ?? 2_000);
		const longest = Math.max(first, options.maxIntervalMs ?? 10_000);
		const seen = new Set<string>();
		const controller = new AbortController();
		let lastState = '';
		let delay = first;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const stop = (): void => {
			if (stopped) return;
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			controller.abort();
		};

		const poll = async (): Promise<void> => {
			let answer: JobWithImages;
			try {
				answer = await this.fetchJob(jobId, controller.signal);
			} catch (error) {
				if (stopped) return;
				stop();
				callback(options.onError, toImagineError(error));
				return;
			}
			if (stopped) return;

			const {images, ...job} = answer;
			const fresh = images.filter(image => image && !seen.has(image._id)).sort((a, b) => a.seq - b.seq);
			for (const image of fresh) {
				seen.add(image._id);
				callback(options.onImage, image);
				if (stopped) return;
			}
			const state = JSON.stringify(job);
			const changed = state !== lastState;
			if (changed) {
				lastState = state;
				callback(options.onProgress, job);
				if (stopped) return;
			}
			if (TERMINAL.includes(job.status)) {
				stop();
				callback(options.onDone, job);
				return;
			}
			delay = changed || fresh.length ? first : Math.min(longest, Math.round(delay * 1.5));
			timer = setTimeout(() => void poll(), delay);
		};

		void poll();
		return stop;
	}

	// ── Session token ───────────────────────────────────────────────────────

	private currentToken(): Promise<string> {
		if (this.pendingToken) return this.pendingToken;
		const token = this.token;
		if (token && (token.expiresAt === null || Date.now() < token.expiresAt - REFRESH_MARGIN_MS)) {
			return Promise.resolve(token.value);
		}
		this.pendingToken = this.loadToken().finally(() => {
			this.pendingToken = null;
		});
		return this.pendingToken;
	}

	private async loadToken(): Promise<string> {
		this.token = null;
		let result: SessionTokenResult;
		try {
			result = await this.getSessionToken();
		} catch (cause) {
			throw new ImagineError('SESSION_TOKEN_FAILED',
				`getSessionToken() failed: ${(cause as Error)?.message || String(cause)}`, {cause});
		}
		const value = typeof result === 'string' ? result : result?.token;
		if (typeof value !== 'string' || !value.trim()) {
			throw new ImagineError('SESSION_TOKEN_FAILED', 'getSessionToken() returned no token.');
		}
		const token = value.trim();
		const expiresAt = typeof result === 'object' && result?.expiresAt ? Date.parse(result.expiresAt) : NaN;
		if (Number.isFinite(expiresAt)) {
			this.token = {value: token, expiresAt};
			return token;
		}
		// Only the token was given: read its expiry from the session (api.md §11.1).
		// If that read fails, the token is still used; blooms.ai says when it expires.
		this.token = {value: token, expiresAt: null};
		try {
			const session = await this.attempt<Session>({method: 'GET', path: '/session', retry: 'never'}, token);
			this.noteExpiry(token, session.data?.expiresAt);
			this.probe = {token, session: session.data, at: Date.now()};
		} catch {
			// Ignored on purpose; see above.
		}
		return token;
	}

	private noteExpiry(token: string, expiresAt: string | undefined): void {
		const at = expiresAt ? Date.parse(expiresAt) : NaN;
		if (this.token?.value === token && Number.isFinite(at)) this.token = {value: token, expiresAt: at};
	}

	// ── Transport ───────────────────────────────────────────────────────────

	/** @internal test seam */
	_setSleep(sleep: Sleep): void {
		this.sleep = sleep;
	}

	private async fetchJob(jobId: string, signal?: AbortSignal): Promise<JobWithImages> {
		const job = await this.request<JobWithImages>({
			method: 'GET', path: `/jobs/${encodeURIComponent(jobId)}`, retry: 'always', signal,
		});
		return {...job, images: Array.isArray(job?.images) ? job.images : []};
	}

	private async request<T>(spec: RequestSpec): Promise<T> {
		return (await this.requestEnvelope<T>(spec)).data;
	}

	/** One call: with the current token, and once more with a new one after `SESSION_EXPIRED`. */
	private async requestEnvelope<T>(spec: RequestSpec): Promise<Envelope<T>> {
		const token = await this.currentToken();
		try {
			return await this.attempt<T>(spec, token);
		} catch (error) {
			if (!(isImagineError(error) && error.status === 401 && error.code === 'SESSION_EXPIRED')) throw error;
			if (this.token?.value === token) this.token = null;
			const next = await this.currentToken();
			return this.attempt<T>(spec, next);
		}
	}

	/** The retry loop for one token. */
	private async attempt<T>(spec: RequestSpec, token: string): Promise<Envelope<T>> {
		const fetchImpl = this.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
		if (!fetchImpl) throw new ImagineError('NO_FETCH', 'No fetch is available in this environment.');
		const url = `${this.base}${API_PATH}${spec.path}`;
		const headers: Record<string, string> = {Authorization: `Bearer ${token}`, Accept: 'application/json'};
		if (spec.json !== undefined) headers['Content-Type'] = 'application/json';
		if (spec.idempotencyKey) headers['Idempotency-Key'] = spec.idempotencyKey;
		const json = spec.json === undefined ? undefined : JSON.stringify(spec.json);

		for (let attempt = 0; ; attempt++) {
			if (spec.signal?.aborted) throw aborted();
			const controller = new AbortController();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, spec.timeoutMs ?? this.timeoutMs);
			const onAbort = (): void => controller.abort();
			spec.signal?.addEventListener('abort', onAbort, {once: true});

			let response: Response;
			let parsed: Envelope<T> | null = null;
			try {
				response = await fetchImpl.call(globalThis, url, {
					method: spec.method, headers, body: spec.form ? spec.form() : json, signal: controller.signal,
				});
				try {
					parsed = await response.json();
				} catch (bodyError) {
					// A body cut off by the timeout or a stop is that, not a bad answer.
					if (timedOut || spec.signal?.aborted) throw bodyError;
					parsed = null;
				}
			} catch (cause) {
				if (spec.signal?.aborted) throw aborted();
				if (spec.retry === 'always' && attempt < this.maxRetries) {
					await this.sleep(backoff(attempt), spec.signal);
					continue;
				}
				throw new ImagineError(timedOut ? 'TIMEOUT' : 'NETWORK_FAILURE',
					timedOut ? 'blooms.ai did not answer in time.' : `Could not reach blooms.ai: ${(cause as Error)?.message || String(cause)}`,
					{cause});
			} finally {
				clearTimeout(timer);
				spec.signal?.removeEventListener('abort', onAbort);
			}

			if (response.ok && parsed && parsed.success === true) return parsed;

			const code = parsed && typeof parsed === 'object' && typeof parsed.code === 'string' ? parsed.code : undefined;
			const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
			const waitMs = retryAfter === undefined ? null : retryAfter * 1000;
			const transient = RETRY_STATUSES.has(response.status)
				|| (response.status === 409 && code === 'IDEMPOTENCY_IN_PROGRESS' && Boolean(spec.idempotencyKey));
			const allowed = spec.retry === 'always' || (spec.retry === 'refused' && response.status === 429);
			if (transient && allowed && attempt < this.maxRetries && (waitMs === null || waitMs <= this.maxRetryWaitMs)) {
				await this.sleep(waitMs ?? backoff(attempt), spec.signal);
				continue;
			}

			if (!parsed || typeof parsed !== 'object') {
				throw new ImagineError('BAD_RESPONSE', `blooms.ai answered HTTP ${response.status} without its usual JSON.`,
					{status: response.status, retryAfter});
			}
			const {success: _s, code: _c, message, data: _d, ...rest} = parsed;
			throw new ImagineError(code ?? `HTTP_${response.status}`,
				typeof message === 'string' && message ? message : `Request failed (HTTP ${response.status}).`, {
					status: response.status,
					retryAfter,
					details: Object.keys(rest).length ? rest : undefined,
				});
		}
	}
}

/** 0.5 s, 1 s, 2 s, 4 s … plus up to 25% jitter, capped at 10 s. */
function backoff(attempt: number): number {
	const base = Math.min(10_000, 500 * 2 ** attempt);
	return Math.round(base * (1 + Math.random() * 0.25));
}

/** `Retry-After` in seconds: a number of seconds, or an HTTP date. */
function parseRetryAfter(header: string | null): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds;
	const at = Date.parse(header);
	if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
	return undefined;
}

function randomKey(): string | undefined {
	const c = (globalThis as {crypto?: {randomUUID?: () => string}}).crypto;
	return typeof c?.randomUUID === 'function' ? c.randomUUID() : undefined;
}

/** Duck-typed, so a Blob from another realm (an iframe, a test DOM) passes too. */
function isBlob(value: unknown): value is Blob {
	const v = value as Partial<Blob> | null;
	return typeof v === 'object' && v !== null && typeof v.size === 'number' && typeof v.type === 'string'
		&& typeof v.slice === 'function';
}

function fileName(file: Blob, index: number): string {
	const name = (file as {name?: unknown}).name;
	if (typeof name === 'string' && name) return name;
	const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png';
	return `image-${index + 1}.${ext}`;
}

function toImagineError(error: unknown): ImagineError {
	if (isImagineError(error)) return error;
	return new ImagineError('UNEXPECTED', (error as Error)?.message || String(error), {cause: error});
}

/** Runs a caller's callback; a throw is logged and does not stop watching. */
function callback<T>(fn: ((value: T) => void) | undefined, value: T): void {
	if (!fn) return;
	try {
		fn(value);
	} catch (error) {
		console.error('imagine.js: a watchJob callback threw', error);
	}
}
