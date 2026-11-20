# Changelog

## 0.1.0 (unreleased)

First release.

- `ImagineBrowser`: `session()`, `uploadReferences()`, `createJob()`, `getJob()`,
  `cancelJob()` and `watchJob()` against the blooms.ai browser API
  (`/api/v1/imagine/browser`).
- Session tokens from your backend through `getSessionToken()`: fetched lazily,
  renewed 30 seconds before they expire, and once more on `SESSION_EXPIRED`.
- Retries for 429, 5xx and network errors, honouring `Retry-After`. Creates carry an
  `Idempotency-Key`.
- `ImagineError` with `status`, `code`, `message` and `retryAfter`.
- ESM, CommonJS, and a `<script>` build with the global `BloomsImagine`. No
  dependencies.
