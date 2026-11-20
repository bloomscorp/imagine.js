/**
 * The shapes of the Imagine browser API (blooms.ai documentation/imagine/api.md §4–§6).
 *
 * This module holds types only. The Angular and React wrappers re-export it, so an
 * app never has to import the core just for a type.
 */

import type {ImagineError} from './error';

// ── Options ────────────────────────────────────────────────────────────────

/**
 * What `getSessionToken()` may return: the token alone, or the whole answer of
 * `imagine.sessions.create()` on your backend. With `expiresAt` the client knows
 * when to ask again without one extra request.
 */
export type SessionTokenResult = string | {token: string; expiresAt?: string | null};

export interface ImagineBrowserOptions {
	/**
	 * Asks your backend for a session token (`ims_…`). Called lazily: on the first
	 * call, 30 seconds before the token expires, and once more when blooms.ai answers
	 * `SESSION_EXPIRED`.
	 */
	getSessionToken: () => SessionTokenResult | Promise<SessionTokenResult>;
	/** Default `https://z.bloomscorp.com`. */
	baseUrl?: string;
	/** Per attempt. Default 30 000 ms. */
	timeoutMs?: number;
	/** Per attempt, for `uploadReferences`. Default 120 000 ms. */
	uploadTimeoutMs?: number;
	/** Retries for 429, 5xx and network errors. Default 3. */
	maxRetries?: number;
	/** A longer `Retry-After` is thrown (with `retryAfter`), not waited out. Default 60 000 ms. */
	maxRetryWaitMs?: number;
	/** A `fetch` to use instead of the global one (tests, or an instrumented fetch). */
	fetch?: typeof fetch;
}

export interface CreateJobOptions {
	/**
	 * Sent as `Idempotency-Key` (at most 200 characters). The same key and body within
	 * 24 hours returns the original job. One is made for you when the browser has
	 * `crypto.randomUUID`; without a key, a create is never retried.
	 */
	idempotencyKey?: string;
}

export interface WatchJobOptions {
	/** Called with the first answer, then whenever the job changes. */
	onProgress?: (job: Job) => void;
	/** Called once for each new image, in `seq` order. */
	onImage?: (image: Image) => void;
	/** Called once when the job is completed, failed or cancelled. Watching then stops. */
	onDone?: (job: Job) => void;
	/** Called once with the error that stopped watching (after the request's own retries). */
	onError?: (error: ImagineError) => void;
	/** The first wait between polls. Default 2 000 ms. */
	intervalMs?: number;
	/** The longest wait between polls. Default 10 000 ms. */
	maxIntervalMs?: number;
}

// ── Jobs ───────────────────────────────────────────────────────────────────

export type JobMode = 'prompt' | 'product' | 'edit' | 'batch';
export type JobSource = 'ui' | 'api' | 'browser';
export type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
export type PauseReason =
	| 'user' | 'daily_limit' | 'monthly_limit' | 'storage' | 'credential' | 'disabled' | 'destination';

export interface JobCounts {
	total: number;
	done: number;
	failed: number;
	cancelled: number;
}

export interface JobSchedule {
	acceptedAt: string | null;
	startsAt: string | null;
	finishesAt: string | null;
}

export interface JobEstimate {
	usdPerImage: number | null;
	usd: number | null;
}

export interface JobNotify {
	webhookId: string | null;
	everyImages: number;
	everyMinutes: number;
}

/** The public job shape (api.md §4). */
export interface Job {
	_id: string;
	name: string;
	mode: JobMode;
	source: JobSource;
	status: JobStatus;
	pauseReason: PauseReason | null;
	counts: JobCounts;
	credentialId: string | null;
	model: string | null;
	pacePerMinute: number;
	schedule: JobSchedule;
	estimate: JobEstimate | null;
	destinationId?: string | null;
	keepCopy?: boolean;
	notify?: JobNotify | null;
	externalRef: string | null;
	externalUser?: string | null;
	sessionId?: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	lastError: string | null;
}

/** `GET /browser/jobs/:jobId`: the job with the images made so far. */
export interface JobWithImages extends Job {
	images: Image[];
}

