import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

import {ImagineBrowser, type Image, type ImagineError, type Job} from '../src';
import {FakeImagine} from './fake-imagine';

/** watchJob against the fake server, with fake timers driving every poll. */

function setup() {
	const fake = new FakeImagine();
	const imagine = new ImagineBrowser({getSessionToken: () => fake.mint(), baseUrl: 'https://z.test', fetch: fake.fetch});
	const events: string[] = [];
	const images: Image[] = [];
	const progress: Job[] = [];
	const done: Job[] = [];
	const errors: ImagineError[] = [];
	const handlers = {
		onImage: (i: Image) => { images.push(i); events.push(`image ${i.seq}`); },
		onProgress: (j: Job) => { progress.push(j); events.push(`progress ${j.status} ${j.counts.done}`); },
		onDone: (j: Job) => { done.push(j); events.push(`done ${j.status}`); },
		onError: (e: ImagineError) => { errors.push(e); events.push(`error ${e.code}`); },
	};
	const polls = () => fake.seen.filter(s => s.method === 'GET' && s.path.includes('/jobs/')).length;
	return {fake, imagine, events, images, progress, done, errors, handlers, polls};
}

beforeEach(() => {
	// setImmediate stays real: undici parses multipart bodies with it.
	vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});
	vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('watchJob', () => {
	test('emits each image once, in seq order, then onDone, then stops polling', async () => {
		const t = setup();
		const job = t.fake.addJob({counts: {total: 3, done: 0, failed: 0, cancelled: 0}});
		t.imagine.watchJob(job._id, t.handlers);
		await vi.advanceTimersByTimeAsync(0);
		expect(t.events).toEqual(['progress queued 0']);

		t.fake.addImage(job._id);
		t.fake.addImage(job._id);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(t.events).toEqual(['progress queued 0', 'image 0', 'image 1', 'progress running 2']);

		// The next poll sees the same two images again: nothing is emitted twice.
		await vi.advanceTimersByTimeAsync(2_000);
		expect(t.images.map(i => i.seq)).toEqual([0, 1]);

		t.fake.addImage(job._id);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(t.events.slice(-3)).toEqual(['image 2', 'progress completed 3', 'done completed']);
		expect(t.done).toHaveLength(1);
		expect(t.done[0]).not.toHaveProperty('images');

		const after = t.polls();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(t.polls()).toBe(after);
		expect(t.errors).toHaveLength(0);
	});

	test('images arriving out of order in one answer are emitted by seq', async () => {
		const t = setup();
		const job = t.fake.addJob();
		t.fake.addImage(job._id);
		t.fake.addImage(job._id);
		t.fake.images.get(job._id)!.reverse();
		t.imagine.watchJob(job._id, t.handlers);
		await vi.advanceTimersByTimeAsync(0);
		expect(t.images.map(i => i.seq)).toEqual([0, 1]);
	});

	test('polls back off from 2 s to 10 s while nothing changes, and speed up when something does', async () => {
		const t = setup();
		const job = t.fake.addJob();
		t.imagine.watchJob(job._id, {intervalMs: 2_000});
		const at: number[] = [];
		const start = Date.now();
		let seen = 0;
		for (let ms = 0; ms <= 40_000; ms += 250) {
			if (ms === 30_000) t.fake.addImage(job._id);
			await vi.advanceTimersByTimeAsync(ms === 0 ? 0 : 250);
			while (t.polls() > seen) { seen++; at.push(Date.now() - start); }
		}
		// 0, then +2 s, +3 s, +4.5 s, +6.75 s, +10 s, +10 s … an image at 30 s is seen at
		// the 36.25 s poll, and the next wait is 2 s again.
		expect(at.slice(0, 7)).toEqual([0, 2_000, 5_000, 9_500, 16_250, 26_250, 36_250]);
		expect(at[7]).toBe(38_250);
	});

	test('stop() ends polling at once, and an answer already on its way is ignored', async () => {
		const t = setup();
		const job = t.fake.addJob();
		const stop = t.imagine.watchJob(job._id, t.handlers);
		stop();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(t.events).toEqual([]);
		expect(t.polls()).toBeLessThanOrEqual(1);
		stop();   // a second call is harmless
	});

	test('stop() between polls: no more requests', async () => {
		const t = setup();
		const job = t.fake.addJob();
		const stop = t.imagine.watchJob(job._id, t.handlers);
		await vi.advanceTimersByTimeAsync(2_000);
		const before = t.polls();
		stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(t.polls()).toBe(before);
	});

	test('stop() from inside onImage stops before the next image', async () => {
		const t = setup();
		const job = t.fake.addJob();
		t.fake.addImage(job._id);
		t.fake.addImage(job._id);
		const seqs: number[] = [];
		const stop = t.imagine.watchJob(job._id, {onImage: i => { seqs.push(i.seq); stop(); }});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(seqs).toEqual([0]);
	});

	test('a fatal error goes to onError once, and watching stops', async () => {
		const t = setup();
		t.imagine.watchJob('missing', t.handlers);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(t.events).toEqual(['error NOT_FOUND']);
		expect(t.errors[0]!.status).toBe(404);
		expect(t.polls()).toBe(1);
	});

	test('transient failures are retried inside a poll before onError is considered', async () => {
		const t = setup();
		const job = t.fake.addJob();
		t.fake.faults.push({status: 503}, 'network');
		t.imagine.watchJob(job._id, t.handlers);
		await vi.advanceTimersByTimeAsync(1_500);
		expect(t.events).toEqual(['progress queued 0']);
		expect(t.errors).toHaveLength(0);
	});

	test('a callback that throws is logged and does not stop watching', async () => {
		const t = setup();
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const job = t.fake.addJob({counts: {total: 1, done: 0, failed: 0, cancelled: 0}});
		const done = vi.fn();
		t.imagine.watchJob(job._id, {onProgress: () => { throw new Error('app bug'); }, onDone: done});
		await vi.advanceTimersByTimeAsync(0);
		t.fake.addImage(job._id);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(done).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalled();
	});

	test('a job that is already finished: its images, one progress, onDone, one request', async () => {
		const t = setup();
		const job = t.fake.addJob({counts: {total: 1, done: 0, failed: 0, cancelled: 0}});
		t.fake.addImage(job._id);
		t.imagine.watchJob(job._id, t.handlers);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(t.events).toEqual(['image 0', 'progress completed 1', 'done completed']);
		expect(t.polls()).toBe(1);
	});

	test('a cancelled job ends the watch with onDone', async () => {
		const t = setup();
		const job = t.fake.addJob();
		t.imagine.watchJob(job._id, t.handlers);
		await vi.advanceTimersByTimeAsync(0);
		await t.imagine.cancelJob(job._id);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(t.events.at(-1)).toBe('done cancelled');
	});
});
