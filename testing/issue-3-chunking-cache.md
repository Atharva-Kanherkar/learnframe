# issue-3-chunking-cache - Test Contract

## Functional Behavior

- Chunk transcripts by configurable token budget while preserving timestamp boundaries.
- Keep overlap small and configurable.
- Chunk objects include start/end timestamps and source segment IDs.
- Do not split normal transcript segments across chunks.
- Keep a single oversized segment intact as one over-budget chunk instead of losing citation provenance.
- Generate deterministic cache keys for chunks, embeddings, and LLM artifacts.
- Cache keys include task, model, prompt version, input hash, and relevant options where applicable.
- Support resumable processing from cached intermediate stages through `StorageAdapter` helpers.
- Keep this issue separate from artifact generation, embeddings execution, retrieval QA, and player contracts.

## Unit Tests

- `estimateTokens()` returns deterministic positive estimates for non-empty text.
- `chunkTranscript()` preserves chunk start/end timestamps.
- `chunkTranscript()` preserves source segment IDs.
- `chunkTranscript()` respects token budget for normal segment groups.
- `chunkTranscript()` keeps oversized single segments intact.
- `chunkTranscript()` applies configurable segment overlap deterministically.
- `chunkTranscript()` ignores empty transcript segments.
- `createChunkCacheKey()` is stable across option object key order and changes when chunk options change.
- `createPipelineCacheKey()` includes namespace, task, model, prompt version, input hash, and options.
- `getOrComputeCached()` computes and stores on miss, then skips compute on hit.

## Integration / Functional Tests

- Chunking works directly on `Transcript` objects produced by the existing contract shape.
- Resumable cache helpers use the existing `InMemoryStorageAdapter` in tests.
- No test calls LLMs, embedding providers, YouTube, or `yt-dlp`.

## Smoke Tests

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- `npm pack --dry-run` includes built `dist` entrypoints.
- `npm audit --audit-level=critical` passes.

## E2E Tests

- N/A - issue `#3` is SDK chunking/cache infrastructure only.

## Manual / cURL Tests

- N/A - this package is a TypeScript SDK, not an HTTP service.