/** `POST /browser/jobs`: the job; `replay` is true when an idempotency key returned an earlier job. */
export interface CreatedJob extends Job {
	replay?: boolean;
}

// ── Images and references ──────────────────────────────────────────────────

export interface ImageDestination {
	destinationId: string;
	bucket: string;
	key: string;
}

/** The public image shape (api.md §4). */
export interface Image {
	_id: string;
	jobId: string;
	seq: number;
	externalRef: string | null;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
	prompt: string;
	model: string;
	aspectRatio: string | null;
	estUsd: number | null;
	/** Presigned, short-lived. `null` when the job delivered to a destination with `keepCopy: false`. */
	url: string | null;
	thumbUrl: string | null;
	destination?: ImageDestination | null;
	createdAt: string;
}

/** An uploaded product photo or image to edit (`POST /browser/references`). */
export interface Reference {
	_id: string;
	name: string;
	mimeType: string;
	width: number;
	height: number;
}

// ── Requests (recipes) ─────────────────────────────────────────────────────

/** Fields every recipe may carry. The session may pin the credential and model. */
export interface RecipeCommon {
	credentialId?: string;
	model?: string;
	/** A style preset id (`presets.styles`), e.g. `studio`. */
	style?: string;
	/** An aspect ratio id (`presets.aspectRatios`), e.g. `4:5`. */
	aspectRatio?: string;
	/** At most 120 characters. */
	name?: string;
	/** Your own reference, at most 200 characters, kept on the job. */
	externalRef?: string;
}

/** A prompt, `count` times. */
export interface PromptRecipe extends RecipeCommon {
	mode: 'prompt';
	/** At most 5 000 characters. */
	prompt: string;
	count?: number;
	referenceIds?: string[];
}

/** Product photos (1–5 `referenceIds`) × shot types × `perShot`. */
export interface ProductRecipe extends RecipeCommon {
	mode: 'product';
	productName: string;
	productDetails?: string;
	/** Product shot ids (`presets.productShots`), e.g. `white`, `angle`, `lifestyle`. */
	shots: string[];
	/** 1–10. */
	perShot?: number;
	referenceIds: string[];
}

/** Change an image: one uploaded reference, or an image Imagine made (`sourceImageId`). */
export interface EditRecipe extends RecipeCommon {
	mode: 'edit';
	/** The instruction. */
	prompt: string;
	sourceImageId?: string;
	referenceIds?: string[];
	/** Variants, 1–10. */
	count?: number;
}

/** One prompt per line, or CSV `prompt[,aspect_ratio][,count]` when `csv` is true. */
export interface BatchRecipe extends RecipeCommon {
	mode: 'batch';
	text: string;
	csv?: boolean;
	referenceIds?: string[];
}

/** A browser job is always a recipe: no `items[]`, destinations or webhooks (api.md §5). */
export type CreateJobRequest = PromptRecipe | ProductRecipe | EditRecipe | BatchRecipe;

// ── Session and presets ────────────────────────────────────────────────────

export interface AspectRatioPreset {
	id: string;
	label: string;
	hint?: string;
}

export interface StylePreset {
	id: string;
	label: string;
	emoji?: string;
}

export interface ProductShotPreset {
	id: string;
	label: string;
	emoji?: string;
}

export interface PresetLimits {
	PROMPT_MAX: number;
	DETAILS_MAX: number;
	REFS_PER_ITEM: number;
	REF_MAX_BYTES: number;
	REF_MIME: string[];
	EDIT_VARIANTS_MAX: number;
	PER_SHOT_MAX: number;
	BATCH_LINES_MAX: number;
}

export interface Presets {
	aspectRatios: AspectRatioPreset[];
	styles: StylePreset[];
	productShots: ProductShotPreset[];
	limits: PresetLimits;
}

export interface ImagineModel {
	id: string;
	label: string;
	/** List price of one image, when known. */
	priceUsdPerImage?: number | null;
	note?: string;
}

/** `GET /browser/session`: what this session may do. */
export interface Session {
	expiresAt: string;
	modes: JobMode[];
	maxImages: number;
	imagesUsed: number;
	models: ImagineModel[];
	presets: Presets;
}
