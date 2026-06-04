# issue-2-source-resolver - Test Contract

## Functional Behavior

- Parse canonical YouTube watch URLs, `youtu.be` URLs, shorts URLs, playlist URLs, and mixed watch-plus-playlist URLs without network calls.
- Reject non-YouTube URLs before any resolver provider is called.
- Resolve a single video into a `ResolvedYoutubeSource` whose `playlist.videos` and `videos` arrays contain exactly one `VideoMetadata` item.
- Resolve playlists into stable ordered `VideoMetadata[]` values.
- Deduplicate duplicate video IDs while preserving the first occurrence and first playlist position.
- Represent private, deleted, and unavailable playlist videos with explicit `VideoMetadata.availability` values instead of failing the whole playlist.
- Emit source-resolution progress events for playlist pages, final video count, duplicate count, and unavailable count.
- Generate deterministic source-resolution cache keys from provider, source URL, parsed IDs, and relevant resolver options.
- Keep source resolution separate from transcript extraction, chunking, artifact generation, QA, player contracts, and Skillware integration.

## Unit Tests

- `parseYoutubeUrl()` parses canonical watch URLs.
- `parseYoutubeUrl()` parses `youtu.be` URLs.
- `parseYoutubeUrl()` parses shorts URLs.
- `parseYoutubeUrl()` parses playlist URLs.
- `parseYoutubeUrl()` parses mixed watch-plus-playlist URLs and captures both IDs.
- `parseYoutubeUrl()` rejects non-YouTube URLs.
- `createSourceResolutionCacheKey()` returns the same key for equivalent inputs and different keys for changed provider/options.
- `dedupeVideoMetadata()` preserves first occurrence order and reports duplicate count.
- `normalizeResolvedYoutubeSource()` preserves playlist order and unavailable video statuses.
- `createInMemorySourceResolver()` resolves a video as a playlist of one.
- `createInMemorySourceResolver()` resolves fixture playlist videos in order with dedupe and unavailable statuses.

## Integration / Functional Tests

- `sdk.process()` with the in-memory resolver returns ordered playlist metadata and emits source-resolution progress events.
- Official YouTube Data API behavior is tested with fixtures or a fake `fetch`, not live network calls.
- No test requires a real YouTube API key.

## Smoke Tests

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- `npm pack --dry-run` includes built `dist` entrypoints.

## E2E Tests

- N/A - issue `#2` is SDK source resolution only and should not exercise live YouTube, transcripts, artifacts, QA, or UI.

## Manual / cURL Tests

- N/A - this package is a TypeScript SDK, not an HTTP service.
