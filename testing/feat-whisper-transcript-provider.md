# feat-whisper-transcript-provider - Test Contract

## Functional Behavior

- Provide `WhisperTranscriptProvider` behind the existing `TranscriptProvider` interface.
- Extract audio from a video via `yt-dlp` without downloading media.
- Transcribe audio using the OpenAI Whisper API.
- Normalize Whisper response segments into `TranscriptSegment[]`.
- Populate provenance with `provider: "openai-whisper"`, auto-detected language, `captionKind: "transcribed"`, source hash, and extraction timestamp.
- Cache the transcript by video ID, language, provider, and content hash.
- Keep this issue separate from chunking, artifacts, QA, player contracts, and Skillware integration.

## Unit Tests

- `WhisperTranscriptProvider` extracts audio args from `yt-dlp` (verify `--extract-audio` without video download flags).
- `WhisperTranscriptProvider` normalizes Whisper API response segments to `TranscriptSegment[]`.
- `WhisperTranscriptProvider` posts audio to the correct OpenAI endpoint.
- `WhisperTranscriptProvider` returns `blocked` for private/unavailable youtube videos.
- `WhisperTranscriptProvider` caches repeated transcript requests.
- `WhisperTranscriptProvider` fills provenance with transcribed kind and openai-whisper provider.

## Integration / Functional Tests

- Provider tests use fake `fetch` and fake yt-dlp runner; no real API call required.
- Parser tests use static Whisper response JSON.
- The package root exports `WhisperTranscriptProvider`.

## Smoke Tests

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- `npm pack --dry-run` includes built `dist` entrypoints.
- `npm audit --audit-level=critical` passes.

## E2E Tests

- N/A - SDK provider only.

## Manual / cURL Tests

- N/A - this package is a TypeScript SDK, not an HTTP service.
