import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';

/**
 * A local fake of the blooms.ai browser API (api.md §5): nothing leaves the machine.
 *
 * It keeps sessions, jobs and images in memory and answers like the real server,
 * envelope and error codes included. Tests can queue faults (a status, headers, a
 * dropped connection) that are served before the real answer.
 *
 * It runs in-process as a `fetch` (so fake timers drive everything), or on a real
 * socket with `listen()` when a test wants to see the bytes on the wire.
 */

export interface Seen {
	method: string;
	path: string;
	headers: Headers;
	json?: any;
	form?: FormData;
}

export type Fault =
	| {status: number; body?: unknown; headers?: Record<string, string>}
	| 'network';

// Ids from a counter, not Math.random: the tests pin Math.random to remove jitter.
let counter = 0;
const hex = (n: number) => (++counter).toString(16).padStart(n, '0');

export class FakeImagine {
	readonly seen: Seen[] = [];
	readonly faults: Fault[] = [];
	/** token → expiry (ms since epoch). */
	readonly tokens = new Map<string, number>();
	readonly jobs = new Map<string, any>();
	readonly images = new Map<string, any[]>();
	readonly idempotency = new Map<string, string>();
	minted = 0;

	/** Mint a token the way the backend would (`imagine.sessions.create`). */
	mint(ttlSeconds = 900): {token: string; expiresAt: string} {
		const token = `ims_${hex(64)}`;
		const expires = Date.now() + ttlSeconds * 1000;
		this.tokens.set(token, expires);
		this.minted++;
		return {token, expiresAt: new Date(expires).toISOString()};
	}

	expire(token: string): void {
		this.tokens.set(token, Date.now() - 1);
	}

	/** Add a job directly, as if a session had created it. */
	addJob(fields: Record<string, unknown> = {}): any {
		const _id = hex(24);
		const job = {
			_id, name: 'Prompt · A mug', mode: 'prompt', source: 'browser', status: 'queued', pauseReason: null,
			counts: {total: 3, done: 0, failed: 0, cancelled: 0}, credentialId: hex(24), model: 'gemini-3.1-flash-image',
			pacePerMinute: 5, schedule: {acceptedAt: new Date().toISOString(), startsAt: null, finishesAt: null},
			estimate: {usdPerImage: 0.067, usd: 0.2}, externalRef: null, createdAt: new Date().toISOString(),
			startedAt: null, finishedAt: null, lastError: null, ...fields,
		};
		this.jobs.set(_id, job);
		this.images.set(_id, []);
		return job;
	}

	/** The worker made one more image. */
	addImage(jobId: string): any {
		const job = this.jobs.get(jobId);
		const list = this.images.get(jobId)!;
		const image = {
			_id: hex(24), jobId, seq: list.length, externalRef: null, mimeType: 'image/png', bytes: 1000,
			width: 1024, height: 1024, prompt: 'A mug', model: job.model, aspectRatio: '1:1', estUsd: 0.067,
			url: `https://s3.example/${list.length}.png`, thumbUrl: null, createdAt: new Date().toISOString(),
		};
		list.push(image);
		job.status = 'running';
		job.counts.done++;
		if (job.counts.done + job.counts.failed + job.counts.cancelled >= job.counts.total) {
			job.status = 'completed';
			job.finishedAt = new Date().toISOString();
		}
		return image;
	}

	/** As a `fetch`. */
	readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input as any, init);
		const fault = this.faults.shift();
		await this.record(request);
		if (fault === 'network') throw new TypeError('fetch failed');
		if (fault) return json(fault.status, fault.body ?? {success: false, code: 'FAULT', message: 'fault'}, fault.headers);
		return this.answer(request);
	};

	private async record(request: Request): Promise<void> {
		const url = new URL(request.url);
		const entry: Seen = {method: request.method, path: url.pathname, headers: request.headers};
		const type = request.headers.get('content-type') ?? '';
		const copy = request.clone();
		if (type.startsWith('multipart/form-data')) entry.form = await copy.formData();
		else if (type.includes('json')) entry.json = await copy.json();
		this.seen.push(entry);
	}

	private async answer(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.replace(/^\/api\/v1\/imagine\/browser/, '');
		const auth = request.headers.get('authorization') ?? '';
		const token = auth.replace(/^Bearer /, '');
		if (!this.tokens.has(token)) return fail(401, 'SESSION_INVALID', 'Unknown session');
		if (this.tokens.get(token)! < Date.now()) return fail(401, 'SESSION_EXPIRED', 'The session has expired');

		if (request.method === 'GET' && path === '/session') {
			return ok({
				expiresAt: new Date(this.tokens.get(token)!).toISOString(), modes: ['prompt', 'product', 'edit'],
				maxImages: 20, imagesUsed: 0, models: [{id: 'gemini-3.1-flash-image', label: 'Nano Banana 2'}],
				presets: {aspectRatios: [{id: '1:1', label: 'Square'}], styles: [], productShots: [], limits: {}},
			});
		}
		if (request.method === 'POST' && path === '/references') {
			const form = await request.formData();
			const files = form.getAll('images') as File[];
			if (!files.length) return fail(400, 'VALIDATION_ERROR', 'No images');
			return ok(files.map(f => ({_id: hex(24), name: f.name, mimeType: f.type, width: 10, height: 10})), 201);
		}
		if (request.method === 'POST' && path === '/jobs') {
			const body = await request.json();
			const key = request.headers.get('idempotency-key');
			if (key && this.idempotency.has(key)) return ok({...this.jobs.get(this.idempotency.get(key)!), replay: true}, 200);
			if (!body.prompt && body.mode === 'prompt') return fail(400, 'PROMPT_REQUIRED', 'Write a prompt');
			const job = this.addJob({mode: body.mode, counts: {total: body.count ?? 1, done: 0, failed: 0, cancelled: 0}});
			if (key) this.idempotency.set(key, job._id);
			return ok(job, 202);
		}
		const jobMatch = /^\/jobs\/([^/]+)(\/cancel)?$/.exec(path);
		if (jobMatch) {
			const job = this.jobs.get(decodeURIComponent(jobMatch[1]!));
			if (!job) return fail(404, 'NOT_FOUND', 'Not found');
			if (request.method === 'GET' && !jobMatch[2]) return ok({...job, images: [...this.images.get(job._id)!]});
			if (request.method === 'POST' && jobMatch[2]) {
				job.status = 'cancelled';
				job.counts.cancelled = job.counts.total - job.counts.done - job.counts.failed;
				return ok(job);
			}
		}
		return fail(404, 'NOT_FOUND', 'No such route');
	}

	/** Serve on a real local socket. */
	async listen(): Promise<{base: string; close: () => Promise<void>}> {
		const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const chunks: Buffer[] = [];
			req.on('data', c => chunks.push(c));
			req.on('end', async () => {
				const headers = new Headers();
				for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
				const body = chunks.length && req.method !== 'GET' ? Buffer.concat(chunks) : undefined;
				try {
					const response = await this.fetch(`http://local${req.url}`, {method: req.method, headers, body});
					res.writeHead(response.status, Object.fromEntries(response.headers));
					res.end(Buffer.from(await response.arrayBuffer()));
				} catch {
					req.socket.destroy();
				}
			});
		});
		await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		return {base, close: () => new Promise<void>(r => server.close(() => r()))};
	}
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
		status, headers: {'Content-Type': 'application/json', ...headers},
	});
}

const ok = (data: unknown, status = 200) => json(status, {success: true, data, message: 'OK'});
const fail = (status: number, code: string, message: string) => json(status, {success: false, code, message});
