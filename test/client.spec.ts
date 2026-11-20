import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

import {ImagineBrowser, ImagineError, isImagineError} from '../src';
import {FakeImagine} from './fake-imagine';

/**
 * The client against a local fake of blooms.ai (fake-imagine.ts). Timers are fake,
 * so every wait is checked to the millisecond and nothing depends on the clock.
 */

const BASE = 'https://z.test';
const API = '/api/v1/imagine/browser';

function setup(options: Partial<ConstructorParameters<typeof ImagineBrowser>[0]> = {}) {
	const fake = new FakeImagine();
	const getSessionToken = vi.fn(async () => fake.mint());
	const imagine = new ImagineBrowser({getSessionToken, baseUrl: BASE, fetch: fake.fetch, ...options});
	return {fake, imagine, getSessionToken};
}

/** Let pending promises run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	// setImmediate stays real: undici parses multipart bodies with it.
	vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
	vi.spyOn(Math, 'random').mockReturnValue(0);   // no jitter: backoff is exactly 500, 1000, 2000 ms
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('session tokens', () => {
	test('getSessionToken is called lazily, once, and the token is sent as a bearer', async () => {
		const {fake, imagine, getSessionToken} = setup();
		expect(getSessionToken).not.toHaveBeenCalled();
		const job = fake.addJob();
		await imagine.getJob(job._id);
		await imagine.getJob(job._id);
		await imagine.session();
		expect(getSessionToken).toHaveBeenCalledTimes(1);
		const [token] = [...fake.tokens.keys()];
		expect(fake.seen.map(s => s.headers.get('authorization'))).toEqual([`Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`]);
		expect(fake.seen[0]!.path).toBe(`${API}/jobs/${job._id}`);
	});

	test('calls made together share one getSessionToken', async () => {
		const {fake, imagine, getSessionToken} = setup();
		const job = fake.addJob();
		await Promise.all([imagine.getJob(job._id), imagine.getJob(job._id), imagine.session()]);
		expect(getSessionToken).toHaveBeenCalledTimes(1);
	});

	test('a bare token: its expiry is read from GET /browser/session, and that read answers session()', async () => {
		const fake = new FakeImagine();
		const getSessionToken = vi.fn(async () => fake.mint(60).token);
		const imagine = new ImagineBrowser({getSessionToken, baseUrl: BASE, fetch: fake.fetch});
		const session = await imagine.session();
		expect(session.maxImages).toBe(20);
		expect(fake.seen.map(s => `${s.method} ${s.path}`)).toEqual([`GET ${API}/session`]);

		// 60 s token: still good at 29 s, renewed from 30 s before expiry.
		const job = fake.addJob();
		await vi.advanceTimersByTimeAsync(29_000);
		await imagine.getJob(job._id);
		expect(getSessionToken).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(2_000);
		await imagine.getJob(job._id);
		expect(getSessionToken).toHaveBeenCalledTimes(2);
	});

	test('a token is renewed 30 s before the expiresAt the backend returned', async () => {
		const {fake, imagine, getSessionToken} = setup();
		getSessionToken.mockImplementation(async () => fake.mint(120));
		const job = fake.addJob();
		await imagine.getJob(job._id);
		await vi.advanceTimersByTimeAsync(89_000);
		await imagine.getJob(job._id);
		expect(getSessionToken).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1_000);
		await imagine.getJob(job._id);
		expect(getSessionToken).toHaveBeenCalledTimes(2);
		// No GET /session was needed: the expiry came with the token.
		expect(fake.seen.filter(s => s.path.endsWith('/session'))).toHaveLength(0);
	});

	test('SESSION_EXPIRED: a new token is fetched once and the call is retried', async () => {
		const {fake, imagine, getSessionToken} = setup();
		const job = fake.addJob();
		await imagine.getJob(job._id);
		const [first] = [...fake.tokens.keys()];
		fake.expire(first!);   // revoked early on the server; the client still thinks it is good
		const again = await imagine.getJob(job._id);
		expect(again._id).toBe(job._id);
		expect(getSessionToken).toHaveBeenCalledTimes(2);
		const auths = fake.seen.map(s => s.headers.get('authorization'));
		expect(auths[1]).toBe(`Bearer ${first}`);
		expect(auths[2]).not.toBe(`Bearer ${first}`);
	});

	test('SESSION_EXPIRED twice in a row is thrown, after one refresh only', async () => {
		const {fake, imagine, getSessionToken} = setup();
		getSessionToken.mockImplementation(async () => {
			const minted = fake.mint();
			fake.expire(minted.token);
			return minted;
		});
		const error = await imagine.getJob('x').catch(e => e);
		expect(error).toBeInstanceOf(ImagineError);
		expect(error).toMatchObject({status: 401, code: 'SESSION_EXPIRED'});
		expect(getSessionToken).toHaveBeenCalledTimes(2);
		expect(fake.seen).toHaveLength(2);
	});

	test('other 401s do not fetch a new token', async () => {
		const {fake, imagine, getSessionToken} = setup();
		getSessionToken.mockResolvedValue({token: 'ims_unknown', expiresAt: new Date(Date.now() + 600_000).toISOString()});
		const error = await imagine.getJob('x').catch(e => e);
		expect(error).toMatchObject({status: 401, code: 'SESSION_INVALID'});
		expect(getSessionToken).toHaveBeenCalledTimes(1);
		expect(fake.seen).toHaveLength(1);
	});

	test('a failing getSessionToken is SESSION_TOKEN_FAILED, and the next call asks again', async () => {
		const {fake, imagine, getSessionToken} = setup();
		getSessionToken.mockRejectedValueOnce(new Error('backend down'));
		const error = await imagine.session().catch(e => e);
		expect(error).toMatchObject({code: 'SESSION_TOKEN_FAILED', status: 0});
		expect(error.message).toContain('backend down');
		await expect(imagine.session()).resolves.toMatchObject({maxImages: 20});
		expect(getSessionToken).toHaveBeenCalledTimes(2);
		expect(fake.seen).toHaveLength(1);
	});

	test('an empty token is refused before any request', async () => {
		const {fake, imagine, getSessionToken} = setup();
		getSessionToken.mockResolvedValue('' as any);
		await expect(imagine.session()).rejects.toMatchObject({code: 'SESSION_TOKEN_FAILED'});
		expect(fake.seen).toHaveLength(0);
	});
});

describe('retries', () => {
	test('5xx is retried with exponential backoff, then succeeds', async () => {
		const {fake, imagine} = setup();
		const job = fake.addJob();
		fake.faults.push({status: 503}, {status: 502, body: 'Bad gateway'});
		const result = imagine.getJob(job._id);
		await flush();
		expect(fake.seen).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(499);
		expect(fake.seen).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.seen).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(999);
		expect(fake.seen).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toMatchObject({_id: job._id, images: []});
		expect(fake.seen).toHaveLength(3);
	});

	test('jitter adds up to 25% to each wait', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.999);
		const {fake, imagine} = setup();
		const job = fake.addJob();
		fake.faults.push({status: 500});
		const result = imagine.getJob(job._id);
		await vi.advanceTimersByTimeAsync(624);
		expect(fake.seen).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await result;
		expect(fake.seen).toHaveLength(2);
	});

	test('429 waits exactly Retry-After', async () => {
		const {fake, imagine} = setup();
		const job = fake.addJob();
		fake.faults.push({status: 429, body: {success: false, code: 'RATE_LIMITED', message: 'Slow down'}, headers: {'Retry-After': '7'}});
		const result = imagine.getJob(job._id);
		await vi.advanceTimersByTimeAsync(6_999);
		expect(fake.seen).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await result;
		expect(fake.seen).toHaveLength(2);
	});

	test('Retry-After as an HTTP date is honoured', async () => {
		const {fake, imagine} = setup();
		const job = fake.addJob();
		fake.faults.push({status: 503, headers: {'Retry-After': new Date(Date.now() + 4_000).toUTCString()}});
		const result = imagine.getJob(job._id);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(fake.seen).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1_000);
		await result;
		expect(fake.seen).toHaveLength(2);
	});

	test('a Retry-After longer than maxRetryWaitMs is thrown with retryAfter, not waited out', async () => {
		const {fake, imagine} = setup();
		fake.faults.push({status: 429, body: {success: false, code: 'RATE_LIMITED', message: 'Slow down'}, headers: {'Retry-After': '3600'}});
		const error = await imagine.getJob('x').catch(e => e);
		expect(error).toMatchObject({status: 429, code: 'RATE_LIMITED', retryAfter: 3600, message: 'Slow down'});
		expect(fake.seen).toHaveLength(1);
	});

	test('network errors: 3 retries, then NETWORK_FAILURE', async () => {
		const {fake, imagine} = setup();
		fake.faults.push('network', 'network', 'network', 'network');
		const result = imagine.getJob('x').catch(e => e);
		await vi.advanceTimersByTimeAsync(500 + 1_000 + 2_000);
		const error = await result;
		expect(error).toMatchObject({code: 'NETWORK_FAILURE', status: 0});
		expect(fake.seen).toHaveLength(4);
	});

	test('maxRetries: 0 turns retries off', async () => {
		const {fake, imagine} = setup({maxRetries: 0});
		fake.faults.push({status: 503});
		await expect(imagine.getJob('x')).rejects.toMatchObject({status: 503});
		expect(fake.seen).toHaveLength(1);
	});

	test('a slow answer is TIMEOUT', async () => {
		const fake = new FakeImagine();
		let calls = 0;
		const hang: typeof fetch = (_url, init) => {
			calls++;
			return new Promise((_resolve, reject) => {
				init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			});
		};
		const imagine = new ImagineBrowser({getSessionToken: () => fake.mint(), baseUrl: BASE, fetch: hang, timeoutMs: 1_000, maxRetries: 1});
		const result = imagine.getJob('x').catch(e => e);
		await vi.advanceTimersByTimeAsync(1_000 + 500 + 1_000);
		expect(await result).toMatchObject({code: 'TIMEOUT', status: 0});
		expect(calls).toBe(2);
	});
});

describe('errors', () => {
	test('a 4xx is not retried; code, message and extra fields come through', async () => {
		const {fake, imagine} = setup();
		fake.faults.push({status: 409, body: {success: false, code: 'SESSION_LIMIT', message: 'This session has used its images', imagesUsed: 20}});
		const error = await imagine.createJob({mode: 'prompt', prompt: 'A mug'}).catch(e => e);
		expect(isImagineError(error)).toBe(true);
		expect(error.name).toBe('ImagineError');
		expect(error).toMatchObject({status: 409, code: 'SESSION_LIMIT', message: 'This session has used its images', details: {imagesUsed: 20}});
		expect(error.retryAfter).toBeUndefined();
		expect(fake.seen).toHaveLength(1);
	});

	test('the fake server\'s own validation errors pass through', async () => {
		const {imagine} = setup();
		await expect(imagine.createJob({mode: 'prompt', prompt: ''})).rejects.toMatchObject({status: 400, code: 'PROMPT_REQUIRED'});
	});

	test('an answer that is not blooms.ai JSON is BAD_RESPONSE', async () => {
		const {fake, imagine} = setup();
		fake.faults.push({status: 404, body: '<html>Not found</html>'});
		await expect(imagine.getJob('x')).rejects.toMatchObject({code: 'BAD_RESPONSE', status: 404});
	});

	test('a 2xx without success: true is an error, not data', async () => {
		const {fake, imagine} = setup();
		fake.faults.push({status: 200, body: {success: false, code: 'ODD', message: 'odd'}});
		await expect(imagine.getJob('x')).rejects.toMatchObject({code: 'ODD', status: 200});
	});

	test('getSessionToken is required', () => {
		expect(() => new ImagineBrowser({} as any)).toThrow(expect.objectContaining({code: 'SESSION_TOKEN_FAILED'}));
	});
});

describe('createJob', () => {
	test('posts the recipe with a generated Idempotency-Key', async () => {
		const {fake, imagine} = setup();
		const job = await imagine.createJob({mode: 'prompt', prompt: 'A mug on a desk', count: 4, aspectRatio: '1:1'});
		expect(job).toMatchObject({mode: 'prompt', status: 'queued', pacePerMinute: 5});
		expect(job.replay).toBeUndefined();
		const request = fake.seen[0]!;
		expect(`${request.method} ${request.path}`).toBe(`POST ${API}/jobs`);
		expect(request.headers.get('content-type')).toBe('application/json');
		expect(request.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
		expect(request.json).toEqual({mode: 'prompt', prompt: 'A mug on a desk', count: 4, aspectRatio: '1:1'});
	});

	test('a 5xx is retried with the same Idempotency-Key', async () => {
		const {fake, imagine} = setup();
		fake.faults.push({status: 503}, 'network');
		const result = imagine.createJob({mode: 'prompt', prompt: 'A mug'});
		await vi.advanceTimersByTimeAsync(500 + 1_000);
		await result;
		expect(fake.seen).toHaveLength(3);
		expect(new Set(fake.seen.map(s => s.headers.get('idempotency-key'))).size).toBe(1);
	});

	test('your own key is used, and a replay is reported', async () => {
		const {fake, imagine} = setup();
		const first = await imagine.createJob({mode: 'prompt', prompt: 'A mug'}, {idempotencyKey: 'order-42'});
		const second = await imagine.createJob({mode: 'prompt', prompt: 'A mug'}, {idempotencyKey: 'order-42'});
		expect(fake.seen.map(s => s.headers.get('idempotency-key'))).toEqual(['order-42', 'order-42']);
		expect(second._id).toBe(first._id);
		expect(second.replay).toBe(true);
	});

	test('IDEMPOTENCY_IN_PROGRESS is retried shortly', async () => {
		const {fake, imagine} = setup();
		fake.faults.push({status: 409, body: {success: false, code: 'IDEMPOTENCY_IN_PROGRESS', message: 'Still accepting'}});
		const result = imagine.createJob({mode: 'prompt', prompt: 'A mug'});
		await vi.advanceTimersByTimeAsync(500);
		await expect(result).resolves.toMatchObject({status: 'queued'});
		expect(fake.seen).toHaveLength(2);
	});

	test('IDEMPOTENCY_CONFLICT is not retried', async () => {
		const {fake, imagine} = setup();
		fake.faults.push({status: 409, body: {success: false, code: 'IDEMPOTENCY_CONFLICT', message: 'Different body'}});
		await expect(imagine.createJob({mode: 'prompt', prompt: 'A mug'})).rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
		expect(fake.seen).toHaveLength(1);
	});

	test('without crypto.randomUUID there is no key, and a create is never retried', async () => {
		vi.stubGlobal('crypto', {});
		try {
			const {fake, imagine} = setup();
			fake.faults.push({status: 503});
			await expect(imagine.createJob({mode: 'prompt', prompt: 'A mug'})).rejects.toMatchObject({status: 503});
			expect(fake.seen).toHaveLength(1);
			expect(fake.seen[0]!.headers.get('idempotency-key')).toBeNull();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test('a { job } wrapper in data is unwrapped', async () => {
		const {fake, imagine} = setup();
		const job = fake.addJob();
		fake.faults.push({status: 202, body: {success: true, data: {job, replay: false}}});
		await expect(imagine.createJob({mode: 'prompt', prompt: 'A mug'})).resolves.toMatchObject({_id: job._id});
	});
});

describe('uploadReferences', () => {
	const png = (name: string, size = 10) => new File([new Uint8Array(size)], name, {type: 'image/png'});

	test('sends multipart field "images", one part per file, over a real socket', async () => {
		vi.useRealTimers();
		const fake = new FakeImagine();
		const server = await fake.listen();
		try {
			const imagine = new ImagineBrowser({getSessionToken: () => fake.mint(), baseUrl: server.base});
			const blob = new Blob([new Uint8Array(5)], {type: 'image/webp'});
			const refs = await imagine.uploadReferences([png('front.png'), blob]);
			expect(refs.map(r => r.name)).toEqual(['front.png', 'image-2.webp']);
			const request = fake.seen[0]!;
			expect(`${request.method} ${request.path}`).toBe(`POST ${API}/references`);
			expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
			expect([...request.form!.keys()]).toEqual(['images', 'images']);
			const files = request.form!.getAll('images') as File[];
			expect(files.map(f => [f.name, f.type, f.size])).toEqual([['front.png', 'image/png', 10], ['image-2.webp', 'image/webp', 5]]);
		} finally {
			await server.close();
		}
	});

	test('limits are checked before anything is sent', async () => {
		const {fake, imagine} = setup();
		await expect(imagine.uploadReferences([])).rejects.toMatchObject({code: 'VALIDATION_ERROR', status: 0});
		await expect(imagine.uploadReferences(Array.from({length: 6}, (_, i) => png(`${i}.png`)))).rejects.toMatchObject({code: 'TOO_MANY_REFERENCES'});
		await expect(imagine.uploadReferences([png('big.png', 10 * 1024 * 1024 + 1)])).rejects.toMatchObject({code: 'TOO_LARGE'});
		await expect(imagine.uploadReferences([new File(['x'], 'a.gif', {type: 'image/gif'})])).rejects.toMatchObject({code: 'BAD_REFERENCE'});
		await expect(imagine.uploadReferences(['not a file' as any])).rejects.toMatchObject({code: 'BAD_REFERENCE'});
		expect(fake.seen).toHaveLength(0);
	});

	test('a 429 is retried (nothing was stored); a 503 is not (it may have been)', async () => {
		const {fake, imagine} = setup();
		// Multipart parsing finishes on real setImmediate, so record the waits instead of
		// racing the fake clock against it.
		const waits: number[] = [];
		imagine._setSleep(async ms => { waits.push(ms); });
		fake.faults.push({status: 429, headers: {'Retry-After': '1'}});
		await expect(imagine.uploadReferences([png('a.png')])).resolves.toHaveLength(1);
		expect(waits).toEqual([1_000]);
		expect(fake.seen).toHaveLength(2);
		expect((fake.seen[1]!.form!.get('images') as File).size).toBe(10);

		fake.faults.push({status: 503});
		await expect(imagine.uploadReferences([png('a.png')])).rejects.toMatchObject({status: 503});
		expect(fake.seen).toHaveLength(3);
	});
});

describe('jobs', () => {
	test('getJob includes images; cancelJob posts to its path', async () => {
		const {fake, imagine} = setup();
		const job = fake.addJob();
		fake.addImage(job._id);
		const got = await imagine.getJob(job._id);
		expect(got.images).toHaveLength(1);
		const cancelled = await imagine.cancelJob(job._id);
		expect(cancelled.status).toBe('cancelled');
		expect(fake.seen.map(s => `${s.method} ${s.path}`)).toEqual([`GET ${API}/jobs/${job._id}`, `POST ${API}/jobs/${job._id}/cancel`]);
	});

	test('ids are encoded into the path; a missing job is NOT_FOUND', async () => {
		const {fake, imagine} = setup();
		await expect(imagine.getJob('a/b')).rejects.toMatchObject({status: 404, code: 'NOT_FOUND'});
		expect(fake.seen[0]!.path).toBe(`${API}/jobs/a%2Fb`);
	});

	test('the base URL defaults to z.bloomscorp.com, and a trailing slash is ignored', async () => {
		const urls: string[] = [];
		const capture: typeof fetch = async (url) => {
			urls.push(String(url));
			return new Response(JSON.stringify({success: true, data: {expiresAt: new Date(Date.now() + 1e6).toISOString()}}), {status: 200});
		};
		await new ImagineBrowser({getSessionToken: () => ({token: 'ims_a', expiresAt: null}), fetch: capture}).session();
		await new ImagineBrowser({getSessionToken: () => 'ims_b', fetch: capture, baseUrl: 'https://example.test/'}).getJob('j');
		expect(urls[0]).toBe('https://z.bloomscorp.com/api/v1/imagine/browser/session');
		expect(urls.at(-1)).toBe('https://example.test/api/v1/imagine/browser/jobs/j');
	});
});
