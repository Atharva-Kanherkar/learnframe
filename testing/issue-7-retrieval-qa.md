# issue-7-retrieval-qa - Test Contract

## Functional Behavior

- Implement `ask()` for video-only, playlist-wide, and timestamp-specific questions through a configured retrieval QA engine.
- Retrieve nearby timestamp chunks first when `timestampSeconds` and `videoId` are provided.
- Add semantic chunk matches after nearby timestamp chunks when embeddings and chunk embeddings are configured.
- Include compressed video/playlist summaries as course context, not raw full transcripts.
- Keep answer context bounded and configurable.
- Require answered responses to include timestamp citations.
- Return suggested replay ranges, follow-up questions, and confidence metadata.
- Prefer `insufficient_context` over invented answers when context is missing.
- Preserve existing SDK fallback behavior when no QA engine is configured.

## Unit Tests

- `answerSchema` accepts answered responses with citations and rejects answered responses without citations.
- `answerSchema` accepts insufficient-context responses without citations.
- `createRetrievalQaEngine()` ranks timestamp-nearby chunks before semantic matches.
- `createRetrievalQaEngine()` supports video-only questions.
- `createRetrievalQaEngine()` supports playlist-wide questions.
- `createRetrievalQaEngine()` keeps context bounded by `maxContextChunks`.
- `createRetrievalQaEngine()` includes compressed summary/syllabus artifacts in answer prompt context.
- `createRetrievalQaEngine()` returns `insufficient_context` when no chunks or summary context exist.
- SDK `ask()` delegates to configured QA engine after validating input.
- SDK `ask()` returns current insufficient-context fallback when no QA engine is configured.

## Integration / Functional Tests

- Tests use fake `LlmAdapter` and fake `EmbeddingsAdapter`; no real model provider is called.
- Tests use existing `TranscriptChunk` and `Artifact` contract shapes.
- No test calls YouTube, `yt-dlp`, or live embedding providers.

## Smoke Tests

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- `npm pack --dry-run` includes built `dist` entrypoints.
- `npm audit --audit-level=critical` passes.

## E2E Tests

- N/A - issue `#7` is SDK retrieval QA infrastructure only.

## Manual / cURL Tests

- N/A - this package is a TypeScript SDK, not an HTTP service.
