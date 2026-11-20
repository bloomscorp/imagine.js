# @bloomscorp/imagine.js

Generate images with [Imagine](https://bloomscorp.com) from a web page.

Imagine is the AI image generator of blooms.ai. This library is the browser side: a
page asks for images, watches them arrive, and shows them. It works with any
framework, or none. For Angular use `@bloomscorp/ngx-imagine`; for React,
`@bloomscorp/react-imagine`. Both are built on this one.

- **No API key in the browser.** Your backend mints a short-lived session token and
  the page uses that. The token can do only what your backend allowed: how many
  images, which modes, from which origins.
- **Tokens renewed for you.** Fetched when first needed, renewed 30 seconds before
  they expire, and fetched again once if blooms.ai says one has expired.
- **Retries for you** on network errors, `429` and `5xx`, honouring `Retry-After`.
  A create carries an idempotency key, so a retry never makes a second job.
- **Watching built in.** `watchJob` polls, passes each new image once, and stops.
- **One error type**, `ImagineError`, with a `code` to branch on.
- Typed, ESM and CommonJS, a `<script>` build, no dependencies.

## Install

```bash
npm install @bloomscorp/imagine.js
```

Or with a script tag, which defines the global `BloomsImagine`:

```html
<script src="https://cdn.jsdelivr.net/npm/@bloomscorp/imagine.js@0.1.0/dist/imagine.global.js"></script>
```

## Quick start

### 1. Your backend mints a session token

With the Node library and an API key that has the **`imagine`** scope (Project
Settings → API keys). The key stays on your server.

```ts
import express from 'express';
import {Imagine} from '@bloomscorp/imagine-node';

const imagine = new Imagine({apiKey: process.env.BLOOMS_API_KEY!});
const app = express();

app.post('/imagine-session', requireLogin, async (req, res) => {
	const session = await imagine.sessions.create({
		ttlSeconds: 900,                          // 60–3600
		maxImages: 10,                            // for all jobs of this session
		modes: ['prompt', 'product', 'edit'],
		origins: ['https://shop.example.com'],    // the pages allowed to use it
		externalUser: req.user.id,                // your own user id, kept on the jobs
	});
	res.json({token: session.token, expiresAt: session.expiresAt});
});
```

### 2. The page uses it

```ts
import {ImagineBrowser, ImagineError} from '@bloomscorp/imagine.js';

const imagine = new ImagineBrowser({
	getSessionToken: () => fetch('/imagine-session', {method: 'POST'}).then(r => r.json()),
});

const job = await imagine.createJob({mode: 'prompt', prompt: 'A mug on a desk', count: 4});

const stop = imagine.watchJob(job._id, {
	onImage: image => gallery.add(image.url),
	onProgress: job => progress.set(job.counts.done, job.counts.total),
	onDone: job => console.log('finished:', job.status),
	onError: error => console.error(error.code, error.message),
});
// stop() when the page no longer needs it.
```

`getSessionToken` may return the token alone, or `{ token, expiresAt }`. With
`expiresAt` the client knows when to renew without one extra request.

## Recipes

A browser job is always a recipe: one of the Studio's four modes. The session decides
which modes are allowed.

```ts
// A prompt, 1 or more times
await imagine.createJob({mode: 'prompt', prompt: 'A linen shirt on a hanger', count: 2, style: 'studio', aspectRatio: '4:5'});

// Product photos × shot types
const refs = await imagine.uploadReferences(input.files);   // 1–5 PNG/JPEG/WebP, ≤ 10 MB each
await imagine.createJob({
	mode: 'product', productName: 'Linen shirt', productDetails: 'Sky blue',
	shots: ['white', 'angle', 'lifestyle'], perShot: 2, referenceIds: refs.map(r => r._id),
});

// Edit an image
await imagine.createJob({mode: 'edit', prompt: 'Make the background beige', referenceIds: [refs[0]._id], count: 2});

// Many prompts, one per line (only when the session allows `batch`)
await imagine.createJob({mode: 'batch', text: 'A red mug\nA blue mug'});
```

All recipes also take `style`, `aspectRatio`, `model`, `credentialId`, `name` and
`externalRef`. The ids for styles, aspect ratios and product shots are in
`(await imagine.session()).presets`.

## API

### `new ImagineBrowser(options)`

| Option | Default | |
|---|---|---|
| `getSessionToken` | required | `() => string \| { token, expiresAt? }`, or a Promise of either |
| `baseUrl` | `https://z.bloomscorp.com` | |
| `timeoutMs` | `30000` | Per attempt |
| `uploadTimeoutMs` | `120000` | Per attempt, for uploads |
| `maxRetries` | `3` | For 429, 5xx and network errors |
| `maxRetryWaitMs` | `60000` | A longer `Retry-After` is thrown, not waited out |
| `fetch` | the global `fetch` | |

### Methods

| Method | Returns | |
|---|---|---|
| `session()` | `Session` | `expiresAt`, `modes`, `maxImages`, `imagesUsed`, `models`, `presets` |
| `uploadReferences(files)` | `Reference[]` | Sent as multipart field `images`. Checked first: 1–5 files, PNG/JPEG/WebP, ≤ 10 MB |
| `createJob(recipe, { idempotencyKey? })` | `CreatedJob` | The queued job, with `pacePerMinute` and `schedule`. `replay: true` when the key returned an earlier job |
| `getJob(jobId)` | `JobWithImages` | The job and the images made so far |
| `cancelJob(jobId)` | `Job` | Waiting images are cancelled |
| `watchJob(jobId, options)` | `() => void` | Polls until the job ends; returns `stop` |

`watchJob` options: `onProgress(job)` (first answer, then on every change),
`onImage(image)` (once per image, in `seq` order), `onDone(job)` (completed, failed
or cancelled), `onError(error)`, `intervalMs` (first wait, 2000) and `maxIntervalMs`
(10000). Polls slow down while nothing changes and speed up when something does.
Watching stops after `onDone`, after `onError`, or when you call `stop()`.

Image `url`s are presigned and short-lived. Show them, or download them, soon after
they arrive; `getJob` gives fresh ones.

Every request and response type is exported: `Job`, `Image`, `Session`, `Presets`,
`CreateJobRequest`, `PromptRecipe`, `ProductRecipe`, `EditRecipe`, `BatchRecipe`,
`Reference`, and the rest.

## Errors

```ts
try {
	await imagine.createJob({mode: 'prompt', prompt: 'A mug'});
} catch (err) {
	if (err instanceof ImagineError) {
		err.code;         // 'SESSION_LIMIT', 'PROMPT_REQUIRED', …
		err.status;       // HTTP status; 0 when there was no response
		err.retryAfter;   // seconds, when blooms.ai said when to try again
		err.details;      // any extra fields from the server
	}
}
```

| Code | Meaning |
|---|---|
| `SESSION_EXPIRED` | The token expired and a fresh one expired too |
| `SESSION_INVALID` | The token is unknown or was revoked |
| `SESSION_SCOPE` | The session does not allow this mode |
| `SESSION_LIMIT` | The session has used its images |
| `ORIGIN_NOT_ALLOWED` | This page's origin is not in the session's `origins` |
| `TOO_MANY_JOBS` | Too many active jobs for this session or project |
| `IMAGINE_DISABLED` | Imagine is off for the project |
| `NOT_FOUND` | Not a job of this session |
| `PROMPT_REQUIRED`, `BAD_RATIO`, `BAD_MODE`, `SHOTS_REQUIRED`, … | The recipe can't be accepted as sent |
| `RATE_LIMITED` | Too many requests; retried for you, thrown when retries run out |
| `SESSION_TOKEN_FAILED` | `getSessionToken()` threw or returned no token |
| `NETWORK_FAILURE`, `TIMEOUT`, `BAD_RESPONSE` | blooms.ai could not be reached, or answered oddly, after retries |
| `VALIDATION_ERROR`, `TOO_MANY_REFERENCES`, `TOO_LARGE`, `BAD_REFERENCE` | An upload that breaks the limits, refused before sending |

## Security

- **Never put an API key in a web page.** Anyone can read it. API keys stay on your
  server; pages get session tokens.
- Mint tokens only for signed-in users, with the smallest `maxImages` and `ttlSeconds`
  that work, and always set `origins`.
- A token can't be refreshed. When it expires, the page asks your backend for a new
  one, so your backend decides every time.
- Revoke a session at once with `imagine.sessions.revoke(sessionId)` on your server.

## License

MIT
