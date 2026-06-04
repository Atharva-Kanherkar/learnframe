# issue-4-transcript-provider - Test Contract

## Functional Behavior

- Implement the default transcript path around caption extraction, not paid transcription.
- Provide a `YtDlpTranscriptProvider` behind the existing `TranscriptProvider` interface.
- Extract captions without downloading video or audio media.
- Prefer human captions over auto captions.
- Prefer requested language, then English, then configured fallback languages.
- Normalize VTT and SRT captions into timestamped `TranscriptSegment[]` values.
- Return explicit statuses: `available`, `missing`, `blocked`, and `needs_transcription`.
- Populate transcript provenance with provider, actual selected language, caption kind, raw source hash, and extraction timestamp.
- Do not trigger paid transcription; `allowPaidTranscription` may only change missing captions to `needs_transcription`.
- Keep transcript extraction separate from chunking, artifacts, QA, player contracts, and Skillware integration.

## Unit Tests

- `parseVtt()` parses standard cues, cue identifiers, cue settings, NOTE blocks, multiline text, and cue tags.
- `parseSrt()` parses numbered cues, comma milliseconds, and multiline text.
- `normalizeTranscriptCues()` creates deterministic segment IDs, preserves timestamps, and cleans text.
- `createTranscriptCacheKey()` returns stable keys and changes for selected language, provider, caption kind, parser version, or source hash.
- `YtDlpTranscriptProvider` chooses requested human captions before auto captions.
- `YtDlpTranscriptProvider` falls back to English and configured fallback languages.
- `YtDlpTranscriptProvider` returns `missing` when captions are absent and paid transcription is disabled.
- `YtDlpTranscriptProvider` returns `needs_transcription` when captions are absent and paid transcription is explicitly enabled.
- `YtDlpTranscriptProvider` returns `blocked` for provider-reported blocked/private/age/geo failures.
- `YtDlpTranscriptProvider` uses cached transcripts when the cache key matches.
- Runner command arguments include `--skip-download` and do not include media download flags.

## Integration / Functional Tests

- Provider tests use a fake `YtDlpRunner`; no test requires a real `yt-dlp` binary.
- Parser tests use static VTT/SRT fixtures; no test requires live YouTube or network access.
- The package root exports transcript parser utilities and `YtDlpTranscriptProvider`.

## Smoke Tests

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- `npm pack --dry-run` includes built `dist` entrypoints.
- `npm audit --audit-level=critical` passes.

## E2E Tests

- N/A - issue `#4` is SDK transcript extraction only and should not exercise live YouTube, chunking, artifacts, QA, or UI.

## Manual / cURL Tests

- N/A - this package is a TypeScript SDK, not an HTTP service.
